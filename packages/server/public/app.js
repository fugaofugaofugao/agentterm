(function() {
  let token = localStorage.getItem('agentterm_token');
  let currentWs = null;
  let terminal = null;
  let fitAddon = null;
  let pingInterval = null;
  let resizeHandler = null;
  let viewportHandler = null;

  var $ = function(s) { return document.querySelector(s); };

  function showPage(id) {
    document.querySelectorAll('.page').forEach(function(p) { p.classList.add('hidden'); });
    $(id).classList.remove('hidden');
    if (id === '#terminal-page' && fitAddon) {
      requestAnimationFrame(function() { fitAddon.fit(); });
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
    try {
      var res = await fetch('/api/sessions', { headers: { 'Authorization': 'Bearer ' + token } });
      if (res.status === 401) { token = null; localStorage.removeItem('agentterm_token'); showPage('#login-page'); return; }
      var data = await res.json();
      renderSessions(data.sessions || []);
    } catch(err) { $('#session-list').innerHTML = '<p class="empty-hint">Unable to load sessions</p>'; }
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
  function cleanupTerminal() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    if (viewportHandler && window.visualViewport) { window.visualViewport.removeEventListener('resize', viewportHandler); viewportHandler = null; }
    if (currentWs) { currentWs.close(); currentWs = null; }
    if (terminal) { terminal.dispose(); terminal = null; fitAddon = null; }
  }

  function setupTouchScroll(termElement, sendScroll) {
    var touchStartY = 0;
    var accumulated = 0;
    var pendingLines = 0;
    var scrollFrame = 0;
    var LINE_PX = 18;
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
      sendScroll(lines);
      if (pendingLines) scrollFrame = requestAnimationFrame(flushScroll);
    }

    function queueScroll(lines) {
      pendingLines += lines;
      if (!scrollFrame) scrollFrame = requestAnimationFrame(flushScroll);
    }

    function onWheel(e) {
      stopTerminalWheel(e);
      var delta = e.deltaY || (-e.wheelDelta) || 0;
      var lines = Math.max(1, Math.round(Math.abs(delta) / LINE_PX));
      queueScroll(delta > 0 ? lines : -lines);
    }

    function onTouchStart(e) {
      if (e.touches.length === 1) { touchStartY = e.touches[0].clientY; accumulated = 0; }
    }

    function onTouchMove(e) {
      if (e.touches.length !== 1) return;
      stopTerminalWheel(e);
      var dy = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      accumulated += dy;
      while (Math.abs(accumulated) >= LINE_PX) {
        queueScroll(accumulated > 0 ? 1 : -1);
        accumulated += accumulated > 0 ? -LINE_PX : LINE_PX;
      }
    }

    var pointerStartY = 0;
    var pointerAccumulated = 0;
    function onPointerMove(e) {
      e.preventDefault();
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
      var handle = document.createElement('div');
      handle.className = 'terminal-scroll-handle';
      handle.title = 'Drag to scroll terminal history';
      var thumb = document.createElement('div');
      thumb.className = 'terminal-scroll-thumb';
      handle.appendChild(thumb);
      handle.addEventListener('pointerdown', onPointerDown, { passive: false });
      container.appendChild(handle);
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

    await waitForFont('MesloNF', 5000);

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
      cursorBlink: true, allowProposedApi: true, scrollback: 5000,
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
    setTimeout(function() { if (terminal) { terminal.options.fontFamily = TERM_FONT; if (fitAddon) fitAddon.fit(); } }, 300);
    setTimeout(function() { if (terminal) { terminal.options.fontFamily = TERM_FONT; if (fitAddon) fitAddon.fit(); } }, 1000);

    var statusDot = $('#connection-status');
    var wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProto + '//' + location.host + '/ws?token=' + token + '&session=' + encodeURIComponent(sessionName);
    if (deviceId) wsUrl += '&deviceId=' + encodeURIComponent(deviceId);
    currentWs = new WebSocket(wsUrl);

    var termEl = container.querySelector('.xterm');
    if (termEl) setupTouchScroll(termEl, function(lines) {
      if (currentWs && currentWs.readyState === WebSocket.OPEN)
        currentWs.send(JSON.stringify({ type: 'scroll', lines: lines }));
    });

    currentWs.onopen = function() {
      statusDot.className = 'status-dot connected';
      requestAnimationFrame(function() {
        fitAddon.fit();
        if (currentWs && currentWs.readyState === WebSocket.OPEN)
          currentWs.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      });
    };
    currentWs.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'clear') {
          terminal.write('\x1b[3J\x1b[2J\x1b[H');
          try { terminal.clear(); terminal.scrollToBottom(); } catch(err) {}
        } else if (msg.type === 'output' && msg.data) {
          terminal.write(msg.data);
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
      if (currentWs && currentWs.readyState === WebSocket.OPEN)
        currentWs.send(JSON.stringify({ type: 'input', data: data }));
    });

    resizeHandler = function() {
      if (fitAddon) {
        fitAddon.fit();
        if (currentWs && currentWs.readyState === WebSocket.OPEN)
          currentWs.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
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
            fitAddon.fit();
            if (terminal) terminal.scrollToBottom();
            if (currentWs && currentWs.readyState === WebSocket.OPEN)
              currentWs.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
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
