// mycmux Remote Terminal — Dashboard + Terminal SPA
(function () {
  "use strict";

  // --- Token management ---
  function getToken() {
    var params = new URLSearchParams(window.location.search);
    var tok = params.get("token");
    if (tok) {
      localStorage.setItem("mycmux-token", tok);
      // Clean URL
      history.replaceState(null, "", window.location.pathname + window.location.hash);
      return tok;
    }
    // Check hash for legacy support
    var hash = window.location.hash;
    if (hash.includes("token=")) {
      tok = hash.split("token=")[1].split("&")[0];
      if (tok) {
        localStorage.setItem("mycmux-token", tok);
        window.location.hash = "#/dashboard";
        return tok;
      }
    }
    return localStorage.getItem("mycmux-token");
  }

  // --- State ---
  var ws = null;
  var term = null;
  var fitAddon = null;
  var reconnectDelay = 1000;
  var reconnectTimer = null;
  var ctrlActive = false;
  var altActive = false;
  var refreshInterval = null;
  var currentSessionId = null;
  var currentView = null; // "dashboard" or "terminal"
  var pingTimer = null;
  var lastPongTime = 0;
  var disconnectTime = 0;
  var reconnectEnabled = false;
  var reconnectAttempts = 0;
  var pendingWrites = 0;
  var flowPaused = false;

  // --- DOM refs ---
  var dashboardView = document.getElementById("dashboard-view");
  var terminalView = document.getElementById("terminal-view");
  var workspaceList = document.getElementById("workspace-list");
  var sessionInfo = document.getElementById("session-info");
  var overlay = document.getElementById("status-overlay");
  var statusText = document.getElementById("status-text");
  var retryBtn = document.getElementById("retry-btn");
  var refreshBtn = document.getElementById("refresh-btn");
  var connDot = document.getElementById("conn-dot");
  var reconnectToast = document.getElementById("reconnect-toast");
  var approvalBar = document.getElementById("approval-bar");
  var approvalLabel = document.getElementById("approval-label");
  var approveBtn = document.getElementById("approve-btn");
  var denyBtn = document.getElementById("deny-btn");
  var promptBar = document.getElementById("prompt-bar");
  var promptInput = document.getElementById("prompt-input");
  var promptSend = document.getElementById("prompt-send");
  var agentStatusEl = document.getElementById("agent-status");
  var toolbar = document.getElementById("toolbar");
  var agentState = "idle"; // "idle" | "working" | "waiting"

  // --- Agent status detection (from terminal output) ---
  function detectAgentStatus(text) {
    var stripped = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!stripped) return;

    // Approval prompt detection
    var isApproval = /allow\s+.*\?\s*\(y\/n\)/i.test(stripped) ||
      /\(y\/n\)\s*$/i.test(stripped) ||
      /\[y\/N\]/i.test(stripped) ||
      /type your (answer|response)/i.test(stripped);

    if (isApproval) {
      setAgentState("waiting");
      showApprovalBar(stripped);
      return;
    }

    // Working detection (spinners, "working...")
    var isSpinner = /[\u2800-\u28FF\u25CF\u25CB\u25D0-\u25D3]/.test(stripped);
    var isWorking = isSpinner || /working\.\.\./i.test(stripped);
    if (isWorking) {
      setAgentState("working");
      hideApprovalBar();
      return;
    }

    // Idle detection (shell prompt)
    if (/^>\s*$/.test(stripped) || /\$\s*$/.test(stripped)) {
      setAgentState("idle");
      hideApprovalBar();
    }
  }

  function setAgentState(state) {
    agentState = state;
    if (!agentStatusEl) return;
    agentStatusEl.className = "status-" + state;
    agentStatusEl.textContent = state === "working" ? "Working..." : state === "waiting" ? "Waiting" : "Idle";

    // Show/hide prompt bar based on state
    if (promptBar) {
      if (state === "idle" && currentView === "terminal") {
        promptBar.classList.remove("hidden");
      } else {
        promptBar.classList.add("hidden");
      }
    }

    // Show/hide toolbar (hide when approval bar is visible)
    if (toolbar) {
      toolbar.style.display = (state === "waiting") ? "none" : "";
    }
  }

  function showApprovalBar(text) {
    if (!approvalBar) return;
    // Extract tool name from "Allow Bash? (y/n)" pattern
    var match = text.match(/allow\s+(\w+)/i);
    approvalLabel.textContent = match ? "Allow " + match[1] + "?" : "Approve?";
    approvalBar.classList.remove("hidden");
  }

  function hideApprovalBar() {
    if (!approvalBar) return;
    approvalBar.classList.add("hidden");
  }

  // --- Connection indicator ---
  function setConnState(state) {
    if (!connDot) return;
    connDot.className = "conn-dot " + state;
  }

  function showToast(msg) {
    if (!reconnectToast) return;
    reconnectToast.textContent = msg;
    reconnectToast.classList.remove("hidden");
  }

  function hideToast() {
    if (!reconnectToast) return;
    reconnectToast.classList.add("hidden");
  }

  // --- Status overlay ---
  function showStatus(msg, showRetry) {
    statusText.textContent = msg;
    overlay.classList.remove("hidden");
    if (showRetry) {
      retryBtn.classList.remove("hidden");
    } else {
      retryBtn.classList.add("hidden");
    }
  }

  function hideStatus() {
    overlay.classList.add("hidden");
    retryBtn.classList.add("hidden");
  }

  // --- Router ---
  function navigate(hash) {
    window.location.hash = hash;
  }

  function onRoute() {
    var hash = window.location.hash || "#/dashboard";
    if (hash.startsWith("#/terminal/")) {
      var rest = hash.slice("#/terminal/".length);
      var qIdx = rest.indexOf("?");
      var sid = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
      var label = "";
      if (qIdx >= 0) {
        try { label = new URLSearchParams(rest.slice(qIdx)).get("label") || ""; } catch(e) {}
      }
      showTerminal(sid, label);
    } else {
      showDashboard();
    }
  }

  // --- Dashboard ---
  function startAutoRefresh() {
    stopAutoRefresh();
    refreshInterval = setInterval(loadState, 3000);
  }

  function stopAutoRefresh() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  function loadState() {
    var token = getToken();
    if (!token) {
      renderNoToken();
      return;
    }

    fetch("/api/state?token=" + encodeURIComponent(token))
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        renderDashboard(data.workspaces || []);
      })
      .catch(function (err) {
        console.error("loadState error:", err);
        renderError("Connection failed: " + err.message);
      });
  }

  function renderNoToken() {
    workspaceList.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-icon">&#x1F511;</div>' +
      '<div class="empty-state-title">No token</div>' +
      '<div class="empty-state-desc">Scan the QR code or open the link from mycmux to connect.</div>' +
      "</div>";
  }

  function renderError(msg) {
    workspaceList.innerHTML =
      '<div class="error-state">' +
      '<div class="error-state-icon">&#x26A0;</div>' +
      '<div class="error-state-msg">' + escHtml(msg) + "</div>" +
      '<button class="error-state-retry" onclick="location.reload()">Retry</button>' +
      "</div>";
  }

  function renderDashboard(workspaces) {
    if (!workspaces.length) {
      workspaceList.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-icon">&#x1F4BB;</div>' +
        '<div class="empty-state-title">No workspaces running</div>' +
        '<div class="empty-state-desc">Start a mycmux workspace on your PC, then refresh.</div>' +
        '<button class="empty-state-action" onclick="location.reload()">Refresh</button>' +
        "</div>";
      return;
    }

    var html = "";
    for (var i = 0; i < workspaces.length; i++) {
      var ws = workspaces[i];
      html += '<div class="workspace-card">';
      html += '<div class="workspace-card-header">';
      html += '<span class="workspace-name">' + escHtml(ws.name) + "</span>";
      var paneCount = (ws.panes || []).length;
      html += '<span class="session-count">' + paneCount + "</span>";
      if (ws.grid_template) {
        html += '<span class="grid-badge">' + escHtml(ws.grid_template) + "</span>";
      }
      html += "</div>";

      var panes = ws.panes || [];
      for (var j = 0; j < panes.length; j++) {
        var pane = panes[j];
        var meta = pane.metadata || {};
        var isActive = pane.active;

        html += '<div class="pane-row">';
        html += '<div class="pane-indicator ' + (isActive ? "active" : "inactive") + '"></div>';
        html += '<div class="pane-info">';

        if (pane.label) {
          html += '<span class="pane-label">' + escHtml(pane.label) + "</span>";
        }

        html += '<div class="pane-meta-row">';
        if (meta.cwd) {
          html += '<span class="pane-cwd" title="' + escAttr(meta.cwd) + '">' + escHtml(shortenPath(meta.cwd)) + "</span>";
        }
        if (meta.git_branch) {
          html += '<span class="pane-branch">' + escHtml(meta.git_branch) + "</span>";
        }
        html += "</div>";

        if (meta.process_name) {
          html += '<span class="pane-process">' + escHtml(meta.process_name) + "</span>";
        }

        html += "</div>"; // .pane-info
        html += '<button class="pane-connect" data-session="' + escAttr(pane.session_id) + '" data-label="' + escAttr(pane.label || "") + '">Connect</button>';
        html += "</div>"; // .pane-row
      }

      html += "</div>"; // .workspace-card
    }

    workspaceList.innerHTML = html;

    // Attach event listeners
    var connectBtns = workspaceList.querySelectorAll(".pane-connect");
    for (var k = 0; k < connectBtns.length; k++) {
      connectBtns[k].addEventListener("click", function () {
        var label = this.dataset.label || "";
        navigate("#/terminal/" + this.dataset.session + (label ? "?label=" + encodeURIComponent(label) : ""));
      });
    }
  }

  function escHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function escAttr(s) {
    return escHtml(s);
  }

  function shortenPath(p) {
    if (!p) return "";
    // Show last 2 segments
    var parts = p.replace(/\\/g, "/").split("/");
    if (parts.length <= 2) return p;
    return ".../" + parts.slice(-2).join("/");
  }

  // --- Terminal ---
  function initTerminal() {
    if (term) return;

    term = new Terminal({
      cursorBlink: true,
      fontSize: 16,
      fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
      allowProposedApi: true,
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    try {
      var canvasAddon = new CanvasAddon.CanvasAddon();
      term.loadAddon(canvasAddon);
    } catch (e) {
      console.warn("Canvas addon failed, using DOM renderer:", e);
    }

    var container = document.getElementById("terminal-container");
    term.open(container);

    term.onData(function (data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    term.onResize(function (size) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
      }
    });
  }

  function connectWs(sessionId) {
    disconnectWs();
    currentSessionId = sessionId;
    reconnectEnabled = true;
    setConnState("connecting");

    var token = getToken();
    if (!token) {
      showStatus("No token", true);
      return;
    }

    showStatus("Connecting...");

    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/ws?token=" + encodeURIComponent(token) + "&session=" + encodeURIComponent(sessionId);

    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      hideStatus();
      hideToast();
      setConnState("connected");
      reconnectDelay = 1000;
      reconnectAttempts = 0;
      disconnectTime = 0;
      pendingWrites = 0;
      flowPaused = false;

      // Fit terminal and send resize at multiple timings
      function fitAndResize() {
        if (fitAddon) fitAddon.fit();
        if (term && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      }
      setTimeout(fitAndResize, 50);
      setTimeout(fitAndResize, 300);
      setTimeout(fitAndResize, 800);

      // Focus terminal after scrollback replay
      setTimeout(function () { if (term) term.focus(); }, 200);

      // Start keepalive ping
      startPing();
    };

    ws.onmessage = function (event) {
      if (!term) return;
      if (event.data instanceof ArrayBuffer) {
        // Detect agent status from output
        try {
          var chunk = new TextDecoder().decode(event.data);
          detectAgentStatus(chunk);
        } catch(e) {}
        // Flow control: track pending writes
        pendingWrites++;
        term.write(new Uint8Array(event.data), function () {
          pendingWrites--;
          // Low water mark: resume if we were paused
          if (flowPaused && pendingWrites < 2) {
            flowPaused = false;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resume" }));
            }
          }
        });
        // High water mark: pause server output
        if (!flowPaused && pendingWrites > 5) {
          flowPaused = true;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pause" }));
          }
        }
      } else {
        try {
          var msg = JSON.parse(event.data);
          if (msg.type === "connected") {
            sessionInfo.textContent = shortenSessionId(msg.session_id || sessionId);
          } else if (msg.type === "pong") {
            lastPongTime = Date.now();
          } else if (msg.type === "error") {
            reconnectEnabled = false;
            showToast(msg.msg || "Error");
            setConnState("disconnected");
            setTimeout(function () { navigate("#/dashboard"); }, 2000);
          } else if (msg.type === "exit") {
            reconnectEnabled = false;
            term.write("\r\n[Process exited with code " + msg.code + "]\r\n");
            setConnState("disconnected");
          }
        } catch (e) {
          term.write(event.data);
        }
      }
    };

    ws.onclose = function () {
      stopPing();
      setConnState("disconnected");
      if (reconnectEnabled && currentView === "terminal" && currentSessionId === sessionId) {
        if (!disconnectTime) disconnectTime = Date.now();
        var elapsed = Date.now() - disconnectTime;
        if (elapsed < 60000) {
          // Brief disconnect: small toast, keep terminal visible
          reconnectAttempts++;
          showToast("Reconnecting #" + reconnectAttempts + " (" + Math.ceil(reconnectDelay / 1000) + "s)");
          scheduleReconnect(sessionId);
        } else {
          // Long disconnect: full overlay
          showStatus("Disconnected", true);
        }
      }
    };

    ws.onerror = function () {
      if (ws) ws.close();
    };
  }

  function disconnectWs() {
    stopPing();
    reconnectEnabled = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
  }

  function scheduleReconnect(sessionId) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () {
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      connectWs(sessionId);
    }, reconnectDelay);
  }

  function startPing() {
    stopPing();
    lastPongTime = Date.now();
    pingTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Check for zombie connection (no pong within 45s)
        if (Date.now() - lastPongTime > 45000) {
          console.warn("[remote] No pong received in 45s, reconnecting");
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function shortenSessionId(sid) {
    if (!sid) return "";
    var parts = sid.split("-");
    if (parts.length > 6) {
      return parts.slice(-2).join("-");
    }
    return sid.length > 20 ? "..." + sid.slice(-16) : sid;
  }


  // --- View switching ---
  function showTerminal(sessionId, label) {
    currentView = "terminal";
    stopAutoRefresh();

    dashboardView.classList.add("hidden");
    terminalView.classList.remove("hidden");

    initTerminal();
    sessionInfo.textContent = label || shortenSessionId(sessionId);

    // Only clear when switching to a DIFFERENT session
    if (currentSessionId !== sessionId && term) {
      term.clear();
    }

    connectWs(sessionId);

    // Fit at multiple timings to ensure layout is correct
    function doFit() {
      if (fitAddon) {
        fitAddon.fit();
        // Send resize to server after fit
        if (term && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      }
    }
    setTimeout(function () { doFit(); if (term) term.focus(); }, 100);
    setTimeout(doFit, 500);
    setTimeout(doFit, 1000);
  }

  function showDashboard() {
    currentView = "dashboard";
    currentSessionId = null;

    disconnectWs();
    hideStatus();
    hideToast();
    setConnState("");

    terminalView.classList.add("hidden");
    dashboardView.classList.remove("hidden");

    loadState();
    startAutoRefresh();
  }
  // --- Viewport resize (iOS keyboard) ---
  var resizeDebounceTimer = null;
  function handleResize() {
    if (currentView === "terminal" && fitAddon) {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(function () {
        fitAddon.fit();
      }, 150);
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResize);
  }
  window.addEventListener("resize", handleResize);

  // --- Touch toolbar ---
  var DIRECT_SEQS = {
    "enter": "\r",
    "bs": "\x7f",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "ctrl-z": "\x1a"
  };

  var SPECIAL_KEYS = {
    Escape: "\x1b",
    Tab: "\t",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
  };

  document.getElementById("toolbar").addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn || !term) return;

    var modifier = btn.dataset.modifier;
    var action = btn.dataset.action;
    var key = btn.dataset.key;
    var seq = btn.dataset.seq;

    if (modifier === "ctrl") {
      ctrlActive = !ctrlActive;
      btn.classList.toggle("active", ctrlActive);
      if (ctrlActive) {
        altActive = false;
        document.getElementById("alt-btn").classList.remove("active");
      }
      term.focus();
      return;
    }

    if (modifier === "alt") {
      altActive = !altActive;
      btn.classList.toggle("active", altActive);
      if (altActive) {
        ctrlActive = false;
        document.getElementById("ctrl-btn").classList.remove("active");
      }
      term.focus();
      return;
    }

    var data = DIRECT_SEQS[action] || seq || SPECIAL_KEYS[key] || "";
    if (!data) return;

    if (ctrlActive && data.length === 1) {
      var code = data.toUpperCase().charCodeAt(0);
      if (code >= 65 && code <= 90) {
        data = String.fromCharCode(code - 64);
      }
      ctrlActive = false;
      document.getElementById("ctrl-btn").classList.remove("active");
    }

    if (altActive) {
      data = "\x1b" + data;
      altActive = false;
      document.getElementById("alt-btn").classList.remove("active");
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data));
    }
    term.focus();
  });

  // Long-press repeat for arrow keys
  var repeatTimer = null;
  var repeatInterval = null;
  document.getElementById("toolbar").addEventListener("touchstart", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    var key = btn.dataset.key;
    if (!key || !SPECIAL_KEYS[key]) return;
    var seq = SPECIAL_KEYS[key];
    // Start repeat after 400ms hold, then every 80ms
    repeatTimer = setTimeout(function () {
      repeatInterval = setInterval(function () {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(seq));
        }
      }, 80);
    }, 400);
  }, { passive: true });

  function stopRepeat() {
    if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
    if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
  }
  document.getElementById("toolbar").addEventListener("touchend", stopRepeat);
  document.getElementById("toolbar").addEventListener("touchcancel", stopRepeat);

  // --- Approval buttons ---
  if (approveBtn) {
    approveBtn.addEventListener("click", function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode("y\n"));
      }
      hideApprovalBar();
      setAgentState("working");
      if (term) term.focus();
    });
  }
  if (denyBtn) {
    denyBtn.addEventListener("click", function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode("n\n"));
      }
      hideApprovalBar();
      setAgentState("working");
      if (term) term.focus();
    });
  }

  // --- Prompt input ---
  if (promptSend) {
    promptSend.addEventListener("click", function () {
      var text = promptInput.value.trim();
      if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(text + "\n"));
        promptInput.value = "";
        setAgentState("working");
      }
    });
  }
  if (promptInput) {
    promptInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        promptSend.click();
      }
    });
  }

  // --- Button handlers ---
  document.getElementById("back-btn").addEventListener("click", function () {
    navigate("#/dashboard");
  });

  document.getElementById("refresh-btn").addEventListener("click", function () {
    refreshBtn.classList.add("spinning");
    setTimeout(function () { refreshBtn.classList.remove("spinning"); }, 600);
    loadState();
  });

  document.getElementById("new-session-btn").addEventListener("click", function () {
    navigate("#/terminal/new");
  });

  retryBtn.addEventListener("click", function () {
    if (currentView === "terminal" && currentSessionId) {
      reconnectDelay = 1000;
      disconnectTime = 0;
      reconnectAttempts = 0;
      hideStatus();
      connectWs(currentSessionId);
    } else {
      hideStatus();
      loadState();
    }
  });

  // --- Visibility ---
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopAutoRefresh();
    } else {
      if (currentView === "dashboard") {
        loadState();
        startAutoRefresh();
      } else if (currentView === "terminal") {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          if (currentSessionId) {
            reconnectDelay = 1000;
            disconnectTime = 0;
            reconnectAttempts = 0;
            connectWs(currentSessionId);
          }
        }
      }
    }
  });

  // --- Boot ---
  window.addEventListener("hashchange", onRoute);
  onRoute();
})();
