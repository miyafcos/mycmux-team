import { describe, expect, it } from "vitest";
import {
  friendlyOauthError,
  isOauthLoginExpired,
  isOauthRateLimited,
  needsFreshOauthLogin,
} from "../../src/lib/oauthErrors";

describe("friendlyOauthError", () => {
  it("maps HTTP 429 exchange errors to rate-limit guidance", () => {
    const raw =
      'Claude OAuth token exchange error: HTTP 429: {"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}';
    const friendly = friendlyOauthError(raw);
    expect(friendly).toContain("レート制限");
    expect(friendly).toContain("HTTP 429");
    expect(friendly).toContain("やり直し");
  });

  it("maps rate_limit_error bodies without an explicit 429 marker", () => {
    expect(friendlyOauthError("rate_limit_error: slow down")).toContain("レート制限");
  });

  it("maps state mismatch to re-paste guidance", () => {
    expect(
      friendlyOauthError("OAuth state mismatch; check the pasted code and retry"),
    ).toContain("code#state");
  });

  it("maps expired login attempts to restart guidance", () => {
    expect(
      friendlyOauthError("Unknown or expired login attempt; restart login"),
    ).toContain("有効期限");
  });

  it("maps malformed code input to format guidance", () => {
    expect(friendlyOauthError("OAuth code input must contain '#'")).toContain("code#state");
  });

  it("passes through unknown errors verbatim", () => {
    expect(friendlyOauthError("something else broke")).toBe("something else broke");
  });
});

describe("oauth error classifiers", () => {
  it("classifies rate-limit errors", () => {
    expect(isOauthRateLimited("Claude OAuth token exchange error: HTTP 429: ...")).toBe(true);
    expect(isOauthRateLimited("rate_limit_error: nope")).toBe(true);
    expect(isOauthRateLimited("OAuth state mismatch; check the pasted code and retry")).toBe(false);
  });

  it("classifies expired-login errors", () => {
    expect(isOauthLoginExpired("Unknown or expired login attempt; restart login")).toBe(true);
    expect(isOauthLoginExpired("HTTP 429")).toBe(false);
  });

  it("requires a fresh login for 429 and expired-login, not for fixable input errors", () => {
    expect(needsFreshOauthLogin("Claude OAuth token exchange error: HTTP 429")).toBe(true);
    expect(needsFreshOauthLogin("Unknown or expired login attempt; restart login")).toBe(true);
    expect(needsFreshOauthLogin("OAuth state mismatch; check the pasted code and retry")).toBe(false);
    expect(needsFreshOauthLogin("OAuth code input must contain '#'")).toBe(false);
  });
});
