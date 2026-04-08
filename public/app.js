class Herd {
  static THEMES = {
    dark: {
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
    light: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#0969da',
      cursorAccent: '#ffffff',
      selectionBackground: '#0969da33',
      selectionForeground: '#1f2328',
      black: '#24292f',
      red: '#cf222e',
      green: '#1a7f37',
      yellow: '#9a6700',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#24292f',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#2da44e',
      brightYellow: '#bf8700',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#24292f',
    },
  };

  constructor() {
    this.tabs = new Map();
    this.activeTabId = null;
    this.projects = [];
    this.searchQuery = '';
    this.sessionCache = new Map(); // projectId -> sessions array
    this.init();
  }

  async init() {
    this.initTheme();
    await this.loadProjects();
    this.setupResize();
    this.setupSearch();
    window.addEventListener('resize', () => this.fitActiveTerminal());

    // B3: Keyboard shortcuts
    document.addEventListener('keydown', e => {
      // Ctrl+W: close active tab (double-press within 2s if alive — F3)
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        if (this.activeTabId) this.requestCloseTab(this.activeTabId);
      }
      // Ctrl+T: new session in last used project
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        this.newSessionInLastProject();
      }
      // Ctrl+PageDown / Ctrl+PageUp: cycle tabs
      if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        this.cycleTab(1);
      }
      if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        this.cycleTab(-1);
      }
    });

    // P9: Warn before closing page with active sessions
    window.addEventListener('beforeunload', e => {
      if ([...this.tabs.values()].some(t => t.alive)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ── Tab cycling (B3) ──

  cycleTab(direction) {
    const ids = [...this.tabs.keys()];
    if (ids.length < 2) return;
    const idx = ids.indexOf(this.activeTabId);
    const next = ids[(idx + direction + ids.length) % ids.length];
    this.switchTab(next);
  }

  newSessionInLastProject() {
    // Use the active tab's project, or the first project
    const activeTab = this.activeTabId && this.tabs.get(this.activeTabId);
    if (activeTab) {
      this.createTab(activeTab.projectPath, this.lastName(activeTab.projectPath));
    } else if (this.projects.length) {
      const p = this.projects[0];
      if (p.exists) this.createTab(p.path, this.lastName(p.path));
    }
  }

  requestCloseTab(tabId) {
    this.closeTab(tabId);
  }

  // ── Theme ──

  initTheme() {
    this.theme = localStorage.getItem('herd-theme') || 'dark';
    this.applyTheme(this.theme);

    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setTheme(btn.dataset.theme));
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.theme === 'auto') this.updateTerminalThemes();
    });
  }

  setTheme(theme) {
    this.theme = theme;
    localStorage.setItem('herd-theme', theme);
    this.applyTheme(theme);
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
    this.updateTerminalThemes();
  }

  getEffectiveXtermTheme() {
    if (this.theme === 'auto') {
      return window.matchMedia('(prefers-color-scheme: light)').matches
        ? Herd.THEMES.light : Herd.THEMES.dark;
    }
    return Herd.THEMES[this.theme] || Herd.THEMES.dark;
  }

  updateTerminalThemes() {
    const xtermTheme = this.getEffectiveXtermTheme();
    for (const [, tab] of this.tabs) {
      tab.terminal.options.theme = xtermTheme;
    }
  }

  // ── Search (F1) ──

  setupSearch() {
    const input = document.getElementById('project-search');
    if (!input) return;
    input.addEventListener('input', () => {
      this.searchQuery = input.value.toLowerCase();
      this.filterProjects();
    });
  }

  filterProjects() {
    const q = this.searchQuery;
    document.querySelectorAll('.project-item').forEach(el => {
      if (!q) {
        el.style.display = '';
        // Hide session-level highlights when filter is cleared
        el.querySelectorAll('.session-item').forEach(s => s.style.display = '');
        return;
      }
      const name = (el.dataset.path || '').toLowerCase();
      const projectMatch = name.includes(q);

      // Check cached sessions for matches
      const sessions = this.sessionCache.get(el.dataset.id);
      const matchingSessions = sessions
        ? sessions.filter(s => {
            const text = (s.summary || s.preview || '').toLowerCase();
            return text.includes(q);
          })
        : [];

      const hasSessionMatch = matchingSessions.length > 0;
      el.style.display = (projectMatch || hasSessionMatch) ? '' : 'none';

      // Auto-expand projects that match only by session, and filter visible sessions
      if (hasSessionMatch && !projectMatch && !el.classList.contains('expanded')) {
        this.toggleProject(el, { fromFilter: true });
      }

      // If expanded, filter individual session items
      if (el.classList.contains('expanded') && !projectMatch) {
        const matchIds = new Set(matchingSessions.map(s => s.id));
        el.querySelectorAll('.session-item').forEach(s => {
          s.style.display = matchIds.has(s.dataset.sid) ? '' : 'none';
        });
      } else if (el.classList.contains('expanded')) {
        // Project name matched — show all sessions
        el.querySelectorAll('.session-item').forEach(s => s.style.display = '');
      }
    });
  }

  // ── Projects ──

  async loadProjects() {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.projects = await res.json();
      this.renderProjects();
    } catch (err) {
      document.getElementById('project-list').innerHTML =
        `<div style="padding:12px 16px;color:var(--red);font-size:11px">Failed to load projects: ${this.esc(err.message)}</div>`;
    }
  }

  renderProjects() {
    const el = document.getElementById('project-list');
    el.innerHTML = this.projects.map(p => `
      <div class="project-item${p.exists ? '' : ' archived'}" data-id="${p.id}" data-path="${this.esc(p.path)}" data-exists="${p.exists}">
        <div class="project-header">
          <span class="project-chevron">&#x25B8;</span>
          <span class="project-name" title="${this.esc(p.path)}">${this.esc(p.name)}</span>
          <span class="project-count">${p.sessionCount}</span>
        </div>
        <div class="project-sessions"></div>
      </div>
    `).join('');

    el.querySelectorAll('.project-header').forEach(h => {
      h.addEventListener('click', () => this.toggleProject(h.parentElement));
    });

    this.filterProjects();
  }

  async toggleProject(el, { fromFilter = false } = {}) {
    const wasExpanded = el.classList.contains('expanded');
    if (!fromFilter) {
      document.querySelectorAll('.project-item.expanded').forEach(p => p.classList.remove('expanded'));
    }
    if (wasExpanded) return;

    el.classList.add('expanded');
    const container = el.querySelector('.project-sessions');
    container.innerHTML = '<div style="padding:5px 36px;color:var(--text-muted);font-size:11px">loading...</div>';

    let sessions, truncated;
    try {
      const res = await fetch(`/api/projects/${el.dataset.id}/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Handle both new {sessions, total, truncated} and old array format
      if (Array.isArray(data)) {
        sessions = data;
        truncated = false;
      } else {
        sessions = data.sessions;
        truncated = data.truncated;
      }
    } catch (err) {
      container.innerHTML = `<div style="padding:5px 36px;color:var(--red);font-size:11px">Failed to load sessions</div>`;
      return;
    }

    this.sessionCache.set(el.dataset.id, sessions);

    const projectExists = el.dataset.exists === 'true';
    container.innerHTML = `
      ${projectExists ? '<button class="new-session-btn">+ new session</button>' : ''}
      ${sessions.map(s => `
        <div class="session-item" data-sid="${s.id}" title="${this.esc(s.preview || '')}">
          ${this.esc(this.truncate(s.summary || s.preview || s.id.slice(0, 8), 40))}
          <span class="session-date">${this.relDate(s.date)}</span>
        </div>
      `).join('')}
      ${truncated ? '<div class="session-truncated">older sessions not shown</div>' : ''}
    `;

    if (projectExists) {
      container.querySelector('.new-session-btn').addEventListener('click', e => {
        e.stopPropagation();
        this.createTab(el.dataset.path, this.lastName(el.dataset.path));
      });
    }

    container.querySelectorAll('.session-item').forEach((item, idx) => {
      const s = sessions[idx];
      // Re-link open tabs so the highlight is preserved after collapse/expand
      for (const [tabId, tab] of this.tabs) {
        if (tab.sessionId === s.id) { item.dataset.tabId = tabId; break; }
      }
      item.addEventListener('click', e => {
        e.stopPropagation();
        this.createTab(el.dataset.path, s.summary || this.truncate(s.preview || '', 40), s.id);
      });
    });

    // Re-apply filter to show/hide individual sessions after async load
    if (this.searchQuery) {
      clearTimeout(this._filterDebounce);
      this._filterDebounce = setTimeout(() => this.filterProjects(), 50);
    }
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

    // P1: Loading overlay
    const overlay = document.createElement('div');
    overlay.className = 'terminal-overlay';
    overlay.textContent = 'Connecting...';
    wrapper.appendChild(overlay);

    // xterm.js
    const terminal = new Terminal({
      theme: this.getEffectiveXtermTheme(),
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    try { terminal.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
    terminal.open(wrapper);

    const tab = {
      id: tabId, name: name || 'new session', terminal, fitAddon, ws: null,
      projectPath, sessionId: resumeId, alive: true, unread: false,
      finished: false, idleTimer: null, outputSinceViewed: 0,
      _closeRequested: 0, _inactiveSince: 0,
    };
    this.tabs.set(tabId, tab);

    // Register terminal I/O handlers once (they reference tab.ws dynamically)
    terminal.onData(data => {
      if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data }));
    });
    terminal.onResize(({ cols, rows }) => {
      if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    this.connectWebSocket(tab);
    this.switchTab(tabId);
    this.renderTabs();
    if (!resumeId) {
      this.addSessionToSidebar(tabId, projectPath);
    } else {
      // Link existing sidebar item to this tab so updateSidebarFinished can find it
      const existing = document.querySelector(`.session-item[data-sid="${resumeId}"]`);
      if (existing) existing.dataset.tabId = tabId;
    }
    requestAnimationFrame(() => { fitAddon.fit(); terminal.focus(); });
  }

  // F2: WebSocket connection (extracted for reconnection support)
  connectWebSocket(tab) {
    const { id: tabId, terminal, fitAddon, projectPath, sessionId: resumeId } = tab;

    const wsUrl = new URL(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    wsUrl.searchParams.set('project', projectPath);
    if (tab.sessionId) wsUrl.searchParams.set('resume', tab.sessionId);
    wsUrl.searchParams.set('cols', terminal.cols);
    wsUrl.searchParams.set('rows', terminal.rows);

    const ws = new WebSocket(wsUrl);
    tab.ws = ws;
    tab.alive = true;

    ws.onopen = () => {
      // Remove loading/reconnect overlay
      const overlay = document.getElementById(`term-${tabId}`)?.querySelector('.terminal-overlay');
      if (overlay) overlay.remove();
      requestAnimationFrame(() => { fitAddon.fit(); terminal.scrollToBottom(); });
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'output':
            terminal.write(msg.data);
            if (tabId !== this.activeTabId && tab._inactiveSince && Date.now() - tab._inactiveSince > 5000) {
              tab.outputSinceViewed += this.stripAnsi(msg.data).trim().length;
              if (tab.outputSinceViewed > 200) {
                if (tab.finished) {
                  tab.finished = false;
                  this.updateSidebarFinished(tabId, false);
                  this.renderTabs();
                }
                if (tab.idleTimer) clearTimeout(tab.idleTimer);
                tab.idleTimer = setTimeout(() => {
                  if (tabId !== this.activeTabId && !tab.finished) {
                    tab.finished = true;
                    tab.unread = false;
                    this.renderTabs();
                    this.updateSidebarFinished(tabId, true);
                  }
                }, 5000);
                if (!tab.unread) {
                  tab.unread = true;
                  this.renderTabs();
                }
              }
            }
            break;
          case 'ready':
            tab.sessionId = msg.sessionId;
            const sidebarItem = document.querySelector(`.session-item[data-tab-id="${tabId}"]`);
            if (sidebarItem) sidebarItem.dataset.sid = msg.sessionId;
            break;
          case 'title':
            tab.name = msg.title;
            this.renderTabs();
            this.updateSidebarSession(tabId, msg.title);
            break;
          case 'exit':
            tab.alive = false;
            terminal.write('\r\n\x1b[38;5;240m[shell exited]\x1b[0m\r\n');
            if (tabId !== this.activeTabId) {
              tab.finished = true;
              tab.unread = false;
              this.updateSidebarFinished(tabId, true);
            }
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

        // F2: Auto-reconnect for sessions that can be resumed
        if (tab.sessionId) {
          this.scheduleReconnect(tab);
        }
      }
    };

  }

  // F2: Reconnection with exponential backoff
  scheduleReconnect(tab, attempt = 0) {
    if (tab._destroyed) return;
    if (tab._reconnectTimer) clearTimeout(tab._reconnectTimer);
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    tab._reconnectTimer = setTimeout(() => {
      if (tab._destroyed) return;
      tab.terminal.write(`\r\n\x1b[38;5;240m[reconnecting...]\x1b[0m\r\n`);
      this.connectWebSocket(tab);
      // If still disconnected after 5s, retry
      setTimeout(() => {
        if (tab.ws?.readyState !== WebSocket.OPEN && !tab._destroyed) {
          this.scheduleReconnect(tab, attempt + 1);
        }
      }, 5000);
    }, delay);
  }

  switchTab(tabId) {
    // Mark the previously active tab with the time it became inactive
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prev = this.tabs.get(this.activeTabId);
      if (prev) prev._inactiveSince = Date.now();
    }
    this.activeTabId = tabId;
    document.querySelectorAll('.terminal-wrapper').forEach(w => w.classList.remove('active'));

    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.unread = false;
      tab.finished = false;
      tab.outputSinceViewed = 0;
      if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
      this.updateSidebarFinished(tabId, false);
      document.getElementById(`term-${tabId}`).classList.add('active');
      document.getElementById('terminal-area').classList.add('has-tabs');
      document.getElementById('empty-state').classList.add('hidden');
      requestAnimationFrame(() => { tab.fitAddon.fit(); tab.terminal.scrollToBottom(); tab.terminal.focus(); });
    }
    this.renderTabs();
    // F8: Highlight active project in sidebar
    this.highlightActiveProject();
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    tab._destroyed = true;
    if (tab._reconnectTimer) clearTimeout(tab._reconnectTimer);
    try { tab.ws?.close(); } catch {}
    tab.terminal.dispose();
    document.getElementById(`term-${tabId}`)?.remove();
    const sidebarEl = document.querySelector(`.session-item[data-tab-id="${tabId}"]`);
    if (sidebarEl) delete sidebarEl.dataset.tabId;
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
      el.className = `tab${id === this.activeTabId ? ' active' : ''}${tab.finished ? ' finished' : tab.unread ? ' unread' : ''}`;
      el.innerHTML = `
        <span class="tab-dot${tab.alive ? '' : ' dead'}"></span>
        <span class="tab-name">${this.esc(this.truncate(tab.name, 30))}</span>
        <span class="tab-close">&times;</span>
      `;

      el.addEventListener('click', e => {
        if (e.target.classList.contains('tab-close')) this.requestCloseTab(id);
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

  // ── Sidebar session sync ──

  // F8: Highlight the sidebar project that matches the active tab
  highlightActiveProject() {
    document.querySelectorAll('.project-item').forEach(el => el.classList.remove('active-project'));
    const tab = this.activeTabId && this.tabs.get(this.activeTabId);
    if (tab) {
      const projectEl = [...document.querySelectorAll('.project-item')].find(
        el => el.dataset.path === tab.projectPath
      );
      if (projectEl) projectEl.classList.add('active-project');
    }
  }

  addSessionToSidebar(tabId, projectPath) {
    const projectEl = [...document.querySelectorAll('.project-item')].find(
      el => el.dataset.path === projectPath
    );
    if (!projectEl || !projectEl.classList.contains('expanded')) return;

    const container = projectEl.querySelector('.project-sessions');
    const newBtn = container.querySelector('.new-session-btn');

    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.tabId = tabId;
    item.innerHTML = `
      ${this.esc(this.truncate(this.lastName(projectPath), 40))}
      <span class="session-date">now</span>
    `;
    item.addEventListener('click', e => {
      e.stopPropagation();
      if (this.tabs.has(tabId)) {
        this.switchTab(tabId);
      } else if (item.dataset.sid) {
        this.createTab(projectPath, item.textContent.trim(), item.dataset.sid);
      }
    });

    if (newBtn) newBtn.after(item);
    else container.prepend(item);

    // Update count
    const countEl = projectEl.querySelector('.project-count');
    if (countEl) countEl.textContent = parseInt(countEl.textContent) + 1;
  }

  updateSidebarSession(tabId, name) {
    const item = document.querySelector(`.session-item[data-tab-id="${tabId}"]`);
    if (!item) return;
    item.innerHTML = `
      ${this.esc(this.truncate(name, 40))}
      <span class="session-date">now</span>
    `;
  }

  updateSidebarFinished(tabId, finished) {
    const item = document.querySelector(`.session-item[data-tab-id="${tabId}"]`);
    if (item) item.classList.toggle('finished', finished);
  }

  // ── Sidebar resize ──

  setupResize() {
    const handle = document.getElementById('resize-handle');
    const sidebar = document.getElementById('sidebar');
    let dragging = false;

    // P3: Restore saved sidebar width
    const savedWidth = localStorage.getItem('herd-sidebar-width');
    if (savedWidth) sidebar.style.width = savedWidth + 'px';

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
      // P3: Persist sidebar width
      localStorage.setItem('herd-sidebar-width', parseInt(sidebar.style.width));
    });
  }

  // ── Helpers ──

  fitActiveTerminal() {
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab) requestAnimationFrame(() => tab.fitAddon.fit());
    }
  }

  stripAnsi(s) { return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x00-\x1f]/g, ''); }
  lastName(p) { return p.split('/').filter(Boolean).pop() || p; }
  truncate(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }
  esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  relDate(d) {
    const ms = Date.now() - new Date(d).getTime();
    if (ms < 60000) return 'now';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
    if (ms < 86400000) return Math.floor(ms / 3600000) + 'h';
    if (ms < 604800000) return Math.floor(ms / 86400000) + 'd';
    return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

window.__herd = new Herd();
