import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import "./PetSprite.css";

export type PetSpriteState = "idle" | "waving" | "failed" | "waiting" | "running" | "jumping";

interface PetSpriteProps {
  atlasUrl: string;
  state: PetSpriteState;
  height: number;
}

interface PetAnimation {
  row: number;
  frames: 4 | 5 | 6 | 8;
  duration: number;
}

const PET_ANIMATIONS: Record<PetSpriteState, PetAnimation> = {
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

export default function PetSprite({ atlasUrl, state, height }: PetSpriteProps) {
  const [displayedState, setDisplayedState] = useState(state);
  const [failedToLoad, setFailedToLoad] = useState(false);

  useEffect(() => {
    setFailedToLoad(false);
  }, [atlasUrl]);

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
    backgroundSize: `${width * 8}px ${height * 9}px`,
    backgroundPosition: `0 ${-animation.row * height}px`,
    "--pet-animation": `cmux-pet-sprite-${animation.frames}`,
    "--pet-duration": `${animation.duration}ms`,
    "--pet-frames": String(animation.frames),
    "--pet-frame-width": `${width}px`,
    "--pet-row-offset": `${-animation.row * height}px`,
  };

  return (
    <span className="cmux-pet-sprite" style={style} aria-hidden="true">
      <img className="cmux-pet-sprite__probe" src={atlasUrl} alt="" onError={() => setFailedToLoad(true)} />
    </span>
  );
}
