// mycmux Remote Terminal — Dashboard + Terminal SPA
var RemoteTransport = {
  applyControlMessage: function (state, msg) {
    var lastEnd = state && state.lastEnd;
    var epoch = state && state.epoch;
    var dropLastEnd = false;
    if (msg && typeof msg.session_epoch === "number") {
      if (epoch != null && Number(epoch) !== Number(msg.session_epoch)) {
        lastEnd = undefined;
        dropLastEnd = true;
      }
      epoch = msg.session_epoch;
    }
    var shouldReset = !!(msg && msg.resync);
    // A wiped display cannot keep a receive cursor: the next since= would
    // append a delta onto an empty screen.
    if (shouldReset) {
      lastEnd = undefined;
      dropLastEnd = true;
    }
    return {
      lastEnd: lastEnd,
      epoch: epoch,
      dropLastEnd: dropLastEnd,
      shouldReset: shouldReset,
      acceptsResize: !!(msg && msg.accepts_resize),
      hasAcceptsResize: !!(msg && typeof msg.accepts_resize === "boolean"),
      mode: msg && (msg.mode === "control" || msg.mode === "view") ? msg.mode : undefined,
      cols: msg && msg.cols ? msg.cols : undefined,
      rows: msg && msg.rows ? msg.rows : undefined
    };
  },
  applyBinaryFrame: function (state, frameEnd) {
    return {
      lastEnd: frameEnd,
      epoch: state && state.epoch
    };
  },
  sinceForReconnect: function (lastEnd, epoch) {
    var out = {};
    if (typeof lastEnd === "number") out.since = lastEnd;
    if (typeof epoch === "number") out.epoch = epoch;
    return out;
  },
  // Pair "discard the local display" with "forget the receive cursor".
  // Callers must apply both fields; a clear that keeps lastEnd is N-1.
  discardDisplay: function (state) {
    return {
      lastEnd: undefined,
      dropLastEnd: true,
      shouldClear: true,
      epoch: state && state.epoch
    };
  },
  defaultFontSize: function (isTouch) {
    return isTouch ? 13 : 16;
  },
  // FitAddon must never run at a view-mode shrink (down to 6px) or it
  // invents a huge cols/rows and resizes the remote PTY.
  fontSizeForFit: function (isTouch) {
    return RemoteTransport.defaultFontSize(isTouch);
  },
  freshSessionSurface: function () {
    return {
      acceptsResize: false,
      serverCols: 0,
      serverRows: 0
    };
  },
  fontSizeToFit: function (containerW, containerH, cols, rows, cellW, cellH, sampleSize, minSize, maxSize) {
    minSize = minSize == null ? 6 : minSize;
    maxSize = maxSize == null ? 20 : maxSize;
    sampleSize = sampleSize == null ? 16 : sampleSize;
    if (!containerW || !containerH || !cols || !rows || !cellW || !cellH || !sampleSize) {
      return minSize;
    }
    var size = Math.min(
      containerW / (cols * (cellW / sampleSize)),
      containerH / (rows * (cellH / sampleSize)),
      maxSize
    );
    return Math.max(minSize, size);
  }
};

