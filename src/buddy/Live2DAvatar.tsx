import * as PIXI from "pixi.js";
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import {
  Live2DModel,
  MotionPreloadStrategy,
} from "pixi-live2d-display/cubism4";
import { POOL_BY_KIND, REACTION_MOOD } from "./core/reaction/reaction-expressions";
import type { BuddyMood, BuddyReaction } from "./core/types";
import { appendBuddyLog } from "./sprite-skin";

interface Live2DAvatarProps {
  mood: BuddyMood;
  reaction?: BuddyReaction | null;
  modelUrl: string;
  size: number;
  speaking?: boolean;
  fallback: ReactNode;
}

interface Live2DState {
  mood: BuddyMood;
  reaction: BuddyReaction | null;
  speaking: boolean;
}

interface Live2DCoreModel {
  setParameterValueById(parameterId: string, value: number, weight?: number): void;
  addParameterValueById(parameterId: string, value: number, weight?: number): void;
}

type HiyoriModel = Live2DModel;

declare global {
  interface Window {
    PIXI?: typeof PIXI;
    Live2DCubismCore?: unknown;
  }
}

const PARAM_MOUTH_OPEN_Y = "ParamMouthOpenY";
const LIVE2D_CONTAINER_CLASS = "buddy__avatar buddy__avatar--live2d";

let tickerRegistered = false;

export function Live2DAvatar({
  mood,
  reaction = null,
  modelUrl,
  size,
  speaking = false,
  fallback,
}: Live2DAvatarProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const modelRef = useRef<HiyoriModel | null>(null);
  const latestRef = useRef<Live2DState>({ mood, reaction, speaking });
  const [loadFailed, setLoadFailed] = useState(false);

  latestRef.current = { mood, reaction, speaking };

  useEffect(() => {
    let cancelled = false;
    let appDestroyed = false;
    setLoadFailed(false);
    ensurePixiRuntime();

    const app = new PIXI.Application({
      width: size,
      height: size,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    appRef.current = app;

    const canvas = app.view as HTMLCanvasElement;
    canvas.style.display = "block";
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    hostRef.current?.replaceChildren(canvas);

    Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      idleMotionGroup: "Idle",
      motionPreload: MotionPreloadStrategy.IDLE,
    })
      .then((model) => {
        if (cancelled) {
          model.destroy({ children: true, texture: true, baseTexture: true });
          return;
        }
        modelRef.current = model;
        app.stage.addChild(model);
        fitLive2DModel(model, size);
        attachParameterDriver(model, latestRef);
        void applyLive2DExpression(model, latestRef.current);
      })
      .catch((error) => {
        void appendBuddyLog({
          event: "live2d-load-failed",
          modelUrl,
          error: String(error),
        });
        if (!cancelled) {
          destroyApp(app);
          appDestroyed = true;
          appRef.current = null;
          setLoadFailed(true);
        }
      });

    return () => {
      cancelled = true;
      modelRef.current = null;
      appRef.current = null;
      if (!appDestroyed) {
        destroyApp(app);
        appDestroyed = true;
      }
    };
  }, [modelUrl]);

  useEffect(() => {
    const app = appRef.current;
    const model = modelRef.current;
    if (!app) {
      return;
    }
    app.renderer.resize(size, size);
    const canvas = app.view as HTMLCanvasElement;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    if (model) {
      fitLive2DModel(model, size);
    }
  }, [size]);

  useEffect(() => {
    const model = modelRef.current;
    if (model) {
      void applyLive2DExpression(model, latestRef.current);
    }
  }, [mood, reaction?.id]);

  if (loadFailed) {
    return <>{fallback}</>;
  }

  return (
    <div
      ref={hostRef}
      className={LIVE2D_CONTAINER_CLASS}
      title={modelUrl}
      style={{
        display: "block",
        width: size,
        height: size,
        overflow: "hidden",
      }}
    />
  );
}

function ensurePixiRuntime(): void {
  window.PIXI = PIXI;
  if (!tickerRegistered) {
    Live2DModel.registerTicker(PIXI.Ticker);
    tickerRegistered = true;
  }
}

function destroyApp(app: PIXI.Application): void {
  app.destroy(true, { children: true, texture: true, baseTexture: true });
}

function fitLive2DModel(model: HiyoriModel, size: number): void {
  model.anchor.set(0.5, 0.5);
  model.scale.set(1);
  const bounds = model.getLocalBounds();
  const naturalWidth = Math.max(1, bounds.width);
  const naturalHeight = Math.max(1, bounds.height);
  const scale = Math.min((size * 0.96) / naturalWidth, (size * 1.18) / naturalHeight);
  model.scale.set(scale);
  model.x = size / 2;
  model.y = size * 0.56;
}

