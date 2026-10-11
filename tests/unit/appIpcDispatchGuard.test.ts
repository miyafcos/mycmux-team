import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const macroPath = new URL("../../src-tauri/src/app_commands.rs", import.meta.url);
const macro = existsSync(macroPath) ? readFileSync(macroPath, "utf8") : "";
const source = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");

describe("F2 app dispatch boundary", () => {
  it("routes the entire registered handler through one caller guard", () => {
    expect(source).toContain(".invoke_handler(app_handler())");
    expect(macro).toContain("ipc_caller::guard_app_handler(tauri::generate_handler!");
    expect(source).toContain('include!("app_commands.rs")');
  });
});
