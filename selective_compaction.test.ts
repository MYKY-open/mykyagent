/** Offline tests against Pi's real append-only session projection and agent loop. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";
import { COMPACTION_TYPE, PROBE_TYPE, registerSelectiveCompaction } from "./selective_compaction.ts";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-compact-"));
let passed = 0, failed = 0, seq = 0;
async function test(name: string, fn: () => any) {
  try { await fn(); passed++; console.log(` PASS  ${name}`); }
  catch (e) { failed++; console.error(` FAIL  ${name}: ${e instanceof Error ? e.stack : e}`); }
}
const text = (r: any) => r.content.map((c: any) => c.text || "").join("\n");
const payload = "Unique investigation detail: stale generated bindings, not a timeout.\n".repeat(80);
const summary = "Generated bindings were stale. Regenerated them; focused tests passed. Timeout changes were rejected.";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content: any[], stopReason = "stop"): any {
  return { role: "assistant", content, api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason, timestamp: ++seq };
}
function toolResult(id: string, name: string, result: any): any {
  return { role: "toolResult", toolCallId: id, toolName: name, content: result.content, isError: !!result.isError, timestamp: ++seq };
}
function seed(manager = SessionManager.inMemory(DIR)) {
  const user = manager.appendMessage({ role: "user", content: "Do not change public APIs.", timestamp: ++seq });
  const first = manager.appendMessage(assistant([{ type: "toolCall", id: `read-${seq}`, name: "read", arguments: { path: "bindings.ts" } }], "toolUse"));
  const callId = (manager.getEntry(first) as any).message.content[0].id;
  const last = manager.appendMessage(toolResult(callId, "read", { content: [{ type: "text", text: payload }] }));
  const keep = manager.appendMessage(assistant([{ type: "text", text: "Current design: preserve the public interface.\n".repeat(15) }]));
  return { manager, user, first, last, keep };
}
function harness(manager: SessionManager) {
  let tool: any;
  const hooks: Record<string, any> = {};
  const controller = registerSelectiveCompaction({ registerTool: (t: any) => { tool = t; }, on: (n: string, f: any) => { hooks[n] = f; } });
  const ctx: any = { sessionManager: manager };
  const applyDrafts = (drafts: any[]) => {
    for (const draft of drafts || []) {
      if (draft.type === "context_edit") manager.appendContextEdit(draft.targetId, draft.replacement);
      else if (draft.type === "custom") manager.appendCustomEntry(draft.customType, draft.data);
      else if (draft.type === "custom_message") manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display);
    }
  };
  const call = (args: any, id = `call-${++seq}`, signal?: AbortSignal) => tool.execute(id, args, signal, undefined, ctx);
  async function start(args: any, extraCalls: any[] = []) {
    const id = `call-${++seq}`;
    const message = assistant([{ type: "toolCall", id, name: "context_compact", arguments: args }, ...extraCalls], "toolUse");
    const assistantId = manager.appendMessage(message);
    const result = await call(args, id);
    return { id, message, assistantId, result };
  }
  function finish(turn: any, options: any = {}) {
    const resultMessage = toolResult(turn.id, "context_compact", turn.result);
    const resultId = manager.appendMessage(resultMessage);
    const event = {
      message: turn.message, messageEntryId: turn.assistantId, toolResults: [resultMessage], toolResultEntryIds: [resultId],
      entries: [], context: { contextEntries: manager.buildSessionProjection().entries }, outcome: "completed", ...options,
    };
    const output = hooks.turn_end(event, ctx);
    applyDrafts(output?.entries || []);
    return output;
  }
  async function compact(args: any) {
    const turn = await start({ action: "compact", ...args });
    finish(turn);
    return turn;
  }
  return { call, start, finish, compact, tool, hooks, ctx, applyDrafts, beginProbe: controller.beginProbe };
}
const projected = (m: SessionManager) => JSON.stringify(m.buildSessionProjection().messages);
const compactArgs = (s: ReturnType<typeof seed>) => ({ from: s.first, through: s.last, summary });

try {
  await test("review with no candidates removes its whole turn and toasts the human", async () => {
    const s = seed(), h = harness(s.manager);
    h.beginProbe(s.manager);
    const nudge = s.manager.appendCustomMessageEntry(PROBE_TYPE, "Review this conversation for candidates.", false);
    const listCall = assistant([{ type: "toolCall", id: "probe-list", name: "context_compact", arguments: { action: "list" } }], "toolUse");
    s.manager.appendMessage(listCall);
    s.manager.appendMessage(toolResult("probe-list", "context_compact", { content: [{ type: "text", text: "Current context: 4 entries - nothing exhausted." }] }));
    const final = assistant([{ type: "text", text: "Usage is low and everything is still active." }]);
    s.manager.appendMessage(final);
    const notes: string[] = [];
    h.ctx.ui = { notify: (m: string) => notes.push(m) };
    const contextEntries = s.manager.buildSessionProjection().entries;
    const out = h.hooks.turn_end({ message: final, toolResults: [], entries: [], context: { contextEntries }, outcome: "completed" }, h.ctx);
    assert.equal(out?.entries?.length, 4, JSON.stringify(out?.entries)); // hidden prompt + list call + list result + answer
    h.applyDrafts(out!.entries);
    const proj = projected(s.manager);
    assert.doesNotMatch(proj, /Review this conversation for candidates/);
    assert.doesNotMatch(proj, /nothing exhausted/);
    assert.doesNotMatch(proj, /Usage is low and everything is still active/);
    assert.match(proj, /Unique investigation detail/);
    assert.match(proj, /Do not change public APIs/);
    assert.match(notes[0], /No compaction applied - nothing qualified: Usage is low and everything is still active\./);
    assert.match(notes[0], /removed from context/);
    assert.equal((s.manager.getEntry(nudge) as any).type, "custom_message");
  });

  await test("review that compacts keeps its turn and does not toast", async () => {
    const s = seed(), h = harness(s.manager);
    h.beginProbe(s.manager);
    s.manager.appendCustomMessageEntry(PROBE_TYPE, "Review this conversation for candidates.", false);
    await h.compact(compactArgs(s));
    const final = assistant([{ type: "text", text: "Compacted the finished investigation." }]);
    s.manager.appendMessage(final);
    const notes: string[] = [];
    h.ctx.ui = { notify: (m: string) => notes.push(m) };
    const out = h.hooks.turn_end({ message: final, toolResults: [], entries: [], context: { contextEntries: s.manager.buildSessionProjection().entries }, outcome: "completed" }, h.ctx);
    assert.equal(out, undefined);
    assert.equal(notes.length, 0);
    assert.match(projected(s.manager), /Generated bindings were stale/);
    assert.match(projected(s.manager), /Compacted the finished investigation/);
  });

  await test("aborted review drops the probe without deleting anything", async () => {
    const s = seed(), h = harness(s.manager);
    h.beginProbe(s.manager);
    h.hooks.agent_end({}, h.ctx);
    const final = assistant([{ type: "text", text: "Unrelated next answer." }]);
    s.manager.appendMessage(final);
    const out = h.hooks.turn_end({ message: final, toolResults: [], entries: [], context: { contextEntries: s.manager.buildSessionProjection().entries }, outcome: "completed" }, h.ctx);
    assert.equal(out, undefined);
    assert.match(projected(s.manager), /Unrelated next answer/);
  });

  await test("a real user message during the review cancels cleanup", async () => {
    const s = seed(), h = harness(s.manager);
    h.beginProbe(s.manager);
    s.manager.appendCustomMessageEntry(PROBE_TYPE, "Review this conversation for candidates.", false);
    s.manager.appendMessage({ role: "user", content: "stop, do something else", timestamp: ++seq });
    const final = assistant([{ type: "text", text: "Will do." }]);
    s.manager.appendMessage(final);
    const out = h.hooks.turn_end({ message: final, toolResults: [], entries: [], context: { contextEntries: s.manager.buildSessionProjection().entries }, outcome: "completed" }, h.ctx);
    assert.equal(out, undefined);
    assert.match(projected(s.manager), /stop, do something else/);
    assert.match(projected(s.manager), /Review this conversation for candidates/);
  });

  await test("review with a pending compaction is not mistaken for a fruitless one", async () => {
    // A failed compact attempt reports an error; the probe must then clean up
    // rather than leave the failed exchange in context.
    const s = seed(), h = harness(s.manager);
    h.beginProbe(s.manager);
    s.manager.appendCustomMessageEntry(PROBE_TYPE, "Review this conversation for candidates.", false);
    const turn = await h.start({ action: "compact", from: s.user, through: s.last, summary });
    assert.equal(turn.result.isError, true);
    h.finish(turn);
    const final = assistant([{ type: "text", text: "Nothing could be compacted under the rules." }]);
    s.manager.appendMessage(final);
    const out = h.hooks.turn_end({ message: final, toolResults: [], entries: [], context: { contextEntries: s.manager.buildSessionProjection().entries }, outcome: "completed" }, h.ctx);
    assert(out && out.entries.length >= 1, JSON.stringify(out));
    h.applyDrafts(out.entries);
    assert.doesNotMatch(projected(s.manager), /Nothing could be compacted under the rules/);
    assert.match(projected(s.manager), /Unique investigation detail/);
  });

  await test("list exposes stable IDs, previews, protection and pagination", async () => {
    const s = seed(), h = harness(s.manager);
    const r = await h.call({ action: "list", limit: 2 });
    assert.match(text(r), new RegExp(s.user));
    assert.match(text(r), /protected: user message/);
    assert.match(text(r), new RegExp(`Next page: list cursor=${s.first}`));
    const next = await h.call({ action: "list", cursor: s.first });
    assert.match(text(next), new RegExp(s.last));
    assert.doesNotMatch(text(next), new RegExp(s.user));
  });

  await test("list shows objective context usage from Pi, and says unknown when absent", async () => {
    const s = seed(), h = harness(s.manager);
    const live = await h.tool.execute("x", { action: "list" }, undefined, undefined, { sessionManager: s.manager, getContextUsage: () => ({ tokens: 156400, contextWindow: 200000, percent: 78 }) });
    assert.match(text(live), /usage 78% \(156k \/ 200k\)/);
    const fractional = await h.tool.execute("x", { action: "list" }, undefined, undefined, { sessionManager: s.manager, getContextUsage: () => ({ tokens: 132326, contextWindow: 1000000, percent: 13.2326 }) });
    assert.match(text(fractional), /usage 13% \(132k \/ 1M\)/, text(fractional).split("\n")[0]);
    const beforeFirst = await h.tool.execute("x", { action: "list" }, undefined, undefined, { sessionManager: s.manager, getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }) });
    assert.match(text(beforeFirst), /usage unknown \(window 200k\)/);
    assert.match(text(await h.call({ action: "list" })), /usage unknown\./);
    const broken = await h.tool.execute("x", { action: "list" }, undefined, undefined, { sessionManager: s.manager, getContextUsage: () => { throw new Error("stale ctx"); } });
    assert(!broken.isError, text(broken));
    assert.match(text(broken), /usage unknown/);
  });

  await test("list flags only the trailing working set as [recent]", async () => {
    const manager = SessionManager.inMemory(DIR);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(manager.appendMessage(assistant([{ type: "text", text: `step ${i}` }])));
    const h = harness(manager);
    const body = text(await h.call({ action: "list", limit: 50 }));
    const line = (id: string) => body.split("\n").find((l) => l.startsWith(id)) || "";
    for (const id of ids.slice(4)) assert.match(line(id), /\[recent\]/, line(id));
    for (const id of ids.slice(0, 4)) assert.doesNotMatch(line(id), /\[recent\]/, line(id));
    assert.match(body, /\[recent\] entries are the working set/);
  });

  await test("compact result tells the model not to confirm with list", async () => {
    const s = seed(), h = harness(s.manager);
    const turn = await h.start({ action: "compact", ...compactArgs(s) });
    assert.match(text(turn.result), /Applied at the end of this tool turn; no listing needed to confirm/);
  });

  await test("tool description carries the decision trigger, recency and size guidance", async () => {
    const s = seed(), h = harness(s.manager);
    const d = h.tool.description;
    for (const part of ["Use when", "abandoned", "high context usage", "Do NOT compact the current task", "[recent]", "twice your summary", "no listing needed to confirm", "reading pastes them back"]) {
      assert(d.includes(part), `missing guidance: ${part}`);
    }
  });

  await test("compaction applies only at the completed tool boundary; raw messages stay intact", async () => {
    const s = seed(), h = harness(s.manager);
    const original = JSON.stringify(s.manager.getBranch());
    const turn = await h.start({ action: "compact", ...compactArgs(s) });
    assert.equal(turn.result.isError, undefined, text(turn.result));
    assert.match(projected(s.manager), /Unique investigation detail/);
    h.finish(turn);
    assert.doesNotMatch(projected(s.manager), /Unique investigation detail/);
    assert.match(projected(s.manager), /Generated bindings were stale/);
    assert.match(projected(s.manager), /Do not change public APIs/);
    assert.match(projected(s.manager), /Current design/);
    assert.equal(JSON.stringify(s.manager.getBranch().slice(0, 4)), original);
    assert.equal(s.manager.buildSessionProjection().entries.find((e) => e.sourceEntry.id === s.last)?.messages.length, 0);
    const llm = convertToLlm(s.manager.buildSessionProjection().messages);
    assert(!llm.some((m: any) => m.role === "toolResult" && m.toolName === "read"));
    assert(!llm.some((m: any) => m.role === "assistant" && m.content.some((c: any) => c.type === "toolCall" && c.name === "read")));
  });

  await test("read recovers exact original text by block or message ID with bounded paging", async () => {
    const s = seed(), h = harness(s.manager);
    const turn = await h.compact(compactArgs(s));
    const block = await h.call({ action: "read", id: `compact:${turn.assistantId}`, limit: 100 });
    assert.match(text(block), /Next: read/);
    assert.equal(text(block).split("\n").slice(1).join("\n").length, 100);
    const recovered = await h.call({ action: "read", id: s.last });
    assert.match(text(recovered), /Unique investigation detail/);
    assert.equal(JSON.parse(text(recovered).slice(text(recovered).indexOf("\n") + 1)).message.content[0].text, payload);
    const page = await h.call({ action: "read", id: s.last, offset: 25, limit: 37 });
    assert.equal(text(page).split("\n").slice(1).join("\n"), text(recovered).split("\n").slice(1).join("\n").slice(25, 62));
  });

  await test("single assistant message can be compacted without a through parameter", async () => {
    const s = seed(), h = harness(s.manager);
    const turn = await h.compact({ from: s.keep, summary: "Preserve the public interface." });
    assert(!turn.result.isError, text(turn.result));
    assert.match(projected(s.manager), /Selective compaction/);
    assert.match(projected(s.manager), /Unique investigation detail/);
  });

  for (const [name, makeArgs, expected] of [
    ["user instructions", (s: any) => ({ from: s.user, through: s.last, summary }), /protected user/],
    ["a result without its call", (s: any) => ({ from: s.last, summary }), /splits a tool exchange/],
    ["a call without its result", (s: any) => ({ from: s.first, summary }), /include all tool results/],
    ["reversed range", (s: any) => ({ from: s.last, through: s.first, summary }), /reversed/],
    ["unknown IDs", (_s: any) => ({ from: "missing", summary }), /not in current context/],
    ["empty summary", (s: any) => ({ from: s.first, through: s.last, summary: " \n " }), /non-empty/],
    ["oversize summary", (s: any) => ({ from: s.first, through: s.last, summary: "x".repeat(6001) }), /exceeds/],
    ["non-shrinking replacement", (s: any) => ({ from: s.keep, summary: "x".repeat(1000) }), /not smaller/],
  ] as const) {
    await test(`rejects ${name} without writing context edits`, async () => {
      const s = seed(), h = harness(s.manager);
      const turn = await h.compact(makeArgs(s));
      assert.equal(turn.result.isError, true);
      assert.match(text(turn.result), expected);
      assert.equal(s.manager.getBranch().filter((e) => e.type === "context_edit").length, 0);
      assert.match(projected(s.manager), /Unique investigation detail/);
    });
  }

  await test("rejects ranges crossing a user message in the middle", async () => {
    const s = seed(), h = harness(s.manager);
    s.manager.appendMessage({ role: "user", content: "Also preserve ordering.", timestamp: ++seq });
    const end = s.manager.appendMessage(assistant([{ type: "text", text: payload }]));
    const turn = await h.compact({ from: s.first, through: end, summary });
    assert.equal(turn.result.isError, true);
    assert.match(text(turn.result), /protected user/);
  });

  await test("rejects the current compaction turn", async () => {
    const s = seed(), h = harness(s.manager);
    const id = `self-${++seq}`;
    const self = s.manager.appendMessage(assistant([{ type: "toolCall", id, name: "context_compact", arguments: {} }], "toolUse"));
    const result = await h.call({ action: "compact", from: self, summary }, id);
    assert.equal(result.isError, true);
    assert.match(text(result), /current tool turn/);
  });

  await test("requires ALL parallel tool results and refuses mismatched tool names", async () => {
    for (const wrongName of [false, true]) {
      const s = seed(), h = harness(s.manager);
      const first = s.manager.appendMessage(assistant([
        { type: "toolCall", id: "a", name: "read", arguments: {} },
        { type: "toolCall", id: "b", name: "grep", arguments: {} },
      ], "toolUse"));
      const partial = s.manager.appendMessage(toolResult("a", wrongName ? "grep" : "read", { content: [{ type: "text", text: payload }] }));
      const bad = await h.compact({ from: first, through: partial, summary });
      assert.equal(bad.result.isError, true);
      assert.match(text(bad.result), /tool exchange/);
    }
    const s = seed(), h = harness(s.manager);
    const first = s.manager.appendMessage(assistant([
      { type: "toolCall", id: "a", name: "read", arguments: {} },
      { type: "toolCall", id: "b", name: "grep", arguments: {} },
    ], "toolUse"));
    s.manager.appendMessage(toolResult("b", "grep", { content: [{ type: "text", text: payload }] }));
    const last = s.manager.appendMessage(toolResult("a", "read", { content: [{ type: "text", text: payload }] }));
    const good = await h.compact({ from: first, through: last, summary });
    assert(!good.result.isError, text(good.result));
  });

  await test("rejects compaction batched with other tools", async () => {
    const s = seed(), h = harness(s.manager);
    const turn = await h.start({ action: "compact", ...compactArgs(s) }, [{ type: "toolCall", id: "other", name: "read", arguments: {} }]);
    assert.equal(turn.result.isError, true);
    assert.match(text(turn.result), /only direct tool call/);
    assert.equal(h.finish(turn), undefined);
  });

  await test("existing summaries cannot be compacted again; hidden endpoints are rejected", async () => {
    const s = seed(), h = harness(s.manager);
    await h.compact(compactArgs(s));
    const repeat = await h.compact({ from: s.first, summary });
    assert.equal(repeat.result.isError, true);
    assert.match(text(repeat.result), /existing compaction summary/);
    const hidden = await h.compact({ from: s.last, summary });
    assert.equal(hidden.result.isError, true);
    assert.match(text(hidden.result), /not in current context/);
    assert.match(text(await h.call({ action: "list" })), /protected: existing compaction summary/);
  });

  await test("abort and failed tool results leave context unchanged", async () => {
    for (const failResult of [false, true]) {
      const s = seed(), h = harness(s.manager);
      const turn = await h.start({ action: "compact", ...compactArgs(s) });
      if (failResult) turn.result.isError = true;
      h.finish(turn, { outcome: failResult ? "completed" : "aborted" });
      assert.match(projected(s.manager), /Unique investigation detail/);
      assert.equal(s.manager.getBranch().filter((e) => e.type === "context_edit").length, 0);
    }
    const s = seed(), h = harness(s.manager);
    const result = await h.call({ action: "compact", ...compactArgs(s) }, undefined, AbortSignal.abort());
    assert.equal(result.isError, true);
    assert.match(text(result), /cancelled/);
  });

  await test("stale projection fails closed and reports that compaction was not applied", async () => {
    const s = seed(), h = harness(s.manager);
    const turn = await h.start({ action: "compact", ...compactArgs(s) });
    s.manager.appendContextEdit(s.last, { content: "Changed by another extension." });
    h.finish(turn);
    assert.match(projected(s.manager), /NOT applied/);
    assert.equal(s.manager.getBranch().filter((e) => e.type === "custom" && e.customType === COMPACTION_TYPE).length, 0);
  });

  await test("session persistence is append-only and reload restores compaction and archives", async () => {
    const s = seed(SessionManager.create(DIR, join(DIR, "sessions"))), h = harness(s.manager);
    const file = s.manager.getSessionFile()!;
    const originalBytes = readFileSync(file, "utf8");
    const turn = await h.compact(compactArgs(s));
    assert(readFileSync(file, "utf8").startsWith(originalBytes));
    const reopened = SessionManager.open(file), restored = harness(reopened);
    assert.equal(projected(reopened), projected(s.manager));
    assert.doesNotMatch(projected(reopened), /Unique investigation detail/);
    assert.match(text(await restored.call({ action: "read", id: `compact:${turn.assistantId}` })), /Unique investigation detail/);
  });

  await test("tree navigation and session switching do not leak compactions across branches", async () => {
    const s = seed(), h = harness(s.manager);
    const leafBefore = s.manager.getLeafId()!;
    const turn = await h.compact(compactArgs(s));
    const compactedLeaf = s.manager.getLeafId()!;
    s.manager.branch(leafBefore);
    assert.match(projected(s.manager), /Unique investigation detail/);
    assert.equal((await h.call({ action: "read", id: `compact:${turn.assistantId}` })).isError, true);
    s.manager.branch(compactedLeaf);
    assert.doesNotMatch(projected(s.manager), /Unique investigation detail/);
    const other = seed();
    assert.equal((await h.tool.execute("x", { action: "read", id: s.last }, undefined, undefined, { sessionManager: other.manager })).isError, true);
  });

  await test("Pi's ordinary compaction can follow selective compaction; originals remain readable", async () => {
    const s = seed(), h = harness(s.manager);
    const turn = await h.compact(compactArgs(s));
    s.manager.appendCompaction("Overall progress summary", s.keep, 1000);
    assert.match(projected(s.manager), /Overall progress summary/);
    assert.doesNotMatch(projected(s.manager), /Unique investigation detail/);
    assert.match(text(await h.call({ action: "read", id: `compact:${turn.assistantId}` })), /Unique investigation detail/);
  });

  await test("boundary action is applied once, retains prior extension drafts, and ignores wrong session", async () => {
    const s = seed(), h = harness(s.manager);
    const turn = await h.start({ action: "compact", ...compactArgs(s) });
    const other = seed();
    assert.equal(h.hooks.turn_end({ messageEntryId: turn.assistantId }, { sessionManager: other.manager }), undefined);
    h.finish(turn, { entries: [{ type: "custom", customType: "another-extension", data: { keep: true } }] });
    assert(s.manager.getBranch().some((e) => e.type === "custom" && e.customType === "another-extension"));
    assert.equal(h.finish(turn), undefined);
    assert.equal(s.manager.getBranch().filter((e) => e.type === "custom" && e.customType === COMPACTION_TYPE).length, 1);
  });

  await test("reused provider tool-call IDs do not collide in archive block IDs", async () => {
    const s = seed(), h = harness(s.manager);
    const archived: string[] = [];
    for (let i = 0; i < 2; i++) {
      const target = s.manager.appendMessage(assistant([{ type: "text", text: `${i}: ${payload}` }]));
      const args = { action: "compact", from: target, summary: `Investigation ${i} completed.` };
      const message = assistant([{ type: "toolCall", id: "reused-id", name: "context_compact", arguments: args }], "toolUse");
      const assistantId = s.manager.appendMessage(message);
      const result = await h.call(args, "reused-id");
      assert(!result.isError, text(result));
      h.finish({ id: "reused-id", message, assistantId, result });
      archived.push(`compact:${assistantId}`);
    }
    assert.notEqual(archived[0], archived[1]);
    for (let i = 0; i < 2; i++) {
      const original = await h.call({ action: "read", id: archived[i] });
      assert.match(text(original), new RegExp(`${i}: Unique investigation detail`));
    }
  });

  await test("system and extension messages cannot be compacted", async () => {
    const s = seed(), h = harness(s.manager);
    const system = s.manager.appendMessage({ role: "system", content: [{ type: "text", text: payload }], timestamp: ++seq } as any);
    const custom = s.manager.appendCustomMessageEntry("protected", payload, false);
    for (const from of [system, custom]) {
      const turn = await h.compact({ from, summary });
      assert.equal(turn.result.isError, true);
      assert.match(text(turn.result), /protected/);
    }
  });

  await test("large Unicode archives are completely recoverable with bounded pages", async () => {
    const s = seed(), h = harness(s.manager);
    const original = "Žluťoučký kůň 🦍 日本語\n".repeat(2000);
    const from = s.manager.appendMessage(assistant([{ type: "text", text: original }]));
    const turn = await h.compact({ from, summary: "Unicode fixture archived." });
    assert(!turn.result.isError, text(turn.result));
    let recovered = "", offset = 0;
    for (;;) {
      const page = text(await h.call({ action: "read", id: from, offset }));
      const body = page.slice(page.indexOf("\n") + 1);
      assert(body.length <= 12000);
      recovered += body;
      const next = page.split("\n")[0].match(/Next: read .* offset=(\d+)/);
      if (!next) break;
      offset = Number(next[1]);
    }
    assert.equal(JSON.parse(recovered).message.content[0].text, original);
  });

  await test("query finds a historical block by text without paging", async () => {
    const manager = SessionManager.inMemory(DIR), h = harness(manager);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(manager.appendMessage(assistant([{ type: "text", text: i === 5 ? "FAILED npm test: binding generation missing" : `routine step ${i}` }])));
    const out = text(await h.call({ action: "list", query: "BINDING generation" }));
    assert.match(out, /Query "BINDING generation": 1 matching entry/);
    assert.match(out, new RegExp(`^${ids[5]} .*\\[match\\]`, "m"), out);
    // neighbours included, but not the whole history
    assert.match(out, new RegExp(ids[3]));
    assert.match(out, new RegExp(ids[7]));
    assert.doesNotMatch(out, new RegExp(ids[0]));
    assert.match(text(await h.call({ action: "list", query: "no-such-text" })), /No entries match "no-such-text"/);
  });

  await test("query pages matches with cursor and respects limit", async () => {
    const manager = SessionManager.inMemory(DIR), h = harness(manager);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(manager.appendMessage(assistant([{ type: "text", text: `flaky test case ${i}` }])));
    const first = text(await h.call({ action: "list", query: "flaky", limit: 3 }));
    assert.match(first, /8 matching entries \(showing 1-3\)/);
    assert.match(first, new RegExp(`Next page: list query="flaky" cursor=${ids[2]}`));
    const second = text(await h.call({ action: "list", query: "flaky", limit: 3, cursor: ids[2] }));
    assert.match(second, /showing 4-6/);
    assert.match(second, new RegExp(`^${ids[3]} .*\\[match\\]`, "m"));
    const missingCursor = await h.call({ action: "list", query: "flaky", cursor: "nope" });
    assert.equal(missingCursor.isError, true);
    assert.match(text(missingCursor), /Unknown cursor for this query/);
  });

  await test("multi-range compact applies disjoint ranges with their own summaries atomically", async () => {
    const s = seed(SessionManager.create(DIR, join(DIR, "multi-sessions"))), h = harness(s.manager);
    const middle = s.manager.appendMessage(assistant([{ type: "text", text: "KEEP: public API shape decided here." }]));
    const tail = s.manager.appendMessage(assistant([{ type: "text", text: "Old tail: dead end B.\n" + payload }]));
    const turn = await h.compact({
      ranges: [
        { from: s.first, through: s.last, summary: "Range A summary: stale bindings." },
        { from: tail, summary: "Range B summary: abandoned approach B." },
      ],
    });
    assert(!turn.result.isError, text(turn.result));
    const proj = projected(s.manager);
    assert.doesNotMatch(proj, /Unique investigation detail/);
    assert.doesNotMatch(proj, /Old tail: dead end B/);
    assert.match(proj, /Range A summary: stale bindings/);
    assert.match(proj, /Range B summary: abandoned approach B/);
    assert.match(proj, /KEEP: public API shape decided here/);
    assert.equal(s.manager.getBranch().filter((e) => e.type === "custom" && e.customType === COMPACTION_TYPE).length, 1);
    const block = s.manager.getBranch().find((e) => e.type === "custom") as any;
    assert.equal(block.data.version, 2);
    assert.equal(block.data.ranges.length, 2);
    const reopened = harness(SessionManager.open(s.manager.getSessionFile()!));
    const read = text(await reopened.call({ action: "read", id: `compact:${turn.assistantId}` }));
    assert.match(read, /Unique investigation detail/);
    assert.match(read, /dead end B/);
  });

  await test("multi-range rejects overlaps and partially valid sets without touching context", async () => {
    const s = seed(), h = harness(s.manager);
    const mid = s.manager.appendMessage(assistant([{ type: "text", text: "mid step\n" + payload }]));
    const end = s.manager.appendMessage(assistant([{ type: "text", text: "end step\n" + payload }]));
    const overlap = await h.compact({ ranges: [
      { from: mid, through: end, summary: "A" },
      { from: end, summary: "B" },
    ] });
    assert.equal(overlap.result.isError, true);
    assert.match(text(overlap.result), /overlap/);
    const mixed = await h.compact({ from: s.first, ranges: [{ from: s.last, summary }] });
    assert.equal(mixed.result.isError, true);
    assert.match(text(mixed.result), /not both/);
    const tooMany = await h.compact({ ranges: Array.from({ length: 9 }, () => ({ from: s.keep, summary })) });
    assert.equal(tooMany.result.isError, true);
    assert.match(text(tooMany.result), /At most 8 ranges/);
    const oneBad = await h.compact({ ranges: [
      { from: s.first, through: s.last, summary: "A" },
      { from: s.keep, summary: "x".repeat(1000) },
    ] });
    assert.equal(oneBad.result.isError, true);
    assert.match(text(oneBad.result), /Range 2: summary plus archive label is not smaller/);
    assert.equal(s.manager.getBranch().filter((e) => e.type === "context_edit").length, 0);
    assert.match(projected(s.manager), /Unique investigation detail/);
  });

  await test("v1 compaction blocks written by older sessions stay readable and protected", async () => {
    const s = seed();
    s.manager.appendCustomEntry(COMPACTION_TYPE, { version: 1, id: "compact:legacy", ids: [s.first, s.last], summary: "Legacy summary." });
    s.manager.appendContextEdit(s.first, { content: [{ type: "text", text: "Legacy summary." }] });
    s.manager.appendContextEdit(s.last, null);
    const h = harness(s.manager);
    const body = text(await h.call({ action: "list", query: "Legacy summary" }));
    assert.match(body, /\[compact:legacy\]/);
    assert.match(text(await h.call({ action: "read", id: "compact:legacy" })), /Unique investigation detail/);
    const again = await h.compact({ from: s.first, summary });
    assert.equal(again.result.isError, true);
    assert.match(text(again.result), /protected existing compaction summary/);
  });

  await test("bad actions, pagination, absent runtime and archive IDs return explicit errors", async () => {
    const s = seed(), h = harness(s.manager);
    for (const args of [
      { action: "oops" }, { action: "list", cursor: "missing" }, { action: "list", limit: 0 },
      { action: "list", limit: 51 }, { action: "list", limit: 1.5 }, { action: "read", id: "missing" },
      { action: "read", id: s.last, offset: -1 }, { action: "read", id: s.last, limit: 12001 },
      { action: "read", id: s.last, offset: Number.MAX_SAFE_INTEGER },
    ]) assert.equal((await h.call(args)).isError, true, JSON.stringify(args));
    const unavailable = await h.tool.execute("x", { action: "list" }, undefined, undefined, {});
    assert.equal(unavailable.isError, true);
    assert.match(text(unavailable), /requires Pi/);
  });

  await test("REAL PI LOOP: list reports real context usage from Pi's runtime", async () => {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
    const loader = new DefaultResourceLoader({
      cwd: DIR, agentDir: join(DIR, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("selective_compaction.ts")], systemPrompt: "Offline usage probe.",
    });
    await loader.reload();
    const manager = seed(SessionManager.create(DIR, join(DIR, "usage-sessions")));
    const model: any = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { session } = await createAgentSession({ cwd: DIR, agentDir: join(DIR, "agent"), model, thinkingLevel: "off", tools: ["context_compact"], resourceLoader: loader, settingsManager: settings, sessionManager: manager.manager });
    const errors: any[] = [], requests: any[] = [];
    try {
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      session.modelRuntime.registerProvider("fixture", { baseUrl: model.baseUrl, api: model.api, apiKey: "offline-test-only", models: [model] });
      session.agent.streamFunction = ((_model: any, context: any) => {
        requests.push(structuredClone(context));
        const response = requests.length === 1
          ? assistant([{ type: "toolCall", id: "live-list", name: "context_compact", arguments: { action: "list", limit: 5 } }], "toolUse")
          : assistant([{ type: "text", text: "Done." }]);
        return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: response.stopReason, message: response }; }, result: async () => response };
      }) as any;
      await session.prompt("List the context.");
      assert.equal(errors.length, 0, JSON.stringify(errors));
      const result = (requests[1].messages as any[]).find((m) => m.role === "toolResult" && m.toolCallId === "live-list");
      assert.equal(result?.isError, false, JSON.stringify(result));
      const body = result.content.map((c: any) => c.text || "").join("\n");
      // Real ctx.getContextUsage() reached the tool: the window is known, not "usage unknown."
      assert.match(body, /usage .*\/ 100k/);
      assert.doesNotMatch(body, /usage unknown\./);
    } finally { session.dispose(); }
  });

  await test("REAL PI LOOP: next model request uses compacted context, archive read retrieves originals", async () => {
    // Real loader resolves TypeBox exactly as the app does (unit-test bundling uses a schema stub).
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
    const loader = new DefaultResourceLoader({
      cwd: DIR, agentDir: join(DIR, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("selective_compaction.ts")], systemPrompt: "Offline selective compaction integration test.",
    });
    await loader.reload();
    assert.equal(loader.getExtensions().errors.length, 0, JSON.stringify(loader.getExtensions().errors));
    const s = seed(SessionManager.create(DIR, join(DIR, "live-sessions")));
    const model: any = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { session } = await createAgentSession({ cwd: DIR, agentDir: join(DIR, "agent"), model, thinkingLevel: "off", tools: ["context_compact"], resourceLoader: loader, settingsManager: settings, sessionManager: s.manager });
    const errors: any[] = [], requests: any[] = [];
    try {
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      session.modelRuntime.registerProvider("fixture", { baseUrl: model.baseUrl, api: model.api, apiKey: "offline-test-only", models: [model] });
      session.agent.streamFunction = ((_model: any, context: any) => {
        requests.push(structuredClone(context));
        const n = requests.length;
        const blockId = n === 2 ? text(context.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "live-compact")).match(/Scheduled (compact:[^: ]+):/)?.[1] : undefined;
        const response = n === 1
          ? assistant([{ type: "toolCall", id: "live-compact", name: "context_compact", arguments: { action: "compact", ...compactArgs(s) } }], "toolUse")
          : n === 2
            ? assistant([{ type: "toolCall", id: "live-read", name: "context_compact", arguments: { action: "read", id: blockId } }], "toolUse")
            : assistant([{ type: "text", text: "Finished." }]);
        return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: response.stopReason, message: response }; }, result: async () => response };
      }) as any;
      await session.prompt("Compact the completed investigation, then recover its originals.");
      assert.equal(errors.length, 0, JSON.stringify(errors));
      assert.equal(requests.length, 3, JSON.stringify(session.messages).slice(-1500));
      assert.match(JSON.stringify(requests[0]), /Unique investigation detail/);
      assert.doesNotMatch(JSON.stringify(requests[1]), /Unique investigation detail/);
      assert(JSON.stringify(requests[1]).length < JSON.stringify(requests[0]).length, "provider request should shrink for this substantial range");
      assert.match(JSON.stringify(requests[1]), /Generated bindings were stale/);
      assert.match(JSON.stringify(requests[2]), /Unique investigation detail/);
      const compactResult = (requests[1].messages as any[]).find((m) => m.role === "toolResult" && m.toolCallId === "live-compact");
      assert.equal(compactResult?.isError, false, JSON.stringify(compactResult));
      assert(s.manager.getBranch().some((e) => e.type === "context_edit"));
    } finally { session.dispose(); }
  });
} finally {
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\nSelective compaction: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
