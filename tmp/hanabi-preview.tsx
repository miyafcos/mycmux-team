import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { WinterNightBackground, type NightFrameStats } from "../src/components/theme/WinterNightBackground";
import { buildThemeVars } from "../src/components/layout/themeVars";
import { getTheme } from "../src/components/theme/themeDefinitions";
import { DEFAULT_THEME_BACKGROUND, hanabiRecommendedBackground } from "../src/lib/themeBackgrounds";
import type { CelebrationKind } from "../src/lib/hanabiScene";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { resolveTerminalTheme, buildTerminalOptions } from "../src/components/terminal/terminalOptions";
import { ThemeBackgroundPanel } from "../src/components/theme/ThemeBackgroundPanel";
import { HANABI_SCENES } from "../src/lib/hanabiScenes";
import type { HanabiSceneId } from "../src/types/theme";
import { applyBackgroundPreset } from "../src/lib/theme/backgroundPresets";

const measurements: NightFrameStats[] = [];
const vars = (clear = false) => buildThemeVars({ theme: getTheme("hanabi"), background: { ...hanabiRecommendedBackground(DEFAULT_THEME_BACKGROUND), ...(clear ? applyBackgroundPreset("clear") : {}), mode: "scene" },
  uiDensity: "standard", fontFamily: "Consolas, monospace", fontSize: 13, lineHeight: 1.5, uiFontScale: 1, mediaActive: true });
