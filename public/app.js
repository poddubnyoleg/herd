class Herd {
  // Rejoin the hard line-wraps TUIs emit at the terminal width so copied
  // prose pastes as real paragraphs. Heuristic, tuned to be code-safe:
  // a line is treated as soft-wrapped (joined with the next) only when it
  // physically reaches near the wrap column — code lines rarely do, so
  // they keep their newlines. Blank lines stay paragraph breaks;
  // list/box-drawing starters never join.
  // The selection's common leading indent (Claude Code pads its whole
  // transcript by 2) is stripped, preserving relative indent.
  static reflowCopiedText(text, cols = 80) {
    let lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
    if (lines.length < 2) return text;
    const nonEmpty = lines.filter(l => l);
    if (!nonEmpty.length) return text;
    const minIndent = Math.min(...nonEmpty.map(l => l.match(/^ */)[0].length));
    if (minIndent) lines = lines.map(l => l.slice(minIndent));
    const maxLen = Math.max(...lines.map(l => l.length));
    if (maxLen < 60) return lines.join('\n'); // too narrow to be wrapped prose
    // A soft-wrapped line must physically reach near the wrap column
    // (minus the TUI's own margins and ragged-right slack from long
    // words). The wrap column is NOT terminal.cols on wide windows: the
    // server caps every PTY at MAX_COLS=96 via stty, so xterm can be 140+
    // cols while content wraps at 96 — clamp, or nothing ever joins. The
    // maxLen term is a fallback for narrower content (e.g. resized since).
    const threshold = Math.max(Math.min(cols, 96) - 22, maxLen - 16);
    const noJoin = /^\s*([-*+•·●○◦‣›❯>]\s|\d+[.)]\s|[│┃┆┊┌└├┬┴┤─═║╔╚╠#])/;
    const out = [];
    let cur = null, prevLen = -1;
    for (const line of lines) {
      if (cur !== null && cur.trim() && prevLen >= threshold && line.trim() && !noJoin.test(line)) {
        cur += ' ' + line.trim();
      } else {
        if (cur !== null) out.push(cur);
        cur = line;
      }
      prevLen = line.length;
    }
    if (cur !== null) out.push(cur);
    return out.join('\n');
  }

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
    this.grokAvailable = false;
    this.live = [];
    this.host = { native: true, workspace: null }; // see /api/host
    // Diagnostic ring buffer for the unread/finished pipeline. Dump with
    // __herd.dumpLog() in the console when tabs pulse green spuriously.
    this._log = [];
    this.init();
  }

  _dbg(event, data) {
    this._log.push({ t: new Date().toISOString(), event, ...data });
    if (this._log.length > 300) this._log.splice(0, this._log.length - 300);
  }

  dumpLog() {
    return this._log.map(e => JSON.stringify(e)).join('\n');
  }

  async init() {
    // Bump when debugging client-side state issues: confirms in the console
    // which build the browser actually loaded after a fix.
    console.log('[herd] build 2026-10-03 — sessions outlive their viewer');
    this.initTheme();
    try { this.host = await (await fetch('/api/host')).json(); } catch {}
    await this.loadProjects();
    await this.loadRecentSessions();
    this.loadTokenUsage();
    this.restoreTabState();
    this.setupResize();
    this.setupSearch();
    this.setupAddProject();
    this.setupFiles();
    this.setupLocalServices();
    this.listenForSummaryUpdates();
    this.refreshLive();
    setInterval(() => this.refreshLive(), 10000);
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

    // Sleep/wake detector. System sleep freezes timers and WebSockets; on
    // wake, armed finished-timers flush at once against aged-out _chunkTimes
    // and resume replays race the fixed suppress window — both used to paint
    // every background tab green the moment the lid opened. Two signals:
    // wall-vs-monotonic clock drift (performance.now() stalls during sleep
    // on platforms where it excludes suspend), and the heartbeat firing far
    // later than any hidden-tab throttling allows (Chrome's intensive
    // throttling is one run per 60s, so a >90s gap means suspend even where
    // performance.now() keeps counting through sleep, as modern Chrome on
    // macOS does via mach_continuous_time). On wake, treat every tab like it
    // just reconnected. The check also runs on visibilitychange so a wake
    // with the page hidden is handled before the user looks at it.
    this._lastWall = Date.now();
    this._lastPerf = performance.now();
    const wakeCheck = () => {
      const wall = Date.now(), perf = performance.now();
      const wallGap = wall - this._lastWall;
      const drift = wallGap - (perf - this._lastPerf);
      if (drift > 10000 || wallGap > 90000) {
        this._dbg('wake', { wallGap, drift });
        for (const tab of this.tabs.values()) {
          tab._suppressUntil = Math.max(tab._suppressUntil || 0, wall + 30000);
          tab._sawOutput = false;
          tab._chunkTimes = [];
          if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
        }
      }
      this._lastWall = wall;
      this._lastPerf = perf;
    };
    setInterval(wakeCheck, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wakeCheck();
    });

    // xterm WebGL atlas LRU eviction can corrupt individual glyph slots in
    // long sessions — scattered wrong characters appear mid-word. A periodic
    // full clear keeps the atlas fresh; re-rasterization on next render is
    // microseconds per glyph and imperceptible.
    setInterval(() => {
      for (const [, tab] of this.tabs) {
        try { tab.terminal.clearTextureAtlas?.(); } catch {}
      }
    }, 90 * 1000);
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

    // DPR changes (browser zoom, dragging window between monitors) corrupt
    // the WebGL glyph atlas — old-DPR bitmaps get stretched into the new
    // grid. Rebind on each change since the media query references the
    // current devicePixelRatio.
    const watchDpr = () => {
      window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        .addEventListener('change', () => {
          for (const [, tab] of this.tabs) {
            try { tab.terminal.clearTextureAtlas?.(); } catch {}
          }
          watchDpr();
        }, { once: true });
    };
    watchDpr();
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
      // Old-theme glyphs remain cached in the WebGL texture atlas otherwise,
      // producing the mangled-character artifact when composited under the
      // new theme.
      try { tab.terminal.clearTextureAtlas?.(); } catch {}
    }
  }

  // ── Tab persistence ──

  // A tab is restorable by its terminal (still running server-side) or by
  // its session (resumable). A new session has only a termId for up to 5
  // minutes, until the server detects its session id.
  saveTabState() {
    const tabs = [...this.tabs.values()]
      .filter(t => t.termId || t.sessionId)
      .map(t => ({ termId: t.termId, sessionId: t.sessionId, projectPath: t.projectPath, name: t.name, agent: t.agent }));
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    localStorage.setItem('herd-tabs', JSON.stringify({
      tabs, activeTermId: active?.termId || null, activeSessionId: active?.sessionId || null,
    }));
  }

  restoreTabState() {
    try {
      const raw = localStorage.getItem('herd-tabs');
      if (!raw) return;
      const state = JSON.parse(raw);
      if (!state.tabs?.length) return;

      const activeIdx = state.tabs.findIndex(s =>
        (state.activeTermId && s.termId === state.activeTermId) ||
        (state.activeSessionId && s.sessionId === state.activeSessionId));
      // Attach the active tab first and the rest ~150ms apart: the server
      // serializes each snapshot synchronously, so a reload or wake that
      // attaches 10-15 tabs at once would block every terminal's event loop.
      // steal:false — restoring is automatic, so it never displaces another
      // window's viewer.
      let activeTabId = null, rank = 0;
      state.tabs.forEach((saved, i) => {
        const tabId = this.createTab(saved.projectPath, saved.name, saved.sessionId || null, saved.agent || 'claude', {
          termId: saved.termId || null, steal: false, connectDelay: i === activeIdx ? 0 : 150 * ++rank,
        });
        if (i === activeIdx) activeTabId = tabId;
      });
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
    if (!this.host.native && !this.host.workspace) { btn.hidden = true; return; }

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        let res;
        if (this.host.native) {
          res = await fetch('/api/pick-folder', { method: 'POST' });
        } else {
          const name = prompt(`Project folder under ${this.host.workspace}/ (created if missing):`);
          if (!name) return;
          res = await fetch('/api/create-project', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) { alert(`Could not open project: ${(await res.json().catch(() => ({}))).error || res.status}`); return; }
        }
        const data = await res.json();
        if (data.cancelled || !data.path) return;
        this.createTab(data.path, data.name);
      } catch {}
      finally { btn.disabled = false; }
    });
  }

  // ── Files (deployments: what Finder does for a local Herd) ──

  setupFiles() {
    const btn = document.getElementById('files-btn');
    if (!btn || !this.host.files) return;
    btn.hidden = false;
    btn.addEventListener('click', () => {
      const tab = this.tabs.get(this.activeTabId);
      this.showFilesPanel(tab?.projectPath || this.host.workspace);
    });
  }

  async uploadFile(dir, name, file) {
    const res = await fetch(`/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'PUT', body: file });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return (await res.json()).path;
  }

  // Pasted files — a screenshot, or files copied in Finder. Claude in the
  // container can't read this machine's clipboard, so they go to
  // <project>/uploads and their paths are typed, as dragging into iTerm does.
  async pasteFiles(e, tab) {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    // Rich copies (Excel, Numbers, Keynote) carry an image rendering beside
    // their text — that's a text paste. Finder copies carry the file names.
    const text = e.clipboardData.getData('text/plain');
    if (text && !files.every(f => text.includes(f.name))) return;
    e.preventDefault();
    e.stopPropagation();
    const now = new Date();
    const stamp = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const paths = [];
    for (const [i, f] of files.entries()) {
      const ext = (f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg');
      const name = f.name && f.name !== 'image.png' ? f.name : `paste-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`;
      try { paths.push(await this.uploadFile(tab.projectPath, `uploads/${name}`, f)); }
      catch (err) { console.warn('[herd] paste upload failed', err); }
    }
    if (paths.length) tab.terminal.paste(paths.map(p => p.replace(/([^\w@%+=:,./-])/g, '\\$1')).join(' ') + ' ');
  }

  // Browse a folder, upload through the system file dialog, download a
  // selection — several entries arrive as one .tar.gz.
  showFilesPanel(startDir) {
    document.getElementById('files-popup')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'files-popup';
    overlay.className = 'usage-overlay';
    overlay.innerHTML = `
      <div class="usage-popup files-popup">
        <div class="files-head">
          <button class="files-btn" data-act="up" title="Parent folder">&#x2191;</button>
          <span class="files-path"></span>
          <button class="files-btn" data-act="close" title="Close">&#x2715;</button>
        </div>
        <div class="files-list"></div>
        <div class="files-actions">
          <span class="files-status"></span>
          <button class="files-btn" data-act="upload">Upload files</button>
          <button class="files-btn" data-act="upload-dir">Upload folder</button>
          <button class="files-btn" data-act="download" disabled>Download</button>
        </div>
        <input type="file" multiple hidden data-input="files">
        <input type="file" webkitdirectory hidden data-input="dir">
      </div>`;
    document.body.appendChild(overlay);
    const $ = s => overlay.querySelector(s);
    const status = $('.files-status');
    const downloadBtn = $('[data-act="download"]');
    let cwd = startDir, parent = null;
    const selected = new Set();

    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
    const syncSelection = () => {
      downloadBtn.disabled = !selected.size;
      downloadBtn.textContent = selected.size > 1 ? `Download ${selected.size}` : 'Download';
      const all = $('.files-all');
      if (all) all.checked = selected.size > 0 && selected.size === overlay.querySelectorAll('.files-row input[data-path]').length;
    };
    // One path is a plain link; a selection is a form POST, since hundreds of
    // paths would overflow a URL.
    const download = paths => {
      const el = document.createElement(paths.length === 1 ? 'a' : 'form');
      if (paths.length === 1) {
        el.href = '/api/download?path=' + encodeURIComponent(paths[0]);
        el.download = '';
      } else {
        // Into a hidden frame: an error response (a vanished file, an expired
        // login) must not replace the whole page.
        let frame = document.querySelector('iframe[name="herd-download"]');
        if (!frame) {
          frame = Object.assign(document.createElement('iframe'), { name: 'herd-download', hidden: true });
          document.body.appendChild(frame);
        }
        el.target = 'herd-download';
        el.method = 'POST';
        el.action = '/api/download';
        for (const p of paths) el.append(Object.assign(document.createElement('input'), { type: 'hidden', name: 'path', value: p }));
      }
      document.body.appendChild(el);
      paths.length === 1 ? el.click() : el.submit();
      el.remove();
    };

    const load = async dir => {
      let data;
      try {
        const res = await fetch('/api/files?path=' + encodeURIComponent(dir));
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        data = await res.json();
      } catch (err) { status.textContent = `Can't open ${dir}: ${err.message}`; return; }
      cwd = data.path;
      parent = data.parent;
      selected.clear();
      $('.files-path').textContent = cwd;
      $('[data-act="up"]').disabled = !parent;
      const join = name => (cwd.endsWith('/') ? cwd : cwd + '/') + name;
      $('.files-list').innerHTML = data.entries.length ? `
        <label class="files-row files-row-head"><input type="checkbox" class="files-all"><span>Name</span><span>Size</span></label>
        ${data.entries.map(e => `
          <div class="files-row">
            <input type="checkbox" data-path="${this.esc(join(e.name))}">
            <span class="files-name${e.dir ? ' is-dir' : ''}" data-path="${this.esc(join(e.name))}" data-dir="${e.dir}">${this.esc(e.name)}${e.dir ? '/' : ''}</span>
            <span class="files-size">${e.dir ? '' : fmtSize(e.size)}</span>
          </div>`).join('')}`
        : '<div class="files-empty">Empty folder</div>';
      syncSelection();
    };

    overlay.addEventListener('change', e => {
      const t = e.target;
      if (t.classList.contains('files-all')) {
        overlay.querySelectorAll('.files-row input[data-path]').forEach(cb => {
          cb.checked = t.checked;
          t.checked ? selected.add(cb.dataset.path) : selected.delete(cb.dataset.path);
        });
      } else if (t.dataset.path) {
        t.checked ? selected.add(t.dataset.path) : selected.delete(t.dataset.path);
      } else if (t.dataset.input) {
        upload([...t.files]);
        t.value = '';
        return;
      }
      syncSelection();
    });
    overlay.addEventListener('click', e => {
      const name = e.target.closest('.files-name');
      if (name) return name.dataset.dir === 'true' ? load(name.dataset.path) : download([name.dataset.path]);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') close();
      else if (act === 'up' && parent) load(parent);
      else if (act === 'upload') $('[data-input="files"]').click();
      else if (act === 'upload-dir') $('[data-input="dir"]').click();
      else if (act === 'download' && selected.size) download([...selected]);
    });

    const upload = async files => {
      if (!files.length) return;
      const dest = cwd; // fixed for the batch: browsing on mid-upload must not move it
      let done = 0, failed = 0;
      for (const f of files) {
        status.textContent = `Uploading ${done + failed + 1}/${files.length}…`;
        try { await this.uploadFile(dest, f.webkitRelativePath || f.name, f); done++; }
        catch { failed++; }
      }
      await load(cwd);
      status.textContent = failed ? `${done} uploaded, ${failed} failed` : `${done} uploaded`;
    };

    load(cwd);
  }

  // ── Local services (llama.cpp model server, STT dictation daemon) ──

  setupLocalServices() {
    const header = document.getElementById('sidebar-header');
    if (!header) return;
    const buttons = new Map();  // id -> button element

    const getState = async (id) => {
      const list = await (await fetch('/api/local-services')).json();
      return list.find(s => s.id === id);
    };
    const render = (state) => {
      let btn = buttons.get(state.id);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'local-svc-btn';
        btn.textContent = state.icon;
        btn.addEventListener('click', () => onClick(state.id, btn));
        header.appendChild(btn);
        buttons.set(state.id, btn);
      }
      btn.hidden = !state.available;
      btn.classList.toggle('up', !!state.running);
      btn.classList.toggle('starting', !state.running && !!state.starting);
      btn.title = state.running ? `${state.label}: running — click to stop`
        : state.starting ? `${state.label}: starting…`
        : `${state.label}: stopped — click to start`;
      return btn;
    };
    // Starts can be slow (model load ~10-30s, minutes on a cold download);
    // poll until up or until the server-side grace expires
    const pollUntilUp = async (id, btn) => {
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const s = await getState(id);
          if (s.running || !s.starting) { render(s); return; }
        } catch {}
      }
      // Deadline: render the actual state once more (it may have come up at
      // the last moment) and only then show the failure hint
      btn.classList.remove('starting');
      try {
        const s = await getState(id);
        render(s);
        if (!s.running) btn.title = `${s.label}: still not up — check the service log`;
      } catch {}
    };

    const onClick = async (id, btn) => {
      if (btn.classList.contains('starting')) return;
      if (btn.classList.contains('up')) {
        const s = await getState(id).catch(() => null);
        if (!confirm((s && s.confirmStop) || 'Stop this service?')) return;
        try {
          await fetch(`/api/local-services/${id}/stop`, { method: 'POST' });
          // SIGTERM is fast for both services; give it a beat, then re-probe
          await new Promise(r => setTimeout(r, 1000));
        } catch {}
        try { render(await getState(id)); } catch {}
        return;
      }
      btn.classList.add('starting');
      try {
        const res = await fetch(`/api/local-services/${id}/start`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          btn.classList.remove('starting');
          btn.title = `Failed to start — ${data.error || 'see service log'}`;
          return;
        }
        if (data.running) { btn.classList.remove('starting'); btn.classList.add('up'); return; }
        await pollUntilUp(id, btn);
      } catch {
        btn.classList.remove('starting');
        try { render(await getState(id)); } catch {}
      }
    };

    // Initial state; if a start is already in flight (another tab, or a reload
    // mid-load), resume polling instead of showing a clickable gray button
    (async () => {
      try {
        const list = await (await fetch('/api/local-services')).json();
        for (const state of list) {
          const btn = render(state);
          if (!state.running && state.starting) pollUntilUp(state.id, btn);
        }
      } catch {}
    })();
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
      this.grokAvailable = this.projects.some(p => p.grokAvailable);
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
          ${p.exists && this.host.native ? `<button class="project-finder-btn" title="Reveal in Finder" aria-label="Reveal in Finder">&#x29C9;</button>` : ''}
          ${p.exists && this.host.files ? `<button class="project-finder-btn project-files-btn" title="Files" aria-label="Files">&#x21C5;</button>` : ''}
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
        if (btn.classList.contains('project-files-btn')) return this.showFilesPanel(p);
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
    this.applyLiveMarks();

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
      const oneM = m.includes('[1m]');
      const base = m.replace('[1m]', '').replace(/^.*\//, '').replace(/-\d{8}$/, '');
      const cap = s => s[0].toUpperCase() + s.slice(1);
      let label, match;
      if ((match = base.match(/claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?/)))
        label = `${cap(match[1])} ${match[2]}${match[3] ? '.' + match[3] : ''}`;
      else if ((match = base.match(/^(gpt-[\d.]+|o\d)(?:-(\w+))?/)))
        label = match[1].toUpperCase() + (match[2] ? ' ' + cap(match[2]) : '');
      else if ((match = base.match(/gemini-([\d.]+)-(.+)/)))
        label = `Gemini ${match[1]} ${match[2].replace(/-?preview/, '').split('-').filter(Boolean).map(cap).join(' ')}`.trim();
      else if (base.startsWith('glm'))
        label = base.toUpperCase();
      else if ((match = base.match(/^grok-([\d.]+)(?:-(.+))?/)))
        label = `Grok ${match[1]}${match[2] ? ' ' + cap(match[2]) : ''}`;
      else
        label = base;
      return label + (oneM ? ' (1M)' : '');
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
    const grokBtn = this.grokAvailable
      ? '<button class="new-session-btn new-session-grok" data-agent="grok"><span class="badge-grok"></span> grok</button>'
      : '';
    container.innerHTML = `
      ${projectExists ? `<div class="new-session-actions"><button class="new-session-btn new-session-claude" data-agent="claude"><span class="badge-claude"></span> claude</button>${codexBtn}${geminiBtn}${piBtn}${grokBtn}</div>` : ''}
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

    this.applyLiveMarks();

    // Re-apply filter to show/hide individual sessions after async load
    if (this.searchQuery) {
      clearTimeout(this._filterDebounce);
      this._filterDebounce = setTimeout(() => this.filterProjects(), 50);
    }
  }

  // ── Tabs ──

  // termId attaches to a terminal still running server-side. steal: whether
  // opening this tab may displace another window's viewer — true for every
  // user click, false for automatic restores.
  createTab(projectPath, name, resumeId, agent = 'claude', { termId = null, steal = true, connectDelay = 0 } = {}) {
    // Don't open a session or terminal twice: a second tab would attach a
    // second viewer and show "opened elsewhere" on the tab that owns it.
    if (resumeId || termId) {
      for (const [id, tab] of this.tabs) {
        if (tab.agent === agent && ((resumeId && tab.sessionId === resumeId) || (termId && tab.termId === termId))) {
          this.switchTab(id);
          return id;
        }
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
    // Inline images (sixel + iTerm2 IIP). The vendored addon is a locally
    // patched build ("HERD PATCH (DPR)" in the source): bitmaps are decoded
    // and drawn at device resolution so images stay crisp on retina.
    // storageLimit is per-terminal MB of decoded pixels — device-res costs
    // 4x on 2x displays, so keep the addon default rather than trimming it.
    try { terminal.loadAddon(new ImageAddon.ImageAddon({ storageLimit: 128 })); } catch {}
    // IMPORTANT: terminal.open() is deferred until AFTER switchTab makes the
    // wrapper visible. xterm's CharSizeService measures the font against a
    // DOM element at open time — if the wrapper is display:none then, it
    // caches cell width/height = 0 and fitAddon.proposeDimensions() returns
    // undefined forever, so the PTY stays at xterm's 80x24 default.

    const tab = {
      id: tabId, name: name || 'new session', terminal, fitAddon, ws: null,
      projectPath, sessionId: resumeId, termId, agent, alive: true, unread: false,
      finished: false, idleTimer: null, outputSinceViewed: 0,
      _closeRequested: 0, _inactiveSince: 0,
      _writeBuf: '', _writeRaf: 0,
      _chunkTimes: [], _scrolled: false, _lineWatermark: undefined,
      _resizeObserver: null, _suppressUntil: 0, _sawOutput: false,
      _awaitingInput: true,
      _steal: steal, _holdsSlot: false, _busy: false, _yielded: false,
      // Identifies this tab's viewer to the server: its own reconnect may
      // replace its previous socket (a ghost after lid close) without
      // counting as another window. Per tab, not per page — two tabs on one
      // terminal must not silently replace each other back and forth.
      clientId: crypto.randomUUID(),
    };
    this.tabs.set(tabId, tab);
    if (this.host.files) wrapper.addEventListener('paste', e => this.pasteFiles(e, tab), true);

    // Buffer-scroll = content growth even at the scrollback cap, where the
    // cursor-line watermark stops moving. Feeds trackTabActivity.
    terminal.onScroll(() => { tab._scrolled = true; });
    // Reflow after a resize shifts absolute line numbers; re-baseline.
    terminal.onResize(() => { tab._lineWatermark = undefined; });

    // macOS keyboard navigation: Option+Arrow for word jump, Cmd+Arrow for line jump
    terminal.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true;
      // Cmd+C with a selection: copy with prose reflow. TUIs (Claude Code
      // et al.) hard-wrap prose at the terminal width, so the buffer holds
      // real newlines xterm can't distinguish from intentional ones —
      // pasted paragraphs break mid-sentence. Reflow joins those wraps
      // back into paragraphs; Option+Cmd+C copies the selection verbatim.
      // e.code, not e.key: Option+C produces key='ç' on macOS.
      // navigator.clipboard only exists in secure contexts (localhost or
      // https) — served plain-http from a remote HOST, fall through to the
      // browser's default (raw) copy rather than break Cmd+C entirely.
      if (e.metaKey && !e.ctrlKey && e.code === 'KeyC' && terminal.hasSelection() && navigator.clipboard) {
        e.preventDefault();
        const raw = terminal.getSelection();
        const text = e.altKey ? raw : Herd.reflowCopiedText(raw, terminal.cols);
        navigator.clipboard.writeText(text).catch(() => {});
        return false;
      }
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
      // First keystroke since (re)connect: only now can this session start
      // real work, so only now may it later earn the green finished pulse.
      // onData also carries data the user never typed — focus reports
      // (\x1b[I, \x1b[O: apps like claude enable DECSET 1004, so merely
      // clicking into or away from a tab fires these), mouse reports, and
      // xterm's automatic replies to the app's status queries (cursor
      // position etc.). All of it is ESC-prefixed; real engagement is
      // printable keys, Enter, or a bracketed paste.
      if ((!data.startsWith('\x1b') || data.startsWith('\x1b[200~')) && tab._awaitingInput) {
        tab._awaitingInput = false;
        this._dbg('input-gate-cleared', { tab: tab.id, name: tab.name });
      }
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
      // A tab restored in the background (restoreTabState opens several
      // at once and only the active one is displayed) reaches this frame
      // with a display:none wrapper. xterm measures its cell size against
      // the DOM at open() and the fit addon bails while that size is 0, so
      // such a tab used to connect at xterm's 80x24 default: `--resume`
      // replayed at 80 columns and the terminal sat in the top-left corner
      // of the pane. Give the wrapper layout — but no pixels — for the
      // duration of this callback so the measurement and the fit are real.
      const hidden = wrapper.getClientRects().length === 0;
      if (hidden) wrapper.classList.add('measuring');
      terminal.open(wrapper);

      // GPU-accelerated rendering via WebGL (major FPS improvement).
      // On context loss, re-install on the next frame — otherwise the
      // terminal silently falls back to the DOM renderer for the rest of
      // the session.
      const installWebgl = () => {
        try {
          const webglAddon = new WebglAddon.WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
            requestAnimationFrame(installWebgl);
          });
          terminal.loadAddon(webglAddon);
        } catch {}
      };
      installWebgl();

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

      // Option/Alt+click to reposition the input cursor (iTerm2-style). A
      // terminal exposes no editable buffer to the browser, so we emulate it:
      // translate the click into the matching number of Left/Right arrow
      // keystrokes sent to the PTY. Only correct on the cursor's own visual
      // row (a single unwrapped line — shell prompt or single-line input);
      // vertical moves would map to history nav, so we bail off-row. Capture
      // phase + stopPropagation so xterm's own selection doesn't also fire.
      const screenEl = wrapper.querySelector('.xterm-screen');
      if (terminal.element && screenEl) {
        terminal.element.addEventListener('mousedown', e => {
          if (!e.altKey || e.button !== 0) return;
          const buf = terminal.buffer.active;
          const rect = screenEl.getBoundingClientRect();
          const cellW = rect.width / terminal.cols;
          const cellH = rect.height / terminal.rows;
          if (!cellW || !cellH) return;
          const clickRow = Math.floor((e.clientY - rect.top) / cellH);
          const clickCol = Math.floor((e.clientX - rect.left) / cellW);
          // cursorY is relative to baseY; map it into the visible viewport.
          const cursorRow = buf.baseY + buf.cursorY - buf.viewportY;
          if (clickRow !== cursorRow) return;
          const delta = clickCol - buf.cursorX;
          if (delta !== 0 && tab.ws?.readyState === WebSocket.OPEN) {
            const seq = delta > 0 ? '\x1b[C' : '\x1b[D';
            tab.ws.send(JSON.stringify({ type: 'input', data: seq.repeat(Math.abs(delta)) }));
          }
          e.preventDefault();
          e.stopPropagation();
          terminal.focus();
        }, { capture: true });
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
      if (hidden) wrapper.classList.remove('measuring');
      if (connectDelay) {
        setTimeout(() => { if (!tab._destroyed) this.connectWebSocket(tab); }, connectDelay);
      } else {
        this.connectWebSocket(tab);
      }
      if (this.activeTabId === tabId) terminal.focus();
    });
    return tabId;
  }

  // F2: WebSocket connection (extracted for reconnection support). The
  // socket is a viewer of a server-owned terminal: the server attaches it to
  // the running terminal (`attached` + `snapshot`) or spawns one (`ready`).
  connectWebSocket(tab) {
    const { id: tabId, terminal, fitAddon, projectPath } = tab;

    const wsUrl = new URL(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    wsUrl.searchParams.set('project', projectPath);
    wsUrl.searchParams.set('agent', tab.agent || 'claude');
    if (tab.termId) wsUrl.searchParams.set('attach', tab.termId);
    if (tab.sessionId) wsUrl.searchParams.set('resume', tab.sessionId);
    wsUrl.searchParams.set('client', tab.clientId);
    // One-shot: only the explicit action that opened this connection may
    // displace another window's viewer. Reconnects never do.
    wsUrl.searchParams.set('steal', tab._steal ? '1' : '0');
    tab._steal = false;
    wsUrl.searchParams.set('cols', terminal.cols);
    wsUrl.searchParams.set('rows', terminal.rows);

    const ws = new WebSocket(wsUrl);
    tab.ws = ws;
    tab.alive = true;

    // The first `ready` (spawned) or `attached` (reattached) reply: this page
    // now holds the terminal's viewer slot.
    let established = false;
    const establish = () => {
      established = true;
      tab._reconnectAttempt = 0;
      tab._holdsSlot = true;
      tab._busy = false;
      tab._yielded = false;
      this.hideTakeover(tab);
      // Clear any stale finished-tracking from the prior connection
      if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
      tab.outputSinceViewed = 0;
      tab._scrolled = false;
      requestAnimationFrame(() => { fitAddon.fit(); terminal.scrollToBottom(); });
      this.renderTabs();
    };
    const setSessionId = sessionId => {
      if (!sessionId) return;
      tab.sessionId = sessionId;
      const sidebarItem = document.querySelector(`.session-item[data-tab-id="${tabId}"]`);
      if (sidebarItem) sidebarItem.dataset.sid = sessionId;
    };

    ws.onopen = () => {
      if (tab.ws !== ws) return;
      this._dbg('ws-open', { tab: tabId, name: tab.name });
      // Remove the loading overlay
      const overlay = document.getElementById(`term-${tabId}`)?.querySelector('.terminal-overlay');
      if (overlay) overlay.remove();
    };

    ws.onmessage = e => {
      // A replaced socket (take over, reconnect) may still deliver frames.
      if (tab.ws !== ws) return;
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'output':
            // While a suppress window is active, keep sliding it forward as
            // long as output is streaming. `claude --resume` replay bursts can
            // easily outlast the initial 15s window on long sessions; without
            // this, the tail of the replay flips every restored background
            // tab to "finished" (green pulse) a few seconds after refresh.
            // The FIRST burst after a (re)connect or wake is always resume
            // replay / startup noise, so it opens the window unconditionally:
            // when many tabs respawn `claude --resume` at once (page refresh,
            // laptop wake), a slow spawn can push the replay past the fixed
            // 15s window, and its tail used to read as work-then-quiet.
            if (!tab._sawOutput) {
              tab._sawOutput = true;
              tab._suppressUntil = Math.max(tab._suppressUntil || 0, Date.now() + 3000);
            } else if (tab._suppressUntil && Date.now() < tab._suppressUntil) {
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
                // onScroll also fires on viewport scrolls (user scrolling,
                // scrollToBottom), not just buffer growth. Reset the flag
                // before the write and consume it before scrolling, so only
                // scrolls caused by this write's content count as growth.
                tab._scrolled = false;
                terminal.write(chunk, () => {
                  this.trackTabActivity(tabId, tab, terminal);
                  if (atBottom) terminal.scrollToBottom();
                });
              });
            }
            // Incoming-chunk rate (rolling 2s window): the activity signal for
            // alt-screen TUIs and the "still working" test before the green
            // finished pulse — see trackTabActivity / armFinishedTimer.
            const _now = Date.now();
            tab._chunkTimes = tab._chunkTimes.filter(t => _now - t < 2000);
            tab._chunkTimes.push(_now);
            tab._lastChunkAt = _now;
            break;
          case 'ready':
            // Sent at spawn, and again when the session id is detected (up to
            // 5 minutes later) — only the first one, before any output, may
            // reset the activity gates, or it would re-arm the input gate
            // after the user had typed.
            if (!established) {
              establish();
              // Suppress finished/unread tracking for 15s after a spawn. When
              // it is `--resume` (the terminal was gone, e.g. after a server
              // restart), the agent replays session history as a burst of
              // output — indistinguishable from a real completed run (output,
              // then quiet), which used to mark every restored background tab
              // with the green "finished" pulse.
              tab._suppressUntil = Date.now() + 15000;
              tab._sawOutput = false;
              // A spawned session is brand new or resumed, and sits at a
              // prompt: it cannot be doing work, so nothing it prints — replay,
              // MCP banners, trailing startup hints, error dumps — is ever
              // "work finished". The green pulse stays disabled until the user
              // actually types into this tab (terminal.onData clears the flag).
              tab._awaitingInput = true;
              this._dbg('spawned', { tab: tabId, name: tab.name });
            }
            if (msg.termId) tab.termId = msg.termId;
            setSessionId(msg.sessionId);
            this.saveTabState();
            break;
          case 'attached': {
            // Reattached to a terminal that kept running server-side; the
            // `snapshot` that follows restores its screen and scrollback.
            establish();
            tab.termId = msg.termId;
            setSessionId(msg.sessionId);
            if (msg.title && msg.title !== tab.name) {
              tab.name = msg.title;
              this.updateSidebarSession(tabId, msg.title);
            }
            // Turn state, from the server's view of the output (heuristics
            // until hooks report turns):
            // - working: a turn is in flight; normal tracking takes over and
            //   the tab goes green when it finishes.
            // - grew while detached, now quiet: the turn finished while nobody
            //   was watching — a background tab is green right away.
            // - neither: the session sat idle; gate on typing, as after a
            //   spawn.
            // Not working: mute the first burst (the agent's SIGWINCH redraw
            // if the size changed). Working: no mute — the window slides while
            // output streams, so it would swallow the whole turn.
            const background = tabId !== this.activeTabId;
            if (msg.working) {
              tab._awaitingInput = false;
              tab._suppressUntil = 0;
              tab._sawOutput = true;
              // The turn may end inside the snapshot, with no output after
              // it to drive trackTabActivity; the timer still sees it go quiet.
              if (background) this.armFinishedTimer(tabId, tab);
            } else {
              tab._suppressUntil = Math.max(tab._suppressUntil || 0, Date.now() + 3000);
              tab._sawOutput = false;
              tab._awaitingInput = !msg.grewWhileDetached;
              if (msg.grewWhileDetached && background) {
                tab.finished = true;
                tab.unread = false;
                this.updateSidebarFinished(tabId, true);
              }
            }
            this._dbg('attached', {
              tab: tabId, name: tab.name, working: !!msg.working,
              grewWhileDetached: !!msg.grewWhileDetached, background,
            });
            this.renderTabs();
            this.saveTabState();
            break;
          }
          case 'snapshot':
            // Pending rAF output is from before the disconnect (the rAF batch
            // freezes in hidden pages) and would land on top of the restored
            // screen. RIS goes in-stream rather than terminal.reset(), so
            // anything xterm still has queued is parsed first, then wiped.
            if (tab._writeRaf) { cancelAnimationFrame(tab._writeRaf); tab._writeRaf = 0; }
            tab._writeBuf = '';
            // Bypasses trackTabActivity: restored content is not new output.
            terminal.write('\x1bc' + msg.data, () => {
              tab._lineWatermark = undefined;
              tab._scrolled = false;
              terminal.scrollToBottom();
              this.syncViewport(terminal);
            });
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
          case 'busy':
            // Another window is viewing this terminal. Don't take it: retry
            // quietly (onclose) and attach once it leaves, or on a click.
            // Retries name the terminal, so if it is killed meanwhile the
            // server answers session-gone instead of resuming the session.
            if (msg.termId) tab.termId = msg.termId;
            tab.alive = false;
            tab._busy = true;
            tab._holdsSlot = false;
            tab._yielded = true;
            this.showTakeover(tab, 'Open in another window');
            this._dbg('busy', { tab: tabId, name: tab.name });
            this.renderTabs();
            break;
          case 'detached':
            // Another window took this terminal over (opened-elsewhere).
            // alive=false: no auto-reconnect, which would take it back.
            tab.alive = false;
            tab._holdsSlot = false;
            tab._yielded = true;
            this.showTakeover(tab, 'Opened in another window');
            this._dbg('detached', { tab: tabId, name: tab.name, reason: msg.reason });
            this.renderTabs();
            break;
          case 'exit':
            tab.alive = false;
            tab.termId = null;
            tab._holdsSlot = false;
            terminal.write('\r\n\x1b[38;5;240m[shell exited]\x1b[0m\r\n');
            this._dbg('exit-msg', { tab: tabId, name: tab.name, awaitingInput: tab._awaitingInput });
            // Only pulse green if the user engaged this session since its
            // last (re)connect — a resumed-but-untouched tab dying at startup
            // isn't finished work. The dead dot already shows it exited.
            if (tabId !== this.activeTabId && !tab._awaitingInput) {
              tab.finished = true;
              tab.unread = false;
              this.updateSidebarFinished(tabId, true);
            }
            this.renderTabs();
            this.saveTabState();
            break;
          case 'error':
            terminal.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
            // A new session whose terminal is gone (server restart) before
            // its id was detected: nothing to resume. Mark the tab dead and
            // stop restoring it.
            if (msg.code === 'session-gone') {
              tab.alive = false;
              tab.termId = null;
              tab._holdsSlot = false;
              tab._busy = false;
              this.hideTakeover(tab);
              this.renderTabs();
              this.saveTabState();
            }
            break;
        }
      } catch {}
    };

    ws.onclose = () => {
      if (tab._destroyed || tab.ws !== ws) return;
      this._dbg('ws-close', { tab: tabId, name: tab.name, alive: tab.alive, busy: tab._busy });
      if (tab._busy) {
        if (tab.termId || tab.sessionId) this.scheduleReconnect(tab, { quiet: true });
        return;
      }
      if (tab.alive) {
        tab.alive = false;
        terminal.write('\r\n\x1b[38;5;240m[disconnected]\x1b[0m\r\n');
        this.renderTabs();

        // F2: Auto-reconnect: reattach to the running terminal, or resume
        // the session if the terminal is gone
        if (tab.termId || tab.sessionId) {
          this.scheduleReconnect(tab);
        }
      }
    };

  }

  // F2: Reconnection with exponential backoff. The attempt counter lives on
  // the tab (reset when a connection is established) — passing it
  // positionally meant every onclose restarted the sequence at attempt 0,
  // i.e. a permanent ~1s retry loop while the server was down. Each failed
  // attempt fires its own onclose, which calls back into here, so no separate
  // "still disconnected?" poll is needed. quiet: retries while another window
  // holds the terminal, behind the take-over overlay.
  scheduleReconnect(tab, { quiet = false } = {}) {
    if (tab._destroyed) return;
    if (tab._reconnectTimer) clearTimeout(tab._reconnectTimer);
    const attempt = tab._reconnectAttempt || 0;
    tab._reconnectAttempt = attempt + 1;
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    tab._reconnectTimer = setTimeout(() => {
      tab._reconnectTimer = null;
      if (tab._destroyed) return;
      if (!quiet) tab.terminal.write(`\r\n\x1b[38;5;240m[reconnecting...]\x1b[0m\r\n`);
      this.connectWebSocket(tab);
    }, delay);
  }

  // Overlay on a tab whose terminal another window holds; a click takes it
  // over (steal=1), which is the only way this page displaces that viewer.
  showTakeover(tab, text) {
    const wrapper = document.getElementById(`term-${tab.id}`);
    if (!wrapper) return;
    let el = wrapper.querySelector('.terminal-takeover');
    if (!el) {
      el = document.createElement('div');
      el.className = 'terminal-takeover';
      el.addEventListener('click', () => this.takeOver(tab));
      wrapper.appendChild(el);
    }
    el.textContent = `${text}. Click to take over.`;
  }

  hideTakeover(tab) {
    document.getElementById(`term-${tab.id}`)?.querySelector('.terminal-takeover')?.remove();
  }

  takeOver(tab) {
    if (tab._destroyed) return;
    if (tab._reconnectTimer) { clearTimeout(tab._reconnectTimer); tab._reconnectTimer = null; }
    tab._busy = false;
    tab._reconnectAttempt = 0;
    tab._steal = true;
    this.connectWebSocket(tab);
  }

  // Unread/finished detection, run after each batched write completes (buffer
  // state is only current then). "Unread" means content actually grew: the
  // absolute cursor line passed its high-water mark, or the buffer scrolled
  // (covers the scrollback cap, where baseY stops moving). In-place repaints —
  // gemini's ~2s idle footer heartbeat, Claude Code's spinner and live agent
  // counters — rewrite the same rows without growth, so they don't flag the
  // tab. Alt-screen TUIs (codex) repaint full-screen in place and have no
  // growth signal; for them the chunk-rate heuristic (≥4 chunks per rolling
  // 2s ≈ real output) remains.
  trackTabActivity(tabId, tab, terminal) {
    const buf = terminal.buffer.active;
    const now = Date.now();
    let grew;
    if (buf.type === 'alternate') {
      grew = tab._chunkTimes.filter(t => now - t < 2000).length >= 4;
    } else {
      const line = buf.baseY + buf.cursorY;
      grew = tab._scrolled || (tab._lineWatermark !== undefined && line > tab._lineWatermark);
      tab._scrolled = false;
      if (tab._lineWatermark === undefined || line > tab._lineWatermark) tab._lineWatermark = line;
    }
    if (!grew || now < (tab._suppressUntil || 0)) return;
    if (tabId === this.activeTabId || !tab._inactiveSince || now - tab._inactiveSince < 5000) return;
    // Until the user engages the session (types) after a (re)connect, nothing
    // it prints is signal: no unread accent, no green pulse. Post-resume the
    // session sits at a prompt, so its output is replay tails, banners, or
    // startup noise — and a green earned before the reconnect stays visible
    // (its result is still unseen) instead of being demoted to unread.
    if (tab._awaitingInput) return;
    if (tab.finished) {
      tab.finished = false;
      this.updateSidebarFinished(tabId, false);
      this.renderTabs();
    }
    // Writes are rAF-batched and rAF freezes while the page is hidden, so
    // a run that ended during that time is only processed on return. If
    // the flushed chunk is already stale, the session has long gone quiet:
    // mark finished now, so the user comes back to tabs already green
    // instead of watching them all flash in sync 5 seconds later.
    if (now - (tab._lastChunkAt || 0) > 5000) {
      this._dbg('finished-set', {
        tab: tabId, name: tab.name, cause: 'stale-on-return',
        sinceLastChunk: now - (tab._lastChunkAt || 0),
      });
      tab.finished = true;
      tab.unread = false;
      this.renderTabs();
      this.updateSidebarFinished(tabId, true);
      return;
    }
    this.armFinishedTimer(tabId, tab);
    if (!tab.unread) {
      tab.unread = true;
      this.renderTabs();
    }
  }

  // The green "finished" pulse means done, not paused: it fires only after
  // content growth stops AND the TUI goes quiet. A session that is still
  // working keeps its spinner animating — many repaints per 2s even with no
  // new content lines (e.g. Claude Code waiting on background agents) — so
  // keep re-arming until the repaints stop too.
  armFinishedTimer(tabId, tab) {
    if (tab.idleTimer) clearTimeout(tab.idleTimer);
    const armedAt = Date.now();
    tab.idleTimer = setTimeout(() => {
      tab.idleTimer = null;
      if (tab._destroyed || tabId === this.activeTabId || tab.finished) return;
      const now = Date.now();
      // Fired way past its 5s deadline: the machine slept (lid close) or the
      // browser throttled a hidden tab. Every _chunkTimes entry has aged out
      // during the gap, so the quiet-check below would false-positive and
      // paint all working tabs green at once. Re-arm and judge on fresh data.
      // Same while a post-(re)connect suppress window is active: resume
      // replay is muted, so quiet ≠ done.
      if (now - armedAt > 7000 || now < (tab._suppressUntil || 0)) {
        this.armFinishedTimer(tabId, tab);
        return;
      }
      if (tab._chunkTimes.filter(t => now - t < 2000).length >= 4) {
        this.armFinishedTimer(tabId, tab);
        return;
      }
      this._dbg('finished-set', {
        tab: tabId, name: tab.name, cause: 'idle-timer',
        lateMs: now - armedAt - 5000,
        sinceLastChunk: tab._chunkTimes.length ? now - tab._chunkTimes[tab._chunkTimes.length - 1] : -1,
      });
      tab.finished = true;
      tab.unread = false;
      this.renderTabs();
      this.updateSidebarFinished(tabId, true);
    }, 5000);
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
      requestAnimationFrame(() => {
        this.fitTab(tab);
        tab.terminal.scrollToBottom();
        this.syncViewport(tab.terminal);
        tab.terminal.focus();
      });
    }
    this.renderTabs();
    // F8: Highlight active project in sidebar
    this.highlightActiveProject();
    this.saveTabState();
  }

  // Fit a tab that has just been made visible. If xterm still has no cell
  // size (it was opened hidden and re-measures only from an
  // IntersectionObserver task that may land after this frame), fit() is a
  // silent no-op — retry over the next frames until the measurement exists.
  fitTab(tab, tries = 10) {
    if (tab._destroyed) return;
    try { tab.fitAddon.fit(); } catch {}
    if (tries > 0 && tab.fitAddon.proposeDimensions() === undefined) {
      requestAnimationFrame(() => this.fitTab(tab, tries - 1));
    }
  }

  // Re-sync xterm's DOM scrollbar with its buffer after the wrapper was
  // display:none. Output written to a hidden tab still refreshes the
  // viewport, but it measures a 0px viewport (so the scroll area comes out
  // one screen short) and its scrollTop assignment is dropped by the
  // browser — the thumb stays wherever it was (at the top, for a tab opened
  // hidden) while the buffer is at the bottom. xterm only re-syncs on a
  // resize or a buffer scroll, and a restored tab does neither when shown:
  // it was fit at open, and scrollToBottom is a no-op at the bottom. So the
  // first scrollbar or wheel movement mapped a near-zero scrollTop to a row
  // near the start of the session, and scrolling up had nowhere to go.
  // Private API: xterm is vendored and pinned, and the public scroll calls
  // would fire onScroll into the tab-activity tracking.
  syncViewport(terminal) {
    try { terminal._core?.viewport?.syncScrollArea(true); } catch {}
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    tab._destroyed = true;
    if (tab._reconnectTimer) clearTimeout(tab._reconnectTimer);
    if (tab.idleTimer) clearTimeout(tab.idleTimer);
    if (tab._writeRaf) cancelAnimationFrame(tab._writeRaf);
    if (tab._resizeObserver) tab._resizeObserver.disconnect();
    this.killTerminal(tab);
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

  // ✕ kills the terminal; only unintended disconnects (reload, lid close,
  // network loss) leave it running. A close code arrives atomically with the
  // close itself, so it cannot be lost or reordered like a separate message.
  // After `busy` or `opened-elsewhere`, another window is using the session:
  // close the tab locally only.
  killTerminal(tab) {
    const ws = tab.ws;
    if (tab._yielded) {
      try { ws?.close(); } catch {}
      return;
    }
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.close(4001, 'closed'); } catch {}
    } else if (ws?.readyState === WebSocket.CONNECTING) {
      // The server may spawn or attach before it sees this page leave
      ws.onmessage = null;
      ws.onopen = () => { try { ws.close(4001, 'closed'); } catch {} };
    } else if (tab.termId) {
      // No socket: in reconnect backoff, or a restored tab still waiting for
      // its staggered connect. Kill over HTTP — the server refuses if another
      // window is viewing it (it may have attached during the backoff).
      fetch(`/api/live/${tab.termId}?client=${tab.clientId}`, { method: 'DELETE' }).catch(() => {});
    }
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
        this.createTab(projectPath, item.textContent.trim(), item.dataset.sid, item.dataset.agent || 'claude');
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

  // ── Running terminals (server-side, with or without a viewer) ──

  async refreshLive() {
    try {
      const res = await fetch('/api/live');
      if (!res.ok) return;
      this.live = await res.json();
    } catch { return; }
    this.applyLiveMarks();
  }

  // Sessions running server-side get a "running" mark and a kill action.
  // Terminals whose session id is not detected yet are listed as "running
  // (unnamed)" under their (expanded) project and attach by termId.
  applyLiveMarks() {
    const running = new Map(this.live.filter(t => t.sessionId).map(t => [`${t.agent}:${t.sessionId}`, t]));
    document.querySelectorAll('.session-item[data-sid]').forEach(el => {
      const t = running.get(`${el.dataset.agent || 'claude'}:${el.dataset.sid}`);
      el.classList.toggle('running', !!t);
      this.setKillButton(el, t);
    });
    document.querySelectorAll('.live-unnamed').forEach(el => el.remove());
    const openTermIds = new Set([...this.tabs.values()].map(t => t.termId).filter(Boolean));
    for (const t of this.live) {
      if (t.sessionId || openTermIds.has(t.termId)) continue;
      const projectEl = [...document.querySelectorAll('.project-item:not(.recent-section)')]
        .find(el => el.dataset.path === t.project);
      if (!projectEl?.classList.contains('expanded')) continue;
      const container = projectEl.querySelector('.project-sessions');
      const name = t.title || 'running (unnamed)';
      const item = document.createElement('div');
      item.className = 'session-item live-unnamed running';
      item.dataset.agent = t.agent;
      item.innerHTML = `<span class="badge-${t.agent}"></span>${this.esc(this.truncate(name, 38))}`;
      item.addEventListener('click', e => {
        e.stopPropagation();
        this.createTab(t.project, name, null, t.agent, { termId: t.termId });
      });
      this.setKillButton(item, t);
      const first = container.querySelector('.session-item');
      if (first) first.before(item);
      else container.append(item);
    }
  }

  setKillButton(el, t) {
    let btn = el.querySelector('.session-kill');
    if (!t) { btn?.remove(); return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'session-kill';
      btn.title = 'Stop this running session';
      btn.setAttribute('aria-label', 'Stop this running session');
      btn.textContent = '\u00d7';
      el.appendChild(btn);
    }
    btn.onclick = async e => {
      e.stopPropagation();
      if (!confirm('Stop this running session?')) return;
      try { await fetch(`/api/live/${t.termId}`, { method: 'DELETE' }); } catch {}
      setTimeout(() => this.refreshLive(), 500);
    };
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

// Behind HERD_PASSWORD an expired cookie turns every API call into a 401;
// send the page back to the login form instead of failing silently.
{
  const fetch0 = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await fetch0(...args);
    if (res.status === 401) location.href = '/login';
    return res;
  };
}

window.__herd = new Herd();
