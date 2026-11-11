/**
 * Model-directed, branch-local compaction using Pi's append-only context edits.
 * No transcript rewriting, model sub-calls, filesystem rollback, or global state.
 * The tool stages one edit; turn_end applies it only after its tool result exists.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

export const COMPACTION_TYPE = "mykyagent-selective-compaction";
/** Hidden custom message that starts a /compact-context review turn. */
export const PROBE_TYPE = "mykyagent-compact-probe";
const SUMMARY_MAX = 6000;
const READ_MAX = 12000;
/** Trailing entries are the working set: list flags them, nothing forbids them. */
const RECENT_TRAIL = 6;
/** Neighbourhood returned around each `query` hit. */
const MATCH_WINDOW = 2;
const MAX_RANGES = 8;

type Row = ProjectedSessionEntry;
type ReadonlySessionManager = ExtensionContext["sessionManager"];
interface BlockRange {
  ids: string[];
  summary: string;
}
/** v2: one block can cover several disjoint ranges, each with its own summary. */
interface Block {
  version: 2;
  id: string;
  ranges: BlockRange[];
}
interface PlannedRange {
  ids: string[];
  replacement: string;
  fingerprints: string[];
  beforeChars: number;
}
interface Plan {
  block: Block;
  ranges: PlannedRange[];
  beforeChars: number;
}
interface RangeSpec {
  from: unknown;
  through: unknown;
  summary: unknown;
}
interface Pending {
  sessionId: string;
  assistantId: string;
  callId: string;
  plan: Plan;
}
interface Probe {
  sessionId: string;
  /** Every entry that existed before the review started; named by ID, not position. */
  baselineIds: Set<string>;
}

export interface SelectiveCompactionController {
  /** Mark the start of a /compact-context review turn (before its hidden prompt). */
  beginProbe(manager: ReadonlySessionManager): void;
}

/**
 * A manual review turn exposes the tool even when its toggle is off, so a human
 * can always ask for compaction. Autonomous use still requires the toggle.
 * Scoped to one session: a stale review cannot leak the tool into another one.
 */
let reviewSessionId: string | null = null;
export function compactionReviewSession(): string | null {
  return reviewSessionId;
}

function rows(manager: ReadonlySessionManager): Row[] {
  if (typeof manager?.buildSessionProjection !== "function") {
    throw new Error("Selective compaction requires Pi's session projection and turn_end context-edit APIs.");
  }
  return manager.buildSessionProjection().entries.filter((e) => e.messages.length > 0);
}

/** Accepts current v2 blocks and v1 blocks written before multi-range support. */
function normalizeBlock(data: any): Block | null {
  if (!data || typeof data !== "object" || typeof data.id !== "string") return null;
  if (data.version === 2 && Array.isArray(data.ranges)) {
    const ranges: BlockRange[] = [];
    for (const r of data.ranges) {
      if (!r || !Array.isArray(r.ids) || !r.ids.every((id: any) => typeof id === "string") || typeof r.summary !== "string") return null;
      ranges.push({ ids: [...r.ids], summary: r.summary });
    }
    return ranges.length ? { version: 2, id: data.id, ranges } : null;
  }
  if (data.version === 1 && Array.isArray(data.ids) && data.ids.every((id: any) => typeof id === "string") && typeof data.summary === "string") {
    return { version: 2, id: data.id, ranges: [{ ids: [...data.ids], summary: data.summary }] };
  }
  return null;
}

function blocks(branch: SessionEntry[]): Block[] {
  return branch.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== COMPACTION_TYPE) return [];
    const b = normalizeBlock(entry.data);
    return b ? [b] : [];
  });
}

function blockIds(block: Block): string[] {
  return block.ranges.flatMap((r) => r.ids);
}

function calls(message: any): any[] {
  return Array.isArray(message.content) ? message.content.filter((c: any) => c.type === "toolCall") : [];
}

