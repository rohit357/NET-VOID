// NET-VOID — state module (nodes, links, requests, pathfinding, chaos)
export class State {
  constructor() {
    this.nodes = [];
    this.links = [];
    this.requests = [];
    this.events = [];
    this.requestLog = [];

    this.nextNodeId = 1;
    this.nextReqId = 1;

    this.simSpeed = 1;
    this.autoTraffic = true;
    this.trafficRate = 3; // req/sec
    this.chaosMode = false;

    this.stats = {
      activeNodes: 0,
      failedNodes: 0,
      rps: 0,
      avgLatency: 0,
      packetLoss: 0,
      uptime: 100,
      sessionStart: Date.now(),
      rpsHistory: new Array(60).fill(0), // last 60s
      rpsCounter: 0,
      rpsWindow: 0,
    };

    this.trafficAccum = 0;
    this.chaosAccum = 0;
  }

  // node colors by type
  getNodeColor(type) {
    const map = {
      server: '#3987e5',
      website: '#d95926',
      api: '#199e70',
      database: '#c98500',
      user: '#d55181',
      network: '#9085e9',
    };
    return map[type] || '#898781';
  }

  spawnNode(type, x, y) {
    const node = {
      id: this.nextNodeId++,
      type,
      name: `${type}-${this.nextNodeId - 1}`,
      x: x ?? Math.random() * 800 + 300,
      y: y ?? Math.random() * 400 + 200,
      vx: 0,
      vy: 0,
      targetX: null,
      targetY: null,
      status: 'online', // online | overloaded | degraded | failed | restarting
      load: 0,
      uptime: 100,
      color: this.getNodeColor(type),
      restartTimer: 0,
      overloadTimer: 0,
      activityGlow: 0, // 0..1 pulse when sending/receiving
      trail: [], // recent positions for trail effect
    };
    this.nodes.push(node);
    this.log('info', `spawned ${node.name}`);
    return node;
  }

  deleteNode(id) {
    const idx = this.nodes.findIndex(n => n.id === id);
    if (idx === -1) return;
    const node = this.nodes[idx];

    // remove links
    this.links = this.links.filter(l => l.source !== id && l.target !== id);

    // cancel in-flight requests
    this.requests = this.requests.filter(r => {
      if (r.route.includes(id)) {
        r.status = 'dropped';
        r.endTime = Date.now();
        this.logRequest(r);
        return false;
      }
      return true;
    });

    this.nodes.splice(idx, 1);
    this.log('warn', `deleted ${node.name}`);
  }

  linkNodes(sourceId, targetId) {
    if (sourceId === targetId) return;
    const exists = this.links.some(l =>
      (l.source === sourceId && l.target === targetId) ||
      (l.source === targetId && l.target === sourceId)
    );
    if (exists) return;

    const link = {
      source: sourceId,
      target: targetId,
      latency: 10 + Math.random() * 40, // 10-50ms
      packetLoss: 0,
    };
    this.links.push(link);

    const s = this.getNode(sourceId);
    const t = this.getNode(targetId);
    if (s && t) this.log('info', `linked ${s.name} → ${t.name}`);
  }

  unlinkNodes(sourceId, targetId) {
    const idx = this.links.findIndex(l =>
      (l.source === sourceId && l.target === targetId) ||
      (l.source === targetId && l.target === sourceId)
    );
    if (idx === -1) return;

    const link = this.links[idx];
    const s = this.getNode(link.source);
    const t = this.getNode(link.target);
    this.links.splice(idx, 1);

    if (s && t) this.log('warn', `unlinked ${s.name} ↔ ${t.name}`);
  }

  getNode(id) {
    return this.nodes.find(n => n.id === id);
  }

  getNeighbors(nodeId) {
    const neighbors = [];
    for (const link of this.links) {
      if (link.source === nodeId) neighbors.push(this.getNode(link.target));
      else if (link.target === nodeId) neighbors.push(this.getNode(link.source));
    }
    return neighbors.filter(Boolean);
  }

