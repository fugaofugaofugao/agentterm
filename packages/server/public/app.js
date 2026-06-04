(function() {
  let token = localStorage.getItem('agentterm_token');
  let currentWs = null;
  let terminal = null;
  let fitAddon = null;
  let pingInterval = null;
  let resizeHandler = null;
  let viewportHandler = null;
  let writeQueue = [];
  let writing = false;
  let clearingTerminal = false;
  let writeGeneration = 0;
  let terminalUsesRemoteSize = false;
  let waitingForRemoteSize = false;
  let initialResizeSent = false;
  let resizeRole = 'observer';
  let knownRevision = 0;
  let clientId = '';
  let resizeTimer = null;
  let lastSentSize = '';

  var $ = function(s) { return document.querySelector(s); };

  function showPage(id) {
    document.querySelectorAll('.page').forEach(function(p) { p.classList.add('hidden'); });
    $(id).classList.remove('hidden');
    if (id === '#terminal-page' && fitAddon && !terminalUsesRemoteSize) {
      requestAnimationFrame(function() { if (!terminalUsesRemoteSize) fitAddon.fit(); });
    }
  }

  // --- Init ---
  async function init() {
    if (token) { loadSessions(); } else { showPage('#login-page'); }
  }

  // --- Login ---
  $('#login-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var username = $('#username').value;
    var password = $('#password').value;
    try {
      var res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      var data = await res.json();
      if (!res.ok) { $('#login-error').textContent = data.error || 'Login failed'; return; }
      token = data.token;
      localStorage.setItem('agentterm_token', token);
      loadSessions();
    } catch(err) { $('#login-error').textContent = 'Network error'; }
  });

  $('#logout-btn').addEventListener('click', function() {
    token = null;
    localStorage.removeItem('agentterm_token');
    showPage('#login-page');
  });

  // --- Sessions ---
  async function loadSessions() {
    showPage('#sessions-page');
    var refreshBtn = $('#refresh-btn');
    if (refreshBtn) { refreshBtn.classList.add('spinning'); refreshBtn.disabled = true; }
    try {
      var res = await fetch('/api/sessions', { headers: { 'Authorization': 'Bearer ' + token } });
      if (res.status === 401) { token = null; localStorage.removeItem('agentterm_token'); showPage('#login-page'); return; }
      var data = await res.json();
      renderSessions(data.sessions || []);
    } catch(err) { $('#session-list').innerHTML = '<p class="empty-hint">Unable to load sessions</p>'; }
    finally { if (refreshBtn) setTimeout(function(){ refreshBtn.classList.remove('spinning'); refreshBtn.disabled = false; }, 300); }
  }

  function renderSessions(sessions) {
    var list = $('#session-list');
    if (sessions.length === 0) {
      list.innerHTML = '<p class="empty-hint">No sessions available. Create sessions from Electron app.</p>';
      return;
    }

    var grouped = {};
    sessions.forEach(function(s) {
      var key = s.device ? (s.device.id || 'unknown') : 'host';
      if (!grouped[key]) grouped[key] = { device: s.device, sessions: [] };
      grouped[key].sessions.push(s);
    });

    var html = '';
    Object.keys(grouped).forEach(function(key) {
      var group = grouped[key];
      var dev = group.device;
      var icon = dev && dev.type === 'client' ? '&#x1F4BB;' : '&#x1F5A5;';
      var label = dev ? dev.name : 'Local';
      var badge = dev ? (dev.type === 'host' ? 'HOST' : 'CLIENT') : 'HOST';
      var badgeClass = dev && dev.type === 'client' ? 'device-badge-client' : 'device-badge-host';

      html += '<div class="device-group">';
      html += '<div class="device-header">' + icon + ' <span class="device-name">' + escapeHtml(label) + '</span> <span class="device-badge ' + badgeClass + '">' + badge + '</span></div>';

      group.sessions.forEach(function(s) {
        var n = escapeHtml(s.name);
        var deviceId = dev ? dev.id : '';
        html += '<div class="session-item" data-name="' + n + '" data-device-id="' + escapeHtml(deviceId) + '">';
        html += '<div class="session-left"><div class="session-name">' + n + '</div>';
        html += '<div class="session-meta">' + s.windows + ' window' + (s.windows !== 1 ? 's' : '') + '</div></div>';
        if (s.attached) html += '<span class="session-badge">LIVE</span>';
        html += '<button class="session-reset-btn" title="Reset session" data-name="' + n + '" data-device-id="' + escapeHtml(deviceId) + '">&#x21bb;</button>';
        html += '<span class="session-arrow">&#x203A;</span></div>';
      });

      html += '</div>';
    });

    list.innerHTML = html;

    list.querySelectorAll('.session-item').forEach(function(el) {
      el.addEventListener('click', function() {
        openTerminal(el.dataset.name, el.dataset.deviceId || null);
      });
    });
    list.querySelectorAll('.session-reset-btn').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.preventDefault(); e.stopPropagation();
        await resetSession(btn.dataset.name, btn.dataset.deviceId || null, btn);
      });
    });
  }

  async function resetSession(name, deviceId, button) {
    if (!name) return;
    var oldText = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = '...'; }
    try {
      var res = await fetch('/api/sessions/' + encodeURIComponent(name) + '/reset', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId || null })
      });
      if (!res.ok) {
        var data = await res.json().catch(function(){ return {}; });
        alert(data.error || data.message || 'Reset failed');
      }
      await loadSessions();
    } catch(err) { alert('Reset failed'); }
    finally { if (button) { button.disabled = false; button.textContent = oldText || '\u21bb'; } }
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  $('#refresh-btn').addEventListener('click', loadSessions);

  // --- Settings ---
  $('#settings-btn').addEventListener('click', async function() {
    showPage('#settings-page');
    try {
      var res = await fetch('/api/config', { headers: { 'Authorization': 'Bearer ' + token } });
      if (!res.ok) return;
      var cfg = await res.json();
      $('#cfg-host').value = cfg.server.host || '';
      $('#cfg-port').value = cfg.server.port || '';
      $('#cfg-shell').value = cfg.tmux.default_shell || '';
      $('#cfg-prefix').value = cfg.tmux.session_prefix || '';
      $('#cfg-password').value = '';
      $('#cfg-server-key').value = cfg.auth.server_key || '';
      $('#settings-msg').textContent = '';
    } catch(err) {}
  });

  $('#copy-key-btn').addEventListener('click', function() {
    var keyInput = $('#cfg-server-key');
    navigator.clipboard.writeText(keyInput.value).then(function() {
      var btn = $('#copy-key-btn');
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
    });
  });

  $('#settings-back-btn').addEventListener('click', function() { loadSessions(); });

  $('#settings-save-btn').addEventListener('click', async function() {
    var updates = {
      server: { host: $('#cfg-host').value, port: parseInt($('#cfg-port').value) || 39488 },
      tmux: { default_shell: $('#cfg-shell').value, session_prefix: $('#cfg-prefix').value },
    };
    var pw = $('#cfg-password').value;
    if (pw) updates.auth = { password: pw };
    try {
      var res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        $('#settings-msg').style.color = '#51cf66';
        $('#settings-msg').textContent = 'Saved! Restart server if port changed.';
      } else {
        var data = await res.json();
        $('#settings-msg').style.color = '';
        $('#settings-msg').textContent = data.error || 'Save failed';
      }
    } catch(err) {
      $('#settings-msg').textContent = 'Network error';
    }
  });

  // --- Terminal ---
  function refreshTerminalView(scrollToBottom, allowFit) {
    requestAnimationFrame(function() {
      if (!terminal) return;
      if (allowFit && !terminalUsesRemoteSize) { try { if (fitAddon && !terminalUsesRemoteSize) fitAddon.fit(); } catch(err) {} }
      if (scrollToBottom) { try { terminal.scrollToBottom(); } catch(err) {} }
      try { if (terminal.refresh) terminal.refresh(0, Math.max(0, terminal.rows - 1)); } catch(err) {}
      requestAnimationFrame(function() { if (window.__agentTermRefreshScrollThumb) window.__agentTermRefreshScrollThumb(); });
    });
  }

  function enqueueWrite(data) {
    if (!terminal || !data) return;
    var maxChunk = 8192;
    for (var i = 0; i < data.length; i += maxChunk) writeQueue.push(data.slice(i, i + maxChunk));
    pumpWriteQueue();
  }

  function pumpWriteQueue() {
    if (!terminal || writing || !writeQueue.length) return;
    var chunk = writeQueue.shift() || '';
    writing = true;
    terminal.write(chunk, function() {
      writing = false;
      refreshTerminalView(false);
      pumpWriteQueue();
    });
  }

  function clearTerminalView() {
    writeQueue = [];
    writing = false;
    if (!terminal) return;
    try { terminal.clear(); } catch(err) {}
    try { terminal.reset(); } catch(err) {}
    terminal.write('\x1b[3J\x1b[2J\x1b[H', function() {
      refreshTerminalView(true, false);
    });
  }

  function sendResizeIntent() {
    if (!terminal || !fitAddon || !currentWs || currentWs.readyState !== WebSocket.OPEN) return;
    try { fitAddon.fit(); } catch(err) {}
    resizeRole = 'controller';
    terminalUsesRemoteSize = false;
    currentWs.send(JSON.stringify({ type: 'resize-intent', cols: terminal.cols, rows: terminal.rows, clientId: clientId, revision: knownRevision }));
  }

  function sendFitResize() {
    if (!terminal || !fitAddon || terminalUsesRemoteSize || resizeRole !== 'controller') return;
    try { fitAddon.fit(); } catch(err) {}
    var sizeKey = terminal.cols + 'x' + terminal.rows;
    if (sizeKey === lastSentSize) return;
    lastSentSize = sizeKey;
    initialResizeSent = true;
    if (currentWs && currentWs.readyState === WebSocket.OPEN)
      currentWs.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows, clientId: clientId, revision: knownRevision }));
  }

  function scheduleFitResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendFitResize, 100);
  }

  function cleanupTerminal() {
    writeGeneration += 1;
    writeQueue = [];
    writing = false;
    clearingTerminal = false;
    terminalUsesRemoteSize = false;
    waitingForRemoteSize = false;
    initialResizeSent = false;
    resizeRole = 'observer';
    knownRevision = 0;
    clientId = '';
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    lastSentSize = '';
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    if (viewportHandler && window.visualViewport) { window.visualViewport.removeEventListener('resize', viewportHandler); viewportHandler = null; }
    if (currentWs) { currentWs.close(); currentWs = null; }
    if (terminal) { terminal.dispose(); terminal = null; fitAddon = null; }
  }

  function setupTouchScroll(termElement, sendScroll) {
    var touchStartY = 0;
    var touchStartX = 0;
    var touchScrolling = false;
    var accumulated = 0;
    var pendingLines = 0;
    var scrollFrame = 0;
    var LINE_PX = 18;
    var scrollState = { scrollPosition: 0, historySize: 0, paneHeight: 0, inCopyMode: false };
    var scrollHandle = null;
    var scrollThumb = null;
    function usesTmuxScroll() { return scrollState.paneHeight > 0; }
    function getLocalScrollState() {
      if (!terminal || !terminal.buffer || !terminal.buffer.active) return { scrollPosition: 0, historySize: 0, paneHeight: 0 };
      var buffer = terminal.buffer.active;
      var historySize = Math.max(0, buffer.baseY || 0);
      var scrollPosition = Math.max(0, (buffer.baseY || 0) - (buffer.viewportY || 0));
      return { scrollPosition: scrollPosition, historySize: historySize, paneHeight: terminal.rows || 0 };
    }
    function getEffectiveScrollState() { return usesTmuxScroll() ? scrollState : getLocalScrollState(); }
    function updateScrollThumb() {
      if (!scrollHandle || !scrollThumb) return;
      var state = getEffectiveScrollState();
      var hasScrollableHistory = state.historySize > 0 || state.scrollPosition > 0;
      scrollHandle.style.display = hasScrollableHistory ? 'block' : 'none';
      if (!hasScrollableHistory) return;
      var trackHeight = scrollHandle.clientHeight || 1;
      var thumbHeight = Math.max(44, Math.min(96, Math.round(trackHeight * Math.max(0.12, Math.min(0.45, state.paneHeight / Math.max(state.historySize + state.paneHeight, 1))))));
      var maxTop = Math.max(0, trackHeight - thumbHeight);
      var maxScroll = Math.max(1, state.historySize);
      var ratio = 1 - Math.max(0, Math.min(1, state.scrollPosition / maxScroll));
      scrollThumb.style.height = thumbHeight + 'px';
      scrollThumb.style.transform = 'translateY(' + Math.round(maxTop * ratio) + 'px)';
    }
    window.__agentTermRefreshScrollThumb = updateScrollThumb;
    window.__agentTermUpdateScrollState = function(state) {
      scrollState.scrollPosition = Number(state.scrollPosition || 0);
      scrollState.historySize = Number(state.historySize || 0);
      scrollState.paneHeight = Number(state.paneHeight || 0);
      scrollState.inCopyMode = !!state.inCopyMode;
      updateScrollThumb();
    };
    var targets = [termElement];
    var viewport = termElement.querySelector('.xterm-viewport');
    var screen = termElement.querySelector('.xterm-screen');
    if (viewport) targets.push(viewport);
    if (screen) targets.push(screen);

    function stopTerminalWheel(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    function flushScroll() {
      scrollFrame = 0;
      if (!pendingLines) return;
      var lines = Math.max(-120, Math.min(120, pendingLines));
      pendingLines -= lines;
      if (usesTmuxScroll()) sendScroll(lines);
      else if (terminal) { terminal.scrollLines(lines); requestAnimationFrame(updateScrollThumb); }
      if (pendingLines) scrollFrame = requestAnimationFrame(flushScroll);
    }

    function queueScroll(lines) {
      if (usesTmuxScroll() && scrollState.historySize > 0) {
        scrollState.scrollPosition = Math.max(0, Math.min(scrollState.historySize, scrollState.scrollPosition - lines));
        updateScrollThumb();
      }
      pendingLines += lines;
      if (!scrollFrame) scrollFrame = requestAnimationFrame(flushScroll);
    }

    function onWheel(e) {
      stopTerminalWheel(e);
      var delta = e.deltaY || (-e.wheelDelta) || 0;
      var lines = Math.max(1, Math.round(Math.abs(delta) / LINE_PX));
      queueScroll(delta > 0 ? lines : -lines);
    }

    function isTextInputTarget(target) {
      if (!target || !target.closest) return false;
      return !!target.closest('textarea,input,.xterm-helper-textarea,.composition-view,.xterm-composition-view');
    }

    function onTouchStart(e) {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
        touchScrolling = false;
        accumulated = 0;
      }
    }

    function onTouchMove(e) {
      if (e.touches.length !== 1 || isTextInputTarget(e.target)) return;
      var dx = e.touches[0].clientX - touchStartX;
      var rawDy = e.touches[0].clientY - touchStartY;
      if (!touchScrolling) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(rawDy) * 1.2) return;
        if (Math.abs(rawDy) < 8) return;
        touchScrolling = true;
      }
      stopTerminalWheel(e);
      var dy = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      accumulated += dy;
      while (Math.abs(accumulated) >= LINE_PX) {
        queueScroll(accumulated > 0 ? 1 : -1);
        accumulated += accumulated > 0 ? -LINE_PX : LINE_PX;
      }
    }

    var pointerStartY = 0;
    var pointerStartScroll = 0;
    var pointerAccumulated = 0;
    function onPointerMove(e) {
      e.preventDefault();
      var state = getEffectiveScrollState();
      if (scrollHandle && scrollThumb && state.historySize > 0) {
        var trackHeight = scrollHandle.clientHeight || 1;
        var thumbHeight = scrollThumb.clientHeight || 72;
        var maxTop = Math.max(1, trackHeight - thumbHeight);
        var dy = e.clientY - pointerStartY;
        var targetScroll = Math.max(0, Math.min(state.historySize, pointerStartScroll - Math.round((dy / maxTop) * state.historySize)));
        var delta = targetScroll - state.scrollPosition;
        if (delta) {
          if (usesTmuxScroll()) {
            scrollState.scrollPosition = targetScroll;
            updateScrollThumb();
            queueScroll(delta > 0 ? -Math.abs(delta) : Math.abs(delta));
          } else if (terminal) {
            terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - targetScroll));
            updateScrollThumb();
          }
        }
        return;
      }
      var dy = e.clientY - pointerStartY;
      pointerStartY = e.clientY;
      pointerAccumulated += dy;
      while (Math.abs(pointerAccumulated) >= 6) {
        queueScroll(pointerAccumulated > 0 ? 2 : -2);
        pointerAccumulated += pointerAccumulated > 0 ? -6 : 6;
      }
    }
    function onPointerUp() {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }
    function onPointerDown(e) {
      e.preventDefault();
      pointerStartY = e.clientY;
      pointerStartScroll = getEffectiveScrollState().scrollPosition;
      pointerAccumulated = 0;
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp, { once: true });
    }

    targets.forEach(function(target) {
      target.addEventListener('wheel', onWheel, { capture: true, passive: false });
      target.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      target.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    });
    var container = termElement.parentElement;
    if (container && !container.querySelector('.terminal-scroll-handle')) {
      scrollHandle = document.createElement('div');
      scrollHandle.className = 'terminal-scroll-handle';
      scrollHandle.title = 'Drag to scroll terminal history';
      scrollThumb = document.createElement('div');
      scrollThumb.className = 'terminal-scroll-thumb';
      scrollHandle.appendChild(scrollThumb);
      scrollHandle.addEventListener('pointerdown', onPointerDown, { passive: false });
      container.appendChild(scrollHandle);
      updateScrollThumb();
    }
  }

  var TERM_FONT = "'MesloNF', 'Menlo', 'Monaco', 'Noto Sans Mono CJK SC', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', monospace";

  function waitForFont(fontFamily, timeout) {
    return new Promise(function(resolve) {
      if (document.fonts && document.fonts.load) {
        document.fonts.load('14px ' + fontFamily).then(resolve).catch(resolve);
      }
      var canvas = document.createElement('canvas');
      var ctx2d = canvas.getContext('2d');
      ctx2d.font = '14px monospace';
      var fallbackWidth = ctx2d.measureText('ABCDEFG').width;
      var start = Date.now();
      function check() {
        ctx2d.font = '14px ' + fontFamily + ', monospace';
        var w = ctx2d.measureText('ABCDEFG').width;
        if (w !== fallbackWidth || Date.now() - start > timeout) resolve();
        else requestAnimationFrame(check);
      }
      check();
    });
  }

  async function openTerminal(sessionName, deviceId) {
    cleanupTerminal();
    showPage('#terminal-page');
    $('#session-title').textContent = sessionName;
    var container = $('#terminal-container');
    container.innerHTML = '';

    waitForFont('MesloNF', 1200).then(function() {
      if (terminal) {
        terminal.options.fontFamily = TERM_FONT;
        if (fitAddon && !terminalUsesRemoteSize) fitAddon.fit();
      }
    });

    terminal = new window.Terminal({
      fontSize: 14,
      fontFamily: TERM_FONT,
      lineHeight: 1.2,
      theme: {
        background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#00d4ff',
        selectionBackground: 'rgba(0, 212, 255, 0.3)',
        black: '#1a1a2e', red: '#ff6b6b', green: '#51cf66', yellow: '#ffd43b',
        blue: '#339af0', magenta: '#cc5de8', cyan: '#00d4ff', white: '#e0e0e0',
        brightBlack: '#495057', brightRed: '#ff8787', brightGreen: '#69db7c',
        brightYellow: '#ffe066', brightBlue: '#5c7cfa', brightMagenta: '#da77f2',
        brightCyan: '#3bc9db', brightWhite: '#f8f9fa',
      },
      cursorBlink: true, allowProposedApi: true, scrollback: 5000, customGlyphs: false,
    });

    fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    try {
      if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) {
        terminal.loadAddon(new window.Unicode11Addon.Unicode11Addon());
        terminal.unicode.activeVersion = '11';
      }
    } catch(err) {}

    terminal.open(container);
    function focusTerminalTextarea() {
      var textarea = container.querySelector('.xterm-helper-textarea');
      try { if (textarea) textarea.focus({ preventScroll: true }); else terminal.focus(); } catch(err) { try { terminal.focus(); } catch(_) {} }
    }
    function stabilizeImeLayout() {
      requestAnimationFrame(function() {
        if (!terminal || !fitAddon) return;
        if (!terminalUsesRemoteSize) {
          try { fitAddon.fit(); } catch(err) {}
          if (currentWs && currentWs.readyState === WebSocket.OPEN)
            currentWs.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }
        refreshTerminalView(false, false);
      });
    }
    var helperTextarea = container.querySelector('.xterm-helper-textarea');
    ['compositionstart','compositionupdate','compositionend','input'].forEach(function(eventName) {
      if (helperTextarea) helperTextarea.addEventListener(eventName, stabilizeImeLayout);
    });
    container.addEventListener('pointerdown', function(e) {
      if (e.target && e.target.closest && e.target.closest('.terminal-scroll-handle')) return;
      setTimeout(focusTerminalTextarea, 0);
      setTimeout(sendResizeIntent, 0);
    }, { passive: true });
    container.addEventListener('click', function() { setTimeout(focusTerminalTextarea, 0); setTimeout(sendResizeIntent, 0); }, { passive: true });
    setTimeout(focusTerminalTextarea, 100);
    setTimeout(function() { if (terminal) { terminal.options.fontFamily = TERM_FONT; if (fitAddon && !terminalUsesRemoteSize) fitAddon.fit(); } }, 300);
    setTimeout(function() { if (terminal) { terminal.options.fontFamily = TERM_FONT; if (fitAddon && !terminalUsesRemoteSize) fitAddon.fit(); } }, 1000);

    var statusDot = $('#connection-status');
    var wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProto + '//' + location.host + '/ws?token=' + token + '&session=' + encodeURIComponent(sessionName);
    if (deviceId) wsUrl += '&deviceId=' + encodeURIComponent(deviceId);
    clientId = 'web:' + (deviceId || 'local') + ':' + sessionName + ':' + Date.now();
    waitingForRemoteSize = true;
    currentWs = new WebSocket(wsUrl);

    var termEl = container.querySelector('.xterm');
    if (termEl) setupTouchScroll(termEl, function(lines) {
      if (currentWs && currentWs.readyState === WebSocket.OPEN)
        currentWs.send(JSON.stringify({ type: 'scroll', lines: lines }));
    });

    currentWs.onopen = function() {
      statusDot.className = 'status-dot connected';
      requestAnimationFrame(function() {
        if (!waitingForRemoteSize) sendFitResize();
        refreshTerminalView(true, false);
      });
      setTimeout(function() { if (waitingForRemoteSize && !initialResizeSent) sendResizeIntent(); }, 250);
      setTimeout(function() { refreshTerminalView(true); }, 350);
      setTimeout(function() { refreshTerminalView(true); }, 1000);
    };
    currentWs.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'terminal-size' && msg.cols && msg.rows) {
          knownRevision = Number(msg.revision || knownRevision);
          resizeRole = (msg.role === 'controller' || msg.controllerId === clientId) ? 'controller' : 'observer';
          terminalUsesRemoteSize = resizeRole !== 'controller';
          waitingForRemoteSize = false;
          if (terminalUsesRemoteSize || msg.sourceClientId === clientId) initialResizeSent = true;
          if (msg.sourceClientId !== clientId || resizeRole !== 'controller') {
            try { terminal.resize(msg.cols, msg.rows); } catch(err) {}
          }
          refreshTerminalView(true, false);
        } else if (msg.type === 'clear') {
          clearTerminalView();
        } else if (msg.type === 'scroll-state') {
          if (window.__agentTermUpdateScrollState) window.__agentTermUpdateScrollState(msg);
        } else if (msg.type === 'output' && msg.data) {
          enqueueWrite(msg.data);
        }
      } catch(err) {}
    };
    currentWs.onclose = function() {
      statusDot.className = 'status-dot disconnected';
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
      if (viewportHandler && window.visualViewport) { window.visualViewport.removeEventListener('resize', viewportHandler); viewportHandler = null; }
    };
    currentWs.onerror = function() { statusDot.className = 'status-dot disconnected'; };

    terminal.onData(function(data) {
      sendResizeIntent();
      if (currentWs && currentWs.readyState === WebSocket.OPEN)
        currentWs.send(JSON.stringify({ type: 'input', data: data }));
    });

    resizeHandler = function() {
      if (fitAddon) {
        if (!terminalUsesRemoteSize && !waitingForRemoteSize && resizeRole === 'controller') scheduleFitResize();
        else refreshTerminalView(false, false);
      }
    };
    window.addEventListener('resize', resizeHandler);
    pingInterval = setInterval(function() {
      if (currentWs && currentWs.readyState === WebSocket.OPEN)
        currentWs.send(JSON.stringify({ type: 'ping' }));
    }, 30000);

    // Mobile keyboard handling
    if (window.visualViewport) {
      viewportHandler = function() {
        var vp = window.visualViewport;
        var page = $('#terminal-page');
        if (page) page.style.height = vp.height + 'px';
        document.documentElement.style.setProperty('--vh', vp.height + 'px');
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
        if (fitAddon) {
          setTimeout(function() {
            if (!terminalUsesRemoteSize && !waitingForRemoteSize && resizeRole === 'controller') scheduleFitResize();
            if (terminal) terminal.scrollToBottom();
          }, 50);
        }
      };
      window.visualViewport.addEventListener('resize', viewportHandler);
      window.visualViewport.addEventListener('scroll', function() { window.scrollTo(0, 0); });
      viewportHandler();
    }
  }

  $('#back-btn').addEventListener('click', function() { cleanupTerminal(); loadSessions(); });

  // --- Global viewport fix for mobile keyboards ---
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
      document.querySelectorAll('.page:not(.hidden)').forEach(function(p) {
        p.style.height = window.visualViewport.height + 'px';
      });
      window.scrollTo(0, 0);
    });
    document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
  }

  // --- Start ---
  init();
})();
