import { memo, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface BrowserPaneProps {
  /** Local absolute path (no file:// prefix). Already normalized by the caller. */
  htmlPath: string;
  /** Bump to force iframe remount when the same htmlPath is re-emitted. */
  reloadKey: number;
}

function BrowserPaneImpl({ htmlPath, reloadKey }: BrowserPaneProps) {
  const src = useMemo(() => convertFileSrc(htmlPath), [htmlPath]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--cmux-popover, #1e1e1e)",
        overflow: "hidden",
      }}
    >
      {/*
        sandbox is intentionally "allow-popups" only — no allow-scripts and no
        allow-same-origin. Sidetab HTML is static report output ($MYCMUX_HTML_OUT),
        so disabling scripts is the desired security posture, not a limitation.
        Do not add allow-scripts without re-reviewing the OSC 9988 path gate.
      */}
      <iframe
        key={`${htmlPath}#${reloadKey}`}
        src={src}
        sandbox="allow-popups"
        title={htmlPath}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
          background: "white",
        }}
      />
    </div>
  );
}

export default memo(BrowserPaneImpl);