  // A* pathfinding
  findPath(sourceId, targetId) {
    if (sourceId === targetId) return [sourceId];

    const openSet = [sourceId];
    const cameFrom = new Map();
    const gScore = new Map([[sourceId, 0]]);
    const fScore = new Map([[sourceId, this.heuristic(sourceId, targetId)]]);

    while (openSet.length > 0) {
      openSet.sort((a, b) => (fScore.get(a) ?? Infinity) - (fScore.get(b) ?? Infinity));
      const current = openSet.shift();

      if (current === targetId) {
        const path = [current];
        let node = current;
        while (cameFrom.has(node)) {
          node = cameFrom.get(node);
          path.unshift(node);
        }
        return path;
      }

      const currentNode = this.getNode(current);
      if (!currentNode || currentNode.status === 'failed') continue;

      for (const neighbor of this.getNeighbors(current)) {
        if (neighbor.status === 'failed') continue;

        const link = this.getLink(current, neighbor.id);
        const tentative = (gScore.get(current) ?? Infinity) + (link?.latency ?? 100);

        if (tentative < (gScore.get(neighbor.id) ?? Infinity)) {
          cameFrom.set(neighbor.id, current);
          gScore.set(neighbor.id, tentative);
          fScore.set(neighbor.id, tentative + this.heuristic(neighbor.id, targetId));
          if (!openSet.includes(neighbor.id)) openSet.push(neighbor.id);
        }
      }
    }

    return null; // no path
  }

