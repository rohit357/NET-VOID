// NET-VOID simulation engine: requests, packets, chaos, node lifecycle, metrics.
import {
  state, TYPES, pushEvent, findPath, edgeLatency, nodeUp, failNode,
} from './state.js';

let reqCounter = 0;
const MAX_LOG = 800;
const TIMEOUT_MS = 1600;
const VISUAL_MS_PER_LATENCY = 9; // 1ms simulated latency -> 9ms of packet animation at speed 1

// ---------- requests ----------

export function sendRequest(srcId, dstId, depth = 0) {
  const src = state.nodes.get(srcId), dst = state.nodes.get(dstId);
  if (!src || !dst) return null;
  const id = 'r' + (++reqCounter);
  const route = findPath(srcId, dstId);
  const req = {
    id,
    src: src.name, srcId,
    dst: dst.name, dstId,
    route: route ? route.map(n => state.nodes.get(n).name) : [],
    routeIds: route || [],
    latency: 0,
    status: route ? 'in-flight' : 'unroutable',
    reason: route ? '' : 'no path',
    timestamp: state.simTime,
    wall: new Date(),
    depth,
  };
  state.requests.unshift(req);
  if (state.requests.length > MAX_LOG) state.requests.length = MAX_LOG;
  state.metrics.started.push(state.simTime);
  state.requestsDirty = true;

  if (!route) {
    finish(req, 'unroutable', 'no route to host');
    return req;
  }
  if (route.length === 1) {
    finish(req, 'ok', '');
    return req;
  }
  state.packets.push({
    req,
    route,             // node ids
    hop: 0,            // index into route (currently travelling route[hop] -> route[hop+1])
    progress: 0,       // 0..1 along current hop
    hopVisualMs: hopVisual(route[0], route[1]),
    phase: 'request',  // request | response
  });
  return req;
}

function hopVisual(aId, bId) {
  const edge = findEdgeBetween(aId, bId);
  const lat = edge ? edgeLatency(edge) : 20;
  return Math.max(120, lat * VISUAL_MS_PER_LATENCY);
}

function findEdgeBetween(aId, bId) {
  for (const eid of state.adj.get(aId) || []) {
    const e = state.edges.get(eid);
    if (e.a === bId || e.b === bId) return e;
  }
  return null;
}

function finish(req, status, reason) {
  req.status = status;
  req.reason = reason;
  state.metrics.finished.push({ t: state.simTime, status, latency: req.latency });
  state.requestsDirty = true;

  const latStr = `${Math.round(req.latency)}ms`;
  if (status === 'ok') {
    pushEvent('ok', `200 ${req.src} → ${req.dst} · ${latStr} · ${req.routeIds.length - 1} hops`);
  } else if (status === 'unroutable') {
    pushEvent('warn', `NOROUTE ${req.src} → ${req.dst} · ${reason}`);
  } else if (status === 'timeout') {
    pushEvent('warn', `TIMEOUT ${req.src} → ${req.dst} · ${latStr}`);
  } else {
    pushEvent('error', `DROP ${req.src} → ${req.dst} · ${reason} · ${latStr}`);
  }

  // cascade: delivered request may trigger a backend call
  if (status === 'ok' && req.depth < 2) {
    const dstNode = state.nodes.get(req.dstId);
    if (dstNode && nodeUp(dstNode)) {
      if (dstNode.type === 'website' && Math.random() < 0.55) {
        const target = pickConnectedOfType(dstNode.id, ['api', 'server']);
        if (target) sendRequest(dstNode.id, target, req.depth + 1);
      } else if ((dstNode.type === 'api' || dstNode.type === 'server') && Math.random() < 0.5) {
        const target = pickConnectedOfType(dstNode.id, ['database']);
        if (target) sendRequest(dstNode.id, target, req.depth + 1);
      }
    }
  }
}

function pickConnectedOfType(fromId, types) {
  const candidates = [];
  for (const [id, n] of state.nodes) {
    if (id !== fromId && types.includes(n.type) && nodeUp(n)) candidates.push(id);
  }
  if (!candidates.length) return null;
  return candidates[(Math.random() * candidates.length) | 0];
}

