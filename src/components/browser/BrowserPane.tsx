import { memo, useState, useRef, useEffect } from "react";
import { useBrowserStore } from "../../stores/browserStore";

interface BrowserPaneProps {
  sessionId: string;
}

export default memo(function BrowserPane({ sessionId }: BrowserPaneProps) {
  const [url, setUrl] = useState("about:blank");
  const [inputUrl, setInputUrl] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const navigate = (target: string) => {
    let normalized = target.trim();
    if (normalized && !normalized.startsWith("http://") && !normalized.startsWith("https://") && !normalized.startsWith("about:")) {
      normalized = "https://" + normalized;
    }
    const finalUrl = normalized || "about:blank";
    setUrl(finalUrl);
    setInputUrl(normalized || "");
    setBlocked(false);
    setIsLoading(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      navigate(inputUrl);
    }
  };

  const handleBack = () => iframeRef.current?.contentWindow?.history.back();
  const handleForward = () => iframeRef.current?.contentWindow?.history.forward();
  const handleRefresh = () => iframeRef.current?.contentWindow?.location.reload();

  // Relay keydown events from iframe to parent window so AppShell keybindings fire
  const handleIframeLoad = () => {
    setIsLoading(false);
    try {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin) return;
      iframeWin.addEventListener("keydown", (e: KeyboardEvent) => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: e.key, code: e.code, ctrlKey: e.ctrlKey,
          altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
          bubbles: true, cancelable: true,
        }));
      });
    } catch {
      // Cross-origin iframes block contentWindow access — skip silently
    }
  };

  // Execute browser commands dispatched via browserStore
  const pendingCommand = useBrowserStore((s) => s.commands[sessionId]);
  const completeCommand = useBrowserStore((s) => s.complete);

  useEffect(() => {
    if (!pendingCommand) return;
    const { type, url: cmdUrl, script, resolve, reject } = pendingCommand;

    const exec = async () => {
      try {
        switch (type) {
          case "navigate":
            navigate(cmdUrl ?? "about:blank");
            resolve({ success: true });
            break;

          case "back":
            iframeRef.current?.contentWindow?.history.back();
            resolve({ success: true });
            break;

          case "forward":
            iframeRef.current?.contentWindow?.history.forward();
            resolve({ success: true });
            break;

          case "reload":
            iframeRef.current?.contentWindow?.location.reload();
            resolve({ success: true });
            break;

          case "eval": {
            const win = iframeRef.current?.contentWindow as any;
            if (!win) { reject("No iframe window"); break; }
            // eslint-disable-next-line no-eval
            const evalResult = win.eval(script ?? "");
            resolve({ result: evalResult });
            break;
          }

          case "snapshot": {
            const doc = iframeRef.current?.contentDocument;
            if (!doc) { reject("Cross-origin or no document"); break; }
            resolve({ html: doc.body?.outerHTML ?? "" });
            break;
          }

          case "screenshot": {
            // Screenshot requires same-origin access to the iframe's document
            const iframeDoc = iframeRef.current?.contentDocument;
            if (!iframeDoc) { reject("Cross-origin: cannot screenshot"); break; }
            // Return a placeholder — full screenshot requires native capture
            resolve({ data_url: null, note: "Screenshot via canvas not supported; use native capture" });
            break;
          }

          case "status": {
            const win = iframeRef.current?.contentWindow;
            const doc = iframeRef.current?.contentDocument;
            resolve({
              url: win?.location?.href ?? url,
              title: doc?.title ?? "",
              loading: isLoading,
            });
            break;
          }

          default:
            reject(`Unknown command type: ${type}`);
        }
      } catch (err: any) {
        reject(err?.message ?? String(err));
      } finally {
        completeCommand(sessionId);
      }
    };

    exec();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCommand]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#111" }}>
      {/* URL bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 8px",
          background: "#1a1a1a",
          borderBottom: "1px solid var(--cmux-border)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleBack}
          title="Back"
          style={{ background: "none", border: "none", color: "var(--cmux-text-tertiary)", cursor: "pointer", padding: "2px 4px", fontSize: 14 }}
        >
          ‹
        </button>
        <button
          onClick={handleForward}
          title="Forward"
          style={{ background: "none", border: "none", color: "var(--cmux-text-tertiary)", cursor: "pointer", padding: "2px 4px", fontSize: 14 }}
        >
          ›
        </button>
        <button
          onClick={handleRefresh}
          title="Refresh"
          style={{ background: "none", border: "none", color: "var(--cmux-text-tertiary)", cursor: "pointer", padding: "2px 4px", fontSize: 12 }}
        >
          ↻
        </button>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={(e) => e.target.select()}
          placeholder="Enter URL..."
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid var(--cmux-border)",
            borderRadius: 4,
            color: "var(--cmux-text)",
            fontSize: 12,
            fontFamily: "monospace",
            padding: "3px 8px",
            outline: "none",
          }}
        />
      </div>
      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
        {url === "about:blank" ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--cmux-text-tertiary)",
              gap: 8,
              fontFamily: "monospace",
              fontSize: 13,
            }}
          >
            <span style={{ fontSize: 32 }}>🌐</span>
            <span>Enter a URL above to browse</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Note: some sites (Google, Twitter) block embedding</span>
          </div>
        ) : blocked ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--cmux-text-tertiary)",
              gap: 8,
              fontFamily: "monospace",
              fontSize: 13,
            }}
          >
            <span style={{ fontSize: 32 }}>🚫</span>
            <span>This site refuses to be embedded</span>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{url}</span>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={url}
            style={{ flex: 1, border: "none", width: "100%", height: "100%" }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"
            onLoad={handleIframeLoad}
            onError={() => setBlocked(true)}
          />
        )}
      </div>
    </div>
  );
});
