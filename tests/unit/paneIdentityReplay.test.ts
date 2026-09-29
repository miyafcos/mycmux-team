import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolvePaneIdentities, displayNameForWorkspace, type PaneIdentityInput } from "../../src/lib/paneIdentity";
const directory = process.env.MYCMUX_PROPERNOUN_REPLAY_DIR;
test.skipIf(!directory)("matches every frozen identity and home without copying private fixtures", () => {
  const input: PaneIdentityInput = JSON.parse(readFileSync(join(directory!, "replay_input.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(directory!, "replay_expected.json"), "utf8"));
  const result = resolvePaneIdentities(input);
  const names = new Map(input.workspaces.map(w => [w.id, w.name]));
  const projects = new Map([...result.tabs.values()].filter(t => t.project).map(t => [t.project!.key, t.project!.display]));
  // Homes may include registrations without a live pane: resolve a synthetic registered tab for their display.
  const all = resolvePaneIdentities({ ...input, tabs: input.registry.map((r, i) => ({ id: String(i), workspaceId: "", cwd: r.path })) });
  for (const t of all.tabs.values()) if (t.project) projects.set(t.project.key, t.project.display);
  expect(Object.fromEntries([...result.homes].map(([key, wid]) => [projects.get(key), names.get(wid)]))).toEqual(expected.homes);
  const actual = input.tabs.map(tab => {
    const identity = result.tabs.get(tab.id)!;
    const destination = identity.project ? result.homes.get(identity.project.key) ?? tab.workspaceId : tab.workspaceId;
    return { id: tab.id, projectDisplay: identity.project?.display ?? null, subject: identity.subject,
      displayAfterMinimalMove: displayNameForWorkspace(identity, destination, result.homes),
      minimalMoveTo: destination !== tab.workspaceId ? names.get(destination) : null };
  });
  expect(actual).toEqual(expected.tabs.map((t: Record<string, unknown>) => ({
    id: t.id, projectDisplay: t.projectDisplay, subject: t.subjectHow === "材料なし" ? null : t.subject,
    displayAfterMinimalMove: t.subjectHow === "材料なし" ? null : t.displayAfterMinimalMove, minimalMoveTo: t.minimalMoveTo,
  })));
});
