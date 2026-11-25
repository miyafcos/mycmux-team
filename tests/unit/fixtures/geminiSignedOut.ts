import type { ProfileUsage } from "../../../src/lib/ipc";

// Mirrors the row for UsageError::NotSignedIn in oauth_gemini.rs.
export const geminiSignedOut: ProfileUsage = {
  profile_id: "live:gemini",
  provider: "gemini",
  label: "Gemini",
  email: null,
  plan: null,
  subscription: null,
  registered: false,
  is_active: false,
  needs_relogin: false,
  state: "needs_relogin",
  five_hour: null,
  seven_day: null,
  seven_day_sonnet: null,
  seven_day_opus: null,
  model_windows: [],
  reset_tickets: null,
  error_code: "usage.error.gemini_not_signed_in",
  token_owner_email: null,
  retry_at: null,
  fetched_at: "2026-11-24T11:00:00+00:00",
};
