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
  /** Summarise a bundle. `allowFollowup` enables the FOLLOWUP/MISSING control
   *  channels; `preamble` carries distilled findings from earlier rounds. */
  distill: (bundle: string, allowFollowup: boolean, preamble?: string) => Promise<{ text: string; usage?: any }>;
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
  /** Facts the summariser flagged as still unverified (MISSING lines). */
  missing: string[];
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
const MISSING_RE = /^[ \t]*MISSING:[ \t]*(.+?)[ \t]*$/gim;
const MISSING_LINE_STRIP = /^[ \t]*MISSING:.*$/gim;

/** Extract a follow-up query, or null. Also returns the answer with any
 *  FOLLOWUP control line removed — it is never part of the user-visible answer. */
export function parseFollowup(text: string): { followup: string | null; answer: string } {
  const m = text.match(FOLLOWUP_RE);
  const answer = text.replace(FOLLOWUP_STRIP, "").trim();
  if (!m) return { followup: null, answer };
  const q = m[1].replace(/^["'`]|["'`]$/g, "").trim().slice(0, 200);
  return { followup: q || null, answer };
}

/** Extract structured gap reports (`MISSING: <item>` lines) and strip them
 *  from the answer — they are control-channel, not user-visible prose. */
export function parseMissing(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  MISSING_RE.lastIndex = 0;
  while ((m = MISSING_RE.exec(text))) {
    const item = m[1].replace(/^["'`]|["'`]$/g, "").trim().slice(0, 200);
    if (item) out.push(item);
  }
  return out;
}

function stripMissing(text: string): string {
  return text.replace(MISSING_LINE_STRIP, "").replace(/\n{3,}/g, "\n\n").trim();
}

export async function runSearchHops(query: string, deps: HopDeps): Promise<HopResult> {
  const seenUrls = new Set<string>();
  const seenQueries = new Set<string>([query.trim().toLowerCase()]);
  const queries: string[] = [query];
  const missing: string[] = [];
  let usage: any;
  let hop = 0;
  let answer = "";
  // Distilled findings from earlier rounds. Raw pages are deliberately replaced
  // each round (fresh material only) but the SUMMARIES survive as a preamble,
  // so a hop-2 round that only checks one specific version still knows what
  // round 1 established. Without this, multi-hop suffers context amnesia.
  let priorFindings = "";

  const first = await deps.research(query);
  if (first?.error && !hasResearchContent(first)) {
    return { answer: "", usage, hops: 0, queries, missing, error: first.error };
  }
  pageUrlsOf(first).forEach((u) => seenUrls.add(u));
  let bundle = deps.render(first, {});

  for (;;) {
    const allowFollowup = hop < deps.maxHops;
    const preamble = priorFindings
      ? `Findings already established by earlier research rounds (treat as verified context, do not re-derive):\n${priorFindings}`
      : undefined;
    const { text, usage: u } = await deps.distill(bundle, allowFollowup, preamble);
    usage = mergeUsage(usage, u);

    const { followup, answer: cleaned } = parseFollowup(text);
    const gaps = parseMissing(cleaned);
    const answerNoGaps = stripMissing(cleaned);
    if (answerNoGaps) answer = answerNoGaps;
    // The latest round's gap report is authoritative: it sees the full preamble
    // (all earlier findings), so gaps it no longer flags have been filled.
    missing.length = 0;
    for (const g of gaps) missing.push(g);

    if (answerNoGaps) {
      priorFindings =
        (priorFindings ? priorFindings + "\n\n" : "") + `Round ${hop}: ${answerNoGaps}`;
      if (priorFindings.length > 6000) priorFindings = priorFindings.slice(-6000);
    }

    if (!allowFollowup) break;

    // Explicit FOLLOWUP wins; otherwise unverified gaps themselves drive the
    // next round (structured gap reporting).
    let nextQuery = followup || "";
    if (!nextQuery && gaps.length) nextQuery = gaps.slice(0, 2).join(" ");
    nextQuery = nextQuery.trim().slice(0, 200);
    if (!nextQuery) break;
    if (seenQueries.has(nextQuery.toLowerCase())) break;

    seenQueries.add(nextQuery.toLowerCase());
    hop++;

    const next = await deps.research(nextQuery);
    const fresh = (Array.isArray(next?.pages) ? next!.pages : []).filter(
      (p: any) => p?.url && !seenUrls.has(p.url)
    );
    fresh.forEach((p: any) => seenUrls.add(p.url));
    queries.push(nextQuery);

    // Nothing new: another round would re-summarise the same material.
    if (!fresh.length) break;

    bundle = deps.render(
      { ...next, pages: fresh },
      {
        note:
          `Additional research, round ${hop} of at most ${deps.maxHops}. ` +
          `Earlier findings are in the preamble; answer the ORIGINAL query, merging this new material with what is already established.`,
      }
    );
  }

  // Surface remaining gaps so the main agent knows what was not verified.
  if (missing.length && answer) {
    answer += "\n\nMissing information (not found in sources): " + missing.join("; ");
  }

  return { answer, usage, hops: hop, queries, missing };
}
