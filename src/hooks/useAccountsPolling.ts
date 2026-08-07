import { useEffect, useRef } from "react";
import { CLI_ACCOUNT_POLL_INTERVAL_MS } from "../lib/cliAccounts";
import { USAGE_POLL_INTERVAL_MS } from "../lib/constants";
import { useCliAccountStore } from "../stores/cliAccountStore";
import { useUsageStore } from "../stores/usageStore";

const USAGE_FOCUS_MIN_INTERVAL_MS = 60_000;

export type AccountsPollTrigger = "mount" | "cli-interval" | "usage-interval" | "focus";

export interface PollPlanInput {
  nowMs: number;
  lastCliAt: number | null;
  lastUsageAt: number | null;
  trigger: AccountsPollTrigger;
}

export interface AccountsPollPlan {
  cli: boolean;
  usage: boolean;
}

function elapsed(nowMs: number, lastAt: number | null): number {
  return lastAt === null ? Infinity : Math.max(0, nowMs - lastAt);
}

export function pollPlan(input: PollPlanInput): AccountsPollPlan {
  if (input.trigger === "mount") return { cli: true, usage: true };
  if (input.trigger === "focus") {
    return {
      cli: true,
      usage: elapsed(input.nowMs, input.lastUsageAt) >= USAGE_FOCUS_MIN_INTERVAL_MS,
    };
  }
  return {
    cli:
      input.trigger === "cli-interval" &&
      elapsed(input.nowMs, input.lastCliAt) >= CLI_ACCOUNT_POLL_INTERVAL_MS,
    usage:
      input.trigger === "usage-interval" &&
      elapsed(input.nowMs, input.lastUsageAt) >= USAGE_POLL_INTERVAL_MS,
  };
}

export function useAccountsPolling(): void {
  const fetchCli = useCliAccountStore((state) => state.fetch);
  const fetchUsage = useUsageStore((state) => state.fetch);
  const lastCliAt = useRef<number | null>(null);
  const lastUsageAt = useRef<number | null>(null);
  const cliInFlight = useRef(false);
  const usageInFlight = useRef(false);

  useEffect(() => {
    const observedUsageAt = () => {
      const storeTimestamp = useUsageStore.getState().lastFetchedAt;
      if (lastUsageAt.current === null) return storeTimestamp;
      if (storeTimestamp === null) return lastUsageAt.current;
      return Math.max(lastUsageAt.current, storeTimestamp);
    };
    const run = (trigger: AccountsPollTrigger): AccountsPollPlan => {
      const nowMs = Date.now();
      const plan = pollPlan({
        nowMs,
        lastCliAt: lastCliAt.current,
        lastUsageAt: observedUsageAt(),
        trigger,
      });
      const dispatched = { cli: false, usage: false };
      if (plan.cli && !cliInFlight.current) {
        cliInFlight.current = true;
        lastCliAt.current = nowMs;
        dispatched.cli = true;
        void fetchCli().finally(() => {
          cliInFlight.current = false;
        });
      }
      if (plan.usage && !usageInFlight.current) {
        usageInFlight.current = true;
        lastUsageAt.current = nowMs;
        dispatched.usage = true;
        void fetchUsage().finally(() => {
          usageInFlight.current = false;
        });
      }
      return dispatched;
    };

    run("mount");
    let cliTimer: number | null = null;
    let usageTimer: number | null = null;
    const scheduleCli = () => {
      if (cliTimer !== null) window.clearTimeout(cliTimer);
      const delay = cliInFlight.current
        ? 1_000
        : Math.max(0, CLI_ACCOUNT_POLL_INTERVAL_MS - elapsed(Date.now(), lastCliAt.current));
      cliTimer = window.setTimeout(() => {
        run("cli-interval");
        scheduleCli();
      }, delay);
    };
    const scheduleUsage = () => {
      if (usageTimer !== null) window.clearTimeout(usageTimer);
      const delay = usageInFlight.current
        ? 1_000
        : Math.max(0, USAGE_POLL_INTERVAL_MS - elapsed(Date.now(), observedUsageAt()));
      usageTimer = window.setTimeout(() => {
        run("usage-interval");
        scheduleUsage();
      }, delay);
    };
    scheduleCli();
    scheduleUsage();
    const onFocus = () => {
      const dispatched = run("focus");
      if (dispatched.cli) scheduleCli();
      if (dispatched.usage) scheduleUsage();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      if (cliTimer !== null) window.clearTimeout(cliTimer);
      if (usageTimer !== null) window.clearTimeout(usageTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchCli, fetchUsage]);
}
