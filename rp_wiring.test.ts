/**
 * Offline wiring test for the RP subsystem inside index.ts (no pi runtime, no
 * network): tool + command registration, mode-gated toolset merging, RP/creator
 * system-prompt dispatch, lorebook injection from event.prompt, author's note,
 * and the create-card -> load-character cross-mode flow from plan Phase 3.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-rpwire-"));
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
process.env.MYKYAGENT_CHARACTERS_DIR = join(DIR, "characters");
process.env.MYKYAGENT_LORE_DIR = join(DIR, "lore");
process.env.MYKYAGENT_AN_FILE = join(DIR, "authors_note.json");
process.env.MYKYAGENT_GAMESTATE_DIR = join(DIR, "gamestate");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
process.env.MYKYAGENT_WEBKILL_FILE = join(DIR, "webkill.json");
process.env.MYKYAGENT_WEBBROWSER_FILE = join(DIR, "webbrowser.json");
process.env.MYKYAGENT_MEMORY_DIR = join(DIR, "memory");
process.env.MYKYAGENT_MEMORY_FILE = join(DIR, "memory.json");
process.env.MYKYAGENT_WEBMODEL_FILE = join(DIR, "webmodel.json");

const ext = (await import("./index.ts")).default;

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

const tools: Record<string, any> = {};
const commands: Record<string, any> = {};
const hooks: Record<string, any> = {};
let activeTools: string[] = [];
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: (def: any) => (tools[def.name] = def),
  registerCommand: (n: string, def: any) => (commands[n] = def),
  getActiveTools: () => [...activeTools],
  setActiveTools: (names: string[]) => (activeTools = [...names]),
};

await ext(pi);

const notify: string[] = [];
const cmdCtx = {
  ui: {
    notify: (msg: string) => notify.push(msg),
  },
};

// --- 1. registration --------------------------------------------------------
t("creator tools registered", !!(tools.character_save && tools.character_read && tools.lorebook_save && tools.card_audit));
t("rpg tools registered", !!(tools.dice_roll && tools.game_state && tools.advance_time));
t("mode commands registered", !!(commands["mode"] && commands["rp-creator"] && commands["character"] && commands["rp"] && commands["an"]));

const modeComp = commands["mode"].getArgumentCompletions("");
t("mode completions list all three modes", Array.isArray(modeComp) && modeComp.map((c: any) => c.value).join(",") === "code,rp,rp-creator");

// --- 2. code mode (default): no rp/rpg/creator tools active -----------------
activeTools = ["bash", "read"];
const codePrompt = await hooks["before_agent_start"]({ prompt: "hi" }, { cwd: DIR });
t("code mode keeps coding tools", activeTools.includes("bash") && activeTools.includes("edit"));
t("code mode hides creator + rpg tools", !activeTools.includes("character_save") && !activeTools.includes("dice_roll"));
t("code mode prompt is persona prompt", codePrompt.systemPrompt.includes("Caveman") || codePrompt.systemPrompt.includes("MykyAgent"));

// tool_call guard blocks creator tool in code mode
const blockedCreator = await hooks["tool_call"]({ toolName: "card_audit" });
t("tool_call blocks card_audit in code mode", blockedCreator?.block === true && blockedCreator.reason.includes("mode"));
const allowedBash = await hooks["tool_call"]({ toolName: "bash" });
t("tool_call allows bash in code mode", !allowedBash?.block);

// --- 3. rp-creator mode: creator prompt + tools ------------------------------
await commands["rp-creator"].handler("", cmdCtx);
t("/rp-creator switches mode", notify.some((n) => n.includes("rp-creator")));
const creatorPrompt = await hooks["before_agent_start"]({ prompt: "make a card" }, { cwd: DIR });
t("creator tools become active", activeTools.includes("character_save") && activeTools.includes("card_audit"));
t("rpg tools hidden in creator mode", !activeTools.includes("dice_roll"));
t("creator prompt has craft rules", creatorPrompt.systemPrompt.includes("character architect") && creatorPrompt.systemPrompt.includes("Token economy"));

// --- 4. Phase 3 integration: create card via tool, load it for rp ------------
const card = {
  name: "Vex",
  description: "A cyberpunk smuggler with chromed cybernetic eyes and a dry wit.",
  personality: "Sardonic, loyal to exactly one person, allergic to corporations.",
  scenario: "The docking bay of a stolen freighter; port security just locked the doors.",
  first_message: "Good news, {{user}}: the ship still flies. Bad news: so does their drone.",
  mes_example: "<START>\n{{user}}: Can we outrun them?\n{{char}}: *taps the console* Define 'we'.",
};
const saved = await tools.character_save.execute("x", { slug: "vex", card });
t("character_save saves Vex", !saved.isError && String(saved.content[0].text).includes("vex"));

const audited = await tools.card_audit.execute("x", { slug: "vex" });
t("card_audit runs on new card", !audited.isError && String(audited.content[0].text).includes("Vex"));

await commands["character"].handler("load vex", cmdCtx);
t("/character load vex loads + switches to rp", notify.some((n) => n.includes("Vex")));

// --- 5. rp mode: dedicated prompt with card + lore + author's note -----------
// Give Vex a lorebook and set an author's note.
await tools.lorebook_save.execute("x", {
  slug: "vex-lore",
  entries: [
    { keys: ["harbor", "docks"], content: "The harbor district is Chrome Lotus territory after dark.", priority: 5 },
  ],
});
const anOk = commands["an"].handler("Keep the tension high; short dialogue.", cmdCtx);
t("/an sets author's note", true);

notify.length = 0;
const lore = await import("./lorebook.ts");
const vexCard = await import("./character.ts").then((m) => m.loadCharacter("vex"));
const { saveModeConfig, loadModeConfig } = await import("./mode.ts");
const cfg = loadModeConfig();
cfg.lorebook = "vex-lore";
saveModeConfig(cfg);

const rpPrompt = await hooks["before_agent_start"]({ prompt: "We slip out through the harbor, right?" }, { cwd: DIR });
t("rp mode strips coding tools", !activeTools.includes("bash") && !activeTools.includes("web_search"));
t("rp mode keeps read + dice_roll", activeTools.includes("read") && activeTools.includes("dice_roll"));
t("rp prompt embeds character block", rpPrompt.systemPrompt.includes("<character>") && rpPrompt.systemPrompt.includes("cybernetic eyes"));
t("rp prompt renders without raw placeholders", !rpPrompt.systemPrompt.includes("{{user}}") && !rpPrompt.systemPrompt.includes("{{char}}"));
t("rp prompt injects active lore from prompt keywords", rpPrompt.systemPrompt.includes("<active_lore>") && rpPrompt.systemPrompt.includes("Chrome Lotus"));
t("rp prompt includes author's note", rpPrompt.systemPrompt.includes("[Author's Note (insert at depth 1): Keep the tension high"));
t("rp prompt includes scene opener (greeting)", rpPrompt.systemPrompt.includes("Scene Opener") && rpPrompt.systemPrompt.includes("Good news, User:"));
t("rp prompt encourages rpg tools", rpPrompt.systemPrompt.includes("dice_roll") && rpPrompt.systemPrompt.includes("advance_time") && rpPrompt.systemPrompt.includes("Narration Tools"));
t("rp prompt has RP rules, not code rules", rpPrompt.systemPrompt.includes("Stay fully in character") && !rpPrompt.systemPrompt.includes("NEVER write files with absolute paths"));

const blockedBash = await hooks["tool_call"]({ toolName: "bash" });
t("tool_call blocks bash in rp mode", blockedBash?.block === true && blockedBash.reason.includes("rp"));
const allowedDice = await hooks["tool_call"]({ toolName: "dice_roll" });
t("tool_call allows dice_roll in rp mode", !allowedDice?.block);

// lorebook feature toggle suppresses injection
const { setFeatureEnabled } = await import("./toggles.ts");
setFeatureEnabled("lorebook", false);
const rpNoLore = await hooks["before_agent_start"]({ prompt: "harbor" }, { cwd: DIR });
t("lorebook feature off suppresses <active_lore>", !rpNoLore.systemPrompt.includes("<active_lore>"));
setFeatureEnabled("lorebook", true);

// rp master toggle off -> everything reverts to code behavior
setFeatureEnabled("rp", false);
const forcedCode = await hooks["before_agent_start"]({ prompt: "hi" }, { cwd: DIR });
t("rp master off: prompt reverts to code", forcedCode.systemPrompt.includes("Caveman") || !forcedCode.systemPrompt.includes("<character>"));
t("rp master off: coding tools back", activeTools.includes("bash"));
setFeatureEnabled("rp", true);

// --- 6. rpg tool execute paths ------------------------------------------------
const roll = await tools.dice_roll.execute("x", { spec: "2d6+3", reason: "Stealth" });
t("dice_roll executes", !roll.isError && /Stealth.*2d6\+3 → \d+/.test(String(roll.content[0].text)));
const badRoll = await tools.dice_roll.execute("x", { spec: "banana" });
t("dice_roll rejects garbage", badRoll.isError === true);

await tools.game_state.execute("x", { action: "set", key: "inventory.gold", value: 150 });
const got = await tools.game_state.execute("x", { action: "get", key: "inventory.gold" });
t("game_state set/get roundtrip", String(got.content[0].text).includes("150"));
const guarded = await tools.game_state.execute("x", { action: "set", key: "world.time", value: 5 });
t("game_state guards world.time", guarded.isError === true);

const advanced = await tools.advance_time.execute("x", { hours: 4 });
t("advance_time executes", !advanced.isError && /→/.test(String(advanced.content[0].text)));

// --- 6b. /character import command ---------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const data = Buffer.concat([
  Buffer.from("chara", "latin1"),
  Buffer.from([0]),
  Buffer.from(
    Buffer.from(
      JSON.stringify({
        spec: "chara_card_v2",
        data: { name: "Wren", description: "imported via command", personality: "p", scenario: "s", first_mes: "g", mes_example: "m" },
      }),
      "utf8"
    ).toString("base64"),
    "latin1"
  ),
]);
const pngPath = join(DIR, "wren.png");
const pngFile = Buffer.concat([PNG_SIG, (() => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length, 0); h.write("tEXt", 4, "latin1"); return Buffer.concat([h, data, Buffer.alloc(4)]); })(), (() => { const i = Buffer.alloc(12); i.write("IEND", 4, "latin1"); return i; })()]);
writeFileSync(pngPath, pngFile);

notify.length = 0;
await commands["character"].handler(`import ${pngPath}`, cmdCtx);
t("/character import succeeds", notify.some((n) => n.includes("Imported") && n.includes("Wren")), notify.join(" | ").slice(0, 200));
const wren = (await import("./character.ts")).loadCharacter("wren");
t("imported card saved to cards dir", wren?.name === "Wren");

notify.length = 0;
await commands["character"].handler("import /nonexistent/card.png", cmdCtx);
t("/character import reports failure", notify.some((n) => n.startsWith("Import failed")));

// --- 7. character greeting + reset + unload -----------------------------------
await commands["character"].handler("greeting", cmdCtx);
t("/character greeting prints greeting", notify.some((n) => n.includes("Good news")));

// Test /character reset
notify.length = 0;
await commands["character"].handler("reset vex", cmdCtx);
t("/character reset notifies success", notify.some((n) => n.includes("Reset")));
t("/character reset keeps active character", (await import("./mode.ts")).getActiveCharacterSlug() === "vex");

// --- 7b. session_start hook (e.g. /new or session switch) --------------------
notify.length = 0;
await hooks["session_start"]({ reason: "new" }, cmdCtx);
t("session_start new displays active character and greeting", notify.some((n) => n.includes("RP Mode: Vex is active.") && n.includes("Greeting:")));

notify.length = 0;
const resumeCtx = {
  ...cmdCtx,
  sessionManager: {
    getEntries: () => [{ type: "message", message: { role: "user", content: "hi" } }],
  },
};
await hooks["session_start"]({ reason: "resume" }, resumeCtx);
t("session_start resume displays active status without greeting", notify.some((n) => n.includes("RP Mode: Vex is active.") && !n.includes("Greeting:")));

await commands["character"].handler("unload", cmdCtx);
t("/character unload clears active character", (await import("./mode.ts")).getActiveCharacterSlug() === undefined);

// --- 8. feature toggles registered ---------------------------------------------
const { FEATURE_DEFS } = await import("./toggles.ts");
t("rp features in toggle registry", ["rp", "lorebook", "authors_note", "rp_creator", "rpg_tools"].every((f) => f in FEATURE_DEFS));

// --- 9. per-character memory namespace ------------------------------------------
// Section 7 unloaded the character (mode: code). Seed a global topic that must
// NOT leak into the character's index — while still in code mode.
const modeMod = await import("./mode.ts");
await tools.memory_write.execute("x", { name: "kernel_build", summary: "tech build notes", body: "arduino stuff" });

// Re-enter rp with Vex loaded.
modeMod.setMode("rp");
modeMod.setActiveCharacter("vex");

// Still in rp mode with Vex loaded from earlier in this suite.
await tools.memory_write.execute("x", { name: "trust", summary: "Vex trusts User after the harbor escape", body: "affinity high; owes User one" });

const { existsSync, readFileSync: rf } = await import("node:fs");
const memDir = process.env.MYKYAGENT_MEMORY_DIR!;
t("rp write namespaced to char-vex-trust", existsSync(join(memDir, "char-vex-trust.md")), (await import("node:fs")).readdirSync(memDir).join(","));
t("rp write did not touch global store", !existsSync(join(memDir, "trust.md")));

// character index shows only character topics
const memListRp = await tools.memory_list.execute("x", {});
t("rp memory_list shows only char topics", String(memListRp.content[0].text).includes("char-vex-trust") && !String(memListRp.content[0].text).includes("kernel_build"));

// rp prompt index also filtered
const rpMemPrompt = await hooks["before_agent_start"]({ prompt: "what do you remember about us?" }, { cwd: DIR });
t("rp prompt memory index filtered", rpMemPrompt.systemPrompt.includes("char-vex-trust") && !rpMemPrompt.systemPrompt.includes("kernel_build"));

// read resolves character topic by short name
const readLocal = await tools.memory_read.execute("x", { name: "trust" });
t("rp read resolves char topic by short name", String(readLocal.content[0].text).includes("harbor escape"));

// read falls back to global when character has no such topic
const readGlobal = await tools.memory_read.execute("x", { name: "kernel_build" });
t("rp read falls back to global topic", String(readGlobal.content[0].text).includes("arduino stuff"));

// code mode: global view again, no namespace on writes
modeMod.setMode("code");
const memListCode = await tools.memory_list.execute("x", {});
t("code memory_list shows global topics", String(memListCode.content[0].text).includes("kernel_build") && String(memListCode.content[0].text).includes("char-vex-trust"));
await tools.memory_write.execute("x", { name: "global_note", summary: "global", body: "g" });
t("code write lands unnamespaced", existsSync(join(memDir, "global_note.md")));

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
