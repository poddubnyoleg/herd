class ClaudeHub {
  constructor() {
    this.tabs = new Map();
    this.activeTabId = null;
    this.init();
  }

  async init() {
    await this.loadProjects();
    this.setupResize();
    window.addEventListener('resize', () => this.fitActiveTerminal());

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      // Ctrl+T: new session in last project
      // Ctrl+W: close active tab
      // Ctrl+Tab / Ctrl+Shift+Tab: switch tabs
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        if (this.activeTabId) this.closeTab(this.activeTabId);
      }
    });
  }

  // ── Projects ──

  async loadProjects() {
    const res = await fetch('/api/projects');
    this.projects = await res.json();
    this.renderProjects();
  }

  renderProjects() {
    const el = document.getElementById('project-list');
    el.innerHTML = this.projects.map(p => `
      <div class="project-item" data-id="${p.id}" data-path="${this.esc(p.path)}">
        <div class="project-header">
          <span class="project-chevron">&#x25B8;</span>
          <span class="project-name">${this.esc(p.name)}</span>
          <span class="project-count">${p.sessionCount}</span>
        </div>
        <div class="project-sessions"></div>
      </div>
    `).join('');

    el.querySelectorAll('.project-header').forEach(h => {
      h.addEventListener('click', () => this.toggleProject(h.parentElement));
    });
  }

  async toggleProject(el) {
    const wasExpanded = el.classList.contains('expanded');
    document.querySelectorAll('.project-item.expanded').forEach(p => p.classList.remove('expanded'));
    if (wasExpanded) return;

    el.classList.add('expanded');
    const container = el.querySelector('.project-sessions');
    container.innerHTML = '<div style="padding:5px 36px;color:var(--text-muted);font-size:11px">loading...</div>';

    const res = await fetch(`/api/projects/${el.dataset.id}/sessions`);
    const sessions = await res.json();

    container.innerHTML = `
      <button class="new-session-btn">+ new session</button>
      ${sessions.map(s => `
        <div class="session-item" data-sid="${s.id}" title="${this.esc(s.preview || '')}">
          ${this.esc(this.truncate(s.summary || s.preview || s.id.slice(0, 8), 40))}
          <span class="session-date">${this.relDate(s.date)}</span>
        </div>
      `).join('')}
    `;

    container.querySelector('.new-session-btn').addEventListener('click', e => {
      e.stopPropagation();
      this.createTab(el.dataset.path, this.lastName(el.dataset.path));
    });

    container.querySelectorAll('.session-item').forEach((item, idx) => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        const s = sessions[idx];
        this.createTab(el.dataset.path, s.summary || this.truncate(s.preview || '', 40), s.id);
      });
    });
  }

  // ── Tabs ──

  createTab(projectPath, name, resumeId) {
    // Don't open duplicate resume
    if (resumeId) {
      for (const [id, tab] of this.tabs) {
        if (tab.sessionId === resumeId) { this.switchTab(id); return; }
      }
    }

    const tabId = crypto.randomUUID();

    // Terminal wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.id = `term-${tabId}`;
    document.getElementById('terminal-area').appendChild(wrapper);

    // xterm.js
    const terminal = new Terminal({
      theme: {
        background: '#0a0e14',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0a0e14',
        selectionBackground: '#264f78',
        selectionForeground: '#ffffff',
        black: '#484f58',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#e6edf3',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#ffffff',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    try { terminal.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
    terminal.open(wrapper);

    // WebSocket
    const wsUrl = new URL(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    wsUrl.searchParams.set('project', projectPath);
    if (resumeId) wsUrl.searchParams.set('resume', resumeId);
    wsUrl.searchParams.set('cols', terminal.cols);
    wsUrl.searchParams.set('rows', terminal.rows);

    const ws = new WebSocket(wsUrl);
    const tab = { id: tabId, name: name || 'new session', terminal, fitAddon, ws, projectPath, sessionId: resumeId, alive: true };
    this.tabs.set(tabId, tab);

    ws.onopen = () => requestAnimationFrame(() => fitAddon.fit());

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'output': terminal.write(msg.data); break;
          case 'ready': tab.sessionId = msg.sessionId; break;
          case 'title': tab.name = msg.title; this.renderTabs(); break;
          case 'exit':
            tab.alive = false;
            terminal.write('\r\n\x1b[38;5;240m[session ended]\x1b[0m\r\n');
            this.renderTabs();
            break;
          case 'error':
            terminal.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
            break;
        }
      } catch {}
    };

    ws.onclose = () => {
      if (tab.alive) {
        tab.alive = false;
        terminal.write('\r\n\x1b[38;5;240m[disconnected]\x1b[0m\r\n');
        this.renderTabs();
      }
    };

    terminal.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    terminal.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    this.switchTab(tabId);
    this.renderTabs();
    requestAnimationFrame(() => { fitAddon.fit(); terminal.focus(); });
  }

  switchTab(tabId) {
    this.activeTabId = tabId;
    document.querySelectorAll('.terminal-wrapper').forEach(w => w.classList.remove('active'));

    const tab = this.tabs.get(tabId);
    if (tab) {
      document.getElementById(`term-${tabId}`).classList.add('active');
      document.getElementById('terminal-area').classList.add('has-tabs');
      document.getElementById('empty-state').classList.add('hidden');
      requestAnimationFrame(() => { tab.fitAddon.fit(); tab.terminal.focus(); });
    }
    this.renderTabs();
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    try { tab.ws.close(); } catch {}
    tab.terminal.dispose();
    document.getElementById(`term-${tabId}`)?.remove();
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        this.activeTabId = null;
        document.getElementById('terminal-area').classList.remove('has-tabs');
        document.getElementById('empty-state').classList.remove('hidden');
      }
    }
    this.renderTabs();
  }

  renderTabs() {
    const container = document.getElementById('tabs');
    container.innerHTML = '';

    for (const [id, tab] of this.tabs) {
      const el = document.createElement('div');
      el.className = `tab${id === this.activeTabId ? ' active' : ''}`;
      el.innerHTML = `
        <span class="tab-dot${tab.alive ? '' : ' dead'}"></span>
        <span class="tab-name">${this.esc(this.truncate(tab.name, 30))}</span>
        <span class="tab-close">&times;</span>
      `;

      el.addEventListener('click', e => {
        if (e.target.classList.contains('tab-close')) this.closeTab(id);
        else this.switchTab(id);
      });

      // Double-click to rename
      el.querySelector('.tab-name').addEventListener('dblclick', e => {
        e.stopPropagation();
        const nameEl = e.target;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = tab.name;
        Object.assign(input.style, {
          background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--accent)',
          outline: 'none', fontSize: '11px', width: '100%', fontFamily: 'inherit', padding: '0 4px',
          borderRadius: '2px',
        });
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        const finish = () => { tab.name = input.value || tab.name; this.renderTabs(); };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') finish();
          if (e.key === 'Escape') this.renderTabs();
        });
      });

      container.appendChild(el);
    }
  }

  // ── Sidebar resize ──

  setupResize() {
    const handle = document.getElementById('resize-handle');
    const sidebar = document.getElementById('sidebar');
    let dragging = false;

    handle.addEventListener('mousedown', e => {
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const width = Math.max(150, Math.min(500, e.clientX));
      sidebar.style.width = width + 'px';
      this.fitActiveTerminal();
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Helpers ──

  fitActiveTerminal() {
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab) requestAnimationFrame(() => tab.fitAddon.fit());
    }
  }

  lastName(p) { return p.split('/').filter(Boolean).pop() || p; }
  truncate(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }
  esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

  relDate(d) {
    const ms = Date.now() - new Date(d).getTime();
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
    if (ms < 86400000) return Math.floor(ms / 3600000) + 'h';
    if (ms < 604800000) return Math.floor(ms / 86400000) + 'd';
    return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

new ClaudeHub();
