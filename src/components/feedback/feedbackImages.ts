import type { FeedbackImage } from "../../lib/ipc";
import { feedbackStrings as strings } from "./feedbackStrings";

const MAX_BYTES = 2 * 1024 * 1024;
function invalid(): Error { return new Error(strings.errors.invalidImage); }
async function readFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.size > 30 * 1024 * 1024) throw invalid();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(invalid());
    reader.onerror = () => reject(invalid());
    reader.readAsDataURL(file);
  });
}
async function loadImage(source: string): Promise<HTMLImageElement> {
  if (!source.startsWith("data:image/")) throw invalid();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(invalid());
    image.src = source;
  });
}
function encoded(canvas: HTMLCanvasElement, mime: "image/png" | "image/jpeg", quality?: number): FeedbackImage {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(canvas.toDataURL(mime, quality));
  if (!match) throw invalid();
  return { mime: match[1] as FeedbackImage["mime"], data: match[2] };
}
function bytes(image: FeedbackImage): number {
  return Math.floor(image.data.length * 3 / 4) - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);
}
export async function normalizeFeedbackImage(source: File | string): Promise<FeedbackImage> {
  const image = await loadImage(typeof source === "string" ? source : await readFile(source));
  if (!Number.isFinite(image.naturalWidth) || !Number.isFinite(image.naturalHeight)
    || image.naturalWidth < 1 || image.naturalHeight < 1) throw invalid();
  const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw invalid();
  for (let attempt = 0; attempt < 8; attempt++) {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = encoded(canvas, "image/png");
    if (bytes(png) <= MAX_BYTES) return png;
    for (const quality of [0.9, 0.75, 0.6, 0.45]) {
      const jpeg = encoded(canvas, "image/jpeg", quality);
      if (bytes(jpeg) <= MAX_BYTES) return jpeg;
    }
    canvas.width = Math.max(1, Math.floor(canvas.width * 0.75));
    canvas.height = Math.max(1, Math.floor(canvas.height * 0.75));
  }
  throw new Error(strings.imageTooLarge);
}
