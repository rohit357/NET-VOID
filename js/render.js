// VOIDNET renderer: canvas drawing, force layout, camera (zoom/pan), hit testing.
import { state, TYPES, edgeLatency, nodeUp } from './state.js';

export const camera = { x: 0, y: 0, scale: 1 };

const STATUS_RING = {
  online: null,
  degraded: '#ec835a',
  overloaded: '#fab219',
  failed: '#d03b3b',
  restarting: '#3987e5',
};

let canvas, ctx, dpr = 1;

export function initRenderer(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

export function resize() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
}

export function screenToWorld(sx, sy) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (sx - rect.left - rect.width / 2) / camera.scale + camera.x,
    y: (sy - rect.top - rect.height / 2) / camera.scale + camera.y,
  };
}

export function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  camera.scale = Math.min(4, Math.max(0.15, camera.scale * factor));
  const after = screenToWorld(sx, sy);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
}

export function fitView() {
  if (!state.nodes.size) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of state.nodes.values()) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const rect = canvas.getBoundingClientRect();
  const w = maxX - minX + 240, h = maxY - minY + 240;
  camera.scale = Math.min(4, Math.max(0.15, Math.min(rect.width / w, rect.height / h)));
  camera.x = (minX + maxX) / 2;
  camera.y = (minY + maxY) / 2;
}

// ---------- hit testing ----------

