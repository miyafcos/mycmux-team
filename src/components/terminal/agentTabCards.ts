import type { Workspace } from "../../types";
import { buildDashboardCards, type DashboardCardModel, type DashboardModelInput } from "../dashboard/dashboardModel";
import { liveTerms, termCache } from "./terminalCache";

type CardInput = Omit<DashboardModelInput, "now" | "hasTerminalBuffer">;
let cached: { workspaces: readonly Workspace[]; input: CardInput; cards: DashboardCardModel[] } | undefined;
const hasTerminalBuffer = (id: string) => liveTerms.has(id) || termCache.has(id);

/** One bounded memo shared by every tab. A render's clock is not an input. */
export function getAgentTabCards(workspaces: readonly Workspace[], input: CardInput): DashboardCardModel[] {
  const keys = Object.keys(input) as (keyof CardInput)[];
  if (cached && cached.workspaces === workspaces && keys.length === Object.keys(cached.input).length
    && keys.every(key => input[key] === cached!.input[key])) return cached.cards;
  const cards = buildDashboardCards(workspaces, { ...input, now: Date.now(), hasTerminalBuffer });
  cached = { workspaces, input, cards };
  return cards;
}
