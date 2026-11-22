import { useRef, type KeyboardEvent } from "react";
import type { ThemeBackgroundSettings } from "../../types";
import { HANABI_SCENES, normalizeHanabiSceneId } from "../../lib/hanabiScenes";
import { SceneThumbnail } from "./SceneThumbnail";

export function ScenePicker({ background, onChange }: { background: ThemeBackgroundSettings; onChange: (patch: Partial<ThemeBackgroundSettings>) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = normalizeHanabiSceneId(background.sceneId);
  const select = (index: number) => onChange({ mode: "scene", sceneId: HANABI_SCENES[index].id });
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = refs.current.findIndex(button => button === document.activeElement);
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight": case "ArrowDown": next = (index + 1) % HANABI_SCENES.length; break;
      case "ArrowLeft": case "ArrowUp": next = (index + HANABI_SCENES.length - 1) % HANABI_SCENES.length; break;
      case "Home": next = 0; break;
      case "End": next = HANABI_SCENES.length - 1; break;
      default: return;
    }
    event.preventDefault(); select(next); refs.current[next]?.focus();
  };
  return <div role="radiogroup" aria-label="場面" onKeyDown={keyDown}
    style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(246px, 100%), 246px))", gap: 8 }}>
    {HANABI_SCENES.map((scene, index) => {
      const active = background.mode === "scene" && selected === scene.id;
      return <button key={scene.id} type="button" role="radio" aria-checked={active} data-scene-id={scene.id}
        ref={element => { refs.current[index] = element; }}
        tabIndex={active || (background.mode !== "scene" && index === 0) ? 0 : -1} onClick={() => select(index)}
        style={{ minWidth: 0, padding: 3, border: `2px solid ${active ? "var(--cmux-accent)" : "var(--cmux-border)"}`,
          borderRadius: 8, background: active ? "var(--cmux-selected)" : "var(--cmux-surface)",
          color: active ? "var(--cmux-accent-text)" : "var(--cmux-text-secondary)", cursor: "pointer" }}>
        <span style={{ display: "block", aspectRatio: "8/5", overflow: "hidden", borderRadius: 4 }}><SceneThumbnail sceneId={scene.id} /></span>
        <span style={{ display: "block", padding: "6px 2px 4px", fontSize: 11, fontWeight: active ? 700 : 500 }}>{scene.label}</span>
      </button>;
    })}
  </div>;
}
