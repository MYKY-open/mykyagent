/**
 * Offline unit tests for conversation tints (/tags): store limits,
 * normalization, prompt rendering, and toggle gating.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-tags-"));
process.env.MYKYAGENT_TAGS_FILE = join(DIR, "tags.json");
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

const tags = await import("./tags.ts");

t("empty by default", tags.getTags().length === 0);
t("render empty is zero-tax", tags.renderTagsBlock() === "");

tags.setTags(["Noir", "  TERSE  ", "noir", "cozy!"]);
t("add normalizes + dedupes", JSON.stringify(tags.getTags()) === JSON.stringify(["noir", "terse", "cozy"]), JSON.stringify(tags.getTags()));

const many = Array.from({ length: 15 }, (_, i) => `tag${i}`);
tags.setTags(many);
t("caps at 10 tags", tags.getTags().length === 10);

tags.setTags(["a".repeat(50)]);
t("tag length capped", tags.getTags()[0].length <= 24);

tags.setTags(["noir", "terse"]);
const block = tags.renderTagsBlock();
t("block names tags", block.includes("noir") && block.includes("terse"));
t("block is subordinate", block.includes("never override"));

const added = tags.addTags(["poetic", "noir"]);
t("addTags reports new only", added.added.length === 1 && added.added[0] === "poetic");

const removed = tags.removeTags(["NOIR"]);
t("remove is case-insensitive", removed.removed.includes("noir") && !tags.getTags().includes("noir"));

tags.clearTags();
t("clear empties", tags.getTags().length === 0 && tags.renderTagsBlock() === "");

// rp prompt embeds tags block when provided
const mode = await import("./mode.ts");
const rpPrompt = mode.buildRpSystemPrompt({ characterBlock: "<character>x</character>", tagsBlock: "Active conversation tints: noir." });
t("rp prompt embeds tags", rpPrompt.includes("noir"));

// toggle registry + prompt gating
const { FEATURE_DEFS, setFeatureEnabled } = await import("./toggles.ts");
t("tags in toggle registry", "tags" in FEATURE_DEFS);
setFeatureEnabled("tags", false);
t("tags toggle off", (await import("./toggles.ts")).isFeatureEnabled("tags") === false);
setFeatureEnabled("tags", true);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