/** Textual archive view. Binary images remain intact in the original session. */
function archiveJson(value: unknown, pretty = false): string {
  return JSON.stringify(value, (_key, v) => v?.type === "image" && typeof v.data === "string"
    ? { ...v, data: `[${v.data.length} base64 characters; image bytes retained in session archive]` }
    : v, pretty ? 2 : undefined);
}

function contentChars(row: Row): number {
  return row.messages.reduce((n, m: any) => n + archiveJson(m.content ?? m).length, 0);
}

function protectedReason(row: Row, archived: Set<string>, currentId?: string): string | undefined {
  const entry = row.sourceEntry;
  if (entry.id === currentId) return "current tool turn";
  if (archived.has(entry.id)) return "existing compaction summary";
  if (entry.type !== "message" || row.messages.length !== 1) return "session/system context";
  const role = row.messages[0].role;
  if (role !== "assistant" && role !== "toolResult") return `${role} message`;
  return undefined;
}

function currentAssistant(branch: SessionEntry[]): any {
  return branch.findLast((e) => e.type === "message" && e.message.role === "assistant");
}

function planRange(active: Row[], positions: Map<string, number>, currentIndex: number, archived: Set<string>,
  currentId: string, spec: RangeSpec, id: string, label: string): PlannedRange {
  const { from, through, summary } = spec;
  if (typeof from !== "string" || !from) throw new Error(`${label}requires from (a stable message ID from list).`);
  const end = through === undefined ? from : through;
  const startIndex = active.findIndex((e) => e.sourceEntry.id === from);
  const endIndex = active.findIndex((e) => e.sourceEntry.id === end);
  if (startIndex < 0 || endIndex < 0) throw new Error(`${label}endpoint is not in current context. Use list for active IDs.`);
  if (endIndex < startIndex) throw new Error(`${label}range endpoints are reversed.`);
  if (typeof summary !== "string" || !summary.trim()) throw new Error(`${label}requires a non-empty summary.`);
  const clean = summary.trim();
  if (clean.length > SUMMARY_MAX) throw new Error(`${label}summary exceeds ${SUMMARY_MAX} characters; shorten it explicitly.`);
  const selected = active.slice(startIndex, endIndex + 1);
  for (const row of selected) {
    const reason = protectedReason(row, archived, currentId);
    if (reason) throw new Error(`${label}cannot compact ${row.sourceEntry.id}: protected ${reason}.`);
    if ((positions.get(row.sourceEntry.id) ?? Infinity) >= currentIndex) {
      throw new Error(`${label}only earlier, completed messages can be compacted.`);
    }
  }

  // A range must own every call/result it removes, including parallel calls.
  const waiting = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of selected) {
    const message: any = row.messages[0];
    if (message.role === "assistant") {
      if (waiting.size) throw new Error(`${label}range contains an incomplete tool exchange before another assistant message.`);
      for (const call of calls(message)) {
        if (seen.has(call.id)) throw new Error(`${label}range contains duplicate tool call IDs.`);
        seen.add(call.id);
        waiting.set(call.id, call.name);
      }
    } else {
      if (!waiting.has(message.toolCallId) || waiting.get(message.toolCallId) !== message.toolName) {
        throw new Error(`${label}range splits a tool exchange at ${row.sourceEntry.id}; include its assistant call and all results.`);
      }
      waiting.delete(message.toolCallId);
    }
  }
  if (waiting.size) throw new Error(`${label}range splits a tool exchange; include all tool results.`);
  const replacement = `[Selective compaction ${id}: assistant-written summary, not verbatim execution evidence. Originals: context_compact read id=${id}]\n${clean}`;
  const beforeChars = selected.reduce((n, row) => n + contentChars(row), 0);
  if (archiveJson([{ type: "text", text: replacement }]).length >= beforeChars) {
    throw new Error(`${label}summary plus archive label is not smaller than the selected content; keep these messages or shorten the summary.`);
  }
  return {
    ids: selected.map((r) => r.sourceEntry.id),
    replacement,
    fingerprints: selected.map((r) => JSON.stringify(r.messages)),
    beforeChars,
  };
}

