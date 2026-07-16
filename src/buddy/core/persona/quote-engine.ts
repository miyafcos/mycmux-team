import quotesRaw from "./steins-quotes.json?raw";
import { getBuddyConfig } from "../config";

/** A canonical Steins;Gate line the buddy may occasionally weave into its speech. */
export interface Quote {
  id: string;
  text: string;
  speaker: string;
  context: string;
  tags: string[];
  tier: "signature" | "notable";
  workApplicable: boolean;
}

interface QuoteLibraryFile {
  quotes: Quote[];
}

interface UsageRecord {
  id: string;
  atMs: number;
}

// A quote used within this window is excluded from candidate selection.
const RECENT_EXCLUDE_MS = 12 * 60 * 60_000;
const MAX_USAGE_RECORDS = 200;

function loadQuotes(): Quote[] {
  try {
    const parsed = JSON.parse(quotesRaw) as QuoteLibraryFile;
    if (!parsed || !Array.isArray(parsed.quotes)) {
      return [];
    }
    return parsed.quotes.filter(
      (quote): quote is Quote =>
        Boolean(quote) &&
        typeof quote.id === "string" &&
        typeof quote.text === "string" &&
        Array.isArray(quote.tags),
    );
  } catch (error) {
    console.warn("[buddy] failed to parse steins-quotes.json:", error);
    return [];
  }
}

/**
 * Decides when the buddy gets an opportunity to use a canonical quote, picks
 * fitting candidates, and tracks recent usage so the same line is not repeated.
 * Usage history is kept in memory only — the buddy process is long-lived.
 */
export class QuoteEngine {
  private readonly quotes: Quote[] = loadQuotes();
  private usage: UsageRecord[] = [];

  shouldOfferOpportunity(opts: { notable: boolean }): boolean {
    const cfg = getBuddyConfig().persona.steinsQuotes;
    if (!cfg.enabled || this.quotes.length === 0) {
      return false;
    }

    const lastUsedAt = this.lastUsedAt();
    if (lastUsedAt !== null && Date.now() - lastUsedAt < cfg.minGapMinutes * 60_000) {
      return false;
    }

    const probability = opts.notable ? cfg.chance : cfg.chance * 0.3;
    return Math.random() < probability;
  }

  selectCandidates(situationText: string, count = 5): Quote[] {
    const now = Date.now();
    const recentlyUsed = new Set(
      this.usage.filter((record) => now - record.atMs < RECENT_EXCLUDE_MS).map((record) => record.id),
    );
    const pool = this.quotes.filter((quote) => quote.workApplicable && !recentlyUsed.has(quote.id));
    if (pool.length === 0) {
      return [];
    }

    const haystack = situationText.toLowerCase();
    const scored = pool.map((quote) => ({
      quote,
      score: quote.tags.reduce(
        (acc, tag) => acc + (haystack.includes(tag.toLowerCase()) ? 1 : 0),
        0,
      ),
      lastUsed: this.usage
        .filter((record) => record.id === quote.id)
        .reduce((max, record) => Math.max(max, record.atMs), 0),
    }));
    // Highest tag-match score first; ties broken by least-recently-used so
    // unmatched quotes still rotate in as fill.
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.lastUsed - b.lastUsed));
    return scored.slice(0, count).map((entry) => entry.quote);
  }

  recordUsed(id: string): void {
    this.usage.push({ id, atMs: Date.now() });
    if (this.usage.length > MAX_USAGE_RECORDS) {
      this.usage = this.usage.slice(-MAX_USAGE_RECORDS);
    }
  }

  private lastUsedAt(): number | null {
    if (this.usage.length === 0) {
      return null;
    }
    return this.usage.reduce((max, record) => Math.max(max, record.atMs), 0);
  }
}
