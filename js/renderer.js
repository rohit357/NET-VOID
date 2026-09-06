// VOIDNET — renderer (canvas drawing with zoom/pan)
export class Renderer {
  constructor(canvas, ctx, state) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.state = state;

    this.camera = { x: 0, y: 0, zoom: 1 };
    this.selectedNode = null;
    this.hoveredNode = null;
    this.hoveredLink = null;

    this.isDragging = false;
    this.dragStart = null;
    this.panStart = null;

    this.setupInput();
  }

  setupInput() {
    this.canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', e => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', e => this.onMouseUp(e));
    this.canvas.addEventListener('wheel', e => this.onWheel(e));
  }

  screenToWorld(sx, sy) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (sx - rect.width / 2) / this.camera.zoom - this.camera.x;
    const y = (sy - rect.height / 2) / this.camera.zoom - this.camera.y;
    return { x, y };
  }

  worldToScreen(wx, wy) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (wx + this.camera.x) * this.camera.zoom + rect.width / 2;
    const y = (wy + this.camera.y) * this.camera.zoom + rect.height / 2;
    return { x, y };
  }

  onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = this.screenToWorld(mx, my);

    const mode = window.currentMode || 'select';

    if (mode === 'select') {
      const node = this.hitTestNode(world.x, world.y);
      if (node) {
        this.isDragging = true;
        this.dragStart = { x: world.x - node.x, y: world.y - node.y };
        this.selectedNode = node;
        this.dispatchEvent('nodeSelected', node);
      } else {
        this.selectedNode = null;
        this.dispatchEvent('nodeSelected', null);
        this.panStart = { x: mx, y: my, camX: this.camera.x, camY: this.camera.y };
        this.canvas.classList.add('panning');
      }
    } else if (mode === 'connect') {
      const node = this.hitTestNode(world.x, world.y);
      if (node) {
        if (!window.connectStart) {
          window.connectStart = node;
        } else {
          this.state.linkNodes(window.connectStart.id, node.id);
          window.connectStart = null;
        }
      }
    } else if (mode === 'disconnect') {
      const link = this.hitTestLink(world.x, world.y);
      if (link) {
        this.state.unlinkNodes(link.source, link.target);
      }
    } else if (mode === 'request') {
      const node = this.hitTestNode(world.x, world.y);
      if (node) {
        if (!window.requestStart) {
          window.requestStart = node;
        } else {
          this.state.sendRequest(window.requestStart.id, node.id);
          window.requestStart = null;
        }
      }
    }
  }

  onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = this.screenToWorld(mx, my);

    if (this.isDragging && this.selectedNode) {
      this.selectedNode.x = world.x - this.dragStart.x;
      this.selectedNode.y = world.y - this.dragStart.y;
    } else if (this.panStart) {
      const dx = mx - this.panStart.x;
      const dy = my - this.panStart.y;
      this.camera.x = this.panStart.camX + dx / this.camera.zoom;
      this.camera.y = this.panStart.camY + dy / this.camera.zoom;
    } else {
      this.hoveredNode = this.hitTestNode(world.x, world.y);
      this.hoveredLink = this.hitTestLink(world.x, world.y);
    }
  }

  onMouseUp(e) {
    this.isDragging = false;
    this.dragStart = null;
    this.panStart = null;
    this.canvas.classList.remove('panning');
  }

  onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = this.screenToWorld(mx, my);

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.3, Math.min(3, this.camera.zoom * delta));

    // zoom toward mouse
    const worldAfter = {
      x: (mx - rect.width / 2) / newZoom - this.camera.x,
      y: (my - rect.height / 2) / newZoom - this.camera.y,
    };
    this.camera.x += world.x - worldAfter.x;
    this.camera.y += world.y - worldAfter.y;
    this.camera.zoom = newZoom;
  }

  hitTestNode(wx, wy) {
    for (let i = this.state.nodes.length - 1; i >= 0; i--) {
      const node = this.state.nodes[i];
      const dx = wx - node.x;
      const dy = wy - node.y;
      const r = this.getNodeRadius(node);
      if (dx * dx + dy * dy < r * r) return node;
    }
    return null;
  }

  hitTestLink(wx, wy) {
    for (const link of this.state.links) {
      const src = this.state.getNode(link.source);
      const tgt = this.state.getNode(link.target);
      if (!src || !tgt) continue;

      const d = this.distanceToSegment(wx, wy, src.x, src.y, tgt.x, tgt.y);
      if (d < 8) return link;
    }
    return null;
  }

  distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);

    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const nearX = x1 + t * dx;
    const nearY = y1 + t * dy;
    return Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2);
  }

  getNodeRadius(node) {
    if (node.type === 'network') return 28;
    if (node.type === 'database') return 24;
    return 20;
  }

  zoomIn() {
    this.camera.zoom = Math.min(3, this.camera.zoom * 1.3);
  }

  zoomOut() {
    this.camera.zoom = Math.max(0.3, this.camera.zoom / 1.3);
  }

  fitNetwork() {
    if (this.state.nodes.length === 0) return;

    const xs = this.state.nodes.map(n => n.x);
    const ys = this.state.nodes.map(n => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const w = maxX - minX + 200;
    const h = maxY - minY + 200;

    const rect = this.canvas.getBoundingClientRect();
    const zoom = Math.min(rect.width / w, rect.height / h, 2);

    this.camera.x = -(minX + maxX) / 2;
    this.camera.y = -(minY + maxY) / 2;
    this.camera.zoom = zoom;
  }

  render() {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.translate(rect.width / 2, rect.height / 2);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(this.camera.x, this.camera.y);

    // draw links
    for (const link of this.state.links) {
      const src = this.state.getNode(link.source);
      const tgt = this.state.getNode(link.target);
      if (!src || !tgt) continue;

      const hovered = this.hoveredLink === link;
      ctx.strokeStyle = hovered ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = hovered ? 2.5 : 1.8;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.stroke();

      // latency text
      if (hovered) {
        const mx = (src.x + tgt.x) / 2;
        const my = (src.y + tgt.y) / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${link.latency.toFixed(0)}ms`, mx, my - 8);
      }
    }

    // draw requests (packets)
    for (const req of this.state.requests) {
      const hop = Math.min(req.currentHop, req.route.length - 2);
      const srcNode = this.state.getNode(req.route[hop]);
      const tgtNode = this.state.getNode(req.route[hop + 1]);
      if (!srcNode || !tgtNode) continue;

      const segmentProgress = (req.progress * (req.route.length - 1)) % 1;
      const px = srcNode.x + (tgtNode.x - srcNode.x) * segmentProgress;
      const py = srcNode.y + (tgtNode.y - srcNode.y) * segmentProgress;

      ctx.fillStyle = '#3987e5';
      ctx.shadowColor = 'rgba(57,135,229,0.8)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // draw nodes
    for (const node of this.state.nodes) {
      const r = this.getNodeRadius(node);
      const hovered = this.hoveredNode === node;
      const selected = this.selectedNode === node;

      // motion trail (fading echo)
      if (node.trail && node.trail.length > 2 && node.status !== 'failed') {
        const now = Date.now();
        for (let i = 0; i < node.trail.length - 1; i++) {
          const pos = node.trail[i];
          const age = now - pos.t;
          const alpha = Math.max(0, 1 - age / 800) * 0.25;
          const trailR = r * (0.5 + 0.5 * (i / node.trail.length));

          if (node.color.startsWith('#')) {
            const hex = node.color.slice(1);
            const rr = parseInt(hex.slice(0, 2), 16);
            const gg = parseInt(hex.slice(2, 4), 16);
            const bb = parseInt(hex.slice(4, 6), 16);
            ctx.fillStyle = `rgba(${rr},${gg},${bb},${alpha})`;
          }

          ctx.beginPath();
          ctx.arc(pos.x, pos.y, trailR, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ambient glow (always on, pulsing)
      if (node.status !== 'failed') {
        const t = Date.now() / 1000;
        const pulse = 0.6 + Math.sin(t * 1.5 + node.id * 0.8) * 0.4;
        const ambientR = r + 12 + pulse * 8;

        if (node.color.startsWith('#')) {
          const hex = node.color.slice(1);
          const rr = parseInt(hex.slice(0, 2), 16);
          const gg = parseInt(hex.slice(2, 4), 16);
          const bb = parseInt(hex.slice(4, 6), 16);

          const gradient = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, ambientR);
          gradient.addColorStop(0, `rgba(${rr},${gg},${bb},${pulse * 0.3})`);
          gradient.addColorStop(0.5, `rgba(${rr},${gg},${bb},${pulse * 0.15})`);
          gradient.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);

          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(node.x, node.y, ambientR, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // activity glow (strong pulse on send/receive)
      if (node.activityGlow > 0 && node.status !== 'failed') {
        const glowR = r + 18 + node.activityGlow * 22;

        if (node.color.startsWith('#')) {
          const hex = node.color.slice(1);
          const rr = parseInt(hex.slice(0, 2), 16);
          const gg = parseInt(hex.slice(2, 4), 16);
          const bb = parseInt(hex.slice(4, 6), 16);

          const gradient = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, glowR);
          gradient.addColorStop(0, `rgba(${rr},${gg},${bb},${node.activityGlow * 0.7})`);
          gradient.addColorStop(0.6, `rgba(${rr},${gg},${bb},${node.activityGlow * 0.3})`);
          gradient.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);

          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // status glow
      if (node.status === 'failed') {
        ctx.strokeStyle = 'rgba(208,59,59,0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      } else if (node.status === 'overloaded') {
        ctx.strokeStyle = 'rgba(250,178,25,0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // node body with subtle inner glow
      if (node.status !== 'failed') {
        const innerGlow = ctx.createRadialGradient(node.x, node.y - r * 0.3, 0, node.x, node.y, r);
        if (node.color.startsWith('#')) {
          const hex = node.color.slice(1);
          const rr = parseInt(hex.slice(0, 2), 16);
          const gg = parseInt(hex.slice(2, 4), 16);
          const bb = parseInt(hex.slice(4, 6), 16);
          innerGlow.addColorStop(0, `rgba(${Math.min(255, rr + 40)},${Math.min(255, gg + 40)},${Math.min(255, bb + 40)},1)`);
          innerGlow.addColorStop(1, node.color);
        }
        ctx.fillStyle = innerGlow;
      } else {
        ctx.fillStyle = '#3a2828';
        ctx.globalAlpha = 0.3;
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // border
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.15)';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.stroke();

      // load indicator
      if (node.load > 10 && node.status !== 'failed') {
        const arc = (node.load / 100) * Math.PI * 2;
        ctx.strokeStyle = node.load > 80 ? '#fab219' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r - 3, -Math.PI / 2, -Math.PI / 2 + arc);
        ctx.stroke();
      }

      // type icon (simplified)
      ctx.fillStyle = node.status === 'failed' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.9)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const icon = { server: 'S', website: 'W', api: 'A', database: 'D', user: 'U', network: 'N' }[node.type] || '?';
      ctx.fillText(icon, node.x, node.y);

      // label
      if (hovered || selected) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(node.name, node.x, node.y + r + 14);
      }
    }

    // connect/request mode preview
    const mode = window.currentMode || 'select';
    if ((mode === 'connect' && window.connectStart) || (mode === 'request' && window.requestStart)) {
      const start = window.connectStart || window.requestStart;
      const mouseWorld = this.screenToWorld(window.lastMouseX || 0, window.lastMouseY || 0);
      ctx.strokeStyle = 'rgba(57,135,229,0.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(mouseWorld.x, mouseWorld.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    // track mouse for preview line
    if ((mode === 'connect' || mode === 'request') && (window.connectStart || window.requestStart)) {
      window.addEventListener('mousemove', e => {
        window.lastMouseX = e.clientX - rect.left;
        window.lastMouseY = e.clientY - rect.top;
      });
    }
  }

  dispatchEvent(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
