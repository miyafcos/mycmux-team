const REPLACEMENT = "\uFFFD";
const ELLIPSIS = "\u2026";

export function tidyToolOutput(text: string): { text: string; lossy: boolean } {
  if (!text.includes(REPLACEMENT)) return { text, lossy: false };

  let lossy = false;
  const lines = text.split("\n").map(line => {
    const carriageReturn = line.endsWith("\r") ? "\r" : "";
    const core = carriageReturn ? line.slice(0, -1) : line;
    let lead = 0;
    while (core[lead] === REPLACEMENT) lead += 1;
    let end = core.length;
    while (end > lead && core[end - 1] === REPLACEMENT) end -= 1;
    const trail = core.length - end;
    const middle = core.slice(lead, end);

    if (!middle.includes(REPLACEMENT) && lead <= 3 && trail <= 1 && lead + trail >= 1
      && (middle.length > 0 || lead + trail === 1)) {
      return (lead ? ELLIPSIS : "") + middle + (trail ? ELLIPSIS : "") + carriageReturn;
    }
    if (core.includes(REPLACEMENT)) lossy = true;
    return line;
  });
  return { text: lines.join("\n"), lossy };
}
