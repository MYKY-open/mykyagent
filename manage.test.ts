/**
 * Offline tests for the management drawers: character duplicate/rename
 * helpers + tools, memory edit/rename/move/search helpers + tools, and the
 * /characters + /memories board flows (scripted UI).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-manage-"));
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
process.env.MYKYAGENT_CHARACTERS_DIR = join(DIR, "characters");
process.env.MYKYAGENT_LORE_DIR = join(DIR, "lore");
process.env.MYKYAGENT_AN_FILE = join(DIR, "authors_note.json");
process.env.MYKYAGENT_GAMESTATE_DIR = join(DIR, "gamestate");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_MEMORY_DIR = join(DIR, "memory");
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
process.env.MYKYAGENT_WEBKILL_FILE = join(DIR, "webkill.json");
process.env.MYKYAGENT_WEBBROWSER_FILE = join(DIR, "webbrowser.json");
process.env.MYKYAGENT_MEMORY_FILE = join(DIR, "memory.json");
process.env.MYKYAGENT_WEBMODEL_FILE = join(DIR, "webmodel.json");

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

const ch = await import("./character.ts");
const mem = await import("./memory.ts");
const modeMod = await import("./mode.ts");

ch.seedStarterCharacters();
t("starters seeded", ch.listCharacters().length === 3);

// --- character helpers -------------------------------------------------------
const dup = ch.duplicateCharacter("evelyn", "Evelyn Clone");
t("duplicate creates copy", dup.slug === "evelyn-clone" && ch.loadCharacter("evelyn-clone")?.name === "Evelyn Clone");
t("duplicate keeps lore link", ch.loadCharacter("evelyn-clone")?.lorebook === ch.loadCharacter("evelyn")?.lorebook);

let threw = "";
try {
  ch.duplicateCharacter("evelyn", "Evelyn Clone");
} catch (e: any) {
  threw = e.message;
}
t("duplicate refuses collision", threw.includes("already exists"));

const ren = ch.renameCharacter("evelyn-clone", "Evelyn Prime");
t("rename moves file", ren.slug === "evelyn-prime" && ch.loadCharacter("evelyn-prime")?.name === "Evelyn Prime" && ch.loadCharacter("evelyn-clone") === null);

threw = "";
try {
  ch.renameCharacter("ghost", "Nobody");
} catch (e: any) {
  threw = e.message;
}
t("rename missing throws", threw.includes("No character card"));

// --- memory helpers ----------------------------------------------------------
mem.writeMemoryEntry("char-vex-trust", "trusts User", "affinity high");
mem.writeMemoryEntry("kernel_build", "tech notes", "arduino and oscillators");

const edited = mem.editMemoryEntry("char-vex-trust", { body: "affinity max", mode: "replace" });
t("edit replaces body", edited?.body === "affinity max");
const appended = mem.editMemoryEntry("char-vex-trust", { body: "owes User one", mode: "append" });
t("edit appends", appended?.body.includes("affinity max") && appended?.body.includes("owes User one"));
t("edit missing is null", mem.editMemoryEntry("nope", { body: "x" }) === null);

const renamed = mem.renameMemoryEntry("kernel_build", "kernel notes");
t("rename keeps content", renamed?.name === "kernel-notes" && renamed?.body.includes("arduino") && mem.readMemoryEntry("kernel_build") === null);

const moved = mem.moveMemoryEntry("char-vex-trust", "evelyn");
t("move to character namespace", moved?.name === "char-evelyn-trust");
const back = mem.moveMemoryEntry("char-evelyn-trust", "global");
t("move back to global", back?.name === "trust");
t("move missing is null", mem.moveMemoryEntry("ghost", "global") === null);

const hits = mem.searchMemories("arduino");
t("search finds body text", hits.length === 1 && hits[0].name === "kernel-notes");
t("search prefix filter", mem.searchMemories("arduino", { prefix: "char-" }).length === 0 && mem.searchMemories("arduino", { prefix: "kernel" }).length === 1);
t("search empty query", mem.searchMemories("").length === 0);

// --- tools -------------------------------------------------------------------
const ext = (await import("./index.ts")).default;
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

t("creator tools registered", !!(tools.character_duplicate && tools.character_rename));
t("memory tools registered", !!(tools.memory_edit && tools.memory_rename && tools.memory_move && tools.memory_search));
t("creator tools blocked in rp", ["character_duplicate", "character_rename"].every((x) => modeMod.isToolAllowedInMode(x, "rp") === false));

const dupTool = await tools.character_duplicate.execute("x", { slug: "evelyn", name: "Evelyn Second" });
t("duplicate tool works", !dupTool.isError && String(dupTool.content[0].text).includes("evelyn-second"));
const dupClash = await tools.character_duplicate.execute("x", { slug: "evelyn", name: "Evelyn Second" });
t("duplicate tool reports collision", dupClash.isError === true);
const renTool = await tools.character_rename.execute("x", { slug: "evelyn-second", name: "Evelyn 2" });
t("rename tool works", !renTool.isError && String(renTool.content[0].text).includes("evelyn-2"));

const editTool = await tools.memory_edit.execute("x", { name: "trust", summary: "trusts User deeply", mode: "replace" });
t("memory_edit tool works", !editTool.isError && String(editTool.content[0].text).includes("trust"));
const editMiss = await tools.memory_edit.execute("x", { name: "ghost" });
t("memory_edit missing errors", editMiss.isError === true);
const searchTool = await tools.memory_search.execute("x", { query: "arduino" });
t("memory_search tool works", !searchTool.isError && String(searchTool.content[0].text).includes("kernel-notes"));
const moveTool = await tools.memory_move.execute("x", { name: "trust", target: "evelyn" });
t("memory_move tool works", !moveTool.isError && String(moveTool.content[0].text).includes("char-evelyn-trust"));
const renameTool = await tools.memory_rename.execute("x", { name: "char-evelyn-trust", new_name: "evelyn bond" });
t("memory_rename tool works", !renameTool.isError && String(renameTool.content[0].text).includes("evelyn-bond"));

// --- /characters board -------------------------------------------------------
const scripted = (answers: string[], inputs: string[], confirmVal = true) => {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      cwd: DIR,
      ui: {
        notify: (m: string) => notes.push(m),
        select: async () => answers.shift(),
        input: async () => inputs.shift(),
        confirm: async () => confirmVal,
      },
    },
  };
};

{
  const s = scripted(["evelyn - Evelyn: A veteran explorer in her late thirties, we", "Duplicate"], ["Evelyn Board"]);
  // picker option text depends on description truncation; feed the real slug line instead:
  s.ctx.ui.select = async () => (s as any).step === 1 ? "Duplicate" : ((s as any).step = 1, "evelyn - Evelyn: x");
  (s as any).step = 0;
  await commands["characters"].handler("", s.ctx);
  t("board duplicate flow", s.notes.some((n) => n.includes("evelyn-board")), s.notes.join(" | ").slice(0, 200));
}

{
  const s = scripted([], [], true);
  (s as any).n = 0;
  s.ctx.ui.select = async () => ((s as any).n++ === 0 ? "evelyn-prime - Evelyn Prime: x" : "Delete file");
  await commands["characters"].handler("", s.ctx);
  t("board delete flow", s.notes.some((n) => n.includes("Deleted character card")), s.notes.join(" | ").slice(0, 200));
}

// rename updates the active character pointer
modeMod.setMode("rp");
modeMod.setActiveCharacter("evelyn");
{
  const s = scripted([], [], true);
  (s as any).n = 0;
  s.ctx.ui.select = async () => ((s as any).n++ === 0 ? "evelyn - Evelyn: x" : "Rename");
  s.ctx.ui.input = async () => "Evelyn Renamed";
  await commands["characters"].handler("", s.ctx);
  t("board rename updates active", modeMod.getActiveCharacterSlug() === "evelyn-renamed", String(modeMod.getActiveCharacterSlug()));
}

// --- /memories board ---------------------------------------------------------
modeMod.setMode("rp");
modeMod.setActiveCharacter("vex");
mem.writeMemoryEntry("char-vex-secret", "a secret", "the harbor password is swordfish");

{
  const notes: string[] = [];
  const ctx = {
    cwd: DIR,
    ui: {
      notify: (m: string) => notes.push(m),
      select: async (title: string) => (title.startsWith("Memories") ? "char-vex-secret — a secret" : "Read"),
    },
  };
  await commands["memories"].handler("", ctx);
  t("board read flow", notes.some((n) => n.includes("swordfish")), notes.join(" | ").slice(0, 200));
}

{
  const notes: string[] = [];
  let n = 0;
  const ctx = {
    cwd: DIR,
    ui: {
      notify: (m: string) => notes.push(m),
      select: async (title: string) => {
        if (title.startsWith("Memories")) return "char-vex-secret — a secret";
        if (title.startsWith("Memory:")) return n++ === 0 ? "Move" : "global";
        return "global";
      },
      confirm: async () => true,
    },
  };
  await commands["memories"].handler("", ctx);
  t("board move flow", notes.some((m) => m.includes('"secret"')), notes.join(" | ").slice(0, 200));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
