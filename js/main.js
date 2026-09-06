// VOIDNET — main entry point
import { State } from './state.js?v=1.1';
import { Renderer } from './renderer.js?v=1.1';
import { UI } from './ui.js?v=1.1';

const canvas = document.getElementById('net-canvas');
const ctx = canvas.getContext('2d');

// high-DPI canvas setup
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// init modules
const state = new State();
const renderer = new Renderer(canvas, ctx, state);
const ui = new UI(state, renderer);

// expose UI to state for physics params
window.uiInstance = ui;

// spawn initial topology
state.spawnInitialNetwork();

// main loop
let lastFrame = performance.now();
function loop(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  state.tick(dt);
  renderer.render();
  ui.update();

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