if (typeof globalThis !== "undefined") {
  globalThis.RemoteTransport = RemoteTransport;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = RemoteTransport;
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;

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
  var promptComposing = false;
  var lastEndBySession = {};
  var epochBySession = {};
  var currentMode = "view";
  var acceptsResize = false;
  var serverCols = 0;
  var serverRows = 0;

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

  function isTouchDevice() {
    return window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  }

  function updateAppHeight() {
    var height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", Math.max(320, height) + "px");
  }

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

    // Keep the staged input available on mobile. It is the reliable path for IME text.
    if (promptBar) {
      if (state === "waiting" || currentView !== "terminal") {
        promptBar.classList.add("hidden");
      } else {
        promptBar.classList.remove("hidden");
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
      try { sid = decodeURIComponent(sid); } catch(e) {}
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
      html += '<div class="workspace-card" data-grid="' + escAttr(ws.grid_template || "free") + '">';
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
        var agentKind = normalizeAgentKind(meta.agent_kind || meta.process_name || "");

        html += '<div class="pane-row">';
        html += '<div class="pane-indicator ' + (isActive ? "active" : "inactive") + '"></div>';
        html += '<div class="pane-info">';

        html += '<div class="pane-title-row">';
        if (pane.label) {
          html += '<span class="pane-label">' + escHtml(pane.label) + "</span>";
        }
        html += '<span class="pane-status ' + (isActive ? "active" : "inactive") + '">' + (isActive ? "active" : "inactive") + "</span>";
        if (agentKind) {
          html += '<span class="agent-badge ' + escAttr(agentKind) + '">' + escHtml(agentKind) + "</span>";
        }
        if (meta.updated_at) {
          html += '<span class="pane-time">' + escHtml(relativeTime(meta.updated_at)) + "</span>";
        }
        html += "</div>";

        html += '<div class="pane-meta-row">';
        if (meta.cwd) {
          html += '<span class="pane-cwd" title="' + escAttr(meta.cwd) + '">' + escHtml(shortenPath(meta.cwd)) + "</span>";
        }
        if (meta.git_branch) {
          html += '<span class="pane-branch">' + escHtml(meta.git_branch) + "</span>";
        }
        html += "</div>";

        if (meta.process_name) {
          html += '<span class="pane-detail">' + escHtml(meta.process_name) + "</span>";
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
        navigate("#/terminal/" + encodeURIComponent(this.dataset.session) + (label ? "?label=" + encodeURIComponent(label) : ""));
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

  function normalizeAgentKind(value) {
    var lower = String(value || "").toLowerCase();
    if (lower.includes("claude-codex")) return "claude-codex";
    if (lower.includes("grok")) return "grok";
    if (lower.includes("claude")) return "claude";
    if (lower.includes("codex")) return "codex";
    return "";
  }

  function relativeTime(value) {
    var time = typeof value === "number" ? value : Date.parse(value);
    if (!time || Number.isNaN(time)) return "";
    var diff = Math.max(0, Date.now() - time);
    var sec = Math.floor(diff / 1000);
    if (sec < 45) return "now";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + "m ago";
    var hour = Math.floor(min / 60);
    if (hour < 24) return hour + "h ago";
    return Math.floor(hour / 24) + "d ago";
  }

  // --- Terminal ---
  function initTerminal() {
    if (term) return true;

    if (typeof Terminal === "undefined" || typeof FitAddon === "undefined") {
      showStatus("Terminal assets are still loading. Reload if this stays.", true);
      return false;
    }

    term = new Terminal({
      cursorBlink: true,
      fontSize: RemoteTransport.defaultFontSize(isTouchDevice()),
      fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace",
      scrollback: 1200,
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

    var container = document.getElementById("terminal-container");
    term.open(container);

    term.onData(function (data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    term.onResize(function (size) {
      if (!acceptsResize) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
      }
    });

    return true;
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

    showStatus("Connecting to " + location.host + "...");

    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/ws?token=" + encodeURIComponent(token)
      + "&session=" + encodeURIComponent(sessionId)
      + "&mode=" + encodeURIComponent(currentMode || "view");
    var resumeQuery = RemoteTransport.sinceForReconnect(
      lastEndBySession[sessionId],
      epochBySession[sessionId]
    );
    if (typeof resumeQuery.since === "number") {
      url += "&since=" + String(resumeQuery.since);
    }
    if (typeof resumeQuery.epoch === "number") {
      url += "&epoch=" + String(resumeQuery.epoch);
    }
    var opened = false;
    var connectTimer = null;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      reconnectEnabled = false;
      setConnState("disconnected");
      showStatus("WebSocket failed: " + e.message, true);
      return;
    }
    ws.binaryType = "arraybuffer";

    connectTimer = setTimeout(function () {
      if (!opened && ws && ws.readyState === WebSocket.CONNECTING) {
        reconnectEnabled = false;
        setConnState("disconnected");
        showStatus("WebSocket timeout to " + location.host + ". HTTP loaded, but the session socket did not open.", true);
        try { ws.close(); } catch(e) {}
      }
    }, 8000);

    ws.onopen = function () {
      opened = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      hideStatus();
      hideToast();
      setConnState("connected");
      reconnectDelay = 1000;
      reconnectAttempts = 0;
      disconnectTime = 0;
      pendingWrites = 0;
      flowPaused = false;

      function fitOrScale() {
        if (fitIfAccepted()) {
          if (term && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        } else if (serverCols && serverRows) {
          applyServerGeometry(serverCols, serverRows);
        }
      }
      setTimeout(fitOrScale, 50);
      setTimeout(fitOrScale, 300);
      setTimeout(fitOrScale, 800);

      // Focus terminal after scrollback replay
      setTimeout(function () { if (term && !isTouchDevice()) term.focus(); }, 200);

      // Start keepalive ping
      startPing();
    };

    ws.onmessage = function (event) {
      if (!term) return;
      if (event.data instanceof ArrayBuffer) {
        var payload = decodeFramedOutput(event.data, sessionId);
        if (!payload) return;
        // Detect agent status from output
        try {
          var chunk = new TextDecoder().decode(payload);
          detectAgentStatus(chunk);
        } catch(e) {}
        // Flow control: track pending writes
        pendingWrites++;
        term.write(payload, function () {
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
          if (msg.type === "connected" || msg.type === "resync") {
            handleServerGeometry(msg, sessionId);
          } else if (msg.type === "pong") {
            lastPongTime = Date.now();
          } else if (msg.type === "token_rotated") {
            reconnectEnabled = false;
            localStorage.removeItem("mycmux-token");
            showStatus("Token rotated on PC. Scan the new QR code.", true);
            setConnState("disconnected");
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

    ws.onclose = function (event) {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      stopPing();
      setConnState("disconnected");
      if (!opened) {
        reconnectEnabled = false;
        var code = event && event.code ? " code " + event.code : "";
        showStatus("WebSocket did not connect" + code + ". Check Tailscale and reload.", true);
        return;
      }
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
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (!opened) {
        showStatus("WebSocket error to " + location.host + ". Check Tailscale and reload.", true);
      }
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

    var switchingSession = currentSessionId !== sessionId;
    currentSessionId = sessionId;
    if (!initTerminal()) return;
    sessionInfo.textContent = label || shortenSessionId(sessionId);

    if (switchingSession) {
      var discarded = RemoteTransport.discardDisplay({
        lastEnd: lastEndBySession[sessionId],
        epoch: epochBySession[sessionId]
      });
      if (discarded.shouldClear && term) {
        term.clear();
      }
      if (discarded.dropLastEnd) {
        delete lastEndBySession[sessionId];
      }
      var surface = RemoteTransport.freshSessionSurface();
      acceptsResize = surface.acceptsResize;
      serverCols = surface.serverCols;
      serverRows = surface.serverRows;
    }

    connectWs(sessionId);

    function doFitOrScale() {
      if (fitIfAccepted()) {
        if (term && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } else if (serverCols && serverRows) {
        applyServerGeometry(serverCols, serverRows);
      }
    }
    setTimeout(function () { doFitOrScale(); if (term && !isTouchDevice()) term.focus(); }, 100);
    setTimeout(doFitOrScale, 500);
    setTimeout(doFitOrScale, 1000);
  }

  function showDashboard() {
    currentView = "dashboard";
    // Keep currentSessionId. Nulling it makes a return to the same session
    // look like a switch, which clears the screen while lastEnd survives.

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
    updateAppHeight();
    if (currentView !== "terminal") return;
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(function () {
      if (!fitIfAccepted() && serverCols && serverRows) {
        applyServerGeometry(serverCols, serverRows);
      }
    }, 150);
  }

  function readEndOffset(buf) {
    if (!buf || buf.byteLength < 8) return null;
    var view = new DataView(buf);
    var lo = view.getUint32(0, true);
    var hi = view.getUint32(4, true);
    return hi * 0x100000000 + lo;
  }

  function decodeFramedOutput(buf, sessionId) {
    var end = readEndOffset(buf);
    if (end == null) return null;
    var next = RemoteTransport.applyBinaryFrame({
      lastEnd: lastEndBySession[sessionId],
      epoch: epochBySession[sessionId]
    }, end);
    lastEndBySession[sessionId] = next.lastEnd;
    return new Uint8Array(buf, 8);
  }

  function handleServerGeometry(msg, sessionId) {
    var next = RemoteTransport.applyControlMessage({
      lastEnd: lastEndBySession[sessionId],
      epoch: epochBySession[sessionId]
    }, msg);
    if (next.dropLastEnd) {
      delete lastEndBySession[sessionId];
    }
    if (typeof next.epoch === "number") {
      epochBySession[sessionId] = next.epoch;
    }
    if (next.mode) currentMode = next.mode;
    if (next.hasAcceptsResize) acceptsResize = next.acceptsResize;
    if (next.shouldReset && term) {
      term.reset();
    }
    if (msg.type === "connected") {
      sessionInfo.textContent = shortenSessionId(msg.session_id || sessionId);
    }
    if (next.cols && next.rows) {
      serverCols = next.cols;
      serverRows = next.rows;
      if (!fitIfAccepted()) {
        applyServerGeometry(next.cols, next.rows);
      }
    }
  }

  function applyDefaultFitFontSize() {
    if (!term) return;
    var size = RemoteTransport.fontSizeForFit(isTouchDevice());
    if (Math.abs((term.options.fontSize || 0) - size) > 0.15) {
      term.options.fontSize = size;
    }
  }

  function fitIfAccepted() {
    if (!acceptsResize) return false;
    applyDefaultFitFontSize();
    if (fitAddon) fitAddon.fit();
    return true;
  }

  function measureCellAt(fontSize) {
    var canvas = measureCellAt._c || (measureCellAt._c = document.createElement("canvas"));
    var ctx = canvas.getContext("2d");
    var family = (term && term.options && term.options.fontFamily) || "Menlo, Consolas, monospace";
    ctx.font = fontSize + "px " + family;
    return {
      width: ctx.measureText("W").width,
      height: fontSize * 1.2
    };
  }

  function applyServerGeometry(cols, rows) {
    if (!term || !cols || !rows) return;
    var container = document.getElementById("terminal-container");
    if (!container) return;
    var cw = container.clientWidth;
    var ch = container.clientHeight;
    var sample = 16;
    var cell = measureCellAt(sample);
    var size = RemoteTransport.fontSizeToFit(cw, ch, cols, rows, cell.width, cell.height, sample, 6, 20);
    if (Math.abs((term.options.fontSize || 0) - size) > 0.15) {
      term.options.fontSize = size;
    }
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
    }
    if (term.element) {
      term.element.style.transform = "";
      term.element.style.position = "";
    }
  }

  updateAppHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResize);
    window.visualViewport.addEventListener("scroll", handleResize);
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
  function sendPromptInput() {
    if (!promptInput || !ws || ws.readyState !== WebSocket.OPEN) return;
    var text = promptInput.value;
    if (!text || !text.trim()) return;
    ws.send(new TextEncoder().encode(text + "\n"));
    promptInput.value = "";
    setAgentState("working");
  }

  if (promptSend) {
    promptSend.addEventListener("click", sendPromptInput);
  }
  if (promptInput) {
    promptInput.addEventListener("compositionstart", function () {
      promptComposing = true;
    });
    promptInput.addEventListener("compositionend", function () {
      promptComposing = false;
    });
    promptInput.addEventListener("keydown", function (e) {
      if (promptComposing || e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendPromptInput();
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
      if (!term) {
        showTerminal(currentSessionId, sessionInfo.textContent || "");
      } else {
        connectWs(currentSessionId);
      }
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