  heuristic(aId, bId) {
    const a = this.getNode(aId);
    const b = this.getNode(bId);
    if (!a || !b) return Infinity;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy) * 0.1; // spatial heuristic
  }

  getLink(aId, bId) {
    return this.links.find(l =>
      (l.source === aId && l.target === bId) ||
      (l.source === bId && l.target === aId)
    );
  }

  sendRequest(sourceId, targetId) {
    const source = this.getNode(sourceId);
    const target = this.getNode(targetId);
    if (!source || !target) return;

    const route = this.findPath(sourceId, targetId);
    if (!route) {
      this.log('error', `no route ${source.name} → ${target.name}`);
      const req = {
        id: this.nextReqId++,
        source: sourceId,
        target: targetId,
        route: [sourceId, targetId],
        status: 'unroutable',
        startTime: Date.now(),
        endTime: Date.now(),
        latency: 0,
      };
      this.logRequest(req);
      return;
    }

    const latency = this.calculateLatency(route);
    const req = {
      id: this.nextReqId++,
      source: sourceId,
      target: targetId,
      route,
      status: 'in-flight',
      startTime: Date.now(),
      latency,
      progress: 0, // 0..1
      currentHop: 0,
    };

    this.requests.push(req);
    this.log('info', `req ${source.name} → ${target.name} via ${route.length} hops`);

    // trigger glow on source
    source.activityGlow = 1;

    return req;
  }

  calculateLatency(route) {
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const link = this.getLink(route[i], route[i + 1]);
      if (link) total += link.latency;
    }
    // add processing time per hop
    total += route.length * 5;
    return total;
  }

  tick(dt) {
    const realDt = dt * this.simSpeed;

    // get physics params from UI
    const floatSpeed = window.uiInstance ? window.uiInstance.floatSpeed : 1.0;
    const repulsion = window.uiInstance ? window.uiInstance.repulsion : 0;
    const floatEnabled = window.uiInstance ? window.uiInstance.floatEnabled : true;

    // update requests
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const req = this.requests[i];
      const elapsed = Date.now() - req.startTime;
      req.progress = Math.min(1, elapsed / req.latency);
      req.currentHop = Math.floor(req.progress * (req.route.length - 1));

      // check node failures along route
      let failed = false;
      for (const nodeId of req.route) {
        const node = this.getNode(nodeId);
        if (node && node.status === 'failed') {
          req.status = 'dropped';
          req.endTime = Date.now();
          failed = true;
          break;
        }
      }

      if (failed || req.progress >= 1) {
        if (!failed) {
          req.status = 'ok';
          req.endTime = Date.now();
          // add load to target
          const target = this.getNode(req.target);
          if (target) {
            target.load = Math.min(100, target.load + 2);
            target.activityGlow = 1; // trigger glow on target
          }
        }
        this.logRequest(req);
        this.requests.splice(i, 1);
        this.stats.rpsCounter++;
      }
    }

    // update nodes
    for (const node of this.nodes) {
      // spring physics toward target (if dragged)
      if (node.targetX !== null && node.targetY !== null) {
        const dx = node.targetX - node.x;
        const dy = node.targetY - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 0.5) {
          const spring = 0.15;
          const damping = 0.7;
          node.vx += dx * spring;
          node.vy += dy * spring;
          node.vx *= damping;
          node.vy *= damping;
          node.x += node.vx;
          node.y += node.vy;
        } else {
          node.targetX = null;
          node.targetY = null;
          node.vx = 0;
          node.vy = 0;
        }
      }

      // floating idle motion (stronger, more visible)
      if (node.targetX === null && node.status !== 'failed' && floatEnabled) {
        const t = Date.now() / 1000;
        node.x += Math.sin(t * 0.5 + node.id * 1.3) * 0.8 * realDt * 60 * floatSpeed;
        node.y += Math.cos(t * 0.4 + node.id * 1.7) * 0.6 * realDt * 60 * floatSpeed;
      }

      // repulsion force (push nodes apart)
      if (repulsion > 0 && node.status !== 'failed') {
        for (const other of this.nodes) {
          if (other.id === node.id || other.status === 'failed') continue;
          const dx = node.x - other.x;
          const dy = node.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0 && dist < 300) {
            const force = (repulsion / 100) * (300 - dist) / 300;
            node.x += (dx / dist) * force * realDt * 60;
            node.y += (dy / dist) * force * realDt * 60;
          }
        }
      }

      // decay activity glow
      node.activityGlow = Math.max(0, node.activityGlow - 2.5 * realDt);

      // decay load
      node.load = Math.max(0, node.load - 8 * realDt);

      // overload detection
      if (node.load > 80 && node.status === 'online') {
        node.status = 'overloaded';
        node.overloadTimer = 0;
        this.log('warn', `${node.name} overloaded`);
      } else if (node.status === 'overloaded') {
        node.overloadTimer += realDt;
        if (node.load < 60) {
          node.status = 'online';
          this.log('ok', `${node.name} recovered`);
        } else if (node.overloadTimer > 4) {
          node.status = 'failed';
          this.log('error', `${node.name} failed (overload)`);
        }
      }

      // restart timer
      if (node.status === 'restarting') {
        node.restartTimer -= realDt;
        if (node.restartTimer <= 0) {
          node.status = 'online';
          node.load = 0;
          this.log('ok', `${node.name} restarted`);
        }
      }

      // update trail
      node.trail.push({ x: node.x, y: node.y, t: Date.now() });
      if (node.trail.length > 8) node.trail.shift();
    }

    // auto traffic
    if (this.autoTraffic && this.trafficRate > 0) {
      this.trafficAccum += realDt * this.trafficRate;
      while (this.trafficAccum >= 1) {
        this.trafficAccum--;
        this.sendRandomRequest();
      }
    }

    // chaos mode
    if (this.chaosMode) {
      this.chaosAccum += realDt;
      if (this.chaosAccum > 2) {
        this.chaosAccum = 0;
        this.triggerChaos();
      }
    }

    // RPS tracking
    this.stats.rpsWindow += realDt;
    if (this.stats.rpsWindow >= 1) {
      this.stats.rps = this.stats.rpsCounter / this.stats.rpsWindow;
      this.stats.rpsHistory.shift();
      this.stats.rpsHistory.push(this.stats.rps);
      this.stats.rpsCounter = 0;
      this.stats.rpsWindow = 0;
    }

    // update stats
    this.updateStats();
  }

  sendRandomRequest() {
    const online = this.nodes.filter(n => n.status !== 'failed' && n.type !== 'network');
    if (online.length < 2) return;

    const source = online[Math.floor(Math.random() * online.length)];
    const target = online[Math.floor(Math.random() * online.length)];
    if (source.id !== target.id) {
      this.sendRequest(source.id, target.id);
    }
  }

  triggerChaos() {
    const roll = Math.random();

    if (roll < 0.3) {
      // latency spike
      const link = this.links[Math.floor(Math.random() * this.links.length)];
      if (link) {
        const oldLat = link.latency;
        link.latency = oldLat * (2 + Math.random() * 3);
        this.log('chaos', `latency spike on link (${oldLat.toFixed(0)}ms → ${link.latency.toFixed(0)}ms)`);
        setTimeout(() => { link.latency = oldLat; }, 3000);
      }
    } else if (roll < 0.5) {
      // packet loss
      const link = this.links[Math.floor(Math.random() * this.links.length)];
      if (link) {
        link.packetLoss = 0.15 + Math.random() * 0.25;
        this.log('chaos', `packet loss on link (${(link.packetLoss * 100).toFixed(0)}%)`);
        setTimeout(() => { link.packetLoss = 0; }, 4000);
      }
    } else if (roll < 0.75) {
      // node failure
      const online = this.nodes.filter(n => n.status === 'online');
      if (online.length > 0) {
        const node = online[Math.floor(Math.random() * online.length)];
        node.status = 'failed';
        this.log('chaos', `${node.name} failed`);
      }
    } else {
      // sudden load
      const online = this.nodes.filter(n => n.status === 'online');
      if (online.length > 0) {
        const node = online[Math.floor(Math.random() * online.length)];
        node.load = Math.min(100, node.load + 40 + Math.random() * 40);
        this.log('chaos', `${node.name} load spike (${node.load.toFixed(0)}%)`);
      }
    }
  }

  failNode(id) {
    const node = this.getNode(id);
    if (!node || node.status === 'failed') return;

    node.status = 'failed';
    node.restartTimer = 0;
    node.overloadTimer = 0;

    // drop in-flight requests traversing this node
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const req = this.requests[i];
      if (req.route.includes(id)) {
        req.status = 'dropped';
        req.endTime = Date.now();
        this.logRequest(req);
        this.requests.splice(i, 1);
        this.stats.rpsCounter++;
      }
    }

    this.log('error', `${node.name} forced to fail`);
    this.updateStats();
  }

  pingNode(sourceId) {
    const source = this.getNode(sourceId);
    if (!source) return null;
    if (source.status === 'failed') {
      this.log('warn', `cannot ping from ${source.name} (node is failed)`);
      return null;
    }

    const candidates = this.nodes.filter(n => n.id !== sourceId && n.status !== 'failed');
    if (candidates.length === 0) {
      this.log('warn', `no other online nodes to ping`);
      return null;
    }

    // prefer reachable nodes
    const reachable = candidates.filter(t => this.findPath(sourceId, t.id) !== null);
    const target = reachable.length > 0
      ? reachable[Math.floor(Math.random() * reachable.length)]
      : candidates[Math.floor(Math.random() * candidates.length)];

    return this.sendRequest(sourceId, target.id);
  }

  restartNode(id) {
    const node = this.getNode(id);
    if (!node || node.status === 'restarting') return;

    node.status = 'restarting';
    node.restartTimer = 3; // 3 seconds
    this.log('info', `restarting ${node.name}…`);
  }

  updateStats() {
    this.stats.activeNodes = this.nodes.filter(n => n.status !== 'failed').length;
    this.stats.failedNodes = this.nodes.filter(n => n.status === 'failed').length;

    const completed = this.requestLog.filter(r => r.endTime > Date.now() - 10000);
    if (completed.length > 0) {
      const sum = completed.reduce((acc, r) => acc + (r.endTime - r.startTime), 0);
      this.stats.avgLatency = sum / completed.length;
    }

    const recent = this.requestLog.filter(r => r.endTime > Date.now() - 30000);
    const dropped = recent.filter(r => r.status === 'dropped' || r.status === 'timeout').length;
    this.stats.packetLoss = recent.length > 0 ? (dropped / recent.length) * 100 : 0;

    const sessionTime = (Date.now() - this.stats.sessionStart) / 1000;
    const totalOk = this.requestLog.filter(r => r.status === 'ok').length;
    const totalReq = this.requestLog.length;
    this.stats.uptime = totalReq > 0 ? (totalOk / totalReq) * 100 : 100;
  }

  log(level, msg) {
    const t = new Date().toISOString().slice(11, 23);
    this.events.push({ t, level, msg });
    if (this.events.length > 500) this.events.shift();
  }

  logRequest(req) {
    this.requestLog.push(req);
    if (this.requestLog.length > 1000) this.requestLog.shift();
  }

  spawnInitialNetwork() {
    // create central networks
    const net1 = this.spawnNode('network', 500, 400);
    const net2 = this.spawnNode('network', 1000, 400);
    this.linkNodes(net1.id, net2.id);

    // spawn servers
    for (let i = 0; i < 3; i++) {
      const s = this.spawnNode('server', 300 + i * 200, 250);
      this.linkNodes(s.id, net1.id);
    }

    // spawn APIs
    for (let i = 0; i < 2; i++) {
      const a = this.spawnNode('api', 900 + i * 200, 250);
      this.linkNodes(a.id, net2.id);
    }

    // databases
    const db1 = this.spawnNode('database', 400, 550);
    const db2 = this.spawnNode('database', 1100, 550);
    this.linkNodes(db1.id, net1.id);
    this.linkNodes(db2.id, net2.id);

    // websites
    const web1 = this.spawnNode('website', 600, 150);
    const web2 = this.spawnNode('website', 900, 150);
    this.linkNodes(web1.id, net1.id);
    this.linkNodes(web2.id, net2.id);

    // users
    for (let i = 0; i < 3; i++) {
      const u = this.spawnNode('user', 200 + i * 500, 650);
      this.linkNodes(u.id, i < 2 ? net1.id : net2.id);
    }

    this.log('ok', 'initialized network topology');
  }
}
