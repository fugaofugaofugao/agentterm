(function() {
  let token = localStorage.getItem('agentterm_token');
  let currentWs = null;
  let terminal = null;
  let fitAddon = null;
  let pingInterval = null;
  let resizeHandler = null;
  let viewportHandler = null;
  let viewportScrollHandler = null;
  let viewportFitTimer = null;
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
  let isComposing = false;
  let pendingFitAfterComposition = false;
  let compositionInputFallbackTimer = null;
  let compositionDraft = '';
  let compositionFilterDraft = '';
  let recentCompositionDraft = '';
  let recentCompositionFilterDraft = '';
  let recentCompositionTimer = null;
  let previousCursorStyle = null;
  let mobileInputShim = null;
  let mobileInputValue = '';
  let mobileInputQueue = '';
  let mobileInputFrame = 0;
  let mobileLastFocusAt = 0;

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
      if (allowFit && !terminalUsesRemoteSize && !isComposing) { try { if (fitAddon && !terminalUsesRemoteSize) fitAddon.fit(); } catch(err) {} }
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
    if (!terminal) return;
    try { terminal.clear(); } catch(err) {}
    try { terminal.reset(); } catch(err) {}
    // Browser xterm can miss the write callback when a relay replay starts with clear
    // while remote terminal-size resize is also applied, leaving `writing` stuck true.
    // Treat clear/reset as synchronous and let queued output render on the next frame.
    writing = false;
    requestAnimationFrame(function() {
      refreshTerminalView(true, false);
      pumpWriteQueue();
    });
  }

  function sendResizeIntent() {
    if (!terminal || !fitAddon || !currentWs || currentWs.readyState !== WebSocket.OPEN) return;
    if (isComposing) { pendingFitAfterComposition = true; return; }
    try { fitAddon.fit(); } catch(err) {}
    resizeRole = 'controller';
    terminalUsesRemoteSize = false;
    currentWs.send(JSON.stringify({ type: 'resize-intent', cols: terminal.cols, rows: terminal.rows, clientId: clientId, revision: knownRevision }));
  }

  function sendFitResize() {
    if (!terminal || !fitAddon || terminalUsesRemoteSize || resizeRole !== 'controller') return;
    if (isComposing) { pendingFitAfterComposition = true; return; }
    try { fitAddon.fit(); } catch(err) {}
    var sizeKey = terminal.cols + 'x' + terminal.rows;
    if (sizeKey === lastSentSize) return;
    lastSentSize = sizeKey;
    initialResizeSent = true;
    if (currentWs && currentWs.readyState === WebSocket.OPEN)
      currentWs.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows, clientId: clientId, revision: knownRevision }));
  }

  function scheduleFitResize() {
    if (isComposing) { pendingFitAfterComposition = true; return; }
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendFitResize, 100);
  }

  function sendTerminalInput(data) {
    if (!data || !currentWs || currentWs.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify({ type: 'input', data: data }));
  }

  function runPendingFitAfterComposition() {
    if (!pendingFitAfterComposition) return;
    pendingFitAfterComposition = false;
    setTimeout(scheduleFitResize, 80);
  }

  function resetInputCompositionState() {
    isComposing = false;
    compositionDraft = '';
    compositionFilterDraft = '';
    recentCompositionDraft = '';
    recentCompositionFilterDraft = '';
    if (recentCompositionTimer) { clearTimeout(recentCompositionTimer); recentCompositionTimer = null; }
    pendingFitAfterComposition = false;
    mobileInputValue = '';
    mobileInputQueue = '';
    if (mobileInputFrame) { cancelAnimationFrame(mobileInputFrame); mobileInputFrame = 0; }
    mobileLastFocusAt = 0;
    if (compositionInputFallbackTimer) { clearTimeout(compositionInputFallbackTimer); compositionInputFallbackTimer = null; }
    if (viewportFitTimer) { clearTimeout(viewportFitTimer); viewportFitTimer = null; }
    if (mobileInputShim && mobileInputShim.parentElement) mobileInputShim.parentElement.removeChild(mobileInputShim);
    mobileInputShim = null;
  }

  function isMobileInputDevice() {
    return !!(navigator.maxTouchPoints > 0 && /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent || ''));
  }

  function sendMobileInput(data) {
    if (!data) return;
    if (data === '\r' || data === '\x7f' || data.charCodeAt(0) < 32) {
      if (mobileInputFrame) { cancelAnimationFrame(mobileInputFrame); mobileInputFrame = 0; }
      if (mobileInputQueue) { sendTerminalInput(mobileInputQueue); mobileInputQueue = ''; }
      sendTerminalInput(data);
      return;
    }
    mobileInputQueue += data;
    if (mobileInputFrame) return;
    mobileInputFrame = requestAnimationFrame(function() {
      mobileInputFrame = 0;
      var queued = mobileInputQueue;
      mobileInputQueue = '';
      sendTerminalInput(queued);
    });
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
    resetInputCompositionState();
    lastSentSize = '';
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    if (viewportHandler && window.visualViewport) { window.visualViewport.removeEventListener('resize', viewportHandler); viewportHandler = null; }
    if (viewportScrollHandler && window.visualViewport) { window.visualViewport.removeEventListener('scroll', viewportScrollHandler); viewportScrollHandler = null; }
    if (currentWs) { currentWs.close(); currentWs = null; }
    if (terminal) { terminal.dispose(); terminal = null; fitAddon = null; }
  }

  // Browser mirror of packages/shared/src/terminal helpers. Keep this block in sync so
  // Electron and web use the same iTerm2-inspired interaction semantics.
  function terminalClamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function shouldHandleVerticalWheel(deltaX, deltaY) { return Math.abs(deltaX || 0) <= Math.abs(deltaY || 0) * 1.25; }
  function normalizeWheelDeltaToLines(e, linePx, pageRows) {
    var delta = e.deltaY || (-e.wheelDelta) || 0;
    if (!delta) return 0;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * Math.max(1, pageRows || 24);
    return delta / Math.max(1, linePx || 1);
  }
  function takeWholeAccumulatedScroll(accumulator, deltaLines, cap) {
    if (!isFinite(deltaLines) || !deltaLines) return 0;
    if (accumulator.value && Math.sign(deltaLines) !== Math.sign(accumulator.value)) accumulator.value = 0;
    accumulator.value += deltaLines;
    var whole = accumulator.value > 0 ? Math.floor(accumulator.value) : Math.ceil(accumulator.value);
    if (!whole) return 0;
    accumulator.value -= whole;
    cap = Math.abs(cap || 24);
    return terminalClamp(whole, -cap, cap);
  }
  function calculateScrollThumbLayout(state, trackHeight, forceVisible) {
    var hasScrollableHistory = !!forceVisible || state.historySize > 0 || state.scrollPosition > 0;
    if (!hasScrollableHistory) return { hasScrollableHistory: false, thumbHeight: 0, top: 0 };
    trackHeight = Math.max(1, trackHeight || 1);
    var visibleRatio = Math.max(0.12, Math.min(0.45, state.paneHeight / Math.max(state.historySize + state.paneHeight, 1)));
    var thumbHeight = Math.max(44, Math.min(96, Math.round(trackHeight * visibleRatio)));
    var maxTop = Math.max(0, trackHeight - thumbHeight);
    var maxScroll = Math.max(1, state.historySize, state.scrollPosition);
    var ratio = 1 - terminalClamp(state.scrollPosition / maxScroll, 0, 1);
    return { hasScrollableHistory: true, thumbHeight: thumbHeight, top: Math.round(maxTop * ratio) };
  }
  function calculateScrollTargetFromDrag(state, pointerStartScroll, dy, trackHeight, thumbHeight) {
    var maxTop = Math.max(1, (trackHeight || 1) - (thumbHeight || 72));
    var historySize = Math.max(state.historySize, state.scrollPosition, 1);
    return terminalClamp(pointerStartScroll - Math.round((dy / maxTop) * historySize), 0, historySize);
  }
  function stripTerminalDeviceAnswers(data) {
    return data.replace(/\[(?:\?|>)?[0-9;]*c/g, '').replace(/(?:\??|>?)[0-9;]+c/g, '');
  }
  function shouldDropCompositionDraft(outgoing, activeDraft) {
    if (!activeDraft || !/^[ -]+$/.test(outgoing)) return false;
    var draft = activeDraft.replace(/\s+/g, '');
    var compact = outgoing.replace(/\s+/g, '');
    return outgoing === activeDraft || compact === draft || draft.indexOf(compact) === 0 || compact.indexOf(draft) === 0;
  }

  function setupTouchScroll(termElement, sendScroll, remotePane) {
    var touchStartY = 0;
    var touchStartX = 0;
    var touchScrolling = false;
    var accumulated = 0;
    var pendingLines = 0;
    var scrollFrame = 0;
    var remoteScrollTimer = null;
    var wheelAccumulator = { value: 0 };
    var LOCAL_LINE_PX = 18;
    var REMOTE_LINE_PX = 32;
    var REMOTE_FLUSH_MS = 42;
    var scrollState = { scrollPosition: 0, historySize: 0, paneHeight: 0, inCopyMode: false };
    var scrollHandle = null;
    var scrollThumb = null;
    function usesTmuxScroll() { return !!remotePane || scrollState.paneHeight > 0; }
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
      var layout = calculateScrollThumbLayout(getEffectiveScrollState(), scrollHandle.clientHeight || 1, usesTmuxScroll());
      scrollHandle.classList.toggle('is-scrollable', layout.hasScrollableHistory);
      scrollHandle.setAttribute('aria-hidden', layout.hasScrollableHistory ? 'false' : 'true');
      if (!layout.hasScrollableHistory) return;
      scrollThumb.style.height = layout.thumbHeight + 'px';
      scrollThumb.style.transform = 'translateY(' + layout.top + 'px)';
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
    if (termElement.parentElement) targets.push(termElement.parentElement);
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
      if (remoteScrollTimer) { clearTimeout(remoteScrollTimer); remoteScrollTimer = null; }
      if (!pendingLines) return;
      var remote = usesTmuxScroll();
      var maxLines = remote ? 36 : 120;
      var lines = Math.max(-maxLines, Math.min(maxLines, pendingLines));
      pendingLines -= lines;
      if (remote) sendScroll(lines);
      else if (terminal) { terminal.scrollLines(lines); requestAnimationFrame(updateScrollThumb); }
      if (pendingLines) scheduleScrollFlush();
    }

    function scheduleScrollFlush() {
      if (usesTmuxScroll()) {
        if (!remoteScrollTimer) remoteScrollTimer = setTimeout(flushScroll, REMOTE_FLUSH_MS);
      } else if (!scrollFrame) {
        scrollFrame = requestAnimationFrame(flushScroll);
      }
    }

    function queueScroll(lines) {
      if (!isFinite(lines) || !lines) return;
      if (usesTmuxScroll()) {
        scrollState.scrollPosition = Math.max(0, Math.min(Math.max(scrollState.historySize, scrollState.scrollPosition), scrollState.scrollPosition - lines));
        updateScrollThumb();
      }
      pendingLines += lines;
      scheduleScrollFlush();
    }

    function onWheel(e) {
      if (e.__agentTermWheelHandled) return;
      if (!shouldHandleVerticalWheel(e.deltaX || 0, e.deltaY || 0)) return;
      e.__agentTermWheelHandled = true;
      stopTerminalWheel(e);
      var linePx = usesTmuxScroll() ? REMOTE_LINE_PX : LOCAL_LINE_PX;
      var rawLines = normalizeWheelDeltaToLines(e, linePx, (terminal && terminal.rows) || 24);
      var lines = takeWholeAccumulatedScroll(wheelAccumulator, rawLines, 24);
      if (lines) queueScroll(lines);
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
      var linePx = usesTmuxScroll() ? REMOTE_LINE_PX : LOCAL_LINE_PX;
      while (Math.abs(accumulated) >= linePx) {
        queueScroll(accumulated > 0 ? 1 : -1);
        accumulated += accumulated > 0 ? -linePx : linePx;
      }
    }

    var pointerStartY = 0;
    var pointerStartScroll = 0;
    var pointerAccumulated = 0;
    function onPointerMove(e) {
      e.preventDefault();
      var state = getEffectiveScrollState();
      if (scrollHandle && scrollThumb && (usesTmuxScroll() || state.historySize > 0 || state.scrollPosition > 0)) {
        var dy = e.clientY - pointerStartY;
        var targetScroll = calculateScrollTargetFromDrag(state, pointerStartScroll, dy, scrollHandle.clientHeight || 1, scrollThumb.clientHeight || 72);
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
      while (Math.abs(pointerAccumulated) >= 8) {
        queueScroll(pointerAccumulated > 0 ? 2 : -2);
        pointerAccumulated += pointerAccumulated > 0 ? -8 : 8;
      }
    }
    function onPointerUp() {
      if (scrollHandle) scrollHandle.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (pendingLines) flushScroll();
    }
    function onPointerDown(e) {
      e.preventDefault();
      if (scrollHandle) scrollHandle.classList.add('is-dragging');
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
    if (terminal && terminal.attachCustomWheelEventHandler) {
      terminal.attachCustomWheelEventHandler(function(e) { onWheel(e); return false; });
    }

    if (container) {
      scrollHandle = container.querySelector('.terminal-scroll-handle');
      if (!scrollHandle) {
        scrollHandle = document.createElement('div');
        scrollHandle.className = 'terminal-scroll-handle';
        scrollHandle.title = 'Drag to scroll terminal history';
        container.appendChild(scrollHandle);
      }
      scrollThumb = scrollHandle.querySelector('.terminal-scroll-thumb');
      if (!scrollThumb) {
        scrollThumb = document.createElement('div');
        scrollThumb.className = 'terminal-scroll-thumb';
        scrollHandle.appendChild(scrollThumb);
      }
      scrollHandle.addEventListener('pointerdown', onPointerDown, { passive: false });
      if (remotePane) {
        scrollHandle.classList.add('is-scrollable');
        scrollHandle.setAttribute('aria-hidden', 'false');
      }
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
    window.__agentTermOpenTerminalArgs = { sessionName: sessionName, deviceId: deviceId || null };
    terminalUsesRemoteSize = !!deviceId;
    var useMobileInputShim = isMobileInputDevice();
    function getHelperTextarea() {
      return container.querySelector('.xterm-helper-textarea');
    }
    function getCompositionText(e, fallbackEl) {
      var target = e && e.target;
      var eventData = (e && e.data) || '';
      var value = (target && target.value) || (fallbackEl && fallbackEl.value) || '';
      if (eventData) return eventData;
      if (value.length >= compositionDraft.length) return value;
      return compositionDraft || value;
    }
    function getCompositionFilterText(e, fallbackEl) {
      var target = e && e.target;
      return (target && target.value) || (fallbackEl && fallbackEl.value) || compositionFilterDraft || compositionDraft || ((e && e.data) || '');
    }
    function applyImeCursorStyle(active) {
      container.classList.toggle('is-ime-composing', active);
    }

    // Native-anchored IME (matches the Electron renderer). We do NOT draw our own
    // preedit overlay or transform .xterm-rows; xterm renders the marked text inline
    // at the cursor and pins .xterm-helper-textarea to the cursor cell so the OS
    // candidate window tracks the caret. The old custom overlay desynced the textarea
    // from the cursor, which made the candidate panel jump to the corner and the draft
    // overlap on the last line.
    function patchNativeCompositionHelper() {
      var helper = terminal && terminal._core && terminal._core._compositionHelper;
      if (!helper || helper.__agentTermImePatchApplied) return helper;
      var compositionView = helper._compositionView;
      var textarea = helper._textarea;
      if (!compositionView || !textarea) return helper;
      var originalCompositionUpdate = helper.compositionupdate && helper.compositionupdate.bind(helper);
      var originalUpdateElements = helper.updateCompositionElements && helper.updateCompositionElements.bind(helper);
      var caret = document.createElement('span');
      caret.className = 'agentterm-ime-caret';
      caret.setAttribute('aria-hidden', 'true');

      function renderCompositionText(data) {
        compositionView.textContent = data ? ('\u200E' + data + '\u200E') : '';
        if (data) compositionView.appendChild(caret);
      }

      helper.compositionupdate = function(event) {
        var data = (event && event.data) || '';
        if (originalCompositionUpdate) originalCompositionUpdate(Object.assign({}, event, { data: data }));
        renderCompositionText(data);
        if (helper.updateCompositionElements) helper.updateCompositionElements();
      };

      helper.updateCompositionElements = function(dontRecurse) {
        if (!helper.isComposing) return;
        if (originalUpdateElements) originalUpdateElements(true);
        var renderService = terminal && terminal._core && terminal._core._renderService;
        var bufferService = terminal && terminal._core && terminal._core._bufferService;
        var cellWidth = Number(renderService && renderService.dimensions && renderService.dimensions.css && renderService.dimensions.css.cell && renderService.dimensions.css.cell.width) || 8;
        var cols = Number((bufferService && bufferService.cols) || (terminal && terminal.cols) || 0);
        var cursorLeft = parseFloat(compositionView.style.left || '0') || 0;
        var maxWidth = Math.max(cellWidth, cols * cellWidth - cursorLeft);
        compositionView.style.maxWidth = maxWidth + 'px';
        compositionView.style.overflow = 'hidden';
        compositionView.style.direction = 'rtl';
        compositionView.style.whiteSpace = 'nowrap';
        compositionView.style.overflowWrap = 'normal';
        compositionView.style.wordBreak = 'normal';
        var bounds = compositionView.getBoundingClientRect();
        textarea.style.width = Math.max(Math.min(bounds.width, maxWidth), 1) + 'px';
        textarea.style.height = Math.max(bounds.height, 1) + 'px';
        textarea.style.lineHeight = Math.max(bounds.height, 1) + 'px';
        if (!dontRecurse) setTimeout(function() { if (helper.updateCompositionElements) helper.updateCompositionElements(true); }, 0);
      };
      helper.__agentTermImePatchApplied = true;
      return helper;
    }

    function reanchorNativeComposition() {
      try {
        var helper = patchNativeCompositionHelper();
        if (!helper || !helper.isComposing || !helper.updateCompositionElements) return;
        helper.updateCompositionElements(true);
      } catch (err) {}
    }

    function scheduleNativeCompositionReanchor() {
      patchNativeCompositionHelper();
      if (window.queueMicrotask) window.queueMicrotask(reanchorNativeComposition);
      else setTimeout(reanchorNativeComposition, 0);
      requestAnimationFrame(reanchorNativeComposition);
    }

    function updateNativeCompositionState(text) {
      if (!isComposing || !text) {
        compositionDraft = '';
        if (!isComposing) compositionFilterDraft = '';
        applyImeCursorStyle(false);
        return;
      }
      compositionDraft = text;
      applyImeCursorStyle(true);
      scheduleNativeCompositionReanchor();
    }

    function ensureMobileInputShim() {
      if (!useMobileInputShim) return null;
      if (mobileInputShim) return mobileInputShim;
      mobileInputShim = document.createElement('textarea');
      mobileInputShim.className = 'terminal-mobile-input';
      mobileInputShim.autocapitalize = 'none';
      mobileInputShim.autocomplete = 'off';
      mobileInputShim.autocorrect = 'off';
      mobileInputShim.spellcheck = false;
      mobileInputShim.rows = 1;
      mobileInputShim.setAttribute('aria-label', 'Terminal input');
      mobileInputShim.value = '';
      mobileInputValue = '';
      container.appendChild(mobileInputShim);
      mobileInputShim.addEventListener('compositionstart', function(e) {
        isComposing = true;
      });
      mobileInputShim.addEventListener('compositionupdate', function(e) {
        isComposing = true;
      });
      mobileInputShim.addEventListener('compositionend', function(e) {
        isComposing = false;
        var committed = (e && e.data) || '';
        if (committed) sendCompositionCommit(committed);
        mobileInputValue = '';
        try { mobileInputShim.value = ''; } catch(err) {}
        runPendingFitAfterComposition();
      });
      mobileInputShim.addEventListener('beforeinput', function(e) {
        if (!e) return;
        if (e.inputType === 'insertLineBreak') {
          e.preventDefault();
          sendMobileInput('\r');
          mobileInputValue = '';
          try { mobileInputShim.value = ''; } catch(err) {}
        } else if (e.inputType === 'deleteContentBackward') {
          e.preventDefault();
          sendMobileInput('\x7f');
          mobileInputValue = '';
          try { mobileInputShim.value = ''; } catch(err) {}
        }
      });
      mobileInputShim.addEventListener('input', function() {
        if (isComposing) return;
        var value = mobileInputShim.value || '';
        if (value && value !== mobileInputValue) {
          var data = value.indexOf(mobileInputValue) === 0 ? value.slice(mobileInputValue.length) : value;
          if (data) sendMobileInput(data);
        }
        mobileInputValue = '';
        try { mobileInputShim.value = ''; } catch(err) {}
      });
      mobileInputShim.addEventListener('keydown', function(e) {
        if (!e || isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); sendMobileInput('\r'); }
        else if (e.key === 'Backspace') { e.preventDefault(); sendMobileInput('\x7f'); }
      });
      mobileInputShim.addEventListener('blur', function() {
        isComposing = false;
        runPendingFitAfterComposition();
      });
      return mobileInputShim;
    }
    function focusTerminalTextarea() {
      var mobileShim = ensureMobileInputShim();
      if (mobileShim) {
        if (container && container.querySelector('.terminal-scroll-handle.is-dragging')) return;
        var now = Date.now();
        if (document.activeElement !== mobileShim || now - mobileLastFocusAt > 600) {
          mobileLastFocusAt = now;
          try { mobileShim.focus({ preventScroll: true }); } catch(err) { try { mobileShim.focus(); } catch(_) {} }
        }
        if (viewportHandler) viewportHandler();
        if (!isComposing) setTimeout(sendResizeIntent, 0);
        return;
      }
      var textarea = getHelperTextarea();
      try { terminal.focus(); } catch(_) {}
      try { if (textarea) textarea.focus({ preventScroll: true }); } catch(err) { try { if (textarea) textarea.focus(); } catch(_) {} }
    }
    function sendCompositionCommit(data) {
      if (!data) return;
      if (!useMobileInputShim) sendTerminalInput(data);
      else sendMobileInput(data);
    }
    function scheduleCompositionInputFallback(textarea) {
      if (compositionInputFallbackTimer) clearTimeout(compositionInputFallbackTimer);
      compositionInputFallbackTimer = setTimeout(function() {
        compositionInputFallbackTimer = null;
        if (!textarea || isComposing) return;
        var value = textarea.value || '';
        if (!value) return;
        sendCompositionCommit(value);
        try { textarea.value = ''; } catch(err) {}
      }, 30);
    }
    patchNativeCompositionHelper();
    requestAnimationFrame(function() { patchNativeCompositionHelper(); });

    var helperTextarea = getHelperTextarea();
    if (!useMobileInputShim && helperTextarea) {
      helperTextarea.addEventListener('compositionstart', function(e) {
        isComposing = true;
        compositionDraft = getCompositionText(e, helperTextarea);
        compositionFilterDraft = getCompositionFilterText(e, helperTextarea);
        updateNativeCompositionState(compositionDraft);
        if (compositionInputFallbackTimer) { clearTimeout(compositionInputFallbackTimer); compositionInputFallbackTimer = null; }
      });
      helperTextarea.addEventListener('compositionupdate', function(e) {
        isComposing = true;
        compositionDraft = getCompositionText(e, helperTextarea);
        compositionFilterDraft = getCompositionFilterText(e, helperTextarea);
        updateNativeCompositionState(compositionDraft);
      });
      helperTextarea.addEventListener('compositionend', function(e) {
        var draft = compositionDraft;
        var filterDraft = getCompositionFilterText(e, helperTextarea);
        isComposing = false;
        compositionDraft = '';
        compositionFilterDraft = '';
        if (draft || filterDraft) {
          recentCompositionDraft = draft;
          recentCompositionFilterDraft = filterDraft;
          if (recentCompositionTimer) clearTimeout(recentCompositionTimer);
          recentCompositionTimer = setTimeout(function() { recentCompositionDraft = ''; recentCompositionFilterDraft = ''; recentCompositionTimer = null; }, 350);
        }
        updateNativeCompositionState('');
        previousCursorStyle = null;
        runPendingFitAfterComposition();
        setTimeout(focusTerminalTextarea, 0);
      });
      helperTextarea.addEventListener('input', function(e) {
        if (!isComposing) return;
        compositionDraft = getCompositionText(e, helperTextarea);
        compositionFilterDraft = getCompositionFilterText(e, helperTextarea);
        updateNativeCompositionState(compositionDraft);
      });
      helperTextarea.addEventListener('blur', function() {
        isComposing = false;
        compositionDraft = '';
        compositionFilterDraft = '';
        updateNativeCompositionState('');
        runPendingFitAfterComposition();
      });
    }
    function focusAndMaybeControl(e) {
      if (e && e.target && e.target.closest && e.target.closest('.terminal-scroll-handle')) return;
      if (e && e.type === 'pointerdown' && e.pointerType === 'mouse') return;
      focusTerminalTextarea();
      if (!useMobileInputShim && !isComposing) setTimeout(sendResizeIntent, 0);
    }
    container.addEventListener('pointerdown', focusAndMaybeControl, { passive: true });
    container.addEventListener('touchstart', focusAndMaybeControl, { passive: true });
    container.addEventListener('click', focusAndMaybeControl, { passive: true });
    setTimeout(focusTerminalTextarea, 100);
    setTimeout(function() { if (terminal) { terminal.options.fontFamily = TERM_FONT; if (fitAddon && !terminalUsesRemoteSize && !isComposing) fitAddon.fit(); } }, 300);
    setTimeout(function() { if (terminal) { terminal.options.fontFamily = TERM_FONT; if (fitAddon && !terminalUsesRemoteSize && !isComposing) fitAddon.fit(); } }, 1000);

    var statusDot = $('#connection-status');
    var wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = wsProto + '//' + location.host + '/ws?token=' + token + '&session=' + encodeURIComponent(sessionName);
    if (deviceId) wsUrl += '&deviceId=' + encodeURIComponent(deviceId);
    clientId = 'web:' + (deviceId || 'local') + ':' + sessionName + ':' + Date.now();
    waitingForRemoteSize = !!deviceId;
    currentWs = new WebSocket(wsUrl);

    var termEl = container.querySelector('.xterm');
    if (termEl) setupTouchScroll(termEl, function(lines) {
      if (currentWs && currentWs.readyState === WebSocket.OPEN)
        currentWs.send(JSON.stringify({ type: 'scroll', lines: lines }));
    }, !!deviceId);

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
        if (statusDot) statusDot.className = 'status-dot connected';
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
      } catch(err) { window.__agentTermLastWsError = String(err && err.message || err); }
    };
    currentWs.onclose = function() {
      statusDot.className = 'status-dot disconnected';
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
      if (viewportHandler && window.visualViewport) { window.visualViewport.removeEventListener('resize', viewportHandler); viewportHandler = null; }
      if (viewportScrollHandler && window.visualViewport) { window.visualViewport.removeEventListener('scroll', viewportScrollHandler); viewportScrollHandler = null; }
    };
    currentWs.onerror = function() { statusDot.className = 'status-dot disconnected'; };

    terminal.onData(function(data) {
      if (useMobileInputShim) return;
      data = data.replace(/\x1b\[(?:\?|>)?[0-9;]*c/g, '').replace(/(?:\??|>?)[0-9;]+c/g, '');
      if (!data) return;
      var activeDraft = isComposing ? (compositionFilterDraft || compositionDraft) : (recentCompositionFilterDraft || recentCompositionDraft);
      if (activeDraft && /^[\x00-\x7f]+$/.test(data)) {
        var draft = activeDraft.replace(/\s+/g, '');
        var compact = data.replace(/\s+/g, '');
        if (data === activeDraft || compact === draft || draft.indexOf(compact) === 0 || compact.indexOf(draft) === 0) return;
      }
      if (isComposing && /^[\x20-\x7e]+$/.test(data)) return;
      // xterm emits committed IME candidates here after compositionend. Draft pinyin is
      // dropped above so it does not leak into the shell as a command.
      sendTerminalInput(data);
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
        var header = page && page.querySelector('.terminal-header');
        var visibleHeight = Math.max(120, Math.floor(vp.height));
        var headerHeight = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
        document.documentElement.style.setProperty('--vh', visibleHeight + 'px');
        document.documentElement.style.setProperty('--terminal-keyboard-gap', '0px');
        if (page) {
          page.style.position = 'fixed';
          page.style.left = Math.floor(vp.offsetLeft || 0) + 'px';
          page.style.right = 'auto';
          page.style.top = Math.floor(vp.offsetTop || 0) + 'px';
          page.style.width = Math.floor(vp.width || window.innerWidth) + 'px';
          page.style.height = visibleHeight + 'px';
          page.style.maxHeight = visibleHeight + 'px';
          page.style.transform = 'none';
        }
        if (container) {
          container.style.height = Math.max(80, visibleHeight - headerHeight) + 'px';
          container.style.maxHeight = Math.max(80, visibleHeight - headerHeight) + 'px';
        }
        var shim = mobileInputShim;
        if (shim) {
          shim.style.position = 'fixed';
          shim.style.left = '0px';
          shim.style.top = Math.max(0, visibleHeight + (vp.offsetTop || 0) - 34) + 'px';
          shim.style.width = '100vw';
          shim.style.height = '32px';
        }
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
        if (fitAddon) {
          if (viewportFitTimer) clearTimeout(viewportFitTimer);
          viewportFitTimer = setTimeout(function() {
            viewportFitTimer = null;
            if (isComposing) { pendingFitAfterComposition = true; return; }
            try { if (fitAddon) fitAddon.fit(); } catch(err) {}
            if (useMobileInputShim) {
              sendResizeIntent();
            } else if (!terminalUsesRemoteSize && !waitingForRemoteSize && resizeRole === 'controller') {
              scheduleFitResize();
            } else {
              refreshTerminalView(false, false);
            }
            if (terminal) terminal.scrollToBottom();
          }, 80);
        }
      };
      viewportScrollHandler = function() { window.scrollTo(0, 0); if (viewportHandler) viewportHandler(); };
      window.visualViewport.addEventListener('resize', viewportHandler);
      window.visualViewport.addEventListener('scroll', viewportScrollHandler);
      viewportHandler();
    }

  }

  $('#back-btn').addEventListener('click', function() { cleanupTerminal(); loadSessions(); });

  // --- Global viewport fix for mobile keyboards ---
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      if (document.querySelector('#terminal-page:not(.hidden) .terminal-mobile-input')) return;
      document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
      document.querySelectorAll('.page:not(.hidden)').forEach(function(p) {
        p.style.position = '';
        p.style.left = '';
        p.style.right = '';
        p.style.top = '';
        p.style.width = '';
        p.style.height = window.visualViewport.height + 'px';
        p.style.maxHeight = window.visualViewport.height + 'px';
        p.style.transform = '';
      });
      window.scrollTo(0, 0);
    });
    document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
  }

  // --- Start ---
  init();
})();