export function makePlan(active: Row[], branch: SessionEntry[], currentId: string, specs: RangeSpec[]): Plan {
  if (!Array.isArray(specs) || specs.length === 0) throw new Error("compact requires at least one range.");
  if (specs.length > MAX_RANGES) throw new Error(`At most ${MAX_RANGES} ranges per compaction.`);
  const archived = new Set(blocks(branch).flatMap((b) => blockIds(b)));
  const positions = new Map(branch.map((e, i) => [e.id, i]));
  const currentIndex = branch.findIndex((e) => e.id === currentId);
  // Providers may reuse tool-call IDs; Pi's persisted entry ID is branch-stable and unique.
  const id = `compact:${currentId}`;
  const ranges: PlannedRange[] = [];
  const seen = new Set<string>();
  for (const [i, spec] of specs.entries()) {
    const label = specs.length > 1 ? `Range ${i + 1}: ` : "";
    const range = planRange(active, positions, currentIndex, archived, currentId, spec, id, label);
    for (const entryId of range.ids) {
      if (seen.has(entryId)) throw new Error(`${label}ranges overlap at ${entryId}; ranges must be disjoint.`);
      seen.add(entryId);
    }
    ranges.push(range);
  }
  const block: Block = {
    version: 2,
    id,
    ranges: specs.map((spec, i) => ({ ids: ranges[i].ids, summary: String(spec.summary ?? "").trim() })),
  };
  return { block, ranges, beforeChars: ranges.reduce((n, r) => n + r.beforeChars, 0) };
}

