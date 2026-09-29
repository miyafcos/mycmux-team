import { describe, expect, it } from "vitest";
import { displaySourcePath } from "../../src/components/workspace/ArtifactEditorToolbar";

// canonicalize() hands back Windows' extended-length spelling, which is what
// the toolbar used to show: `//?/C:/Users/...` after the separators were
// flipped for display. The prefix exists for file I/O and means nothing to a
// reader, so it is taken off the path on the way to the screen.
describe("displaySourcePath", () => {
  it("takes the extended-length prefix off a drive path", () => {
    expect(displaySourcePath("\\\\?\\C:\\a\\b.md")).toBe("C:\\a\\b.md");
    expect(displaySourcePath("//?/C:/a/b.md")).toBe("C:/a/b.md");
  });

  it("puts a share back together", () => {
    expect(displaySourcePath("\\\\?\\UNC\\srv\\s\\a.md")).toBe("\\\\srv\\s\\a.md");
    expect(displaySourcePath("//?/UNC/srv/s/a.md")).toBe("//srv/s/a.md");
  });

  it("leaves an ordinary path alone", () => {
    expect(displaySourcePath("C:\\Users\\miyaz\\report.md")).toBe("C:\\Users\\miyaz\\report.md");
    expect(displaySourcePath("/Users/miyaz/report.md")).toBe("/Users/miyaz/report.md");
    expect(displaySourcePath("")).toBe("");
  });
});