function attachParameterDriver(model: HiyoriModel, latestRef: MutableRefObject<Live2DState>): void {
  model.internalModel.on("beforeModelUpdate", () => {
    const coreModel = model.internalModel.coreModel as Live2DCoreModel;
    driveMoodParameters(coreModel, latestRef.current);
    driveMouth(coreModel, latestRef.current.speaking);
  });
}

function driveMouth(coreModel: Live2DCoreModel, speaking: boolean): void {
  if (!speaking) {
    return;
  }
  const now = performance.now();
  const mouthOpen = 0.18 + Math.abs(Math.sin(now / 86)) * 0.72;
  coreModel.setParameterValueById(PARAM_MOUTH_OPEN_Y, mouthOpen, 0.95);
}

function driveMoodParameters(coreModel: Live2DCoreModel, state: Live2DState): void {
  const effectiveMood = state.reaction ? REACTION_MOOD[state.reaction.kind] : state.mood;
  applyParameterProfile(coreModel, moodParameterProfiles[effectiveMood], 0.62);
  if (state.reaction) {
    applyParameterProfile(coreModel, reactionParameterProfiles[state.reaction.kind], reactionWeight(state.reaction));
  }
}

function reactionWeight(reaction: BuddyReaction): number {
  if (reaction.strength === "strong") return 0.9;
  if (reaction.strength === "mid") return 0.72;
  return 0.52;
}

function applyParameterProfile(coreModel: Live2DCoreModel, profile: Record<string, number>, weight: number): void {
  for (const [parameterId, value] of Object.entries(profile)) {
    coreModel.addParameterValueById(parameterId, value, weight);
  }
}

async function applyLive2DExpression(model: HiyoriModel, state: Live2DState): Promise<void> {
  const expressionManager = model.internalModel.motionManager.expressionManager;
  if (!expressionManager) {
    return;
  }
  for (const name of expressionCandidates(state)) {
    if (expressionManager.getExpressionIndex(name) < 0) {
      continue;
    }
    await model.expression(name);
    return;
  }
}

function expressionCandidates(state: Live2DState): string[] {
  if (state.reaction) {
    return [
      ...POOL_BY_KIND[state.reaction.kind],
      ...moodExpressionCandidates[REACTION_MOOD[state.reaction.kind]],
    ];
  }
  return moodExpressionCandidates[state.mood];
}

const moodExpressionCandidates: Record<BuddyMood, string[]> = {
  idle: ["neutral", "normal", "idle", "default", "F01"],
  thinking: ["thinking", "analyzing", "serious", "worried", "F03"],
  tsukkomi: ["exasperated", "sharp", "pout", "angry", "surprised", "F05"],
  applaud: ["soft_smile", "smile", "happy", "proud", "wink", "F02"],
};

const moodParameterProfiles: Record<BuddyMood, Record<string, number>> = {
  idle: {
    ParamMouthForm: 0.08,
  },
  thinking: {
    ParamAngleX: -3,
    ParamBrowLY: 0.18,
    ParamBrowRY: 0.18,
    ParamBrowLForm: -0.25,
    ParamBrowRForm: -0.25,
    ParamMouthForm: -0.12,
  },
  tsukkomi: {
    ParamAngleZ: -3.5,
    ParamBrowLForm: -0.68,
    ParamBrowRForm: -0.68,
    ParamMouthForm: -0.42,
  },
  applaud: {
    ParamEyeLSmile: 0.62,
    ParamEyeRSmile: 0.62,
    ParamMouthForm: 0.76,
    ParamCheek: 0.55,
  },
};

const reactionParameterProfiles: Record<BuddyReaction["kind"], Record<string, number>> = {
  notice: {
    ParamAngleX: 5,
    ParamEyeBallX: 0.25,
  },
  watch: {
    ParamEyeBallX: -0.18,
    ParamEyeBallY: 0.1,
  },
  focus: {
    ParamAngleX: -4,
    ParamBrowLForm: -0.28,
    ParamBrowRForm: -0.28,
  },
  impressed: {
    ParamEyeLSmile: 0.75,
    ParamEyeRSmile: 0.75,
    ParamMouthForm: 0.82,
    ParamCheek: 0.7,
  },
  exasperated: {
    ParamAngleZ: -5,
    ParamBrowLForm: -0.82,
    ParamBrowRForm: -0.82,
    ParamMouthForm: -0.48,
  },
  concerned: {
    ParamBrowLY: 0.22,
    ParamBrowRY: 0.22,
    ParamBrowLForm: -0.35,
    ParamBrowRForm: -0.35,
    ParamMouthForm: -0.28,
  },
  alarmed: {
    ParamAngleZ: 4,
    ParamBrowLY: 0.34,
    ParamBrowRY: 0.34,
    ParamMouthOpenY: 0.34,
  },
  drowsy: {
    ParamEyeLOpen: -0.45,
    ParamEyeROpen: -0.45,
    ParamMouthForm: -0.2,
  },
};
