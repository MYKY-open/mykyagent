/**
 * End-to-end test of the registered agent tools, against a real model.
 *
 * `run_tests.sh` covers the pure logic offline. This covers the part that unit
 * tests cannot: that the tool handlers are wired correctly, that the helper
 * process is invoked with the right arguments, and that a real model can turn
 * the returned bundle into a usable answer.
 *
 * Requires a reachable OpenAI-compatible endpoint:
 *   MYKYAGENT_BASE_URL   e.g. http://127.0.0.1:8080/v1
 *   MYKYAGENT_API_KEY    optional
 *   MYKYAGENT_E2E_FIXTURE  base URL of the local fixture server
 *
 * Assertions deliberately target the tool's OWN strings (the metadata lines we
 * generate) rather than model output, which is paraphrased and non-deterministic.
 */
import ext from "./index.ts";

const results: { name: string; ok: boolean; extra?: string }[] = [];
const t = (name: string, ok: boolean, extra = "") => {
  results.push({ name, ok, extra });
  console.log(` ${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  ${extra}`}`);
};

// --- load the extension the way pi does, capturing registrations ------------
const tools: Record<string, any> = {};
const hooks: Record<string, any> = {};
(ext as any)({
  on: (n: string, f: any) => {
    hooks[n] = f;
  },
  registerTool: (tool: any) => {
    tools[tool.name] = tool;
  },
  registerCommand: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
});

const ctx: any = { getModel: () => undefined, cwd: process.cwd() };

t("tools: all expected tools registered", ["web_search", "web_fetch", "memory_read", "memory_write", "memory_forget", "memory_list", "read"].every((n) => tools[n]), Object.keys(tools).join(","));
t("tools: persona_set is NOT registered", !tools["persona_set"]);

if (hooks["before_agent_start"]) await hooks["before_agent_start"]({}, ctx);

const call = async (name: string, args: any): Promise<{ text: string; error: boolean }> => {
  const res = await tools[name].execute("e2e", args, undefined, undefined, ctx);
  return { text: (res.content || []).map((c: any) => c.text).join("\n"), error: !!res.isError };
};

const fixture = process.env.MYKYAGENT_E2E_FIXTURE;
if (!fixture) {
  console.log(" SKIP  MYKYAGENT_E2E_FIXTURE not set");
} else {
  // A unique path per run keeps the "cold" assertion genuinely cold.
  const pageUrl = `${fixture}/run-${Date.now().toString(36)}/`;

  // --- cold fetch ---------------------------------------------------------
  const r1 = await call("web_fetch", { url: pageUrl, query: "unicode sample" });
  t("web_fetch: cold fetch succeeds", !r1.error, r1.text.slice(0, 160));
  t("web_fetch: reports the page title", /Page title: E2E Fixture Page/.test(r1.text), r1.text.slice(0, 160));
  t("web_fetch: cold response is not marked cached", !/FROM CACHE/.test(r1.text));
  t("web_fetch: distillation produced output", r1.text.split("\n").length > 3, `${r1.text.length} chars`);

  // --- warm fetch: the same URL must report its age ------------------------
  const r2 = await call("web_fetch", { url: pageUrl, query: "unicode sample" });
  t("web_fetch: repeat call reports FROM CACHE", /FROM CACHE/.test(r2.text), r2.text.slice(0, 200));
  t("web_fetch: cache notice carries an age", /FROM CACHE, \S+ old/.test(r2.text));

  // --- fresh bypasses the cache -------------------------------------------
  const r3 = await call("web_fetch", { url: pageUrl, query: "unicode sample", fresh: true });
  t("web_fetch: fresh=true bypasses the cache", !/FROM CACHE/.test(r3.text));

  // --- errors surface as errors, not as empty successes -------------------
  const r4 = await call("web_fetch", { url: `${fixture}/missing`, query: "x" });
  t("web_fetch: HTTP 404 is reported as an error", r4.error && /404/.test(r4.text), r4.text.slice(0, 120));
}

// --- web_search: full pipeline incl. the multi-hop path ---------------------
if (process.env.MYKYAGENT_E2E_SEARCH === "1") {
  const s = await call("web_search", { query: "what is the ZGC garbage collector" });
  t("web_search: completes without error", !s.error, s.text.slice(0, 160));
  t("web_search: produced a substantial answer", s.text.length > 300, `${s.text.length} chars`);
  t("web_search: did not leak an unresolved FOLLOWUP marker", !/^\s*FOLLOWUP:/im.test(s.text), s.text.slice(0, 200));
} else {
  console.log(" SKIP  web_search live check (set MYKYAGENT_E2E_SEARCH=1)");
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
