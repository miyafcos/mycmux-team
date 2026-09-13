import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useDevicePixelRatio } from "../../hooks/useDevicePixelRatio";
import { deriveRowsFromNatural, peekPrescaledAtlas, prescalePetAtlas, type PrescaledAtlas } from "../../lib/petAtlasScale";
import { PET_DEMOTE_HOLD_MS } from "../../lib/petState";
import "./PetSprite.css";

export type PetSpriteState = "calling" | "stuck" | "working" | "ready" | "resting";

interface PetSpriteProps {
  atlasUrl: string;
  state: PetSpriteState;
  height: number;
  rows?: number;
  animate?: boolean;
}

interface PetAnimation {
  row: number;
  frames: 6 | 8;
  duration: number;
}

const PET_ANIMATIONS: Record<PetSpriteState, PetAnimation> = {
  // Codex atlas: 8 columns of 192x208 cells, in both v1 (9 rows) and v2 (11).
  // calling = waiting (6), stuck = failed (5), working = running (7),
  // ready = review (8), resting = idle (0). Other rows are not status states.
  calling: { row: 6, frames: 6, duration: 1010 },
  stuck: { row: 5, frames: 8, duration: 1220 },
  working: { row: 7, frames: 6, duration: 820 },
  ready: { row: 8, frames: 6, duration: 1030 },
  resting: { row: 0, frames: 6, duration: 6600 },
};

// The rows a status can show. The rest of the atlas is never painted, so it is
// not worth pre-scaling.
const STATUS_ROWS = [...new Set(Object.values(PET_ANIMATIONS).map((animation) => animation.row))];

type PetSpriteStyle = CSSProperties & Record<
  "--pet-animation" | "--pet-duration" | "--pet-frames" | "--pet-frame-width" | "--pet-row-offset",
  string
>;

export interface SpriteFrame {
  /** CSS px. */
  width: number;
  height: number;
  /** The same box in whole device pixels. */
  deviceWidth: number;
  deviceHeight: number;
}

/**
 * The box of one frame for a sprite `height` CSS px tall, snapped to whole
 * device pixels so the pre-scaled atlas lands on the screen grid 1:1. The
 * 192:208 cell aspect holds to within one device pixel.
 */
export function spriteFrame(height: number, devicePixelRatio: number): SpriteFrame {
  const deviceHeight = Math.max(1, Math.round(height * devicePixelRatio));
  const deviceWidth = Math.max(1, Math.round(height * devicePixelRatio * 192 / 208));
  return { width: deviceWidth / devicePixelRatio, height: deviceHeight / devicePixelRatio, deviceWidth, deviceHeight };
}

export function spriteAtlasStyle(
  frame: Pick<SpriteFrame, "width" | "height">,
  rows: number,
  row: number,
): Pick<CSSProperties, "backgroundSize" | "backgroundPosition"> {
  return {
    backgroundSize: `${frame.width * 8}px ${frame.height * rows}px`,
    backgroundPosition: `0 ${-row * frame.height}px`,
  };
}

/** The atlas shrunk to this frame's device size: null until it is ready, or when it cannot be built. */
function usePrescaledAtlas(atlasUrl: string, frame: SpriteFrame): PrescaledAtlas | null {
  const { deviceWidth, deviceHeight } = frame;
  const [, setBuilt] = useState(0);
  useEffect(() => {
    if (peekPrescaledAtlas(atlasUrl, deviceWidth, deviceHeight, STATUS_ROWS) !== undefined) return;
    let live = true;
    void prescalePetAtlas(atlasUrl, deviceWidth, deviceHeight, STATUS_ROWS).then(() => {
      if (live) setBuilt((count) => count + 1);
    });
    return () => {
      live = false;
    };
  }, [atlasUrl, deviceWidth, deviceHeight]);
  return peekPrescaledAtlas(atlasUrl, deviceWidth, deviceHeight, STATUS_ROWS) ?? null;
}

export default function PetSprite({ atlasUrl, state, height, rows = 9, animate = true }: PetSpriteProps) {
  const [displayedState, setDisplayedState] = useState(state);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [atlasRows, setAtlasRows] = useState(rows);
  const devicePixelRatio = useDevicePixelRatio();
  const frame = spriteFrame(height, devicePixelRatio);
  const prescaled = usePrescaledAtlas(atlasUrl, frame);

  useEffect(() => {
    setFailedToLoad(false);
    setAtlasRows(rows);
  }, [atlasUrl, rows]);

  useEffect(() => {
    if (state === displayedState) return;
    if (displayedState !== "working" || (state !== "resting" && state !== "ready")) {
      setDisplayedState(state);
      return;
    }
    const timeoutId = window.setTimeout(() => setDisplayedState(state), PET_DEMOTE_HOLD_MS);
    return () => window.clearTimeout(timeoutId);
  }, [displayedState, state]);

  if (failedToLoad) return null;

  const animation = PET_ANIMATIONS[displayedState];
  const style: PetSpriteStyle = {
    width: frame.width,
    height: frame.height,
    backgroundImage: `url("${prescaled?.url ?? atlasUrl}")`,
    ...spriteAtlasStyle(frame, prescaled?.rows ?? atlasRows, animation.row),
    animationTimingFunction: displayedState === "resting" ? "step-end" : undefined,
    "--pet-animation": displayedState === "resting" ? "cmux-pet-sprite-resting" : `cmux-pet-sprite-${animation.frames}`,
    "--pet-duration": `${animation.duration}ms`,
    "--pet-frames": String(animation.frames),
    "--pet-frame-width": `${frame.width}px`,
    "--pet-row-offset": `${-animation.row * frame.height}px`,
  };
  const className = `cmux-pet-sprite${prescaled ? " cmux-pet-sprite--prescaled" : ""}${animate ? "" : " cmux-pet-sprite--static"}`;

  return (
    <span className={className} style={style} aria-hidden="true">
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
