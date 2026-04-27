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
    this.sessionCache = new Map(); // projectPath -> sessions array
    this.codexAvailable = false;
    this.geminiAvailable = false;
    this.piAvailable = false;
    this.init();
  }

  async init() {
    this.initTheme();
    await this.loadProjects();
    await this.loadRecentSessions();
    this.loadTokenUsage();
    this.restoreTabState();
    this.setupResize();
    this.setupSearch();
    this.setupAddProject();
    this.listenForSummaryUpdates();
    document.getElementById('new-tab-btn').addEventListener('click', () => this.newSessionInLastProject());
    // Window resize is handled per-terminal by ResizeObserver in createTab

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

  newSessionInLastProject(agent) {
    // Use the active tab's project, or the first project
    const activeTab = this.activeTabId && this.tabs.get(this.activeTabId);
    const useAgent = agent || (activeTab?.agent) || 'claude';
    if (activeTab) {
      this.createTab(activeTab.projectPath, this.lastName(activeTab.projectPath), null, useAgent);
    } else if (this.projects.length) {
      const p = this.projects[0];
      if (p.exists) this.createTab(p.path, this.lastName(p.path), null, useAgent);
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

  // ── Tab persistence ──

  saveTabState() {
    const tabs = [...this.tabs.values()]
      .filter(t => t.sessionId)
      .map(t => ({ sessionId: t.sessionId, projectPath: t.projectPath, name: t.name, agent: t.agent }));
    const activeSession = this.activeTabId ? this.tabs.get(this.activeTabId)?.sessionId : null;
    localStorage.setItem('herd-tabs', JSON.stringify({ tabs, activeSessionId: activeSession }));
  }

  restoreTabState() {
    try {
      const raw = localStorage.getItem('herd-tabs');
      if (!raw) return;
      const state = JSON.parse(raw);
      if (!state.tabs?.length) return;

      let activeTabId = null;
      for (const saved of state.tabs) {
        this.createTab(saved.projectPath, saved.name, saved.sessionId, saved.agent || 'claude');
        if (saved.sessionId === state.activeSessionId) {
          for (const [id, tab] of this.tabs) {
            if (tab.sessionId === saved.sessionId) { activeTabId = id; break; }
          }
        }
      }
      if (activeTabId) this.switchTab(activeTabId);
    } catch {}
  }

  // ── Search (F1) ──

  listenForSummaryUpdates() {
    const es = new EventSource('/api/summary-events');
    es.onmessage = (event) => {
      try {
        const { sessionId, agent, summary } = JSON.parse(event.data);
        // Update session cache
        for (const [, sessions] of this.sessionCache) {
          const s = sessions.find(s => s.id === sessionId && (s.agent || 'claude') === agent);
          if (s) { s.summary = summary; break; }
        }
        // Update recent sessions
        if (this.recentSessions) {
          const r = this.recentSessions.find(s => s.id === sessionId && (s.agent || 'claude') === agent);
          if (r) r.summary = summary;
        }
        // Update sidebar session names in-place (no full re-render)
        document.querySelectorAll(`.session-item[data-sid="${sessionId}"][data-agent="${agent}"]`).forEach(el => {
          const nameEl = el.querySelector('.recent-session-name');
          if (nameEl) { nameEl.textContent = this.truncate(summary, 28); return; }
          // Regular session items: text is directly in the element after the badge
          const badge = el.querySelector(`span[class^="badge-"]`);
          if (badge && badge.nextSibling) {
            badge.nextSibling.textContent = '\n          ' + this.truncate(summary, 38);
          }
        });
        // Update recent session items separately
        document.querySelectorAll(`.recent-session-item[data-sid="${sessionId}"]`).forEach(el => {
          const nameEl = el.querySelector('.recent-session-name');
          if (nameEl) nameEl.textContent = this.truncate(summary, 28);
        });
      } catch {}
    };
  }

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
      const sessions = this.sessionCache.get(el.dataset.path);
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

  // ── Add project dialog ──

  setupAddProject() {
    const btn = document.getElementById('add-project-btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const res = await fetch('/api/pick-folder', { method: 'POST' });
        const data = await res.json();
        if (data.cancelled || !data.path) return;
        this.createTab(data.path, data.name);
      } catch {}
      finally { btn.disabled = false; }
    });
  }

  // ── Projects ──

  async loadProjects() {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.projects = await res.json();
      this.codexAvailable = this.projects.some(p => p.codexAvailable);
      this.geminiAvailable = this.projects.some(p => p.geminiAvailable);
      this.piAvailable = this.projects.some(p => p.piAvailable);
      this.renderProjects();
      this.loadRecentSessions();
    } catch (err) {
      document.getElementById('project-list').innerHTML =
        `<div style="padding:12px 16px;color:var(--red);font-size:11px">Failed to load projects: ${this.esc(err.message)}</div>`;
    }
  }

  renderProjects() {
    const el = document.getElementById('project-list');

    const renderProject = p => `
      <div class="project-item${p.exists ? '' : ' archived'}" data-id="${p.id}" data-path="${this.esc(p.path)}" data-exists="${p.exists}">
        <div class="project-header">
          <span class="project-chevron">&#x25B8;</span>
          <span class="project-name" title="${this.esc(p.path)}">${this.esc(this.lastName(p.path))}</span>
          <span class="project-count">${p.sessionCount}</span>
          ${p.exists ? `<button class="project-finder-btn" title="Reveal in Finder" aria-label="Reveal in Finder">&#x29C9;</button>` : ''}
        </div>
        <div class="project-sessions"></div>
      </div>
    `;

    // Group by parent folder (first segment of name, e.g. "pd" from "pd/herd")
    const grouped = new Map();
    for (const p of this.projects) {
      const parts = p.name.split('/');
      const group = parts.length >= 2 ? parts[0] : '';
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(p);
    }

    let html = '';
    if (grouped.size > 1 || (grouped.size === 1 && !grouped.has(''))) {
      for (const [group, projects] of grouped) {
        const count = projects.reduce((s, p) => s + p.sessionCount, 0);
        html += `<div class="project-group" data-group="${this.esc(group || 'other')}">
          <div class="project-group-header">
            <span class="group-label">${this.esc(group || 'other')}</span>
            <span class="group-count">${count}</span>
          </div>
          ${projects.map(renderProject).join('')}
        </div>`;
      }
    } else {
      html = this.projects.map(renderProject).join('');
    }

    el.innerHTML = html;

    el.querySelectorAll('.project-header').forEach(h => {
      h.addEventListener('click', () => this.toggleProject(h.parentElement));
    });

    el.querySelectorAll('.project-finder-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const p = btn.closest('.project-item').dataset.path;
        if (!p) return;
        try {
          await fetch('/api/open-in-finder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p }),
          });
        } catch {}
      });
    });

    this.filterProjects();
  }

  async loadRecentSessions() {
    try {
      const res = await fetch('/api/recent-sessions?limit=20');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.recentSessions = await res.json();
      this.renderRecentSessions();
    } catch {}
  }

  renderRecentSessions() {
    const el = document.getElementById('project-list');
    const sessions = this.recentSessions;
    if (!sessions?.length) return;

    // Remove existing recent section if any
    el.querySelector('.recent-section')?.remove();

    const section = document.createElement('div');
    section.className = 'recent-section project-item expanded';
    section.innerHTML = `
      <div class="project-header recent-header">
        <span class="project-chevron">&#x25B8;</span>
        <span class="project-name">Recent</span>
        <span class="project-count">${sessions.length}</span>
      </div>
      <div class="project-sessions" style="display:block">
        ${sessions.map(s => `
          <div class="session-item recent-session-item" data-sid="${s.id}" data-agent="${s.agent || 'claude'}" data-project="${this.esc(s.projectPath)}" title="${this.esc(s.projectPath)}">
            <span class="badge-${s.agent || 'claude'}"></span>
            <span class="recent-session-name">${this.esc(this.truncate(s.summary || s.preview || 'New Session', 28))}</span>
            <span class="recent-project-label">${this.esc(this.lastName(s.projectPath))}</span>
            <span class="session-date">${this.relDate(s.date)}</span>
          </div>
        `).join('')}
      </div>
    `;

    el.prepend(section);

    // Toggle expand/collapse
    section.querySelector('.recent-header').addEventListener('click', () => {
      section.classList.toggle('expanded');
      section.querySelector('.project-sessions').style.display =
        section.classList.contains('expanded') ? 'block' : 'none';
    });

    // Click to open session
    section.querySelectorAll('.recent-session-item').forEach((item, idx) => {
      const s = sessions[idx];
      // Mark if already open in a tab
      for (const [tabId, tab] of this.tabs) {
        if (tab.sessionId === s.id && tab.agent === (s.agent || 'claude')) { item.dataset.tabId = tabId; break; }
      }
      item.addEventListener('click', e => {
        e.stopPropagation();
        this.createTab(s.projectPath, s.summary || this.truncate(s.preview || 'New Session', 40), s.id, s.agent || 'claude');
      });
    });
  }

  // ── Token usage dashboard ──

  async loadTokenUsage() {
    try {
      const res = await fetch('/api/token-usage');
      if (!res.ok) return;
      this.tokenUsage = await res.json();
      this.renderUsageBadge();
    } catch {}
  }

  fmtTokens(n) {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }

  fmtCost(n) { return '$' + n.toFixed(2); }

  renderUsageBadge() {
    const data = this.tokenUsage;
    const el = document.getElementById('usage-badge');
    if (!data || !el) return;
    el.textContent = this.fmtCost(data.totalCost) + ' / ' + this.fmtTokens(data.totalTokens);
    el.onclick = () => this.showUsagePopup();
  }

  showUsagePopup() {
    if (document.getElementById('usage-popup')) return;
    const data = this.tokenUsage;
    if (!data) return;

    const shortModel = m => {
      if (m.includes('opus')) return 'Opus';
      if (m.includes('sonnet')) return 'Sonnet';
      if (m.includes('haiku')) return 'Haiku';
      return m.split('-').slice(0, 2).join(' ');
    };

    const modelEntries = Object.entries(data.models)
      .filter(([m]) => m !== '<synthetic>' && m !== 'unknown')
      .sort(([, a], [, b]) => b.cost - a.cost);

    const daily = data.daily.slice(-14);
    const maxCost = Math.max(...daily.map(d => d.cost), 1);
    const bars = daily.map(d => {
      const h = Math.max(2, Math.round((d.cost / maxCost) * 32));
      const label = d.date.slice(5);
      return `<div class="spark-bar" style="height:${h}px" title="${label}: ${this.fmtCost(d.cost)}"></div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'usage-popup';
    overlay.className = 'usage-overlay';
    overlay.innerHTML = `
      <div class="usage-popup">
        <div class="usage-header">
          <span class="usage-title">30-day usage</span>
          <span class="usage-total-cost">${this.fmtCost(data.totalCost)}<span class="usage-note">API equivalent</span></span>
        </div>
        <div class="usage-stats">
          <div class="usage-stat">
            <span class="stat-value">${this.fmtTokens(data.totalTokens)}</span>
            <span class="stat-label">tokens</span>
          </div>
          <div class="usage-stat">
            <span class="stat-value">${data.totalSessions.toLocaleString()}</span>
            <span class="stat-label">sessions</span>
          </div>
          <div class="usage-stat">
            <span class="stat-value">${data.totalMessages.toLocaleString()}</span>
            <span class="stat-label">API calls</span>
          </div>
        </div>
        <div class="usage-models">
          ${modelEntries.map(([model, m]) => {
            const pct = data.totalCost > 0 ? (m.cost / data.totalCost * 100) : 0;
            return `<div class="usage-model">
              <div class="model-row">
                <span class="model-name">${this.esc(shortModel(model))}</span>
                <span class="model-cost">${this.fmtCost(m.cost)}</span>
              </div>
              <div class="model-bar-track"><div class="model-bar-fill" style="width:${pct}%"></div></div>
              <div class="model-detail">
                <span>in: ${this.fmtTokens(m.input)}</span>
                <span>out: ${this.fmtTokens(m.output)}</span>
                <span>cache r: ${this.fmtTokens(m.cache_read)}</span>
                <span>cache w: ${this.fmtTokens(m.cache_write_5m + m.cache_write_1h)}</span>
              </div>
            </div>`;
          }).join('')}
        </div>
        <div class="usage-spark">
          <div class="spark-label">daily cost</div>
          <div class="spark-bars">${bars}</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
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
      const res = await fetch(`/api/sessions?project=${encodeURIComponent(el.dataset.path)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
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

    this.sessionCache.set(el.dataset.path, sessions);

    const projectExists = el.dataset.exists === 'true';
    const codexBtn = this.codexAvailable
      ? '<button class="new-session-btn new-session-codex" data-agent="codex"><span class="badge-codex"></span> codex</button>'
      : '';
    const geminiBtn = this.geminiAvailable
      ? '<button class="new-session-btn new-session-gemini" data-agent="gemini"><span class="badge-gemini"></span> gemini</button>'
      : '';
    const piBtn = this.piAvailable
      ? '<button class="new-session-btn new-session-pi" data-agent="pi"><span class="badge-pi"></span> pi</button>'
      : '';
    container.innerHTML = `
      ${projectExists ? `<div class="new-session-actions"><button class="new-session-btn new-session-claude" data-agent="claude"><span class="badge-claude"></span> claude</button>${codexBtn}${geminiBtn}${piBtn}</div>` : ''}
      ${sessions.map(s => `
        <div class="session-item" data-sid="${s.id}" data-agent="${s.agent || 'claude'}" title="${this.esc(s.preview || '')}">
          <span class="badge-${s.agent || 'claude'}"></span>
          ${this.esc(this.truncate(s.summary || s.preview || 'New Session', 38))}
          <span class="session-date">${this.relDate(s.date)}</span>
        </div>
      `).join('')}
      ${truncated ? '<div class="session-truncated">older sessions not shown</div>' : ''}
    `;

    if (projectExists) {
      container.querySelectorAll('.new-session-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this.createTab(el.dataset.path, this.lastName(el.dataset.path), null, btn.dataset.agent || 'claude');
        });
      });
    }

    container.querySelectorAll('.session-item').forEach((item, idx) => {
      const s = sessions[idx];
      for (const [tabId, tab] of this.tabs) {
        if (tab.sessionId === s.id && tab.agent === (s.agent || 'claude')) { item.dataset.tabId = tabId; break; }
      }
      item.addEventListener('click', e => {
        e.stopPropagation();
        this.createTab(el.dataset.path, s.summary || this.truncate(s.preview || 'New Session', 40), s.id, s.agent || 'claude');
      });
    });

    // Re-apply filter to show/hide individual sessions after async load
    if (this.searchQuery) {
      clearTimeout(this._filterDebounce);
      this._filterDebounce = setTimeout(() => this.filterProjects(), 50);
    }
  }

  // ── Tabs ──

  createTab(projectPath, name, resumeId, agent = 'claude') {
    // Don't open duplicate resume
    if (resumeId) {
      for (const [id, tab] of this.tabs) {
        if (tab.sessionId === resumeId && tab.agent === agent) { this.switchTab(id); return; }
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
    // IMPORTANT: terminal.open() is deferred until AFTER switchTab makes the
    // wrapper visible. xterm's CharSizeService measures the font against a
    // DOM element at open time — if the wrapper is display:none then, it
    // caches cell width/height = 0 and fitAddon.proposeDimensions() returns
    // undefined forever, so the PTY stays at xterm's 80x24 default.

    const tab = {
      id: tabId, name: name || 'new session', terminal, fitAddon, ws: null,
      projectPath, sessionId: resumeId, agent, alive: true, unread: false,
      finished: false, idleTimer: null, outputSinceViewed: 0,
      _closeRequested: 0, _inactiveSince: 0,
      _writeBuf: '', _writeRaf: 0,
      _resizeObserver: null,
    };
    this.tabs.set(tabId, tab);

    // macOS keyboard navigation: Option+Arrow for word jump, Cmd+Arrow for line jump
    terminal.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true;
      // Option+Left/Right: word jump (send ESC+b / ESC+f)
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data: '\x1bb' }));
          return false;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data: '\x1bf' }));
          return false;
        }
      }
      // Cmd+Left/Right: beginning/end of line (send Home/End escape)
      if (e.metaKey && !e.altKey && !e.ctrlKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data: '\x01' }));
          return false;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data: '\x05' }));
          return false;
        }
      }
      return true;
    });

    // Register terminal I/O handlers once (they reference tab.ws dynamically)
    terminal.onData(data => {
      if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'input', data }));
    });
    terminal.onResize(({ cols, rows }) => {
      if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    // Activate the tab so #terminal-area + wrapper become visible (display
    // goes from none → flex). This MUST happen before terminal.open() so
    // xterm's font measurement sees a real DOM, not 0x0.
    this.switchTab(tabId);
    if (!resumeId) {
      this.addSessionToSidebar(tabId, projectPath);
    } else {
      // Link existing sidebar item to this tab so updateSidebarFinished can find it
      const existing = document.querySelector(`.session-item[data-sid="${resumeId}"]`);
      if (existing) existing.dataset.tabId = tabId;
    }

    // Wait a frame so the browser lays out the now-visible wrapper, THEN
    // open the terminal (correct font measurement → correct cell dims →
    // fitAddon works), then fit + spawn the PTY with real cols/rows.
    requestAnimationFrame(() => {
      terminal.open(wrapper);

      // GPU-accelerated rendering via WebGL (major FPS improvement)
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        webglAddon.onContextLoss(() => { webglAddon.dispose(); });
        terminal.loadAddon(webglAddon);
      } catch {}

      // Snap to exact buffer bottom when user drags the scrollbar all the way down.
      // With lineHeight 1.25 the per-row pixel height is fractional, so xterm's
      // internal `floor(scrollTop / rowHeight)` can land at `baseY - 1` at max
      // scroll — cropping the last row (e.g. the bottom of Claude's approval box).
      const xtermViewport = wrapper.querySelector('.xterm-viewport');
      if (xtermViewport) {
        xtermViewport.addEventListener('scroll', () => {
          if (xtermViewport.scrollTop + xtermViewport.clientHeight >= xtermViewport.scrollHeight - 1) {
            const buf = terminal.buffer.active;
            if (buf.viewportY < buf.baseY) terminal.scrollToBottom();
          }
        }, { passive: true });
      }

      // Auto-refit terminal when container resizes (window resize, sidebar drag, etc.)
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          try { fitAddon.fit(); } catch {}
        });
      });
      resizeObserver.observe(wrapper);
      tab._resizeObserver = resizeObserver;

      try { fitAddon.fit(); } catch {}
      this.connectWebSocket(tab);
      terminal.focus();
    });
  }

  // F2: WebSocket connection (extracted for reconnection support)
  connectWebSocket(tab) {
    const { id: tabId, terminal, fitAddon, projectPath, sessionId: resumeId } = tab;

    const wsUrl = new URL(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    wsUrl.searchParams.set('project', projectPath);
    wsUrl.searchParams.set('agent', tab.agent || 'claude');
    if (tab.sessionId) wsUrl.searchParams.set('resume', tab.sessionId);
    wsUrl.searchParams.set('cols', terminal.cols);
    wsUrl.searchParams.set('rows', terminal.rows);

    const ws = new WebSocket(wsUrl);
    tab.ws = ws;
    tab.alive = true;

    ws.onopen = () => {
      // Suppress finished/unread tracking for 15s after (re)connect. On page
      // refresh or WS reconnect, `claude --resume` replays session history as
      // a burst of output — indistinguishable from a real completed run
      // (output, then quiet), which used to mark every restored background
      // tab with the green "finished" pulse.
      tab._suppressUntil = Date.now() + 15000;
      // Clear any stale finished-tracking from the prior connection
      if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
      tab.outputSinceViewed = 0;
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
            // While a suppress window is active, keep sliding it forward as
            // long as output is streaming. `claude --resume` replay bursts can
            // easily outlast the initial 15s window on long sessions; without
            // this, the tail of the replay flips every restored background
            // tab to "finished" (green pulse) a few seconds after refresh.
            if (tab._suppressUntil && Date.now() < tab._suppressUntil) {
              tab._suppressUntil = Math.max(tab._suppressUntil, Date.now() + 3000);
            }
            // Batch writes via rAF to reduce render calls and improve FPS
            tab._writeBuf += msg.data;
            if (!tab._writeRaf) {
              tab._writeRaf = requestAnimationFrame(() => {
                tab._writeRaf = 0;
                const chunk = tab._writeBuf;
                tab._writeBuf = '';
                // Check if viewport is near the bottom before writing
                const buf = terminal.buffer.active;
                const atBottom = buf.viewportY >= buf.baseY - 1;
                terminal.write(chunk, () => {
                  if (atBottom) terminal.scrollToBottom();
                });
              });
            }
            // Rate-based activity detection. Idle gemini (and similar ink TUIs) emits one
            // footer repaint every ~2s as a steady heartbeat — cosmetic counter updates
            // that shouldn't flag the tab. Real model output produces many chunks per
            // second. Counting chunks per rolling 2s window cleanly separates the two.
            const _now = Date.now();
            tab._chunkTimes = (tab._chunkTimes || []).filter(t => _now - t < 2000);
            tab._chunkTimes.push(_now);
            if (tabId !== this.activeTabId && tab._inactiveSince && _now - tab._inactiveSince > 5000 && _now >= (tab._suppressUntil || 0) && tab._chunkTimes.length >= 4) {
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
            break;
          case 'ready':
            tab.sessionId = msg.sessionId;
            const sidebarItem = document.querySelector(`.session-item[data-tab-id="${tabId}"]`);
            if (sidebarItem) sidebarItem.dataset.sid = msg.sessionId;
            this.saveTabState();
            break;
          case 'title':
            tab.name = msg.title;
            this.renderTabs();
            this.updateSidebarSession(tabId, msg.title);
            // Update cached session data so sidebar re-renders use this title
            if (tab.sessionId) {
              for (const [, sessions] of this.sessionCache) {
                const s = sessions.find(s => s.id === tab.sessionId);
                if (s) { s.summary = msg.title; break; }
              }
            }
            this.saveTabState();
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
      if (tab._destroyed) return;
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
      tab._chunkTimes = [];
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
    this.saveTabState();
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    tab._destroyed = true;
    if (tab._reconnectTimer) clearTimeout(tab._reconnectTimer);
    if (tab._writeRaf) cancelAnimationFrame(tab._writeRaf);
    if (tab._resizeObserver) tab._resizeObserver.disconnect();
    try { tab.ws?.close(); } catch {}
    try { tab.terminal.dispose(); } catch {}
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
    this.saveTabState();
  }

  renderTabs() {
    const container = document.getElementById('tabs');
    container.innerHTML = '';

    for (const [id, tab] of this.tabs) {
      const el = document.createElement('div');
      el.className = `tab${id === this.activeTabId ? ' active' : ''}${tab.finished ? ' finished' : tab.unread ? ' unread' : ''}`;
      el.innerHTML = `
        <span class="tab-dot${tab.alive ? '' : ' dead'}"></span>
        <span class="badge-${tab.agent || 'claude'}" title="${tab.agent || 'claude'}"></span>
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
    const tab = this.tabs.get(tabId);
    const projectEl = [...document.querySelectorAll('.project-item')].find(
      el => el.dataset.path === projectPath
    );
    if (!projectEl || !projectEl.classList.contains('expanded')) return;

    const container = projectEl.querySelector('.project-sessions');
    const firstSession = container.querySelector('.session-item');

    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.tabId = tabId;
    item.dataset.agent = tab?.agent || 'claude';
    item.innerHTML = `
      <span class="badge-${tab?.agent || 'claude'}"></span>
      ${this.esc(this.truncate(this.lastName(projectPath), 38))}
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

    if (firstSession) firstSession.before(item);
    else container.append(item);

    // Update count
    const countEl = projectEl.querySelector('.project-count');
    if (countEl) countEl.textContent = parseInt(countEl.textContent) + 1;
  }

  updateSidebarSession(tabId, name) {
    document.querySelectorAll(`.session-item[data-tab-id="${tabId}"]`).forEach(item => {
      if (item.classList.contains('recent-session-item')) {
        // Preserve badge and project label in recent section
        const nameEl = item.querySelector('.recent-session-name');
        if (nameEl) nameEl.textContent = this.truncate(name, 28);
        const dateEl = item.querySelector('.session-date');
        if (dateEl) dateEl.textContent = 'now';
      } else {
        const agent = item.dataset.agent || 'claude';
        item.innerHTML = `
          <span class="badge-${agent}"></span>
          ${this.esc(this.truncate(name, 40))}
          <span class="session-date">now</span>
        `;
      }
    });
  }

  updateSidebarFinished(tabId, finished) {
    document.querySelectorAll(`.session-item[data-tab-id="${tabId}"]`).forEach(item => {
      item.classList.toggle('finished', finished);
    });
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

  stripAnsi(s) {
    return s
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')     // CSI sequences
      .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC (BEL-terminated)
      .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')   // DCS/SOS/PM/APC (ST-terminated)
      .replace(/\x1b[()][\s\S]/g, '')             // charset designators (e.g. ESC(B)
      .replace(/\x1b./g, '')                      // remaining 2-byte ESC seqs (7,8,=,>,M,D,c,…)
      .replace(/[\x00-\x1f]/g, '');               // stray control chars
  }
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
