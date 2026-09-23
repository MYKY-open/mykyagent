/**
 * Functional tests for slash-command argument autocompletion (no pi runtime,
 * no network): registers the extension against a mock pi, feeds a fake model
 * registry via before_agent_start (like the real TUI does), then drives the
 * getArgumentCompletions callbacks for /model-variant, /model-refresh and
 * /model-web. Value semantics asserted: item.value must be the FULL argument
 * string pi should insert (pi replaces the entire argument text on accept).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-comp-"));
process.env.MYKYAGENT_MODELS_JSON = join(DIR, "models.json");
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
// One openrouter base model in the "catalog" + one models.json variant.
writeFileSync(
  process.env.MYKYAGENT_MODELS_JSON,
  JSON.stringify({
    providers: {
      openrouter: {
        models: [{ id: "z-ai/glm-5.3-flash:floor", name: "GLM 5.3 Flash (floor)", api: "openai-completions", reasoning: true, contextWindow: 1000 }],
      },
    },
  })
);

const ext = (await import("./index.ts")).default;

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

const fakeRegistry = {
  getAvailable: () => [
    { provider: "openrouter", id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { provider: "openrouter", id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
    { provider: "llama-local", id: "Qwen3.8-35B-A3B-Q4_K_M", name: "Local: Qwen" },
  ],
  getRegisteredProviderIds: () => ["openrouter", "llama-local"],
};

// Simulate the TUI: before_agent_start hands ctx.modelRegistry to the extension.
await hooks["before_agent_start"]({}, { cwd: DIR, modelRegistry: fakeRegistry });

// --- /model-variant -----------------------------------------------------------
{
  const c = await commands["model-variant"].getArgumentCompletions("");
  t("mv: bare → subcommands", Array.isArray(c) && c.some((i: any) => i.value === "add") && c.some((i: any) => i.value === "list"), JSON.stringify(c));
}
{
  const c = await commands["model-variant"].getArgumentCompletions("re");
  t("mv: 're' → remove only", Array.isArray(c) && c.length === 1 && c[0].value === "remove", JSON.stringify(c));
}
{
  const c = await commands["model-variant"].getArgumentCompletions("add ");
  const vals = (c ?? []).map((i: any) => i.value);
  t("mv: 'add ' → base ids with add prefix", Array.isArray(c) && vals.includes("add z-ai/glm-5.3-flash") && vals.includes("add deepseek/deepseek-chat"), JSON.stringify(vals));
  t("mv: openrouter only (no llama-local)", Array.isArray(c) && !vals.some((v: string) => v.includes("Qwen")));
}
{
  const c = await commands["model-variant"].getArgumentCompletions("add z-ai");
  t("mv: 'add z-ai' fuzzy → glm base", (c ?? []).some((i: any) => i.value === "add z-ai/glm-5.3-flash"), JSON.stringify(c));
}
{
  const c = await commands["model-variant"].getArgumentCompletions("add z-ai/glm-5.3-flash:");
  t("mv: base + colon → suffixes", Array.isArray(c) && c.some((i: any) => i.value === "add z-ai/glm-5.3-flash:floor" && i.label === ":floor"), JSON.stringify(c));
  t("mv: suffix notes shown", (c ?? []).some((i: any) => i.value === "add z-ai/glm-5.3-flash:free" && /rate-limited/.test(i.description ?? "")), JSON.stringify(c));
}
{
  const c = await commands["model-variant"].getArgumentCompletions("add z-ai/glm-5.3-flash:f");
  t("mv: suffix partial 'f' → floor + free only", Array.isArray(c) && c.length === 2 && c.every((i: any) => /:(floor|free)$/.test(i.value)), JSON.stringify(c));
}
{
  const c = await commands["model-variant"].getArgumentCompletions("remove ");
  t("mv: 'remove ' → existing variant ids", Array.isArray(c) && c.some((i: any) => i.value === "remove z-ai/glm-5.3-flash:floor"), JSON.stringify(c));
}

// --- /model-refresh -----------------------------------------------------------
{
  const c = await commands["model-refresh"].getArgumentCompletions("");
  const vals = (c ?? []).map((i: any) => i.value);
  t("refresh: bare → provider ids", Array.isArray(c) && vals.includes("openrouter") && vals.includes("llama-local"), JSON.stringify(vals));
}
{
  const c = await commands["model-refresh"].getArgumentCompletions("ope");
  t("refresh: 'ope' → openrouter", (c ?? []).length === 1 && c[0].value === "openrouter", JSON.stringify(c));
}

// --- /model-web ---------------------------------------------------------------
{
  const c = await commands["model-web"].getArgumentCompletions("");
  t("mw: bare → subcommands", Array.isArray(c) && c.some((i: any) => i.value === "set") && c.some((i: any) => i.value === "clear"), JSON.stringify(c));
}
{
  const c = await commands["model-web"].getArgumentCompletions("set ");
  const vals = (c ?? []).map((i: any) => i.value);
  t("mw: 'set ' → provider/model values", Array.isArray(c) && vals.includes("set openrouter/z-ai/glm-5.3-flash") && vals.includes("set llama-local/Qwen3.8-35B-A3B-Q4_K_M"), JSON.stringify(vals));
  t("mw: labels are bare ids, desc = provider", Array.isArray(c) && c.some((i: any) => i.label === "z-ai/glm-5.3-flash" && i.description === "openrouter"));
}
{
  const c = await commands["model-web"].getArgumentCompletions("set deepseek");
  t("mw: 'set deepseek' fuzzy → chat model", (c ?? []).some((i: any) => i.value === "set openrouter/deepseek/deepseek-chat"), JSON.stringify(c));
}
{
  const c = await commands["model-web"].getArgumentCompletions("set llama-local/Qwen");
  t("mw: 'set llama-local/Qwen' slash query matches", (c ?? []).some((i: any) => i.value === "set llama-local/Qwen3.8-35B-A3B-Q4_K_M"), JSON.stringify(c));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\ncompletion tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