// ---------- packet advancement ----------

function updatePackets(dtSim) {
  const alive = [];
  for (const p of state.packets) {
    const req = p.req;
    p.progress += dtSim / p.hopVisualMs;

    if (p.progress >= 1) {
      // arrived at route[hop+1]
      const edge = findEdgeBetween(p.route[p.hop], p.route[p.hop + 1]);
      const hopLat = edge ? edgeLatency(edge) : 20;
      const arrivedId = p.route[p.hop + 1];
      const node = state.nodes.get(arrivedId);

      req.latency += hopLat;

      // node vanished or down mid-flight
      if (!node || !nodeUp(node)) {
        finish(req, 'dropped', `${node ? node.name : 'node'} down mid-flight`);
        continue;
      }
      // link vanished
      if (!edge) {
        finish(req, 'dropped', 'link removed mid-flight');
        continue;
      }

      // node processing cost + bookkeeping
      node.throughput += 1;
      node.handled += 1;
      const procDelay = 1 + Math.max(0, node.load) * 25;
      req.latency += procDelay;

      // drop chances
      if (state.chaos && Math.random() < 0.05) {
        node.dropped += 1;
        finish(req, 'dropped', 'packet loss (chaos)');
        continue;
      }
      if (node.status === 'overloaded' && Math.random() < 0.3) {
        node.dropped += 1;
        finish(req, 'dropped', `${node.name} overloaded`);
        continue;
      }
      if (req.latency > TIMEOUT_MS) {
        finish(req, 'timeout', '');
        continue;
      }

      p.hop += 1;
      const atEnd = p.hop >= p.route.length - 1;
      if (atEnd) {
        if (p.phase === 'request') {
          // turn around: response leg
          p.phase = 'response';
          p.route = [...p.route].reverse();
          p.hop = 0;
          p.progress = 0;
          p.hopVisualMs = hopVisual(p.route[0], p.route[1]);
        } else {
          finish(req, 'ok', '');
          continue;
        }
      } else {
        p.progress = 0;
        p.hopVisualMs = hopVisual(p.route[p.hop], p.route[p.hop + 1]);
      }
    }
    alive.push(p);
  }
  state.packets = alive;
}

// ---------- auto traffic ----------

function updateTraffic(dtSim) {
  if (!state.autoTraffic || state.trafficRate <= 0) return;
  const expected = state.trafficRate * (dtSim / 1000);
  if (Math.random() < expected) {
    const users = [], targets = [];
    for (const [id, n] of state.nodes) {
      if (!nodeUp(n)) continue;
      if (n.type === 'user') users.push(id);
      else if (n.type === 'website' || n.type === 'api') targets.push(id);
    }
    if (users.length && targets.length) {
      sendRequest(
        users[(Math.random() * users.length) | 0],
        targets[(Math.random() * targets.length) | 0],
      );
    }
  }
}

// ---------- node lifecycle & load ----------

function updateNodes(dtSim) {
  const t = state.simTime;
  for (const node of state.nodes.values()) {
    // throughput decay -> load
    node.throughput *= Math.pow(0.5, dtSim / 900);
    node.load = node.type === 'user' ? 0 : node.throughput / (node.capacity * 0.35);

    if (node.status === 'restarting' && t >= node.restartUntil) {
      node.status = 'online';
      pushEvent('ok', `${node.name} back ONLINE`);
      state.statsDirty = true;
    }
    if (node.status === 'failed' && node.autoRecoverAt && t >= node.autoRecoverAt) {
      node.status = 'restarting';
      node.restartUntil = t + 1200;
      pushEvent('info', `${node.name} auto-recovering…`);
      state.statsDirty = true;
    }
    if (node.status === 'online' || node.status === 'overloaded' || node.status === 'degraded') {
      const forced = node.overloadUntil > t;
      const next = (forced || node.load > 1.15) ? 'overloaded'
        : node.load > 0.75 ? 'degraded'
        : 'online';
      if (next !== node.status) {
        if (next === 'overloaded') pushEvent('warn', `${node.name} OVERLOADED (load ${node.load.toFixed(2)})`);
        node.status = next;
        state.statsDirty = true;
      }
    }
  }
}

