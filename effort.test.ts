/**
 * Offline unit tests for effort levels (/effort): default, validation,
 * persistence, per-message prefix, RP quiet mode, feature gating, block content.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-effort-"));
process.env.MYKYAGENT_EFFORT_FILE = join(DIR, "effort.json");
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

const effort = await import("./effort.ts");
const toggles = await import("./toggles.ts");

// The feature is opt-in: nothing is injected until the user turns it on.
t("effort feature is OFF by default", toggles.isFeatureEnabled("effort") === false);
t("feature off: stored max injects nothing", effort.effortForTurn({ prompt: "fix it", mode: "code" }) === null);
toggles.setFeatureEnabled("effort", true);

// --- levels and default -----------------------------------------------------
t("three levels: low | high | max", effort.EFFORT_LEVELS.join(",") === "low,high,max", effort.EFFORT_LEVELS.join(","));
t("default is high", effort.getEffort() === "high");
t("no stored file is not explicit", effort.isEffortExplicit() === false);
t("help text for every level", effort.EFFORT_LEVELS.every((l) => effort.EFFORT_HELP[l].length > 20));

// Stale values from older builds must not crash or silently mean "off".
for (const stale of ["auto", "normal", "off", "turbo"]) {
  writeFileSync(process.env.MYKYAGENT_EFFORT_FILE!, JSON.stringify({ level: stale }), "utf-8");
  t(`stale "${stale}" reads as default high`, effort.getEffort() === "high" && effort.isEffortExplicit() === false);
}
writeFileSync(process.env.MYKYAGENT_EFFORT_FILE!, "{not json", "utf-8");
t("corrupt file reads as default", effort.getEffort() === "high");

// --- set / validate / persist -----------------------------------------------
let threw = "";
try {
  effort.setEffort("auto");
} catch (err: any) {
  threw = err.message;
}
t("removed level 'auto' is rejected", threw.includes("Unknown effort") && threw.includes("low | high | max"), threw);
t("setEffort is case-insensitive", effort.setEffort(" MAX ") === "max");
t("setEffort persists", JSON.parse(readFileSync(process.env.MYKYAGENT_EFFORT_FILE!, "utf-8")).level === "max");
t("stored level is explicit", effort.isEffortExplicit() === true && effort.getEffort() === "max");

// --- per-message prefix -----------------------------------------------------
t("prefix max:", effort.parseEffortPrefix("max: build a game") === "max");
t("prefix is case-insensitive", effort.parseEffortPrefix("LOW : fix typo") === "low");
t("prefix tolerates leading space", effort.parseEffortPrefix("   high:x") === "high");
t("word containing a level is not a prefix", effort.parseEffortPrefix("maximum: no") === null);
t("level mentioned mid-sentence is not a prefix", effort.parseEffortPrefix("please do max: this") === null);
t("empty prompt has no prefix", effort.parseEffortPrefix("") === null);

// --- per-turn resolution ----------------------------------------------------
t("code turn uses stored level", effort.effortForTurn({ prompt: "fix it", mode: "code" }) === "max");
t("prefix overrides stored level for one turn", effort.effortForTurn({ prompt: "low: fix it", mode: "code" }) === "low");
t("prefix does not change stored level", effort.getEffort() === "max");
t("no prompt (custom run) uses stored level", effort.effortForTurn({ mode: "code" }) === "max");

rmSync(process.env.MYKYAGENT_EFFORT_FILE!, { force: true });
t("rp scene: no stored level, no block", effort.effortForTurn({ prompt: "*she looks up*", mode: "rp" }) === null);
t("rp-creator quiet with default (no stored level)", effort.effortForTurn({ prompt: "hi", mode: "rp-creator" }) === null);
t("rp-creator prefix still speaks", effort.effortForTurn({ prompt: "high: score the scene", mode: "rp-creator" }) === "high");
effort.setEffort("max");
t("stored max never leaks into an rp scene", effort.effortForTurn({ prompt: "*she looks up*", mode: "rp" }) === null, String(effort.effortForTurn({ prompt: "hi", mode: "rp" })));
t("stored max never leaks into rp-creator", effort.effortForTurn({ prompt: "hi", mode: "rp-creator" }) === null, String(effort.effortForTurn({ prompt: "hi", mode: "rp-creator" })));
t("rp-creator still takes a typed prefix", effort.effortForTurn({ prompt: "max: build the cast", mode: "rp-creator" }) === "max");
t("code mode never quiet", effort.effortForTurn({ prompt: "hi", mode: "code" }) === "max");

toggles.setFeatureEnabled("effort", false);
t("feature off: no level even with prefix", effort.effortForTurn({ prompt: "max: x", mode: "code" }) === null);
toggles.setFeatureEnabled("effort", true);
t("feature back on: level returns", effort.effortForTurn({ prompt: "x", mode: "code" }) === "max");

// --- blocks -----------------------------------------------------------------
const low = effort.renderEffortBlock("low");
const high = effort.renderEffortBlock("high");
const max = effort.renderEffortBlock("max");
t("low block starts with its header", low.startsWith("Work standard (effort=low)"));
t("low block: plan only for multi-step (no contradiction with base rule)", low.includes("Plan line only if the task has more than one step"));
t("low block: one command proves it", low.includes("Run one command"));
t("high block demands done-criteria", high.includes("done-criteria"));
t("high block bans literal compliance", high.includes("find it and change the code"));
t("high block demands adversarial probe, sized to the change", high.includes("Scale the proof to the change") && high.includes("1-2 probes"));
t("high block: bug reports reproduced before fixing", high.includes("reproduce the exact symptom") && high.includes("watch it fail"));
t("high block: per-ask DONE / NOT DONE line", high.includes("DONE with the command") && high.includes("NOT DONE"));
t("high block demands evidence", high.includes("Never claim success without evidence"));
t("max block adds tests and manual pass", max.includes("Write real tests") && max.includes("Manual pass"));
t("max block sizes the ceremony to the change", max.includes("Size the ceremony to the change") && max.includes("question or explanation -> just answer it"));
t("max block bans re-verifying untouched code", max.includes("Do not re-verify what you did not touch"));
t("max report scales down for a small fix", max.includes("for a small fix, one line with the command that proved it"));
t("max block reproduces bugs first", max.includes("reproduce the exact symptom"));
t("max block validates at boundaries only", max.includes("Validate at boundaries"));
t("max block bans compat shims", max.includes("no compat shims"));
t("max block bans injection", max.includes("command injection"));
t("max block demands file:line refs", max.includes("file_path:line_number"));
t("no block mentions auto/normal/off", ![low, high, max].some((b) => /effort=(auto|normal|off)|auto|normal/.test(b)));

// --- card -------------------------------------------------------------------
rmSync(process.env.MYKYAGENT_EFFORT_FILE!, { force: true });
const defaultCard = effort.describeEffort();
t("card marks default", defaultCard.startsWith("Effort: high (default)"), defaultCard.split("\n")[0]);
t("card lists every level", effort.EFFORT_LEVELS.every((l) => defaultCard.includes(`• ${l}`)));
t("card marks current level", /• high {2}← current/.test(defaultCard));
t("card explains the prefix", defaultCard.includes("prefix one message: low: / high: / max:"));
t("card scopes effort to code mode", defaultCard.includes("Code mode only."));
effort.setEffort("low");
t("card shows stored level, not default", effort.describeEffort().split("\n")[0] === "Effort: low", effort.describeEffort().split("\n")[0]);
toggles.setFeatureEnabled("effort", false);
t("card says when the feature is disabled", effort.describeEffort().includes("feature OFF, /effort <level> turns it on"));
toggles.setFeatureEnabled("effort", true);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