function integer(value: unknown, fallback: number, max: number, name: string, min = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function k(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Objective "should I?" signal from Pi; never guessed from characters. */
function usageLine(usage: any): string {
  if (!usage || typeof usage.contextWindow !== "number") return "usage unknown";
  const window = k(usage.contextWindow);
  return typeof usage.percent === "number" && typeof usage.tokens === "number"
    ? `usage ${Math.round(usage.percent)}% (${k(usage.tokens)} / ${window})`
    : `usage unknown (window ${window})`;
}

function listContext(manager: ReadonlySessionManager, args: any, usage?: any): string {
  const active = rows(manager);
  const branch = manager.getBranch();
  const saved = blocks(branch);
  const archived = new Set(saved.flatMap((b) => blockIds(b)));
  const currentId = currentAssistant(branch)?.id;
  const limit = integer(args.limit, 20, 50, "list limit", 1);
  // The trailing entries are the working set: flag them, never forbid them.
  const recentFrom = Math.max(0, active.length - RECENT_TRAIL);
  const header = `Current context: ${active.length} entries · ${usageLine(usage)}. IDs are stable; ranges are inclusive. Tool calls and ALL their results must stay together. Compact only finished work: [recent] entries are the working set.`;
  const archiveLine = saved.length
    ? `Archive blocks (${saved.length}): ${saved.slice(-20).map((b) => b.id).join(", ")}${saved.length > 20 ? " (latest 20)" : ""}`
    : "";
  const render = (index: number, row: Row, match = false) => {
    const reason = protectedReason(row, archived, currentId);
    const block = saved.find((b) => b.ranges.some((r) => r.ids[0] === row.sourceEntry.id));
    const roles = row.messages.map((m: any) => m.role + (m.toolName ? `:${m.toolName}` : "")).join(",");
    const preview = row.messages.map((m: any) => archiveJson(m.content ?? m)).join(" ").replace(/\s+/g, " ").slice(0, 100);
    const recent = index >= recentFrom ? " [recent]" : "";
    return `${row.sourceEntry.id} ${roles} ~${contentChars(row)} chars${reason ? ` [protected: ${reason}]` : ""}${recent}${match ? " [match]" : ""}${block ? ` [${block.id}]` : ""}\n  ${preview}`;
  };

  // Targeted lookup: find an exhausted block by its text instead of paging
  // through hundreds of entries (the listing itself costs context).
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query) {
    const needle = query.toLowerCase();
    const matches = active
      .map((row, index) => ({ row, index, text: archiveJson(row.messages).toLowerCase() }))
      .filter((m) => m.text.includes(needle));
    if (!matches.length) {
      return [header, `No entries match "${query}" (case-insensitive search over ${active.length} active entries).`, archiveLine].filter(Boolean).join("\n");
    }
    let start = 0;
    if (args.cursor !== undefined) {
      const at = matches.findIndex((m) => m.row.sourceEntry.id === args.cursor);
      if (at < 0) throw new Error("Unknown cursor for this query; list without cursor to restart.");
      start = at + 1;
    }
    const page = matches.slice(start, start + limit);
    const ids = new Set<number>();
    for (const m of page) {
      for (let i = Math.max(0, m.index - MATCH_WINDOW); i <= Math.min(active.length - 1, m.index + MATCH_WINDOW); i++) ids.add(i);
    }
    const matched = new Set(page.map((m) => m.index));
    const lines = [...ids].sort((a, b) => a - b).map((i) => render(i, active[i], matched.has(i)));
    const more = start + page.length < matches.length;
    return [
      `${header} Query "${query}": ${matches.length} matching entr${matches.length === 1 ? "y" : "ies"} (showing ${start + 1}-${start + page.length}). Neighbours included.`,
      ...lines,
      more ? `Next page: list query="${query}" cursor=${page[page.length - 1].row.sourceEntry.id}` : "End of matches.",
      archiveLine,
    ].filter(Boolean).join("\n");
  }

  const cursor = args.cursor === undefined ? -1 : active.findIndex((e) => e.sourceEntry.id === args.cursor);
  if (args.cursor !== undefined && cursor < 0) throw new Error("Unknown cursor; list without cursor to restart.");
  const page = active.slice(cursor + 1, cursor + 1 + limit);
  const lines = page.map((row, i) => render(cursor + 1 + i, row));
  const more = cursor + 1 + page.length < active.length;
  return [
    header,
    ...lines,
    more ? `Next page: list cursor=${page[page.length - 1].sourceEntry.id}` : "End of current context.",
    archiveLine,
  ].filter(Boolean).join("\n");
}

function readArchive(manager: ReadonlySessionManager, args: any): string {
  if (typeof args.id !== "string" || !args.id) throw new Error("read requires a message ID or compact:<entry-id> block ID.");
  const branch = manager.getBranch();
  const block = blocks(branch).find((b) => b.id === args.id);
  const ids = block ? blockIds(block) : [args.id];
  const byId = new Map(branch.map((e) => [e.id, e]));
  const entries = ids.map((id) => byId.get(id));
  if (entries.some((e) => !e || e.type !== "message")) throw new Error("No original message/block with that ID on the active branch.");
  const text = entries.map((e) => archiveJson(e, true)).join("\n\n");
  const offset = integer(args.offset, 0, text.length, "read offset");
  const limit = integer(args.limit, READ_MAX, READ_MAX, "read limit", 1);
  const end = Math.min(text.length, offset + limit);
  return `Original archive ${args.id}; characters ${offset}..${end} of ${text.length} (0-based).${end < text.length ? ` Next: read id=${args.id} offset=${end}` : ""}\n${text.slice(offset, end)}`;
}

export function registerSelectiveCompaction(pi: any): SelectiveCompactionController {
  // Only the single direct compaction call in an assistant turn may stage a plan.
  // Bound to session + persisted assistant + call ID: abort/reload/branch cannot
  // accidentally apply a stale plan to another conversation.
  let pending: Pending | undefined;
  // A /compact-context review is provisional: if it produced no compaction, its
  // hidden prompt, tool calls and answer are omitted from model context and the
  // human just gets a toast.
  let probe: Probe | undefined;
  const beginProbe = (manager: ReadonlySessionManager) => {
    const branch = manager.getBranch();
    probe = { sessionId: manager.getSessionId(), baselineIds: new Set(branch.map((e) => e.id)) };
    reviewSessionId = probe.sessionId;
  };

  pi.registerTool({
    name: "context_compact",
    label: "Selective Context Compaction",
    description: "Selectively shorten EXHAUSTED investigation/debug history. Use when: an investigation is finished and its findings are captured, an approach was abandoned, or list shows high context usage. Do NOT compact the current task, [recent] entries (the working set), user instructions, or a range smaller than about twice your summary plus the listing you paid for. list = stable IDs + usage (add query to find entries by text instead of paging); compact = replace one or more disjoint completed assistant/tool ranges, each with YOUR summary (applied at the end of this turn; no listing needed to confirm); read = archived originals (reading pastes them back into context). Preserve constraints, decisions, failures and actual verification with the command that decided it. Never user/system messages or partial tool exchanges. compact must be the only tool call in its turn. Originals stay in the session; no file rollback or model sub-call. Rewriting a prefix can invalidate prompt cache, so compact occasionally, not constantly.",
    parameters: Type.Object({
      action: Type.String({ description: "list | compact | read" }),
      from: Type.Optional(Type.String({ description: "compact: first message ID from list (single range)" })),
      through: Type.Optional(Type.String({ description: "compact: last message ID, inclusive (default: from)" })),
      summary: Type.Optional(Type.String({ description: "compact: replacement summary, max 6000 chars; retain relevant facts and uncertainties" })),
      ranges: Type.Optional(Type.Array(Type.Object({
        from: Type.String({ description: "first message ID of this range" }),
        through: Type.Optional(Type.String({ description: "last message ID, inclusive (default: from)" })),
        summary: Type.String({ description: "summary replacing exactly this range; keep identifiers, rejected options, deciding output" }),
      }), { description: `compact: 1-${MAX_RANGES} disjoint ranges, each with its own summary, applied atomically` })),
      id: Type.Optional(Type.String({ description: "read: original message ID or compact:<entry-id> block ID returned by compact/list" })),
      query: Type.Optional(Type.String({ description: "list: case-insensitive text filter; returns matches plus neighbours" })),
      cursor: Type.Optional(Type.String({ description: "list: page after this message ID (with query: last match ID)" })),
      offset: Type.Optional(Type.Number({ description: "read: character offset, 0-based" })),
      limit: Type.Optional(Type.Number({ description: "list: entries/matches (default 20, max 50); read: characters (default/max 12000)" })),
    }),
    async execute(callId: string, args: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      try {
        if (signal?.aborted) throw new Error("Compaction call cancelled.");
        const manager: ReadonlySessionManager = ctx?.sessionManager;
        rows(manager); // Capability check before every action; never touch global stores.
        let text: string;
        if (args.action === "list") {
          let usage: any;
          try { usage = ctx?.getContextUsage?.(); } catch {}
          text = listContext(manager, args, usage);
        }
        else if (args.action === "read") text = readArchive(manager, args);
        else if (args.action === "compact") {
          const branch = manager.getBranch();
          const assistant = currentAssistant(branch);
          const toolCalls = assistant ? calls(assistant.message) : [];
          if (toolCalls.length !== 1 || toolCalls[0].id !== callId || toolCalls[0].name !== "context_compact") {
            throw new Error("compact must be the only direct tool call in its assistant turn; list/read may be called normally.");
          }
          const multi = Array.isArray(args.ranges);
          if (multi && (args.from !== undefined || args.through !== undefined || args.summary !== undefined)) {
            throw new Error("Use either ranges or from/through/summary, not both.");
          }
          const specs: RangeSpec[] = multi
            ? args.ranges.map((r: any) => ({ from: r?.from, through: r?.through, summary: r?.summary }))
            : [{ from: args.from, through: args.through, summary: args.summary }];
          const plan = makePlan(rows(manager), branch, assistant.id, specs);
          pending = { sessionId: manager.getSessionId(), assistantId: assistant.id, callId, plan };
          const detail = plan.ranges
            .map((r, i) => `${plan.ranges.length > 1 ? `range ${i + 1}: ` : ""}${r.ids.length} messages (~${r.beforeChars} chars) → ${r.replacement.length} chars`)
            .join("; ");
          text = `Scheduled ${plan.block.id}: ${detail}. Applied at the end of this tool turn; no listing needed to confirm. Originals remain readable with id=${plan.block.id}. No files changed.`;
        } else throw new Error("Unknown action. Use list, compact, or read.");
        return { content: [{ type: "text", text }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: error?.message || String(error) }], isError: true };
      }
    },
  });

  pi.on("turn_end", (event: any, ctx: any) => {
    const manager: ReadonlySessionManager = ctx.sessionManager;
    const sessionId = manager.getSessionId();
    const drafts: any[] = [...(event.entries || [])];

    // 1. Apply a staged compaction only on the completed turn that staged it.
    if (pending && pending.sessionId === sessionId && pending.assistantId === event.messageEntryId) {
      const request = pending;
      pending = undefined;
      const result = event.toolResults?.find((r: any) => r.toolCallId === request.callId && r.toolName === "context_compact");
      if (result && !result.isError && event.outcome === "completed") {
        const active: Row[] | undefined = event.context?.contextEntries;
        const stale = request.plan.ranges.some((range) =>
          range.ids.some((id, i) => {
            const row = active?.find((r) => r.sourceEntry.id === id);
            return !row || JSON.stringify(row.messages) !== range.fingerprints[i];
          })
        );
        if (!active || stale) {
          drafts.push({
            type: "custom_message", customType: COMPACTION_TYPE, display: true,
            content: "Selective compaction was NOT applied: context changed before the turn boundary. List active IDs and retry.",
          });
        } else {
          for (const range of request.plan.ranges) {
            range.ids.forEach((id, i) => {
              drafts.push({
                type: "context_edit", targetId: id,
                replacement: i === 0 ? { content: [{ type: "text", text: range.replacement }] } : null,
              });
            });
          }
          drafts.push({ type: "custom", customType: COMPACTION_TYPE, data: request.plan.block });
        }
      }
    }

    // 2. A review turn is final when the assistant stops calling tools. No
    //    compaction by then means nothing qualified: drop the whole attempt
    //    from context and toast the human instead of leaving a dead turn.
    if (probe && probe.sessionId === sessionId && calls(event.message).length === 0) {
      const current = probe;
      probe = undefined;
      reviewSessionId = null;
      const fresh = manager.getBranch().filter((e) => !current.baselineIds.has(e.id));
      // Anchored on this review's own hidden prompt: a queued or unrelated turn
      // can never delete messages that were not part of the review.
      const anchored = fresh.some((e) => e.type === "custom_message" && e.customType === PROBE_TYPE);
      const compacted = fresh.some((e) => e.type === "custom" && e.customType === COMPACTION_TYPE);
      const intervened = fresh.some((e) => e.type === "message" && (e.message as any).role === "user");
      if (anchored && !compacted && !intervened && event.outcome === "completed") {
        const removable = fresh.filter((e) =>
          (e.type === "custom_message" && e.customType === PROBE_TYPE) ||
          (e.type === "message" && ((e.message as any).role === "assistant" || (e.message as any).role === "toolResult"))
        );
        drafts.push(...removable.map((e) => ({ type: "context_edit", targetId: e.id, replacement: null })));
        const said = (event.message.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/[.!?]+$/, "");
        try {
          const why = said ? `nothing qualified: ${said.slice(0, 200)}.` : "nothing qualified.";
          ctx.ui?.notify?.(`No compaction applied - ${why} The review turn was removed from context.`, "info");
        } catch {}
      }
    }

    if (drafts.length) return { entries: drafts };
  });

  // An aborted or failed review never gets its final-text turn, so drop the
  // probe without touching history. Editing on abort would delete work.
  pi.on("agent_end", (_event: any, ctx: any) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (probe && probe.sessionId === sessionId) {
      probe = undefined;
      reviewSessionId = null;
    }
    // A run that ended without a matching turn boundary can never apply its
    // staged plan; drop it instead of holding it for the process lifetime.
    if (pending && pending.sessionId === sessionId) pending = undefined;
  });

  return { beginProbe };
}

export default registerSelectiveCompaction;
