/**
 * Offline smoke test for /or-routing: command handler, orrouting.json state,
 * models.json patching, AND that the routing actually lands in the direct-HTTP
 * distillation payload (the OpenRouter `provider` field).
 *
 * Like run_model_web_smoke.ts: stub pi, temp models.json + orrouting state via
 * env overrides (the REAL ~/.pi/agent/models.json is never touched), the user's
 * webmodel.json is backed up + restored, and the OpenRouter POST is intercepted
 * by patching globalThis.fetch (nothing leaves the machine).
 *
 * Bundle like run_model_web_smoke.sh does: pi packages --external.
 */
import ext from "./index.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";

const DIR = mkdtempSync(join(tmpdir(), "orrouting-smoke-"));
const MODELS = join(DIR, "models.json");
const STATE = join(DIR, "orrouting.json");
// BEFORE ext(): the startup reconcile must target the temp files, not the real ones.
process.env.MYKYAGENT_MODELS_JSON = MODELS;
process.env.MYKYAGENT_ORROUTING_FILE = STATE;
process.env.OPENROUTER_API_KEY = "sk-smoke-not-real";

const WM = join(homedir(), ".config", "mykyagent", "webmodel.json");
const wmBackup = existsSync(WM) ? readFileSync(WM, "utf-8") : null;
writeFileSync(WM, JSON.stringify({ provider: "openrouter", id: "smoke/or-model" }), "utf-8");
const restore = () => {
  if (wmBackup === null) {
    try {
      unlinkSync(WM);
    } catch {}
  } else writeFileSync(WM, wmBackup, "utf-8");
};
process.on("exit", restore);

const notify = (m: string) => console.log("  [notify]", m.split("\n").join(" | "));
const commands: Record<string, any> = {};
const tools: Record<string, any> = {};
(ext as any)({
  on: () => {},
  registerTool: (t: any) => (tools[t.name] = t),
  registerCommand: (name: string, def: any) => (commands[name] = def),
  getActiveTools: () => ["bash"],
  setActiveTools: () => {},
});

// Force the HTTP fallback: native complete() always throws, model is openrouter.
const registry = {
  find: (p: string, id: string) => (p === "openrouter" && id === "smoke/or-model" ? { provider: p, id } : undefined),
  getAvailable: () => [{ provider: "openrouter", id: "smoke/or-model" }],
  getError: () => undefined,
  complete: async () => {
    throw new Error("smoke: native path disabled");
  },
};
const ctx: any = { modelRegistry: registry, ui: { notify } };

// Intercept ONLY the OpenRouter distillation POST; page GETs go to a real local server.
let captured: any = null;
const realFetch = globalThis.fetch.bind(globalThis);
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  if (init?.method === "POST" && u.includes("openrouter.ai")) {
    captured = { url: u, headers: init.headers, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "smoke-distilled" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      text: async () => "",
    } as any;
  }
  return realFetch(url, init);
};

// Real local page so the python helper's fetch stage succeeds.
const server = http.createServer((_req: any, res: any) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<html><head><title>OR Smoke</title></head><body><p>routing smoke page</p></body></html>");
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as any).port;
const page = `http://127.0.0.1:${port}/`;

const assert = (name: string, cond: boolean, extra = "") => {
  console.log(` ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : " " + extra}`);
  if (!cond) process.exitCode = 1;
};
const modelsJson = () => (existsSync(MODELS) ? JSON.parse(readFileSync(MODELS, "utf-8")) : null);
const runFetch = async () => {
  captured = null;
  await tools["web_fetch"].execute("smoke", { url: page, query: "routing" }, undefined, undefined, ctx);
};

console.log("--- 1. startup reconcile: no-op on empty state, real models.json untouched ---");
assert("state file not created by no-op reconcile", !existsSync(STATE));
assert("temp models.json not created by no-op reconcile", !existsSync(MODELS));

console.log("--- 2. /or-routing (bare) → sort:price ON ---");
await commands["or-routing"].handler("", ctx);
const on = modelsJson();
assert(
  "models.json: exact user example shape",
  on?.providers?.openrouter?.compat?.openRouterRouting &&
    JSON.stringify(on.providers.openrouter.compat.openRouterRouting) === '{"sort":"price"}',
  JSON.stringify(on?.providers)
);

console.log("--- 3. routing reaches the OpenRouter distillation payload ---");
await runFetch();
assert("endpoint is OpenRouter chat/completions", captured?.url === "https://openrouter.ai/api/v1/chat/completions", captured?.url);
assert("auth header uses the (fake) key", captured?.headers?.Authorization === "Bearer sk-smoke-not-real");
assert(
  "payload.provider = {sort:price}",
  JSON.stringify(captured?.body?.provider) === '{"sort":"price"}',
  JSON.stringify(captured?.body)
);
assert("payload.model + messages intact", captured?.body?.model === "smoke/or-model" && Array.isArray(captured?.body?.messages));

console.log("--- 4. /or-routing off → payload drops provider, models.json pruned ---");
await commands["or-routing"].handler("off", ctx);
const off = modelsJson();
assert("models.json pruned to empty providers", JSON.stringify(off) === '{"providers":{}}', JSON.stringify(off));
await runFetch();
assert("payload has no provider field when off", captured?.body && !("provider" in captured.body), JSON.stringify(captured?.body));

console.log("--- 5. /or-routing JSON arg → verbatim object ---");
await commands["or-routing"].handler('{"only":["deepseek"],"sort":"price"}', ctx);
const adv = modelsJson();
assert(
  "models.json: advanced routing verbatim",
  JSON.stringify(adv.providers.openrouter.compat.openRouterRouting) === '{"only":["deepseek"],"sort":"price"}',
  JSON.stringify(adv?.providers)
);
await runFetch();
assert(
  "payload.provider = advanced object",
  JSON.stringify(captured?.body?.provider) === '{"only":["deepseek"],"sort":"price"}',
  JSON.stringify(captured?.body)
);

console.log("--- 6. /or-routing bad arg → error, state unchanged ---");
await commands["or-routing"].handler("not a sort!", ctx);
assert("bad arg: models.json unchanged", JSON.stringify(modelsJson().providers.openrouter.compat.openRouterRouting) === '{"only":["deepseek"],"sort":"price"}');

console.log("--- 7. /or-routing status ---");
await commands["or-routing"].handler("status", ctx);

console.log("--- 8. /or-routing throughput (bare-word sort) ---");
await commands["or-routing"].handler("throughput", ctx);
assert("sort name applied", JSON.stringify(modelsJson().providers.openrouter.compat.openRouterRouting) === '{"sort":"throughput"}');

console.log("--- 9. bare flip: on → off ---");
await commands["or-routing"].handler("", ctx);
assert("flip turned it off", JSON.stringify(modelsJson()) === '{"providers":{}}');
await commands["or-routing"].handler("", ctx);
assert("flip turned it back on (price)", JSON.stringify(modelsJson().providers.openrouter.compat.openRouterRouting) === '{"sort":"price"}');

server.close();
rmSync(DIR, { recursive: true, force: true });
console.log("\nOR-ROUTING SMOKE DONE, exit=" + (process.exitCode || 0));
