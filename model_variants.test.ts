/**
 * Offline tests for model_variants.ts: parseTarget, addVariant, removeVariant,
 * listVariants — all against a temp MYKYAGENT_MODELS_JSON. No network: the
 * registry is mocked and the catalog fetch path is only exercised when the
 * registry misses (covered by or the smoke test with real network).
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-mvar-"));
const MODELS = join(DIR, "models.json");
process.env.MYKYAGENT_MODELS_JSON = MODELS;

const MV = await import("./model_variants.ts");

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

// --- parseTarget -------------------------------------------------------------
{
  const p = MV.parseTarget("z-ai/glm-5.3-flash:floor");
  t("parse: base/suffix split", !("error" in p) && p.base === "z-ai/glm-5.3-flash" && p.suffix === "floor" && p.variantId === "z-ai/glm-5.3-flash:floor");
  t("parse: known suffix", !("error" in p) && p.known === true);
}
{
  const p = MV.parseTarget("openrouter/z-ai/glm-5.3-flash:floor");
  t("parse: openrouter/ prefix dropped", !("error" in p) && p.variantId === "z-ai/glm-5.3-flash:floor");
}
{
  const p = MV.parseTarget("somevendor/model-x:weirdsuffix");
  t("parse: unknown suffix tolerated", !("error" in p) && p.known === false);
}
{
  const p = MV.parseTarget("no-suffix-here");
  t("parse: suffixless id → plain add", !("error" in p) && p.base === "no-suffix-here" && p.suffix === "" && p.variantId === "no-suffix-here");
}
{
  const p = MV.parseTarget(":floor");
  t("parse: leading colon rejected", "error" in p);
}
{
  const p = MV.parseTarget("model:");
  t("parse: empty suffix rejected", "error" in p);
}
{
  const p = MV.parseTarget("model:a:b:free");
  t("parse: nested variant rejected", "error" in p);
}
{
  const p = MV.parseTarget("");
  t("parse: empty rejected", "error" in p);
}

// --- addVariant: registry clone path -----------------------------------------
const fakeRegistry = {
  find: (provider: string, id: string) =>
    provider === "openrouter" && id === "z-ai/glm-5.3-flash"
      ? {
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          id: "z-ai/glm-5.3-flash",
          name: "GLM 5.3 Flash",
          api: "openai-completions",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 262144,
          maxTokens: 65536,
          cost: { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0 },
          compat: { someFlag: true },
        }
      : undefined,
};
{
  const r = await MV.addVariant("z-ai/glm-5.3-flash:floor", fakeRegistry);
  t("add: registry clone ok", r.ok === true, JSON.stringify(r));
  const doc = JSON.parse(readFileSync(MODELS, "utf-8"));
  const entry = doc.providers?.openrouter?.models?.find((m: any) => m.id === "z-ai/glm-5.3-flash:floor");
  t("add: entry written with variant id", !!entry && entry.id === "z-ai/glm-5.3-flash:floor");
  t("add: name suffixed", entry?.name === "GLM 5.3 Flash (floor)");
  t("add: metadata cloned (contextWindow)", entry?.contextWindow === 262144);
  t("add: cost preserved (floor not free)", entry?.cost?.input === 0.5);
  t("add: provider/baseUrl stripped", !("provider" in entry) && !("baseUrl" in entry));
}
{
  // update-in-place
  const r = await MV.addVariant("z-ai/glm-5.3-flash:floor", fakeRegistry);
  t("add: idempotent re-add ok", r.ok === true && r.message.startsWith("Updated"), JSON.stringify(r));
  const doc = JSON.parse(readFileSync(MODELS, "utf-8"));
  t("add: no duplicate entries", doc.providers.openrouter.models.length === 1);
}
{
  // :free zeroes cost
  const r = await MV.addVariant("z-ai/glm-5.3-flash:free", fakeRegistry);
  t("add: :free ok", r.ok === true, JSON.stringify(r));
  const doc = JSON.parse(readFileSync(MODELS, "utf-8"));
  const entry = doc.providers.openrouter.models.find((m: any) => m.id === "z-ai/glm-5.3-flash:free");
  t("add: :free cost zeroed", entry?.cost?.input === 0 && entry?.cost?.output === 0);
}
{
  const r = await MV.addVariant("unknown-base/model:floor", fakeRegistry);
  t("add: unresolved base fails clean", r.ok === false && /not in OpenRouter catalog/.test((r as any).error), JSON.stringify(r));
  // failed add must NOT write a stub entry
  const doc = JSON.parse(readFileSync(MODELS, "utf-8"));
  t("add: failure leaves models.json valid", Array.isArray(doc.providers.openrouter.models) && !doc.providers.openrouter.models.some((m: any) => m.id?.includes("unknown-base")));
}
{
  const r = await MV.addVariant("garbage", fakeRegistry);
  t("add: bad arg rejected", r.ok === false);
}

// --- plain (suffixless) adds --------------------------------------------------
{
  const r = await MV.addVariant("z-ai/glm-5.3-flash", fakeRegistry);
  t("plain add: already-known base is a no-op", r.ok === true && /already in pi's catalog/.test(r.message), JSON.stringify(r));
  const doc = JSON.parse(readFileSync(MODELS, "utf-8"));
  t("plain add: no shadow entry written", !doc.providers.openrouter.models.some((m: any) => m.id === "z-ai/glm-5.3-flash"));
}
{
  // Plain add of an UNKNOWN base falls through to the live-catalog fetch —
  // offline this fails clean, and no entry is written.
  const r = await MV.addVariant("stealth/offline-test-model", fakeRegistry);
  t("plain add: unknown base + no network fails clean", r.ok === false, JSON.stringify(r));
  const doc = JSON.parse(readFileSync(MODELS, "utf-8"));
  t("plain add: failed fetch writes nothing", !doc.providers.openrouter.models.some((m: any) => m.id === "stealth/offline-test-model"));
}

// --- removeVariant / listVariants ---------------------------------------------
{
  const list = MV.listVariants();
  t("list: two variants", list.length === 2 && list.every((v: any) => v.id.includes(":")));
}
{
  const r = MV.removeVariant("z-ai/glm-5.3-flash:free");
  t("remove: ok", r.ok === true, JSON.stringify(r));
  const list = MV.listVariants();
  t("remove: list shrinks", list.length === 1 && list[0].id === "z-ai/glm-5.3-flash:floor");
}
{
  const r = MV.removeVariant("z-ai/glm-5.3-flash:floor");
  const doc = JSON.parse(readFileSync(MODELS, "utf-8"));
  t("remove: prunes empty openrouter block", r.ok === true && !doc.providers?.openrouter);
}
{
  const r = MV.removeVariant("never/existed:floor");
  t("remove: missing id errors", r.ok === false);
}
{
  const r = await MV.addVariant("z-ai/glm-5.3-flash:nitro", fakeRegistry);
  t("add after prune: recreates provider block", r.ok === true && existsSync(MODELS));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\nmodel_variants: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
