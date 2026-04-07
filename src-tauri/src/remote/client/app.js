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

  // --- DOM refs ---
  var dashboardView = document.getElementById("dashboard-view");
  var terminalView = document.getElementById("terminal-view");
  var workspaceList = document.getElementById("workspace-list");
  var sessionInfo = document.getElementById("session-info");
  var overlay = document.getElementById("status-overlay");
  var statusText = document.getElementById("status-text");
  var retryBtn = document.getElementById("retry-btn");
  var refreshBtn = document.getElementById("refresh-btn");

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
      var sid = hash.slice("#/terminal/".length);
      showTerminal(sid);
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
        html += '<button class="pane-connect" data-session="' + escAttr(pane.session_id) + '">Connect</button>';
        html += "</div>"; // .pane-row
      }

      html += "</div>"; // .workspace-card
    }

    workspaceList.innerHTML = html;

    // Attach event listeners
    var connectBtns = workspaceList.querySelectorAll(".pane-connect");
    for (var k = 0; k < connectBtns.length; k++) {
      connectBtns[k].addEventListener("click", function () {
        navigate("#/terminal/" + this.dataset.session);
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
    var parts = p.replace(/\/g, "/").split("/");
    if (parts.length <= 2) return p;
    return ".../" + parts.slice(-2).join("/");
  }

  // --- Terminal ---
  function initTerminal() {
    if (term) return;

    term = new Terminal({
      cursorBlink: true,
      fontSize: 15,
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
      reconnectDelay = 1000;
      if (fitAddon) {
        setTimeout(function () { fitAddon.fit(); }, 50);
      }
    };

    ws.onmessage = function (event) {
      if (!term) return;
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else {
        try {
          var msg = JSON.parse(event.data);
          if (msg.type === "connected") {
            sessionInfo.textContent = msg.session_id || sessionId;
          } else if (msg.type === "exit") {
            term.write("\r\n[Process exited with code " + msg.code + "]\r\n");
          }
        } catch (e) {
          term.write(event.data);
        }
      }
    };

    ws.onclose = function () {
      if (currentView === "terminal" && currentSessionId === sessionId) {
        scheduleReconnect(sessionId);
      }
    };

    ws.onerror = function () {
      if (ws) ws.close();
    };
  }

  function disconnectWs() {
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
    showStatus("Reconnecting...");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connectWs(sessionId);
    }, reconnectDelay);
  }

  // --- View switching ---
  function showTerminal(sessionId) {
    currentView = "terminal";
    stopAutoRefresh();

    dashboardView.classList.add("hidden");
    terminalView.classList.remove("hidden");

    initTerminal();
    sessionInfo.textContent = sessionId;

    // Clear terminal for fresh connection
    if (term) {
      term.clear();
    }

    connectWs(sessionId);

    // Fit after layout settles
    setTimeout(function () {
      if (fitAddon) fitAddon.fit();
      if (term) term.focus();
    }, 100);
  }

  function showDashboard() {
    currentView = "dashboard";
    currentSessionId = null;

    disconnectWs();
    hideStatus();

    terminalView.classList.add("hidden");
    dashboardView.classList.remove("hidden");

    loadState();
    startAutoRefresh();
  }

  // --- Viewport resize (iOS keyboard) ---
  function handleResize() {
    if (currentView === "terminal" && fitAddon) {
      setTimeout(function () { fitAddon.fit(); }, 100);
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResize);
  }
  window.addEventListener("resize", handleResize);

  // --- Touch toolbar ---
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

    var data = seq || SPECIAL_KEYS[key] || "";
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
        // Reconnect if disconnected
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          if (currentSessionId) {
            reconnectDelay = 1000;
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