// ---------- chaos ----------

let chaosAccum = 0;
function updateChaos(dtSim) {
  if (!state.chaos) return;
  chaosAccum += dtSim;
  if (chaosAccum < 1000) return;
  chaosAccum -= 1000;

  const nodes = [...state.nodes.values()].filter(n => n.type !== 'user');
  const edges = [...state.edges.values()];
  const t = state.simTime;

  // latency spike
  if (edges.length && Math.random() < 0.22) {
    const e = edges[(Math.random() * edges.length) | 0];
    e.spikeMult = 3 + Math.random() * 6;
    e.spikeUntil = t + 3000 + Math.random() * 6000;
    const a = state.nodes.get(e.a), b = state.nodes.get(e.b);
    pushEvent('chaos', `latency spike ×${e.spikeMult.toFixed(1)} on ${a.name} ↔ ${b.name}`);
  }
  // node failure (keep at least 60% up)
  const upCount = nodes.filter(nodeUp).length;
  if (nodes.length && upCount / nodes.length > 0.6 && Math.random() < 0.09) {
    const candidates = nodes.filter(nodeUp);
    const victim = candidates[(Math.random() * candidates.length) | 0];
    if (victim) failNode(victim.id, 'chaos');
  }
  // overload
  if (Math.random() < 0.14) {
    const candidates = nodes.filter(n => nodeUp(n) && (n.type === 'server' || n.type === 'api' || n.type === 'database'));
    const victim = candidates[(Math.random() * candidates.length) | 0];
    if (victim) {
      victim.overloadUntil = t + 4000 + Math.random() * 5000;
      victim.throughput = victim.capacity * 0.6;
      pushEvent('chaos', `traffic surge hits ${victim.name}`);
    }
  }
}

// ---------- metrics ----------

let sampleAccum = 0;
function updateMetrics(dtSim) {
  const m = state.metrics, t = state.simTime;
  // availability accounting
  for (const n of state.nodes.values()) {
    m.totalNodeMs += dtSim;
    if (!nodeUp(n)) m.downNodeMs += dtSim;
  }
  // rolling windows (keep 60s)
  const cutoff = t - 60000;
  while (m.started.length && m.started[0] < cutoff) m.started.shift();
  while (m.finished.length && m.finished[0].t < cutoff) m.finished.shift();

  sampleAccum += dtSim;
  while (sampleAccum >= 1000) {
    sampleAccum -= 1000;
    const oneSecAgo = t - 1000;
    let c = 0;
    for (let i = m.started.length - 1; i >= 0 && m.started[i] >= oneSecAgo; i--) c++;
    m.rpsHistory.push(c);
    if (m.rpsHistory.length > 60) m.rpsHistory.shift();
    state.statsDirty = true;
  }
}

export function computeStats() {
  const m = state.metrics;
  let active = 0, failed = 0;
  for (const n of state.nodes.values()) (nodeUp(n) ? active++ : failed++);

  const window = m.finished;
  let okCount = 0, lossCount = 0, latSum = 0, latN = 0;
  for (const f of window) {
    if (f.status === 'ok') { okCount++; latSum += f.latency; latN++; }
    else if (f.status === 'dropped' || f.status === 'timeout') lossCount++;
  }
  const rps = m.started.filter(ts => ts > state.simTime - 5000).length / 5;
  return {
    active, failed,
    links: state.edges.size,
    inflight: state.packets.length,
    rps,
    avgLatency: latN ? latSum / latN : null,
    loss: (okCount + lossCount) ? lossCount / (okCount + lossCount) : 0,
    availability: m.totalNodeMs ? 1 - m.downNodeMs / m.totalNodeMs : 1,
  };
}

// ---------- main tick ----------

export function tick(dtWall) {
  const dtSim = Math.min(dtWall, 100) * state.speed;
  state.simTime += dtSim;
  updateTraffic(dtSim);
  updatePackets(dtSim);
  updateNodes(dtSim);
  updateChaos(dtSim);
  updateMetrics(dtSim);
}
