import { TAB_GROUPING_NAME_MAX } from "./tabGrouping";

/** A literal prefix, shortened before a partial ASCII word. */
export function attributeWordPrefix(value: string, count: number): string {
  const chars = [...value];
  let end = Math.min(count, chars.length);
  const ascii = (char: string | undefined) => Boolean(char && /[A-Za-z0-9]/u.test(char));
  if (end < chars.length && ascii(chars[end - 1]) && ascii(chars[end])) {
    while (end > 0 && ascii(chars[end - 1])) end -= 1;
  }
  return chars.slice(0, end).join("").trimEnd();
}

/** Keep a whole first word when eight characters cannot contain it. */
export function attributeDefaultShort(name: string): string {
  return attributeWordPrefix(name, 8) || name.match(/^[A-Za-z0-9]+/u)?.[0] || name;
}

/** Drop complete trailing shorts before shortening the sole remaining one. */
export function attributeCombinedName(shorts: readonly string[]): string {
  const parts = shorts.filter(Boolean);
  while (parts.length > 1 && [...parts.join("・")].length > TAB_GROUPING_NAME_MAX) parts.pop();
  const name = parts.join("・");
  return [...name].length <= TAB_GROUPING_NAME_MAX ? name : attributeWordPrefix(name, TAB_GROUPING_NAME_MAX);
}
