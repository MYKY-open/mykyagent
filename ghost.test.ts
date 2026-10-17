/**
 * Offline tests for the ghost whisperer (/ghost + /gh): draft cleanup,
 * history extraction, hint pass-through, and the Send/Abort flow.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-ghost-"));
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
process.env.MYKYAGENT_CHARACTERS_DIR = join(DIR, "characters");
process.env.MYKYAGENT_LORE_DIR = join(DIR, "lore");
process.env.MYKYAGENT_AN_FILE = join(DIR, "authors_note.json");
process.env.MYKYAGENT_GAMESTATE_DIR = join(DIR, "gamestate");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_TAGS_FILE = join(DIR, "tags.json");

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

const ext = (await import("./index.ts")).default;
const idx = await import("./index.ts");

t("ghost helpers exported", typeof idx.buildGhostPrompt === "function" && typeof idx.cleanGhostDraft === "function" && typeof idx.extractGhostHistory === "function");

t("clean strips quotes + prefix", idx.cleanGhostDraft('"User: I will go."', "User") === "I will go.");
t("clean strips name prefix", idx.cleanGhostDraft("Kai: hello there", "Kai") === "hello there");
t("clean keeps plain draft", idx.cleanGhostDraft("I kneel.", "User") === "I kneel.");

const hist = idx.extractGhostHistory([
  { type: "message", message: { role: "user", content: "hi" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Welcome." }] } },
  { type: "other", message: { role: "user", content: "skip me" } },
]);
t("history extracts last messages", hist.includes("user: hi") && hist.includes("char: Welcome.") && !hist.includes("skip me"));

const gp = idx.buildGhostPrompt({ charName: "Evelyn", charLine: "dry wit", userName: "Kai", history: "user: hi", hint: "i do as im told", tints: ["noir"] });
t("prompt carries hint + tints", gp.userContent.includes("i do as im told") && gp.userContent.includes("noir") && gp.systemPrompt.includes("Kai"));

const gpNoHint = idx.buildGhostPrompt({ userName: "Kai", history: "", hint: "", tints: [] });
t("prompt handles no hint", gpNoHint.userContent.includes("No hint given"));

// --- command flow -----------------------------------------------------------
const sent: string[] = [];
const tools: Record<string, any> = {};
const commands: Record<string, any> = {};
const hooks: Record<string, any> = {};
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: (def: any) => (tools[def.name] = def),
  registerCommand: (n: string, def: any) => (commands[n] = def),
  getActiveTools: () => [],
  setActiveTools: () => {},
  sendUserMessage: (m: string) => sent.push(m),
};
await ext(pi);

t("ghost registered", !!commands["ghost"]);
t("gh alias registered", !!commands["gh"]);

const captured: any[] = [];
const registry = {
  getAvailable: () => [{ provider: "test", id: "ghost-model" }],
  complete: async (_m: any, req: any) => {
    captured.push(req);
    return { content: [{ type: "text", text: '"User: I will do as you say." ' }] };
  },
};
const baseCtx = (selectImpl: any) => ({
  modelRegistry: registry,
  getModel: () => ({ provider: "test", id: "ghost-model" }),
  sessionManager: { getEntries: () => [{ type: "message", message: { role: "assistant", content: "Come here." } }] },
  ui: { notify: (_m: string) => {}, select: selectImpl },
});

sent.length = 0;
captured.length = 0;
await commands["ghost"].handler("i do as im told", baseCtx(async () => "send - post as my message"));
t("send posts cleaned draft", sent.length === 1 && sent[0] === "I will do as you say.", JSON.stringify(sent));
t("hint reaches the model", captured.length === 1 && JSON.stringify(captured[0]).includes("i do as im told"));

sent.length = 0;
await commands["gh"].handler("", baseCtx(async () => "abort - I'll write it myself"));
t("abort sends nothing", sent.length === 0);

sent.length = 0;
const headlessNotify: string[] = [];
await commands["ghost"].handler("", { ...baseCtx(undefined), ui: { notify: (m: string) => headlessNotify.push(m) } });
t("headless shows draft without sending", sent.length === 0 && headlessNotify.some((m) => m.includes("I will do as you say")));

const errNotify: string[] = [];
await commands["ghost"].handler("", { ui: { notify: (m: string) => errNotify.push(m) } });
t("no registry errors cleanly", errNotify.some((m) => m.includes("model registry")));

// thinking-only models still produce a draft
{
  const thinkRegistry = {
    getAvailable: () => [{ provider: "test", id: "ghost-model" }],
    complete: async () => ({ content: [{ type: "thinking", thinking: "I step forward slowly." }] }),
  };
  const ctx = baseCtx(async () => "send - post as my message");
  ctx.modelRegistry = thinkRegistry;
  sent.length = 0;
  await commands["ghost"].handler("", ctx);
  t("thinking-only reply yields draft", sent.length === 1 && sent[0] === "I step forward slowly.", JSON.stringify(sent));
}

// status lantern: on while drafting, off afterwards (send flow)
{
  const statusLog: string[] = [];
  const ctx = baseCtx(async () => "send - post as my message");
  const prevUi = ctx.ui;
  ctx.ui = {
    ...prevUi,
    setStatus: (key: string, text: string | undefined) => statusLog.push(`${key}=${text === undefined ? "<cleared>" : text}`),
  };
  sent.length = 0;
  await commands["ghost"].handler("", ctx);
  t("lantern on then off (send)", statusLog.length === 2 && statusLog[0].startsWith("ghost=Ghost is listening") && statusLog[1] === "ghost=<cleared>", statusLog.join(" | "));
}

// status lantern clears on the abort path too
{
  const statusLog: string[] = [];
  const ctx = baseCtx(async () => "abort - I'll write it myself");
  const prevUi2 = ctx.ui;
  ctx.ui = {
    ...prevUi2,
    setStatus: (key: string, text: string | undefined) => statusLog.push(`${key}=${text === undefined ? "<cleared>" : text}`),
  };
  await commands["ghost"].handler("", ctx);
  t("lantern clears on abort", statusLog.length === 2 && statusLog[1] === "ghost=<cleared>", statusLog.join(" | "));
}

// registry failure falls back to direct HTTP
{
  const failing = {
    getAvailable: () => [{ provider: "test", id: "ghost-model" }],
    complete: async () => { throw new Error("registry exploded"); },
  };
  const realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "I obey, my lady." } }] }),
  });
  try {
    const ctx = baseCtx(async () => "send - post as my message");
    ctx.modelRegistry = failing;
    sent.length = 0;
    await commands["ghost"].handler("i do as im told", ctx);
    t("http fallback delivers draft", sent.length === 1 && sent[0] === "I obey, my lady.", JSON.stringify(sent));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

// total failure reports the true cause
{
  const failing = {
    getAvailable: () => [{ provider: "test", id: "ghost-model" }],
    complete: async () => { throw new Error("registry exploded"); },
  };
  const realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const notes: string[] = [];
    const ctx = { ...baseCtx(async () => "send - post as my message"), ui: { notify: (m: string) => notes.push(m), select: async () => "abort" } };
    ctx.modelRegistry = failing;
    sent.length = 0;
    await commands["ghost"].handler("", ctx);
    t("error message names the cause", notes.some((m) => m.includes("registry exploded") && m.includes("500")), notes.join(" | ").slice(0, 300));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

// pi's real field name (ctx.model) resolves the conversation model,
// including fresh sessions where no turn has run yet
{
  const ctx = baseCtx(async () => "send - post as my message");
  delete (ctx as any).getModel;
  (ctx as any).model = { provider: "llama-local", id: "MiniCPM" };
  sent.length = 0;
  await commands["ghost"].handler("", ctx);
  t("ctx.model resolves like live pi", sent.length === 1, JSON.stringify(sent));
}

// no model anywhere -> clean error, registry untouched
{
  let completeCalls = 0;
  const quietRegistry = {
    getAvailable: () => [],
    complete: async () => { completeCalls++; return { content: [] }; },
  };
  const notes: string[] = [];
  const ctx = {
    modelRegistry: quietRegistry,
    sessionManager: { getEntries: () => [] },
    ui: { notify: (m: string) => notes.push(m), select: async () => "abort" },
  };
  await commands["ghost"].handler("", ctx);
  t("no model errors cleanly", completeCalls === 0 && notes.some((m) => m.includes("can't tell which model")), notes.join(" | ").slice(0, 200));
}

// foreign (google) models never get raw HTTP
{
  const failing = {
    getAvailable: () => [],
    complete: async () => { throw new Error("registry exploded"); },
  };
  let fetchCalls = 0;
  const realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({ choices: [] }) }; };
  try {
    const notes: string[] = [];
    const ctx = {
      modelRegistry: failing,
      getModel: () => ({ provider: "google", id: "gemini-2.0-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
      sessionManager: { getEntries: () => [] },
      ui: { notify: (m: string) => notes.push(m), select: async () => "abort" },
    };
    await commands["ghost"].handler("", ctx);
    t("google gets no raw HTTP", fetchCalls === 0 && notes.some((m) => m.includes("no direct-HTTP path")), notes.join(" | ").slice(0, 300));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

t("history uses real names when given", idx.extractGhostHistory(
  [{ type: "message", message: { role: "user", content: "hi" } },
   { type: "message", message: { role: "assistant", content: "Welcome." } }],
  2000, "Kai", "Evelyn").includes("Kai: hi") && idx.extractGhostHistory(
  [{ type: "message", message: { role: "assistant", content: "Welcome." } }],
  2000, "Kai", "Evelyn").includes("Evelyn: Welcome."));
t("prompt denies the character identity", idx.buildGhostPrompt({ charName: "Evelyn", userName: "Kai", history: "", hint: "", tints: [] }).systemPrompt.includes("You are NOT Evelyn"));
t("leak detector flags char prefix", idx.isCharLeak("Evelyn: Come here.", "Evelyn") === true);
t("leak detector spares user addressing her", idx.isCharLeak("Evelyn, wait for me!", "Evelyn") === false && idx.isCharLeak("I kneel.", "Evelyn") === false);

// character-voiced first draft triggers one stern retry, second (good) wins
{
  const ch = await import("./character.ts");
  const mode = await import("./mode.ts");
  ch.saveCharacter({ name: "Evelyn", description: "d", personality: "p", scenario: "s", first_message: "g", mes_example: "m" } as any, "evelyn");
  mode.setActiveCharacter("evelyn");
  let calls = 0;
  const flipRegistry = {
    getAvailable: () => [{ provider: "test", id: "ghost-model" }],
    complete: async () => (++calls === 1
      ? { content: [{ type: "text", text: "Evelyn: Come here, little one." }] }
      : { content: [{ type: "text", text: "I step closer." }] }),
  };
  const ctx = baseCtx(async () => "send - post as my message");
  ctx.modelRegistry = flipRegistry;
  sent.length = 0;
  await commands["ghost"].handler("", ctx);
  t("char-voiced draft retried, user voice sent", sent.length === 1 && sent[0] === "I step closer." && calls === 2, JSON.stringify(sent));
}

// twice-leaking draft is shown flagged, never sneaked
{
  const stubborn = {
    getAvailable: () => [{ provider: "test", id: "ghost-model" }],
    complete: async () => ({ content: [{ type: "text", text: "Evelyn: Come here." }] }),
  };
  const notes: string[] = [];
  const ctx = { ...baseCtx(async () => "send - post as my message"), ui: { notify: (m: string) => notes.push(m), select: async () => "abort - I'll write it myself" } };
  ctx.modelRegistry = stubborn;
  sent.length = 0;
  await commands["ghost"].handler("", ctx);
  t("stubborn leak flagged for the user", sent.length === 0 && notes.some((m) => m.includes("sounds like Evelyn")), notes.join(" | ").slice(0, 250));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
