/**
 * Offline tests for the session brief (/brief): store shape, whitespace and
 * size bounds, prompt rendering, toggle gating, and the RP prompt hook.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-brief-"));
process.env.MYKYAGENT_BRIEF_FILE = join(DIR, "brief.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");

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

const B = await import("./brief.ts");
const T = await import("./toggles.ts");
const M = await import("./mode.ts");

t("empty by default", B.getBrief() === "");
t("empty renders no block (zero tax)", B.renderBriefBlock() === "");
t("empty card explains how to start", B.describeBrief().includes("/brief porting the A155F"));

const saved = B.setBrief("  porting the A155F kernel patch,\n\n\nC only, skip the hand-holding  ");
t("set trims and keeps inner text", saved === "porting the A155F kernel patch,\n\nC only, skip the hand-holding", JSON.stringify(saved));
t("store is json on disk", JSON.parse(readFileSync(process.env.MYKYAGENT_BRIEF_FILE!, "utf-8")).text.includes("A155F"));
t("get returns what set stored", B.getBrief() === saved);
t("empty brief is rejected", (() => {
  try {
    B.setBrief("   ");
    return false;
  } catch (err: any) {
    return err.message.includes("/brief clear");
  }
})());

const long = B.setBrief("x".repeat(B.BRIEF_STORE_MAX + 500));
t("store caps at BRIEF_STORE_MAX", long.length === B.BRIEF_STORE_MAX, String(long.length));

B.setBrief("slow-burn harbour heist, Vex POV, keep replies short");
const block = B.renderBriefBlock();
t("block frames the session", block.startsWith("## Session brief (what this session is about)"), block.slice(0, 60));
t("block carries the text verbatim", block.includes("slow-burn harbour heist, Vex POV"));
t("block says the message wins on conflict", block.includes("current message"));
t("block is clipped at BRIEF_MAX", (() => {
  B.setBrief("y".repeat(1500));
  const b = B.renderBriefBlock();
  return b.includes("…") && b.length < B.BRIEF_MAX + 400;
})(), String(B.renderBriefBlock().length));

B.setBrief("porting the A155F patch");
const card = B.describeBrief();
t("card shows the brief", card.includes("porting the A155F patch") && card.includes("/brief clear"));

const probe = M.buildRpSystemPrompt({ briefBlock: B.renderBriefBlock() });
t("rp prompt embeds the brief", probe.includes("porting the A155F patch"));

t("brief is in the toggle registry", "brief" in T.FEATURE_DEFS);
t("retired tags feature is gone", !("tags" in T.FEATURE_DEFS));
T.setFeatureEnabled("brief", false);
t("toggle off", T.isFeatureEnabled("brief") === false);
T.setFeatureEnabled("brief", true);

// Old configs carried features.tags; it must become features.brief, not vanish.
{
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.MYKYAGENT_TOGGLES_FILE!, JSON.stringify({ features: { tags: false, style: false } }), "utf-8");
  t("legacy tags feature migrates", T.migrateLegacyFeatureToggles() === true && T.isFeatureEnabled("brief") === false, JSON.stringify(T.loadToggles().features));
  t("legacy key removed", !("tags" in (T.loadToggles().features || {})));
  t("migration is idempotent", T.migrateLegacyFeatureToggles() === false);
}

B.clearBrief();
t("clear empties the brief", B.getBrief() === "" && B.renderBriefBlock() === "");

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
