/**
 * Tests for the /or-routing switch helpers (or_routing.ts).
 *
 * Behavioural focus: the models.json patch must be surgical (only the
 * openRouterRouting subtree changes; apiKey, baseUrl, sibling providers and
 * sibling compat keys survive), turning off must prune empty objects (a bare
 * `openrouter: {}` is rejected by pi's provider composer), and reconcile must
 * ADOPT a hand-written models.json routing instead of clobbering it.
 *
 * Runs fully offline against temp files via env overrides.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-orrouting-"));
const MODELS = join(DIR, "models.json");
const STATE = join(DIR, "orrouting.json");
process.env.MYKYAGENT_MODELS_JSON = MODELS;
process.env.MYKYAGENT_ORROUTING_FILE = STATE;

const M = await import("./or_routing.ts");

let pass = 0,
  fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};

// --- parseRoutingArg ----------------------------------------------------------
{
  const price = M.parseRoutingArg("price");
  t("parse: sort name → {sort}", !("error" in price) && M.canonicalJson(price.routing) === '{"sort":"price"}');
  const upper = M.parseRoutingArg("Throughput");
  t("parse: sort name lowercased", !("error" in upper) && M.canonicalJson(upper.routing) === '{"sort":"throughput"}');
  const obj = M.parseRoutingArg('{"only":["deepseek"],"sort":"price"}');
  t("parse: JSON object verbatim", !("error" in obj) && M.canonicalJson(obj.routing) === '{"only":["deepseek"],"sort":"price"}');
  t("parse: JSON array rejected", "error" in M.parseRoutingArg("[1,2]"));
  t("parse: JSON scalar rejected", "error" in M.parseRoutingArg('"price"'));
  t("parse: garbage rejected", "error" in M.parseRoutingArg("not a sort!"));
  t("parse: empty rejected", "error" in M.parseRoutingArg(""));
}

// --- canonicalJson: key order must not matter ---------------------------------
t("canonicalJson: order-independent", M.canonicalJson({ sort: "price", only: ["a"] }) === M.canonicalJson({ only: ["a"], sort: "price" }));

// --- sync: create from scratch ------------------------------------------------
rmSync(MODELS, { force: true });
const res1 = M.syncOpenRouterRoutingToModelsJson({ sort: "price" });
const created = res1.ok ? JSON.parse(readFileSync(MODELS, "utf-8")) : null;
t(
  "sync: creates providers.openrouter.compat.openRouterRouting",
  res1.ok &&
    created?.providers?.openrouter?.compat?.openRouterRouting &&
    M.canonicalJson(created.providers.openrouter.compat.openRouterRouting) === '{"sort":"price"}'
);
t("sync: exact user example shape", M.canonicalJson(created?.providers) === '{"openrouter":{"compat":{"openRouterRouting":{"sort":"price"}}}}');

// --- sync: surgical patch preserves everything else ----------------------------
writeFileSync(
  MODELS,
  JSON.stringify(
    {
      providers: {
        llamaLocal: { baseUrl: "http://localhost:8080/v1", apiKey: "secret", models: [{ id: "default" }] },
        openrouter: { apiKey: "sk-or", compat: { supportsReasoningEffort: true } },
      },
    },
    null,
    2
  )
);
M.syncOpenRouterRoutingToModelsJson({ sort: "throughput" });
const patched = JSON.parse(readFileSync(MODELS, "utf-8"));
t("sync: sibling provider untouched", patched.providers.llamaLocal?.apiKey === "secret" && patched.providers.llamaLocal?.models?.[0]?.id === "default");
t("sync: sibling compat key preserved", patched.providers.openrouter?.compat?.supportsReasoningEffort === true);
t(
  "sync: routing updated",
  M.canonicalJson(patched.providers.openrouter?.compat?.openRouterRouting) === '{"sort":"throughput"}'
);

// --- sync(null): removes only our key, prunes empties ---------------------------
M.syncOpenRouterRoutingToModelsJson(null);
const off1 = JSON.parse(readFileSync(MODELS, "utf-8"));
t("sync off: sibling compat key survives", off1.providers.openrouter?.compat?.supportsReasoningEffort === true);
t("sync off: routing removed", !off1.providers.openrouter?.compat?.openRouterRouting);
t("sync off: openrouter entry kept (still has apiKey)", off1.providers.openrouter?.apiKey === "sk-or");

// --- sync(null): empty compat AND empty provider are pruned ---------------------
writeFileSync(MODELS, JSON.stringify({ providers: { openrouter: { compat: { openRouterRouting: { sort: "price" } } } } }, null, 2));
const res2 = M.syncOpenRouterRoutingToModelsJson(null);
const off2 = res2.ok ? JSON.parse(readFileSync(MODELS, "utf-8")) : { providers: { openrouter: {} } };
t(
  "sync off: empty openrouter entry pruned entirely",
  res2.ok && off2.providers && !("openrouter" in off2.providers) && M.canonicalJson(off2) === '{"providers":{}}'
);

// --- readOpenRouterRoutingFromModelsJson ----------------------------------------
M.syncOpenRouterRoutingToModelsJson({ only: ["deepseek"] });
const readBack = M.readOpenRouterRoutingFromModelsJson();
t("read: round-trips routing block", M.canonicalJson(readBack) === '{"only":["deepseek"]}');
rmSync(MODELS, { force: true });
t("read: missing file → null", M.readOpenRouterRoutingFromModelsJson() === null);

// --- state file load/save --------------------------------------------------------
M.saveOpenRouterRouting({ sort: "latency" });
t("state: save/load round-trip", M.canonicalJson(M.loadOpenRouterRouting()) === '{"sort":"latency"}');
M.saveOpenRouterRouting(null);
writeFileSync(STATE, "{}\n", "utf-8");
t("state: empty object = off (null)", M.loadOpenRouterRouting() === null);

// --- reconcile: adoption (models.json is ahead of the switch) --------------------
writeFileSync(STATE, "{}\n", "utf-8");
writeFileSync(MODELS, JSON.stringify({ providers: { openrouter: { compat: { openRouterRouting: { sort: "price" } } } } }, null, 2));
M.reconcileOpenRouterRouting();
t("reconcile: hand-written models.json ADOPTED into switch", M.canonicalJson(M.loadOpenRouterRouting()) === '{"sort":"price"}');
t(
  "reconcile: models.json untouched by adoption",
  M.canonicalJson(JSON.parse(readFileSync(MODELS, "utf-8")).providers) === '{"openrouter":{"compat":{"openRouterRouting":{"sort":"price"}}}}'
);

// --- reconcile: switch wins (models.json diverged) -------------------------------
M.saveOpenRouterRouting({ sort: "price" });
writeFileSync(
  MODELS,
  JSON.stringify({ providers: { openrouter: { apiKey: "keep-me", compat: { openRouterRouting: { sort: "throughput" } } } } }, null, 2)
);
M.reconcileOpenRouterRouting();
const winner = JSON.parse(readFileSync(MODELS, "utf-8"));
t("reconcile: switch overwrites divergent models.json", M.canonicalJson(winner.providers.openrouter.compat.openRouterRouting) === '{"sort":"price"}');
t("reconcile: apiKey survives overwrite", winner.providers.openrouter.apiKey === "keep-me");

// --- reconcile: no-op when both agree (file byte-identical) ---------------------
const before = readFileSync(MODELS, "utf-8");
M.reconcileOpenRouterRouting();
t("reconcile: agreement → no rewrite", readFileSync(MODELS, "utf-8") === before);

// --- reconcile: corrupt models.json does not crash adoption ---------------------
M.saveOpenRouterRouting(null);
writeFileSync(MODELS, "{not json");
M.reconcileOpenRouterRouting(); // must not throw
t("reconcile: corrupt models.json tolerated", true);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