export function nodeAt(wx, wy) {
  const r = 26;
  let best = null, bestD = r * r;
  for (const n of state.nodes.values()) {
    const dx = n.x - wx, dy = n.y - wy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

export function edgeAt(wx, wy) {
  const threshold = 8 / camera.scale + 4;
  let best = null, bestD = threshold;
  for (const e of state.edges.values()) {
    const a = state.nodes.get(e.a), b = state.nodes.get(e.b);
    if (!a || !b) continue;
    const d = pointSegDist(wx, wy, a.x, a.y, b.x, b.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

// ---------- force layout (freezes when settled) ----------

const REPULSE = 5200;
const SPRING_REST = 130;
const SPRING_K = 0.015;
const DAMPING = 0.82;
const CUTOFF2 = 420 * 420;

export function layoutStep(draggedId) {
  if (!state.layoutAwake) return;
  const nodes = [...state.nodes.values()];
  const n = nodes.length;

  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > CUTOFF2) continue;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const f = REPULSE / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
  }
  for (const e of state.edges.values()) {
    const a = state.nodes.get(e.a), b = state.nodes.get(e.b);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - SPRING_REST) * SPRING_K;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  }

  let energy = 0;
  for (const node of nodes) {
    // weak centering
    node.vx -= node.x * 0.0015;
    node.vy -= node.y * 0.0015;
    node.vx *= DAMPING; node.vy *= DAMPING;
    if (node.id === draggedId || node.pinned) { node.vx = 0; node.vy = 0; continue; }
    node.x += node.vx; node.y += node.vy;
    energy += node.vx * node.vx + node.vy * node.vy;
  }
  if (energy < 0.02 * n && !draggedId) state.layoutAwake = false;
}

// ---------- drawing ----------

export function draw(interaction) {
  const rect = canvas.getBoundingClientRect();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, rect.width, rect.height);

  ctx.translate(rect.width / 2, rect.height / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);

  drawGrid(rect);
  drawEdges(interaction);
  drawPackets();
  drawNodes(interaction);
  drawPendingLink(interaction);
}

function drawGrid(rect) {
  const step = 120;
  const halfW = rect.width / 2 / camera.scale, halfH = rect.height / 2 / camera.scale;
  const x0 = Math.floor((camera.x - halfW) / step) * step;
  const x1 = camera.x + halfW, y0 = Math.floor((camera.y - halfH) / step) * step, y1 = camera.y + halfH;
  ctx.strokeStyle = 'rgba(44,44,42,0.55)';
  ctx.lineWidth = 1 / camera.scale;
  ctx.beginPath();
  for (let x = x0; x < x1; x += step) { ctx.moveTo(x, camera.y - halfH); ctx.lineTo(x, y1); }
  for (let y = y0; y < y1; y += step) { ctx.moveTo(camera.x - halfW, y); ctx.lineTo(x1, y); }
  ctx.stroke();
}

function drawEdges(interaction) {
  const t = state.simTime;
  const hover = interaction.hoverEdge;
  for (const e of state.edges.values()) {
    const a = state.nodes.get(e.a), b = state.nodes.get(e.b);
    if (!a || !b) continue;
    const spiking = e.spikeUntil > t;
    const dead = !nodeUp(a) || !nodeUp(b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    if (hover === e) {
      ctx.strokeStyle = 'rgba(208,59,59,0.9)';
      ctx.lineWidth = 2.5 / camera.scale + 1;
    } else if (dead) {
      ctx.strokeStyle = 'rgba(137,135,129,0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
    } else if (spiking) {
      ctx.strokeStyle = 'rgba(236,131,90,0.75)';
      ctx.lineWidth = 1.6;
    } else {
      ctx.strokeStyle = 'rgba(137,135,129,0.35)';
      ctx.lineWidth = 1;
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (camera.scale > 0.85 && !dead) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.fillStyle = spiking ? 'rgba(236,131,90,0.95)' : 'rgba(137,135,129,0.8)';
      ctx.font = `${10 / camera.scale + 4}px ui-monospace, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(edgeLatency(e))}ms`, mx, my - 4);
    }
  }
}

function drawPackets() {
  for (const p of state.packets) {
    const a = state.nodes.get(p.route[p.hop]);
    const b = state.nodes.get(p.route[p.hop + 1]);
    if (!a || !b) continue;
    const x = a.x + (b.x - a.x) * p.progress;
    const y = a.y + (b.y - a.y) * p.progress;
    const isResp = p.phase === 'response';
    const r = 4 / Math.sqrt(camera.scale);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isResp ? '#0ca30c' : '#86b6ef';
    ctx.fill();
    // trail
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = isResp ? 'rgba(12,163,12,0.14)' : 'rgba(134,182,239,0.14)';
    ctx.fill();
  }
}

function drawNodes(interaction) {
  const t = state.simTime;
  const showLabels = camera.scale > 0.5;
  ctx.textAlign = 'center';
  for (const n of state.nodes.values()) {
    const cfg = TYPES[n.type];
    const R = n.type === 'network' ? 17 : 13;
    const isSel = state.selectedNode === n.id;
    const isHover = interaction.hoverNode === n;
    const failed = n.status === 'failed';

    // selection / hover halo
    if (isSel || isHover) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, R + 7, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? 'rgba(57,135,229,0.22)' : 'rgba(255,255,255,0.08)';
      ctx.fill();
    }
    // body
    ctx.beginPath();
    ctx.arc(n.x, n.y, R, 0, Math.PI * 2);
    ctx.fillStyle = failed ? '#2c2c2a' : cfg.color;
    ctx.fill();
    // surface ring separates overlapping marks
    ctx.lineWidth = 2 / camera.scale;
    ctx.strokeStyle = '#0d0d0d';
    ctx.stroke();

    // status ring
    const ring = STATUS_RING[n.status];
    if (ring) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, R + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      if (n.status === 'restarting') {
        const spin = (t / 300) % (Math.PI * 2);
        ctx.beginPath();
        ctx.arc(n.x, n.y, R + 3.5, spin, spin + Math.PI * 1.3);
      }
      ctx.stroke();
    }

    // glyph
    ctx.fillStyle = failed ? '#898781' : '#0d0d0d';
    ctx.font = `700 ${R * 0.85}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(failed ? '×' : cfg.glyph, n.x, n.y + 0.5);

    // label
    if (showLabels) {
      ctx.font = `${11 / Math.max(0.7, camera.scale) + 1}px ui-monospace, Consolas, monospace`;
      ctx.fillStyle = failed ? 'rgba(137,135,129,0.7)' : '#c3c2b7';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(n.name, n.x, n.y + R + 14);
    }
  }
}

function drawPendingLink(interaction) {
  const { pendingNode, cursorWorld, mode } = interaction;
  if (!pendingNode || !cursorWorld) return;
  const n = state.nodes.get(pendingNode);
  if (!n) return;
  ctx.beginPath();
  ctx.moveTo(n.x, n.y);
  ctx.lineTo(cursorWorld.x, cursorWorld.y);
  ctx.strokeStyle = mode === 'request' ? 'rgba(134,182,239,0.8)' : 'rgba(144,133,233,0.8)';
  ctx.lineWidth = 1.5 / camera.scale;
  ctx.setLineDash([6, 6]);
  ctx.stroke();
  ctx.setLineDash([]);
}
