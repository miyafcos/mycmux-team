import { describe, expect, it } from "vitest";

import {
  nonRetryablePersistentStorageError,
  persistentStorageErrorMessage,
  unsupportedPersistentSchemaVersion,
} from "../../src/lib/ipc";

describe("persistent schema command errors", () => {
  it("reads the typed save rejection without relying on message text", () => {
    expect(unsupportedPersistentSchemaVersion({
      kind: "unsupportedSchema",
      schemaVersion: 999,
      message: "localized or changed text",
    })).toBe(999);
  });

  it("keeps child-window diagnostics compatible with the existing string error", () => {
    expect(unsupportedPersistentSchemaVersion(
      "data.json schema version 999 is not supported by this mycmux build",
    )).toBe(999);
    expect(unsupportedPersistentSchemaVersion(new Error("disk full"))).toBeNull();
  });

  it("preserves typed non-schema storage diagnostics", () => {
    expect(persistentStorageErrorMessage({
      kind: "storage",
      message: "disk full",
    })).toBe("disk full");
    expect(persistentStorageErrorMessage(new Error("permission denied"))).toBe("permission denied");
  });

  it("classifies terminal platform and payload errors without message parsing", () => {
    expect(nonRetryablePersistentStorageError({
      kind: "unsupportedPlatform",
      message: "writes are disabled",
    })).toEqual({ kind: "unsupportedPlatform", message: "writes are disabled" });
    expect(nonRetryablePersistentStorageError({
      kind: "invalidPayloadSchema",
      schemaVersion: 999,
      message: "payload mismatch",
    })).toEqual({
      kind: "invalidPayloadSchema",
      schemaVersion: 999,
      message: "payload mismatch",
    });
    expect(nonRetryablePersistentStorageError({
      kind: "invalidPayloadSchema",
      schemaVersion: 1.5,
      message: "malformed",
    })).toBeNull();
  });
});
