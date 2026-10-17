import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTogglesSummary,
  getAllToggleableItems,
  isFeatureEnabled,
  isSkillEnabled,
  isSkillsMasterEnabled,
  isToolEnabled,
  loadToggles,
  resetAllToggles,
  setFeatureEnabled,
  setSkillEnabled,
  setSkillsMasterEnabled,
  setToolEnabled,
  toggleByName,
} from "./toggles.ts";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-toggles-test-"));
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

// 1. Defaults
t("default tool is enabled", isToolEnabled("read") === true);
t("default feature is enabled", isFeatureEnabled("memory") === true);
t("default skills master is enabled", isSkillsMasterEnabled() === true);
t("default individual skill is enabled", isSkillEnabled("web-scraping") === true);

// 2. Set tool toggle
setToolEnabled("bash", false);
t("tool can be disabled", isToolEnabled("bash") === false);
t("other tools remain enabled", isToolEnabled("read") === true);
setToolEnabled("bash", true);
t("tool can be re-enabled", isToolEnabled("bash") === true);

// 3. Set feature toggle
setFeatureEnabled("output_sanitizer", false);
t("feature can be disabled", isFeatureEnabled("output_sanitizer") === false);
setFeatureEnabled("output_sanitizer", true);
t("feature can be re-enabled", isFeatureEnabled("output_sanitizer") === true);

// 4. Master feature switches affect tool availability
setFeatureEnabled("web", false);
t("web feature false disables web_search", isToolEnabled("web_search") === false);
t("web feature false disables web_fetch", isToolEnabled("web_fetch") === false);
setFeatureEnabled("web", true);
t("web feature true restores web_search", isToolEnabled("web_search") === true);

setFeatureEnabled("memory", false);
t("memory feature false disables memory_read", isToolEnabled("memory_read") === false);
setFeatureEnabled("memory", true);
t("memory feature true restores memory_read", isToolEnabled("memory_read") === true);

// 5. Skills toggles
setSkillEnabled("web-scraping", false);
t("specific skill can be disabled", isSkillEnabled("web-scraping") === false);
setSkillEnabled("web-scraping", true);
t("specific skill can be re-enabled", isSkillEnabled("web-scraping") === true);

setSkillsMasterEnabled(false);
t("master skills off disables any skill", isSkillEnabled("web-scraping") === false);
t("master skills off is reflected in isSkillsMasterEnabled", isSkillsMasterEnabled() === false);
setSkillsMasterEnabled(true);
t("master skills re-enabled", isSkillsMasterEnabled() === true);

// 6. toggleByName dispatch
const r1 = toggleByName("grep");
t("toggleByName toggles tool", r1.ok && r1.category === "tool" && r1.enabled === false);
t("grep is now disabled", isToolEnabled("grep") === false);

const r2 = toggleByName("grep", true);
t("toggleByName explicit true works", r2.ok && r2.enabled === true);
t("grep is enabled again", isToolEnabled("grep") === true);

const r3 = toggleByName("persona");
t("toggleByName toggles feature", r3.ok && r3.category === "feature" && r3.enabled === false);
t("persona is now disabled", isFeatureEnabled("persona") === false);

const r4 = toggleByName("skills");
t("toggleByName toggles skills master", r4.ok && r4.category === "skill" && r4.enabled === false);
t("skills master is disabled", isSkillsMasterEnabled() === false);

const r5 = toggleByName("web-scraping", false, ["web-scraping"]);
t("toggleByName toggles specific skill", r5.ok && r5.category === "skill");

// 7. Reset all toggles
resetAllToggles();
t("reset restores tool", isToolEnabled("grep") === true);
t("reset restores feature", isFeatureEnabled("persona") === true);
t("reset restores skills master", isSkillsMasterEnabled() === true);

// 8. getAllToggleableItems & formatTogglesSummary
const items = getAllToggleableItems(["web-scraping"], ["custom_tool"]);
t("items include tools", items.some((i) => i.name === "read" && i.category === "tool"));
t("items include custom tools", items.some((i) => i.name === "custom_tool" && i.category === "tool"));
t("items include features", items.some((i) => i.name === "memory" && i.category === "feature"));
t("items include skills", items.some((i) => i.name === "web-scraping" && i.category === "skill"));

const summary = formatTogglesSummary(["web-scraping"]);
t("summary contains header and sections", summary.includes("Features:") && summary.includes("Skills:") && summary.includes("Tools:"));

// 9. Opt-in features default off
resetAllToggles();
t("tool_recovery defaults OFF", isFeatureEnabled("tool_recovery") === false);
t("regular features still default ON", isFeatureEnabled("memory") === true);
setFeatureEnabled("tool_recovery", true);
t("tool_recovery opt-in enables", isFeatureEnabled("tool_recovery") === true);
setFeatureEnabled("tool_recovery", false);
t("tool_recovery explicit off stays off", isFeatureEnabled("tool_recovery") === false);
resetAllToggles();
t("reset returns tool_recovery to OFF", isFeatureEnabled("tool_recovery") === false);

// 10. Per-mode tool settings
setToolEnabled("memory_read", false, "rp");
t("per-mode off in rp", isToolEnabled("memory_read", "rp") === false);
t("other mode unaffected", isToolEnabled("memory_read", "code") === true);
t("legacy boolean still global", (() => { setToolEnabled("bash", false); const a = isToolEnabled("bash", "rp") === false && isToolEnabled("bash", "code") === false; setToolEnabled("bash", true); return a; })());
setToolEnabled("memory_read", true, "rp");
t("per-mode re-enable", isToolEnabled("memory_read", "rp") === true);

setToolEnabled("grep", false);
t("bare set hits all modes", isToolEnabled("grep", "rp") === false && isToolEnabled("grep") === false);
setToolEnabled("grep", true);

const rMode = toggleByName("memory_write", false, [], "rp");
t("toggleByName mode message", rMode.ok && rMode.enabled === false && rMode.message.includes("rp mode") && isToolEnabled("memory_write", "rp") === false && isToolEnabled("memory_write", "code") === true);
setToolEnabled("memory_write", true, "rp");

const rpItems = getAllToggleableItems([], ["bash", "dice_roll"], { mode: "rp", isAllowed: (x) => x !== "bash" });
t("mode-blocked tools hidden", !rpItems.some((i) => i.name === "bash") && rpItems.some((i) => i.name === "dice_roll"));
setToolEnabled("dice_roll", false, "rp");
const rpItems2 = getAllToggleableItems([], ["dice_roll"], { mode: "rp" });
t("listing reflects per-mode value", rpItems2.some((i) => i.name === "dice_roll" && i.enabled === false));
setToolEnabled("dice_roll", true, "rp");
const sumMode = formatTogglesSummary([], ["bash"], { mode: "rp", isAllowed: (x) => x !== "bash" });
t("summary shows mode + hidden note", sumMode.includes("[rp mode]") && sumMode.includes("unavailable in rp mode"));
t("unfiltered listing unchanged", getAllToggleableItems(["web-scraping"], ["custom_tool"]).some((i) => i.name === "read"));

rmSync(DIR, { recursive: true, force: true });
console.log(`\ntoggles: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
