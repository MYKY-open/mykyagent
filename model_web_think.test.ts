/**
 * Offline tests for /model-web think on|off: the flag persists in
 * webmodel.json, survives set/clear, and decides whether the distillation call
 * carries the session thinking level (streamSimple reasoning) or stays on the
 * plain complete() path. Fake registry records every call; no network.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-mwthink-"));
process.env.MYKYAGENT_WEBMODEL_FILE = join(DIR, "webmodel.json");
process.env.MYKYAGENT_MODELS_JSON = join(DIR, "models.json");
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
writeFileSync(process.env.MYKYAGENT_MODELS_JSON, JSON.stringify({ providers: {} }));

const mod = await import("./index.ts");
const ext = mod.default;
const { distillWithSubagent, loadWebThinking } = mod as any;

const commands: Record<string, any> = {};
const hooks: Record<string, any> = {};
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: () => {},
  registerCommand: (n: string, def: any) => (commands[n] = def),
  getActiveTools: () => ["bash"],
  setActiveTools: () => {},
};
await ext(pi);

let pass = 0,
  fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
  if (ok) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};

// Fake registry: records which entry point distillation used and with what options.
const calls: { kind: "stream" | "complete"; opts: any }[] = [];
const model = { provider: "openrouter", id: "z-ai/glm-5.3-flash", api: "openai-completions" };
const reply = { content: [{ type: "text", text: "DISTILLED" }], usage: {} };
const registry = {
  find: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
  getAvailable: () => [model],
  streamSimple: (_m: any, _req: any, opts: any) => {
    calls.push({ kind: "stream", opts });
    return { result: async () => reply };
  },
  complete: async (_m: any, _req: any, opts: any) => {
    calls.push({ kind: "complete", opts });
    return reply;
  },
};
const notes: string[] = [];
const cmdCtx = { modelRegistry: registry, ui: { notify: (m: string) => notes.push(m) } };
const run = (args: string) => commands["model-web"].handler(args, cmdCtx);
const readFile = () => { try { return JSON.parse(readFileSync(process.env.MYKYAGENT_WEBMODEL_FILE!, "utf-8")); } catch { return {}; } };
const distill = (ctx: any) => distillWithSubagent("q", "some web content", ctx);

await run("set openrouter/z-ai/glm-5.3-flash");
t("setup: override saved", readFile().provider === "openrouter" && readFile().id === "z-ai/glm-5.3-flash", JSON.stringify(notes));
t("think defaults off", loadWebThinking() === false);

// default (off): plain complete(), no reasoning option
calls.length = 0;
let out: any = await distill({ modelRegistry: registry, thinkingLevel: "high" });
t("off: result text comes back", out?.text === "DISTILLED", JSON.stringify(out));
t("off: uses complete(), not streamSimple", calls.length === 1 && calls[0].kind === "complete", JSON.stringify(calls));
t("off: no reasoning option sent", calls[0] && calls[0].opts.reasoning === undefined);

// on: session level goes through streamSimple
await run("think on");
t("think on: flag persisted", readFile().thinking === true && loadWebThinking() === true);
t("think on: notice mentions session level", notes.some((n) => n.includes("session thinking level")), JSON.stringify(notes));
calls.length = 0;
out = await distill({ modelRegistry: registry, thinkingLevel: "high" });
t("on: result text comes back", out?.text === "DISTILLED", JSON.stringify(out));
t("on: uses streamSimple", calls.length === 1 && calls[0].kind === "stream", JSON.stringify(calls));
t("on: reasoning = session level", calls[0] && calls[0].opts.reasoning === "high", JSON.stringify(calls[0]?.opts));
t("on: keeps maxTokens and cacheRetention", calls[0] && calls[0].opts.maxTokens === 4096 && calls[0].opts.cacheRetention === "none");

// session level off: nothing to pass, falls back to complete()
calls.length = 0;
await distill({ modelRegistry: registry, thinkingLevel: "off" });
t("on + session off: complete(), no reasoning", calls.length === 1 && calls[0].kind === "complete" && calls[0].opts.reasoning === undefined);

// stale ctx whose thinkingLevel getter throws: degrade to complete(), no crash
calls.length = 0;
const stale = {
  modelRegistry: registry,
  get thinkingLevel(): string {
    throw new Error("stale ctx");
  },
};
out = await distill(stale);
t("on + stale ctx: still returns text", out?.text === "DISTILLED");
t("on + stale ctx: falls back to complete()", calls.length === 1 && calls[0].kind === "complete");

// set / clear must keep the flag
await run("set openrouter/z-ai/glm-5.3-flash");
t("set keeps think on", readFile().thinking === true && loadWebThinking() === true, JSON.stringify(readFile()));
await run("clear");
t("clear keeps think on", readFile().thinking === true && readFile().follow === true, JSON.stringify(readFile()));

// list shows the state
notes.length = 0;
await run("list");
t("list shows thinking line (on)", notes.some((n) => n.includes("thinking: follows session thinking level")), JSON.stringify(notes));

// off again
await run("think off");
t("think off: flag persisted", readFile().thinking === false && loadWebThinking() === false);
calls.length = 0;
await distill({ modelRegistry: registry, thinkingLevel: "high" });
t("think off again: complete() path", calls.length === 1 && calls[0].kind === "complete");

// usage line lists the new subcommand
notes.length = 0;
await run("bogus");
t("usage lists think on|off", notes.some((n) => n.includes("think on|off")), JSON.stringify(notes));

// completions for "think "
const comp = await commands["model-web"].getArgumentCompletions("think ");
t("completions: think on / think off", Array.isArray(comp) && comp.some((c: any) => c.value === "think on") && comp.some((c: any) => c.value === "think off"), JSON.stringify(comp));

rmSync(DIR, { recursive: true, force: true });
console.log(`\nmodel-web think tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