function LocalTerminal({ echo = false, clear = false }: { echo?: boolean; clear?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({ ...buildTerminalOptions({ fontSize: 13, fontFamily: "Consolas, monospace", lineHeight: 1.5,
      theme: resolveTerminalTheme(getTheme("hanabi").terminal, clear ? 0.15 : 0.25, true), minimumContrastRatio: 7, cursorBlink: false }), cols: 90, rows: 38 });
    term.open(ref.current);
    term.write("\x1b[?25l" + (echo ? '\x1b[36mdev@workstation\x1b[0m MINGW64 ~ (main)\r\n$ echo "✓ Merged pull request #12"\r\n✓ Merged pull request #12\r\n\r\n$ ' : ""));
    (window as any).__previewTerminal = term;
    return () => { term.dispose(); };
  }, [echo, clear]);
  return <div ref={ref} className="local-xterm" />;
}
function Conversation({ sceneId }: { sceneId: HanabiSceneId }) {
  return <div className="conversation"><div className="context">Started on this computer · theme-hanabi · {HANABI_SCENES.find(scene => scene.id === sceneId)!.label}</div>
    <div className="message user">レシピカードに調理時間のバッジを追加して</div>
    <div className="message assistant"><p>カードの構成を確認して、調理時間を追加しました。</p><p className="muted">Read and edited <span className="accent">app.js</span>　<span className="success">+1</span></p>
    <p>すべてのレシピに、ひと目でわかる調理時間が表示されます。</p><p className="muted">レモンタイムのパスタは、平日の夜なら 20 分で完成。</p></div>
    <div className="message user">ship it</div>
    <div className="message assistant"><span className="success">✓</span> テストが通り、pull request が <span className="accent">merged.</span><br/><span className="muted">Cook time badges are live.</span></div>
  </div>;
}
function AppMock({ clear, sceneId, panes, terminalOnly }: { clear: boolean; sceneId: HanabiSceneId; panes: number; terminalOnly: boolean }) {
  return <div className="glass" style={vars(clear)}>
    <div className="title"><i className="dot"/><i className="dot"/><i className="dot"/><span>mycmux</span></div>
    <div className="app-row"><aside className="sidebar"><div className="brand">mycmux</div><small>ワークスペース</small>
      <div className="seat active">{HANABI_SCENES.find(scene => scene.id === sceneId)!.label}</div><div className="seat">プロジェクト</div><small>エージェント</small>
      <div className="seat"><span className="success">●</span> Claude Code</div><div className="seat">Codex</div></aside>
      <section className="work-area"><div className="tabs"><b>Claude Code <span className="success">　✓</span></b><span>ターミナル</span></div>
        <div className="terminal-grid" style={{ gridTemplateColumns: panes === 4 ? "1fr 1fr" : "1fr", gridTemplateRows: panes === 4 ? "1fr 1fr" : "1fr" }}>
          {Array.from({ length: panes }, (_, index) => <div key={index} className="terminal-surface" data-hanabi-terminal-surface="true">
            <LocalTerminal echo={terminalOnly || panes === 4} clear={clear}/>
            {!terminalOnly && panes === 1 && <Conversation sceneId={sceneId}/>}
          </div>)}
        </div>
        <div className="input"><span>シェル:</span><span>メッセージを入力</span></div>
      </section>
    </div></div>;
}
function Preview() {
  const [sceneId, setSceneId] = useState<HanabiSceneId>("winter-night");
  const [view, setView] = useState<"scene" | "gallery" | "settings" | "compare" | "side-by-side">("scene");
  const [before, setBefore] = useState(false);
  const [panes, setPanes] = useState(1);
  const [terminalOnly, setTerminalOnly] = useState(false);
  const [settings, setSettings] = useState(hanabiRecommendedBackground(DEFAULT_THEME_BACKGROUND));
  const [size, setSize] = useState([1280, 800]);
  const [epoch, setEpoch] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [layout, setLayout] = useState(false);
  const [clearGlass, setClearGlass] = useState(false);
  const [frozen, setFrozen] = useState<number | undefined>();
  const [frozenKind, setFrozenKind] = useState<CelebrationKind | undefined>();
  const [manual, setManual] = useState<{ kind: CelebrationKind; nonce: number }>();
  const [stats, setStats] = useState<NightFrameStats>({ fps: 0, averageMs: 0, maxMs: 0, frames: 0 });
  const onStats = useCallback((next: NightFrameStats) => { measurements.push(next); setStats(next); }, []);
  const run = useCallback((kind: CelebrationKind) => { setFrozen(undefined); setManual({ kind, nonce: performance.now() }); }, []);
  useEffect(() => {
    (window as any).__hanabiPreview = {
      run, measurements, stats, mock: (value: boolean) => setLayout(value), scene: (id: HanabiSceneId) => { setSceneId(id); measurements.length = 0; },
      view: (next: typeof view) => setView(next), before: (value: boolean) => setBefore(value), glass: (clear: boolean) => setClearGlass(clear),
      panes: (value: number) => setPanes(value), terminalOnly: (value: boolean) => setTerminalOnly(value),
      size: (w: number, h: number) => setSize([w, h]),
      freeze: (kind: CelebrationKind | undefined, time: number, motion: boolean, mock: boolean) => {
        setFrozen(time); setFrozenKind(kind); setReduced(motion); setLayout(mock); document.body.dataset.capture = "true";
      },
      resume: () => { setManual(undefined); setEpoch(value => value + 1); setFrozen(undefined); setFrozenKind(undefined); setReduced(false); setLayout(false); measurements.length = 0; document.body.dataset.capture = "true"; },
    };
  }, [run, stats]);
  const stage = (id: HanabiSceneId, old = before, width = size[0], height = size[1]) => <div className="stage" data-cmux-themed-root="true" data-cmux-theme="hanabi" style={{ width, height }}>
    <WinterNightBackground key={epoch + "-" + id + "-" + old} sceneId={id} terminalColor={old ? undefined : getTheme("hanabi").terminal.background}
      terminalOpacity={clearGlass ? 0.15 : 0.25} fireworksEnabled sidebarWidth={layout ? 328 : 0} previewMode previewTimeMs={frozen}
      previewFireworks={frozenKind} previewReducedMotion={reduced} manualCelebration={manual} onStats={view === "scene" ? onStats : undefined}/>
    {layout && <AppMock clear={clearGlass} sceneId={id} panes={panes} terminalOnly={terminalOnly || view === "compare"}/>}
  </div>;
  if (view === "gallery" || view === "side-by-side") return <div className={view === "gallery" ? "scene-gallery" : "side-by-side"}>{HANABI_SCENES.map(scene => <figure key={scene.id}>
    <div className="scaled-scene">{stage(scene.id, false, 1280, 800)}</div><figcaption>{scene.label}</figcaption></figure>)}</div>;
  if (view === "compare") return <div className="composition-compare">{[true, false].map(old => <figure key={String(old)}>
    <figcaption>{old ? "修正前の層" : "修正後の層"} · パネル 0.55 / 端末 0.25</figcaption>{stage(sceneId, old, 1280, 800)}</figure>)}</div>;
  if (view === "settings") return <div className="settings-preview" style={vars()}>
    <ThemeBackgroundPanel background={settings} setThemeBackground={patch => setSettings(value => ({ ...value, ...patch }))}/></div>;
  return <><header><strong>花火</strong><select aria-label="場面" value={sceneId} onChange={event => setSceneId(event.target.value as HanabiSceneId)}>
    {HANABI_SCENES.map(scene => <option key={scene.id} value={scene.id}>{scene.label}</option>)}</select><button onClick={() => run("done")}>小さい花火</button><button onClick={() => run("merge")}>大きい花火</button>
    <label><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)}/>視覚効果を減らす</label>
    <select value={size.join("×")} onChange={event => setSize(event.target.value.split("×").map(Number))}>
      {["1280×800", "1920×1080", "900×1400"].map(value => <option key={value}>{value}</option>)}</select>
    <label><input type="checkbox" checked={layout} onChange={event => setLayout(event.target.checked)}/>mycmux の構図</label>
    <label><input type="checkbox" checked={clearGlass} onChange={event => setClearGlass(event.target.checked)}/>ガラスをクリアに</label>
    <span className="stats">{stats.fps.toFixed(1)} fps · 描画 {stats.averageMs.toFixed(2)} ms / frame</span></header>
    <main>{stage(sceneId)}</main></>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
