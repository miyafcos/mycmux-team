/** Presentation assertions use the authored accessible names and hover copy. */
export function dashboardName(element: Element | null | undefined): string {
  if (!element) return "";
  return element.getAttribute("aria-label") ?? element.querySelector("[role=img][aria-label]")?.getAttribute("aria-label") ?? element.textContent ?? "";
}

export function dashboardText(element: Element | null | undefined): string {
  if (!element) return "";
  const labels = [element, ...element.querySelectorAll("[aria-label], [title], [aria-description]")].flatMap(node => (
    ["aria-label", "title", "aria-description"].map(attribute => node.getAttribute(attribute) ?? "")
  ));
  return [element.textContent ?? "", ...labels].join(" ");
}
