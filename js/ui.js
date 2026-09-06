// VOIDNET — UI module (DOM controls, inspector, console, request log)
export class UI {
  constructor(state, renderer) {
    this.state = state;
    this.renderer = renderer;

    this.currentTab = 'console';
    this.consoleFilter = 'all';
    this.reqFilter = { search: '', status: 'all' };

    // physics params
    this.floatSpeed = 1.0;
    this.repulsion = 0;
    this.floatEnabled = true;

    // inspector & telemetry tracking
    this.inspectedNodeId = null;
    this.lastRenderedStatus = null;
    this.lastRenderedLinksHash = '';
    this.lastConsoleEventsCount = 0;
    this.lastRequestLogCount = 0;

    this.setupControls();
    this.setupInspector();
    this.setupConsole();
    this.setupRequestLog();
    this.setupGuide();
  }

  setupControls() {
    // tool buttons
    const toolBtns = document.querySelectorAll('.tool-btn');
    toolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        toolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        window.currentMode = mode;
        window.connectStart = null;
        window.requestStart = null;
        this.updateModeHint(mode);
        this.renderer.canvas.className = mode === 'select' ? '' : `mode-${mode}`;
      });
    });

    // spawn button
    document.getElementById('spawn-btn').addEventListener('click', () => {
      const type = document.getElementById('spawn-type').value;
      const node = this.state.spawnNode(type);

      // auto-connect to nearest network
      const networks = this.state.nodes.filter(n => n.type === 'network');
      if (networks.length > 0) {
        let nearest = networks[0];
        let minDist = Infinity;
        for (const net of networks) {
          const dx = net.x - node.x;
          const dy = net.y - node.y;
          const dist = dx * dx + dy * dy;
          if (dist < minDist) {
            minDist = dist;
            nearest = net;
          }
        }
        this.state.linkNodes(node.id, nearest.id);
      }
    });

    // top bar controls
    document.getElementById('toggle-traffic').addEventListener('change', e => {
      this.state.autoTraffic = e.target.checked;
    });

    document.getElementById('traffic-rate').addEventListener('input', e => {
      this.state.trafficRate = parseFloat(e.target.value);
      document.getElementById('traffic-rate-value').textContent = e.target.value;
    });

    document.getElementById('sim-speed').addEventListener('input', e => {
      this.state.simSpeed = parseFloat(e.target.value);
      document.getElementById('sim-speed-value').textContent = `${e.target.value}×`;
    });

    document.getElementById('toggle-chaos').addEventListener('change', e => {
      this.state.chaosMode = e.target.checked;
      document.getElementById('chaos-banner').classList.toggle('hidden', !e.target.checked);
    });

    // zoom controls
    document.getElementById('zoom-in').addEventListener('click', () => this.renderer.zoomIn());
    document.getElementById('zoom-out').addEventListener('click', () => this.renderer.zoomOut());
    document.getElementById('zoom-fit').addEventListener('click', () => this.renderer.fitNetwork());

    // tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const target = tab.dataset.tab;
        this.currentTab = target;

        document.getElementById('console-pane').classList.toggle('hidden', target !== 'console');
        document.getElementById('requests-pane').classList.toggle('hidden', target !== 'requests');

        document.getElementById('filters-console').classList.toggle('hidden', target !== 'console');
        document.getElementById('filters-requests').classList.toggle('hidden', target !== 'requests');

        if (target === 'console') {
          this.lastConsoleEventsCount = -1;
          this.renderConsole();
        } else if (target === 'requests') {
          this.lastRequestLogCount = -1;
          this.renderRequestLog();
        }
      });
    });

    // console filters
    document.getElementById('console-level').addEventListener('change', e => {
      this.consoleFilter = e.target.value;
      this.lastConsoleEventsCount = -1;
      this.renderConsole();
    });

    document.getElementById('console-clear').addEventListener('click', () => {
      this.state.events = [];
      this.lastConsoleEventsCount = 0;
      this.renderConsole();
    });

    // physics controls
    document.getElementById('float-speed').addEventListener('input', e => {
      this.floatSpeed = parseFloat(e.target.value);
      document.getElementById('float-speed-val').textContent = e.target.value;
    });

    document.getElementById('repulsion').addEventListener('input', e => {
      this.repulsion = parseFloat(e.target.value);
      document.getElementById('repulsion-val').textContent = e.target.value;
    });

    document.getElementById('toggle-float').addEventListener('change', e => {
      this.floatEnabled = e.target.checked;
    });

    // request filters
    document.getElementById('req-search').addEventListener('input', e => {
      this.reqFilter.search = e.target.value.toLowerCase();
      this.lastRequestLogCount = -1;
      this.renderRequestLog();
    });

    document.getElementById('req-status').addEventListener('change', e => {
      this.reqFilter.status = e.target.value;
      this.lastRequestLogCount = -1;
      this.renderRequestLog();
    });
  }

  setupInspector() {
    const body = document.getElementById('inspector-body');

    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;

      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;
      const node = this.renderer.selectedNode;

      if (!node) return;

      if (action === 'restart') {
        if (typeof this.state.restartNode === 'function') {
          this.state.restartNode(node.id);
        } else {
          node.status = 'online';
          this.state.log('ok', `${node.name} restarted`);
        }
        this.updateInspectorButtons(node);
        this.updateInspectorTelemetry(node);
      } else if (action === 'fail') {
        if (typeof this.state.failNode === 'function') {
          this.state.failNode(node.id);
        } else {
          node.status = 'failed';
          this.state.log('error', `${node.name} forced to fail`);
          if (typeof this.state.updateStats === 'function') this.state.updateStats();
        }
        this.updateInspectorButtons(node);
        this.updateInspectorTelemetry(node);
      } else if (action === 'ping') {
        if (node.status === 'failed') {
          this.state.log('warn', `Cannot ping from ${node.name} (node is failed)`);
          return;
        }
        let req = null;
        if (typeof this.state.pingNode === 'function') {
          req = this.state.pingNode(node.id);
        } else {
          const others = this.state.nodes.filter(n => n.id !== node.id && n.status !== 'failed');
          if (others.length > 0) {
            const target = others[Math.floor(Math.random() * others.length)];
            req = this.state.sendRequest(node.id, target.id);
          }
        }
        if (req) {
          btn.style.filter = 'brightness(1.4)';
          setTimeout(() => { btn.style.filter = ''; }, 200);
        }
      } else if (action === 'delete') {
        const id = node.id;
        this.renderer.selectedNode = null;
        if (this.renderer.hoveredNode?.id === id) {
          this.renderer.hoveredNode = null;
        }
        this.state.deleteNode(id);
        this.renderInspector(null);
      }
    });

    window.addEventListener('nodeSelected', e => {
      const node = e.detail;
      this.renderer.selectedNode = node;
      this.renderInspector(node);
    });
  }

  setupConsole() {
    this.renderConsole();
  }

  setupRequestLog() {
    this.renderRequestLog();
  }

  setupGuide() {
    const overlay = document.getElementById('guide-overlay');
    const closeBtn = document.getElementById('guide-close');
    const startBtn = document.getElementById('guide-start');

    const closeGuide = () => {
      overlay.classList.add('hidden');
      localStorage.setItem('voidnet-guide-seen', 'true');
    };

    closeBtn.addEventListener('click', closeGuide);
    startBtn.addEventListener('click', closeGuide);

    // show guide on first visit
    if (!localStorage.getItem('voidnet-guide-seen')) {
      overlay.classList.remove('hidden');
    } else {
      overlay.classList.add('hidden');
    }
  }

  updateModeHint(mode) {
    const hints = {
      select: 'Click a node to inspect it. Drag nodes to move. Drag empty space to pan.',
      connect: 'Click two nodes to link them.',
      disconnect: 'Click a link to remove it.',
      request: 'Click source node, then destination node.',
    };
    document.getElementById('mode-hint').textContent = hints[mode] || '';
  }

  getActionButtonsHTML(node) {
    let toggleBtn = '';
    if (node.status === 'failed') {
      toggleBtn = '<button class="btn btn-good" data-action="restart" title="Restart this node">Restart</button>';
    } else if (node.status === 'restarting') {
      toggleBtn = '<button class="btn btn-good" data-action="restart" disabled style="opacity:0.6;cursor:not-allowed;" title="Node is restarting…">Restarting…</button>';
    } else {
      toggleBtn = '<button class="btn btn-danger" data-action="fail" title="Force fail this node">Force fail</button>';
    }

    const pingDisabled = (node.status === 'failed' || node.status === 'restarting')
      ? 'disabled style="opacity:0.5;cursor:not-allowed;" title="Node is not online"'
      : 'title="Send ping request to an online node"';

    return `
      ${toggleBtn}
      <button class="btn" data-action="ping" ${pingDisabled}>Send ping</button>
      <button class="btn btn-danger" data-action="delete" title="Delete this node">Delete</button>
    `;
  }

  updateInspectorButtons(node) {
    const actionsEl = document.getElementById('insp-actions');
    if (actionsEl && node) {
      actionsEl.innerHTML = this.getActionButtonsHTML(node);
    }
  }

  getLinksHTML(node) {
    const links = this.state.links.filter(l => l.source === node.id || l.target === node.id);
    if (links.length === 0) return '';
    const linkRows = links.map(l => {
      const other = this.state.getNode(l.source === node.id ? l.target : l.source);
      if (!other) return '';
      return `<div class="insp-link-row"><span>${other.name}</span><span class="lat">${l.latency.toFixed(0)}ms</span></div>`;
    }).join('');
    return `<h3>Links (${links.length})</h3>${linkRows}`;
  }

  renderInspector(node) {
    const body = document.getElementById('inspector-body');
    if (!body) return;

    if (!node) {
      this.inspectedNodeId = null;
      this.lastRenderedStatus = null;
      this.lastRenderedLinksHash = '';
      body.className = 'inspector-empty';
      body.innerHTML = 'No node selected.';
      return;
    }

    this.inspectedNodeId = node.id;
    this.lastRenderedStatus = node.status;
    body.className = '';

    const statusMap = {
      online: { label: 'Online', cls: 'st-online', icon: '●' },
      overloaded: { label: 'Overloaded', cls: 'st-overloaded', icon: '⚠' },
      degraded: { label: 'Degraded', cls: 'st-degraded', icon: '⚠' },
      failed: { label: 'Failed', cls: 'st-failed', icon: '✕' },
      restarting: { label: 'Restarting…', cls: 'st-restarting', icon: '↻' },
    };
    const st = statusMap[node.status] || statusMap.online;

    const links = this.state.links.filter(l => l.source === node.id || l.target === node.id);
    this.lastRenderedLinksHash = links.map(l => `${l.source}-${l.target}-${l.latency.toFixed(0)}`).join('|');

    body.innerHTML = `
      <div class="insp-head">
        <div class="insp-dot" style="background:${node.color}"></div>
        <div>
          <div class="insp-name">${node.name}</div>
          <div class="insp-type">${node.type}</div>
        </div>
      </div>
      <div class="insp-status ${st.cls}" id="insp-status-badge"><span class="st-icon">${st.icon}</span><span class="st-label">${st.label}</span></div>
      <div class="insp-rows">
        <div class="insp-row"><span class="k">load</span><span class="v" id="insp-load-val">${node.load.toFixed(0)}%</span></div>
        <div class="insp-row"><span class="k">uptime</span><span class="v" id="insp-uptime-val">${node.uptime.toFixed(1)}%</span></div>
      </div>
      <div class="load-bar"><div id="insp-load-fill" style="width:${Math.min(100, Math.max(0, node.load))}%"></div></div>
      <div class="insp-actions" id="insp-actions">
        ${this.getActionButtonsHTML(node)}
      </div>
      <div class="insp-links" id="insp-links">
        ${this.getLinksHTML(node)}
      </div>
    `;
  }

  updateInspectorTelemetry(node) {
    const statusBadge = document.getElementById('insp-status-badge');
    const loadVal = document.getElementById('insp-load-val');
    const uptimeVal = document.getElementById('insp-uptime-val');
    const loadFill = document.getElementById('insp-load-fill');
    const linksEl = document.getElementById('insp-links');

    if (loadVal) loadVal.textContent = `${node.load.toFixed(0)}%`;
    if (uptimeVal) uptimeVal.textContent = `${node.uptime.toFixed(1)}%`;
    if (loadFill) loadFill.style.width = `${Math.min(100, Math.max(0, node.load))}%`;

    // update status badge & action buttons only when status changes
    if (node.status !== this.lastRenderedStatus) {
      this.lastRenderedStatus = node.status;
      const statusMap = {
        online: { label: 'Online', cls: 'st-online', icon: '●' },
        overloaded: { label: 'Overloaded', cls: 'st-overloaded', icon: '⚠' },
        degraded: { label: 'Degraded', cls: 'st-degraded', icon: '⚠' },
        failed: { label: 'Failed', cls: 'st-failed', icon: '✕' },
        restarting: { label: 'Restarting…', cls: 'st-restarting', icon: '↻' },
      };
      const st = statusMap[node.status] || statusMap.online;
      if (statusBadge) {
        statusBadge.className = `insp-status ${st.cls}`;
        statusBadge.innerHTML = `<span class="st-icon">${st.icon}</span><span class="st-label">${st.label}</span>`;
      }
      this.updateInspectorButtons(node);
    }

    // update links only if links changed
    const links = this.state.links.filter(l => l.source === node.id || l.target === node.id);
    const linksHash = links.map(l => `${l.source}-${l.target}-${l.latency.toFixed(0)}`).join('|');
    if (linksHash !== this.lastRenderedLinksHash) {
      this.lastRenderedLinksHash = linksHash;
      if (linksEl) {
        linksEl.innerHTML = this.getLinksHTML(node);
      }
    }
  }

  renderConsole() {
    const list = document.getElementById('console-list');
    const filtered = this.state.events.filter(evt => {
      if (this.consoleFilter === 'all') return true;
      return evt.level === this.consoleFilter;
    });

    list.innerHTML = filtered.slice(-200).reverse().map(evt => {
      return `<div class="evt evt-${evt.level}"><span class="t">${evt.t}</span><span class="lvl">${evt.level}</span><span class="msg">${evt.msg}</span></div>`;
    }).join('');

    // auto-scroll if near bottom
    const pane = document.getElementById('console-pane');
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 50;
    if (nearBottom) pane.scrollTop = pane.scrollHeight;
  }

  renderRequestLog() {
    const tbody = document.getElementById('req-tbody');
    let filtered = this.state.requestLog.slice().reverse();

    if (this.reqFilter.search) {
      filtered = filtered.filter(r => {
        const src = this.state.getNode(r.source);
        const tgt = this.state.getNode(r.target);
        const srcName = src ? src.name : '';
        const tgtName = tgt ? tgt.name : '';
        return srcName.toLowerCase().includes(this.reqFilter.search) ||
               tgtName.toLowerCase().includes(this.reqFilter.search);
      });
    }

    if (this.reqFilter.status !== 'all') {
      filtered = filtered.filter(r => r.status === this.reqFilter.status);
    }

    tbody.innerHTML = filtered.slice(0, 200).map(r => {
      const src = this.state.getNode(r.source);
      const tgt = this.state.getNode(r.target);
      const srcName = src ? src.name : `#${r.source}`;
      const tgtName = tgt ? tgt.name : `#${r.target}`;
      const route = r.route.map(id => {
        const n = this.state.getNode(id);
        return n ? n.name : `#${id}`;
      }).join(' → ');
      const time = new Date(r.startTime).toISOString().slice(11, 23);
      const lat = r.status === 'ok' ? `${(r.endTime - r.startTime).toFixed(0)}ms` : '—';
      const badge = `<span class="badge badge-${r.status}">${r.status}</span>`;

      return `<tr>
        <td>${time}</td>
        <td>${srcName}</td>
        <td>${tgtName}</td>
        <td class="route">${route}</td>
        <td>${lat}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
  }

  update() {
    // update stats
    document.getElementById('stat-active').textContent = this.state.stats.activeNodes;
    document.getElementById('stat-failed').textContent = this.state.stats.failedNodes;
    document.getElementById('stat-rps').textContent = this.state.stats.rps.toFixed(1);
    document.getElementById('stat-latency').textContent = this.state.stats.avgLatency > 0
      ? `${this.state.stats.avgLatency.toFixed(0)}ms`
      : '—';
    document.getElementById('stat-loss').textContent = `${this.state.stats.packetLoss.toFixed(1)}%`;
    document.getElementById('stat-uptime').textContent = `${this.state.stats.uptime.toFixed(1)}%`;

    const sessionSec = Math.floor((Date.now() - this.state.stats.sessionStart) / 1000);
    const m = Math.floor(sessionSec / 60);
    const s = sessionSec % 60;
    document.getElementById('stat-session').textContent = `${m}:${s.toString().padStart(2, '0')}`;
    document.getElementById('stat-links').textContent = this.state.links.length;
    document.getElementById('stat-inflight').textContent = this.state.requests.length;

    document.getElementById('spark-now').textContent = this.state.stats.rps.toFixed(1);

    // sparkline
    this.renderSparkline();

    // refresh console/log only when counts change
    if (this.currentTab === 'console' && this.state.events.length !== this.lastConsoleEventsCount) {
      this.lastConsoleEventsCount = this.state.events.length;
      this.renderConsole();
    } else if (this.currentTab === 'requests' && this.state.requestLog.length !== this.lastRequestLogCount) {
      this.lastRequestLogCount = this.state.requestLog.length;
      this.renderRequestLog();
    }

    // refresh inspector telemetry without destroying DOM
    const selNode = this.renderer.selectedNode;
    if (selNode) {
      if (!this.state.getNode(selNode.id)) {
        // node was deleted
        this.renderer.selectedNode = null;
        this.renderInspector(null);
      } else if (this.inspectedNodeId !== selNode.id) {
        this.renderInspector(selNode);
      } else {
        this.updateInspectorTelemetry(selNode);
      }
    } else if (this.inspectedNodeId !== null) {
      this.renderInspector(null);
    }
  }

  renderSparkline() {
    const canvas = document.getElementById('sparkline');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const data = this.state.stats.rpsHistory;
    const max = Math.max(...data, 1);

    ctx.strokeStyle = '#3987e5';
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h - (data[i] / max) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();

    // fill under curve
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(57,135,229,0.15)';
    ctx.fill();
  }
}
