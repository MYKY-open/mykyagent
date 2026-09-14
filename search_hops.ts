/**
 * Multi-hop search orchestration for MykyAgent.
 *
 * Kept independent of the pi runtime so the control flow can be unit-tested.
 * The expensive decisions here are: when to spend another research round, and
 * when to stop. Tokens are the scarcer resource than latency, so the loop only
 * escalates when the summariser itself declares the material insufficient, and
 * it bails immediately when a follow-up yields nothing new.
 */

export interface ResearchPayload {
  pages?: any[];
  direct_links?: any[];
  structured?: Record<string, unknown>;
  search_snippets?: any[];
  queries_used?: string[];
  error?: string;
}

export interface HopDeps {
  /** Run one full research round. */
  research: (query: string) => Promise<ResearchPayload>;
  /** Summarise a bundle. `allowFollowup` enables the FOLLOWUP control channel. */
  distill: (bundle: string, allowFollowup: boolean) => Promise<{ text: string; usage?: any }>;
  /** Render a payload into a fenced bundle. */
  render: (raw: ResearchPayload, opts: { note?: string }) => string;
  /** Max extra rounds. 0 disables hopping. */
  maxHops: number;
}

export interface HopResult {
  answer: string;
  usage?: any;
  hops: number;
  queries: string[];
  /** Set only when coverage failed entirely. */
  error?: string;
}

export function hasResearchContent(raw: ResearchPayload | undefined | null): boolean {
  return Boolean(
    (Array.isArray(raw?.pages) && raw!.pages!.length > 0) ||
      (Array.isArray(raw?.direct_links) && raw!.direct_links!.length > 0) ||
      (raw?.structured && Object.keys(raw.structured).length > 0)
  );
}

export function pageUrlsOf(raw: ResearchPayload | undefined | null): string[] {
  return Array.isArray(raw?.pages) ? raw!.pages!.map((p: any) => p?.url).filter(Boolean) : [];
}

/** Merge two usage records, summing nested cost fields. */
export function mergeUsage(a: any, b: any): any {
  if (!a) return b;
  if (!b) return a;
  const n = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const c = (x: any) => x?.cost || {};
  return {
    input: n(a.input) + n(b.input),
    output: n(a.output) + n(b.output),
    cacheRead: n(a.cacheRead) + n(b.cacheRead),
    cacheWrite: n(a.cacheWrite) + n(b.cacheWrite),
    totalTokens: n(a.totalTokens) + n(b.totalTokens),
    cost: {
      input: n(c(a).input) + n(c(b).input),
      output: n(c(a).output) + n(c(b).output),
      cacheRead: n(c(a).cacheRead) + n(c(b).cacheRead),
      cacheWrite: n(c(a).cacheWrite) + n(c(b).cacheWrite),
      total: n(c(a).total) + n(c(b).total),
    },
  };
}

const FOLLOWUP_RE = /^[ \t]*FOLLOWUP:[ \t]*(.+?)[ \t]*$/im;
const FOLLOWUP_STRIP = /^[ \t]*FOLLOWUP:.*$/gim;

/** Extract a follow-up query, or null. Also returns the answer with any
 *  FOLLOWUP control line removed — it is never part of the user-visible answer. */
export function parseFollowup(text: string): { followup: string | null; answer: string } {
  const m = text.match(FOLLOWUP_RE);
  const answer = text.replace(FOLLOWUP_STRIP, "").trim();
  if (!m) return { followup: null, answer };
  const q = m[1].replace(/^["'`]|["'`]$/g, "").trim().slice(0, 200);
  return { followup: q || null, answer };
}

export async function runSearchHops(query: string, deps: HopDeps): Promise<HopResult> {
  const seenUrls = new Set<string>();
  const seenQueries = new Set<string>([query.trim().toLowerCase()]);
  const queries: string[] = [query];
  let usage: any;
  let hop = 0;
  let answer = "";

  const first = await deps.research(query);
  if (first?.error && !hasResearchContent(first)) {
    return { answer: "", usage, hops: 0, queries, error: first.error };
  }
  pageUrlsOf(first).forEach((u) => seenUrls.add(u));
  let bundle = deps.render(first, {});

  for (;;) {
    const allowFollowup = hop < deps.maxHops;
    const { text, usage: u } = await deps.distill(bundle, allowFollowup);
    usage = mergeUsage(usage, u);

    const { followup, answer: cleaned } = parseFollowup(text);
    if (cleaned) answer = cleaned;

    if (!allowFollowup || !followup) break;
    if (seenQueries.has(followup.toLowerCase())) break;

    seenQueries.add(followup.toLowerCase());
    hop++;

    const next = await deps.research(followup);
    const fresh = (Array.isArray(next?.pages) ? next!.pages : []).filter(
      (p: any) => p?.url && !seenUrls.has(p.url)
    );
    fresh.forEach((p: any) => seenUrls.add(p.url));
    queries.push(followup);

    // Nothing new: another round would re-summarise the same material.
    if (!fresh.length) break;

    bundle = deps.render(
      { ...next, pages: fresh },
      {
        note:
          `Additional research, round ${hop} of at most ${deps.maxHops}. ` +
          `The earlier material was insufficient; answer the ORIGINAL query using this new material.`,
      }
    );
  }

  return { answer, usage, hops: hop, queries };
}
