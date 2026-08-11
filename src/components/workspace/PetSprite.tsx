import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import "./PetSprite.css";

export type PetSpriteState = "idle" | "waving" | "failed" | "waiting" | "running" | "jumping";

interface PetSpriteProps {
  atlasUrl: string;
  state: PetSpriteState;
  height: number;
  rows?: number;
}

interface PetAnimation {
  row: number;
  frames: 4 | 5 | 6 | 8;
  duration: number;
}

const PET_ANIMATIONS: Record<PetSpriteState, PetAnimation> = {
  // Atlas contract from openai/codex TUI: 8 columns, 192x208 cells. Rows 0-7
  // are idle, running-right, running-left, waving, jumping, failed, waiting,
  // and running in both v1 (9 rows) and v2 (11 rows) sheets.
  idle: { row: 0, frames: 6, duration: 1100 },
  waving: { row: 3, frames: 4, duration: 700 },
  jumping: { row: 4, frames: 5, duration: 840 },
  failed: { row: 5, frames: 8, duration: 1220 },
  // P5 can map its stalled state here without changing sprite behavior.
  waiting: { row: 6, frames: 6, duration: 1010 },
  running: { row: 7, frames: 6, duration: 820 },
};

type PetSpriteStyle = CSSProperties & Record<
  "--pet-animation" | "--pet-duration" | "--pet-frames" | "--pet-frame-width" | "--pet-row-offset",
  string
>;

export function deriveRowsFromNatural(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width % 8 !== 0) return null;
  const cellWidth = width / 8;
  const rowHeight = cellWidth * 208 / 192;
  const rawRows = height / rowHeight;
  const rows = Math.round(rawRows);
  return Math.abs(rawRows - rows) < 0.001 && rows >= 9 && rows <= 11 ? rows : null;
}

export function spriteAtlasStyle(height: number, rows: number, row: number): Pick<CSSProperties, "backgroundSize" | "backgroundPosition"> {
  const width = height * 192 / 208;
  return {
    backgroundSize: `${width * 8}px ${height * rows}px`,
    backgroundPosition: `0 ${-row * height}px`,
  };
}

export default function PetSprite({ atlasUrl, state, height, rows = 9 }: PetSpriteProps) {
  const [displayedState, setDisplayedState] = useState(state);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [atlasRows, setAtlasRows] = useState(rows);

  useEffect(() => {
    setFailedToLoad(false);
    setAtlasRows(rows);
  }, [atlasUrl, rows]);

  useEffect(() => {
    if (state === displayedState) return;
    if (state === "waving" || state === "failed") {
      setDisplayedState(state);
      return;
    }
    const timeoutId = window.setTimeout(() => setDisplayedState(state), 1500);
    return () => window.clearTimeout(timeoutId);
  }, [displayedState, state]);

  if (failedToLoad) return null;

  const animation = PET_ANIMATIONS[displayedState];
  const width = height * 192 / 208;
  const style: PetSpriteStyle = {
    width,
    height,
    backgroundImage: `url("${atlasUrl}")`,
    ...spriteAtlasStyle(height, atlasRows, animation.row),
    "--pet-animation": `cmux-pet-sprite-${animation.frames}`,
    "--pet-duration": `${animation.duration}ms`,
    "--pet-frames": String(animation.frames),
    "--pet-frame-width": `${width}px`,
    "--pet-row-offset": `${-animation.row * height}px`,
  };

  return (
    <span className="cmux-pet-sprite" style={style} aria-hidden="true">
      <img
        className="cmux-pet-sprite__probe"
        src={atlasUrl}
        alt=""
        onLoad={(event) => {
          const detectedRows = deriveRowsFromNatural(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
          if (detectedRows === null) setFailedToLoad(true);
          else setAtlasRows(detectedRows);
        }}
        onError={() => setFailedToLoad(true)}
      />
    </span>
  );
}
