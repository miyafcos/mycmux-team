import { invoke } from "@tauri-apps/api/core";
import type { FeedbackDestinationStatus, FeedbackRequest } from "../../lib/ipc";

// Keep the feedback/settings entry independent of terminal channels and attachment lifecycles.
export async function getFeedbackDestinationStatus(): Promise<FeedbackDestinationStatus> {
  return invoke<FeedbackDestinationStatus>("feedback_status");
}
export async function saveFeedbackDestination(token: string, destination: string): Promise<FeedbackDestinationStatus> {
  return invoke<FeedbackDestinationStatus>("feedback_save_destination", { token, destination });
}
export async function removeFeedbackDestination(): Promise<FeedbackDestinationStatus> {
  return invoke<FeedbackDestinationStatus>("feedback_remove_destination");
}
export async function captureFeedbackMain(): Promise<string> {
  return invoke<string>("feedback_capture_main");
}
export async function sendFeedback(request: FeedbackRequest): Promise<void> {
  return invoke<void>("feedback_send", { request });
}
