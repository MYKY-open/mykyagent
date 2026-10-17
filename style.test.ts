/**
 * Offline unit tests for narrative style dials (/style): all-off defaults,
 * level validation, freeform tone, persistence filtering, prompt block, and
 * toggle gating.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-style-"));
process.env.MYKYAGENT_STYLE_FILE = join(DIR, "style.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");

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

const style = await import("./style.ts");

t("23 dials registered", style.listStyleDials().length === 23, String(style.listStyleDials().length));
t("all off by default", Object.keys(style.getStyles()).length === 0);
t("empty block is zero-tax", style.renderStyleBlock() === "");

style.setStyle("tense", "Past");
t("levels case-insensitive", style.getStyles().tense === "past");

let threw = "";
try {
  style.setStyle("tense", "sideways");
} catch (err: any) {
  threw = err.message;
}
t("bad level rejected with levels", threw.includes("past | present"), threw);

threw = "";
try {
  style.setStyle("bogus", "x");
} catch (err: any) {
  threw = err.message;
}
t("unknown dial rejected", threw.includes("Dials:"), threw);

style.setStyle("tone", "Noir, PLAYFUL!!!");
t("tone freeform normalized", style.getStyles().tone === "noir, playful", JSON.stringify(style.getStyles().tone));

style.setStyle("pov", "3rd");
const block = style.renderStyleBlock();
t("block renders set dials", block.includes("past tense") && block.includes("3rd person limited") && block.includes("tone: noir, playful"));
t("block names rules", block.startsWith("Narrative style (apply these rules):"));

style.clearStyle("tense");
t("clear one dial", style.getStyles().tense === undefined && style.getStyles().pov === "3rd");

style.clearStyle();
t("clear all resets", Object.keys(style.getStyles()).length === 0 && style.renderStyleBlock() === "");

// junk in the file is filtered, never trusted
const { writeFileSync } = await import("node:fs");
writeFileSync(join(DIR, "style.json"), JSON.stringify({ tense: "future", pov: "3rd", bogus: "x" }));
t("invalid persisted values filtered", (() => {
  const cur = style.getStyles();
  return cur.tense === undefined && cur.pov === "3rd" && (cur as any).bogus === undefined;
})());

// rp prompt embeds the style block
style.setStyle("tense", "past");
const mode = await import("./mode.ts");
const rpPrompt = mode.buildRpSystemPrompt({ characterBlock: "<character>x</character>", styleBlock: style.renderStyleBlock() });
t("rp prompt embeds style", rpPrompt.includes("past tense"));

// toggle registry + gating
const { FEATURE_DEFS, setFeatureEnabled } = await import("./toggles.ts");
t("style in toggle registry", "style" in FEATURE_DEFS);
setFeatureEnabled("style", false);
t("style toggle off", (await import("./toggles.ts")).isFeatureEnabled("style") === false);
setFeatureEnabled("style", true);

// Interactive picker rows
const rows = style.buildStyleSettingItems();
t("picker has master + 23 dials", rows.length === 24 && rows[0].id === style.STYLE_MASTER_ID);
t("every dial row cycles from off", rows.slice(1).every((r) => r.values?.[0] === "off"));
t("unset tone row is off-only", (() => {
  const tone = rows.find((r) => r.id === "style:tone");
  return tone?.currentValue === "off" && tone?.values?.length === 1;
})());

style.setStyle("tense", "past");
style.setStyle("tone", "noir");
const rows2 = style.buildStyleSettingItems();
t("rows reflect current values", rows2.find((r) => r.id === "style:tense")?.currentValue === "past");
t("set tone row offers current", (() => {
  const tone = rows2.find((r) => r.id === "style:tone");
  return tone?.currentValue === "noir" && tone?.values?.includes("noir");
})());

t("apply sets dial", style.applyStyleSettingChange("style:pov", "3rd") === "pov = 3rd." && style.getStyles().pov === "3rd");
t("apply off clears dial", style.applyStyleSettingChange("style:pov", "off") === "pov off." && style.getStyles().pov === undefined);
t("apply master disables", style.applyStyleSettingChange(style.STYLE_MASTER_ID, "disabled").includes("DISABLED") && style.buildStyleSettingItems()[0].currentValue === "disabled");
t("apply master re-enables", style.applyStyleSettingChange(style.STYLE_MASTER_ID, "enabled").includes("ENABLED"));
let threwApply = "";
try { style.applyStyleSettingChange("style:tense", "sideways"); } catch (e: any) { threwApply = e.message; }
t("apply rejects bad level", threwApply.includes("past | present"));
let threwClear = "";
try { style.applyStyleSettingChange("style:bogus", "off"); } catch (e: any) { threwClear = e.message; }
t("apply rejects unknown dial", threwClear.includes("Unknown style dial"));

t("picker rows carry help text", rows.every((r) => r.id === style.STYLE_MASTER_ID || (r.description || "").length > 40));

t("every dial has a real manual", style.listStyleDials().every((d) => d.help.length >= 40));
t("explainer card covers dial", (() => {
  const card = style.describeStyle("heat");
  return card.includes("Intensity") && card.includes("restrained | grounded") && card.includes("Current: off") && card.includes("/style heat");
})());
let threwDesc = "";
try { style.describeStyle("bogus"); } catch (e: any) { threwDesc = e.message; }
t("explainer rejects unknown dial", threwDesc.includes("Unknown style dial"));
style.setStyle("tense", "past");
t("explainer shows current value", style.describeStyle("tense").includes("Current: past"));
t("WBU gap levels accepted", (() => {
  style.setStyle("figurative", "saturated");
  style.setStyle("density", "adaptive");
  style.setStyle("pov", "Shifting 3rd");
  style.setStyle("distance", "free indirect");
  style.setStyle("volatility", "whiplash");
  style.setStyle("depth", "philosophical");
  style.setStyle("thoughts", "open");
  const cur = style.getStyles();
  return cur.figurative === "saturated" && cur.density === "adaptive" && cur.pov === "shifting 3rd" && cur.distance === "free indirect" && cur.volatility === "whiplash" && cur.depth === "philosophical" && cur.thoughts === "open";
})());
t("WBU gap dials render", (() => {
  const b = style.renderStyleBlock();
  return b.includes("saturated figurative language") && b.includes("adaptive paragraphing") && b.includes("shifting 3rd person") && b.includes("free indirect narrative distance") && b.includes("tone whips paragraph by paragraph") && b.includes("philosophical talk") && b.includes("other characters' inner thoughts");
})());
style.clearStyle();

t("intimacy + profanity consent-framed", (() => {
  style.setStyle("intimacy", "explicit");
  style.setStyle("profanity", "strong");
  const b = style.renderStyleBlock();
  const ok = b.includes("adult intimacy may be explicit") && b.includes("strong language where it fits");
  const help = style.describeStyle("intimacy");
  style.clearStyle("intimacy");
  style.clearStyle("profanity");
  return ok && help.includes("may be explicit");
})());

// --- /style picker: Esc (cancel) must not crash (done scoping regression) ---
{
  const piReal = await import("@earendil-works/pi-coding-agent");
  (piReal as any).initTheme("dark");
  const ext = (await import("./index.ts")).default;
  const commands: Record<string, any> = {};
  const pi: any = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (n: string, def: any) => (commands[n] = def),
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  await ext(pi);
  let factory: any = null;
  await commands["style"].handler("", {
    cwd: DIR,
    ui: { notify: () => {}, custom: async (fn: any) => { factory = fn; return undefined; } },
  });
  t("picker factory created", typeof factory === "function");
  let doneCalled = false;
  const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, muted: (s: string) => s };
  const comp = factory({ requestRender: () => {} }, fakeTheme, {}, () => { doneCalled = true; });
  t("picker renders rows", Array.isArray(comp.render(100)) && comp.render(100).join("\n").includes("Style"));
  comp.handleInput("c"); // master row ignores c
  comp.handleInput("\x1b[C"); // Right steps master enabled -> disabled
  t("right arrow steps the selected row", style.buildStyleSettingItems()[0].currentValue === "disabled");
  comp.handleInput("\x1b[D"); // back
  comp.handleInput("\x1b"); // Esc -> onCancel -> done()
  t("esc closes without crashing", doneCalled === true);
  style.applyStyleSettingChange(style.STYLE_MASTER_ID, "enabled");
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
