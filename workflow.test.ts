/**
 * Offline tests for the workflow layer: skills-lite, todos, checkpoints,
 * resume. All pi-free modules driven directly, plus extension wiring
 * (registration, prompt lines, tool_call snapshots, commands).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-flow-"));
process.env.MYKYAGENT_TODO_FILE = join(DIR, "todo.json");
process.env.MYKYAGENT_CHECKPOINTS_DIR = join(DIR, "checkpoints");
process.env.MYKYAGENT_SESSION_FILE = join(DIR, "last_session.md");
process.env.MYKYAGENT_SKILLS_DIR = join(DIR, "skills");
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
process.env.MYKYAGENT_WEBKILL_FILE = join(DIR, "webkill.json");
process.env.MYKYAGENT_WEBBROWSER_FILE = join(DIR, "webbrowser.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
process.env.MYKYAGENT_MEMORY_DIR = join(DIR, "memory");

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

// --- skills ---------------------------------------------------------------
mkdirSync(join(DIR, "skills", "ship"), { recursive: true });
writeFileSync(join(DIR, "skills", "commit.md"), "# commit\nConventional commits flow.\n", "utf-8");
writeFileSync(join(DIR, "skills", "ship", "SKILL.md"), "# ship it\nRelease checklist.\n", "utf-8");

const S = await import("./skills.ts");
const skills = S.listSkills();
t("skills: finds flat + dir skills", skills.some((s) => s.name === "commit") && skills.some((s) => s.name === "ship"), JSON.stringify(skills));
t("skills: description from heading", skills.find((s) => s.name === "commit")?.description === "commit");
t("skills: readSkill returns body", (S.readSkill("ship") || "").includes("Release checklist"));
t("skills: readSkill case-insensitive", (S.readSkill("COMMIT") || "").includes("Conventional"));
t("skills: unknown returns null", S.readSkill("nope") === null);
t("skills: prompt line lists names", S.skillsPromptLine().includes("commit") && S.skillsPromptLine().includes("skill_read"));

// --- todos ----------------------------------------------------------------
const T = await import("./todo.ts");
t("todo: block empty when fresh", T.todoBlock() === "");
const a = T.addTodo("Flash the kernel");
const b = T.addTodo("Verify boot");
t("todo: ids increment", a.id === 1 && b.id === 2);
t("todo: block lists open", T.todoBlock().includes("Flash the kernel") && T.todoBlock().includes("Open todos (2)"));
T.doneTodo(1);
t("todo: done by id", T.openTodos().length === 1 && T.todoBlock().includes("Verify boot") && !T.todoBlock().includes("Flash"));
T.doneTodo("boot");
t("todo: done by text match", T.openTodos().length === 0 && T.todoBlock() === "");
T.addTodo("One");
T.addTodo("Two");
t("todo: clear done-only", T.clearTodos() === 2 && T.loadTodos().length === 2);
t("todo: clear all", T.clearTodos(true) === 2 && T.loadTodos().length === 0);

// --- checkpoints -----------------------------------------------------------
const C = await import("./checkpoints.ts");
const target = join(DIR, "work", "notes.txt");
mkdirSync(join(DIR, "work"), { recursive: true });
writeFileSync(target, "v1", "utf-8");
const snap1 = C.snapshotFile(target);
t("checkpoint: snapshots existing file", !!snap1 && C.listCheckpoints().length === 1);
t("checkpoint: skips unchanged content", C.snapshotFile(target) === null && C.listCheckpoints().length === 1);
writeFileSync(target, "v2", "utf-8");
C.snapshotFile(target);
t("checkpoint: new snapshot on change", C.listCheckpoints().length === 2);
t("checkpoint: missing file returns null", C.snapshotFile(join(DIR, "ghost.txt")) === null);
writeFileSync(target, "v3-bad-edit", "utf-8");
const restored = C.restoreCheckpoint();
t("checkpoint: rewind restores latest pre-write state", restored === target && readFileSync(target, "utf-8") === "v2", readFileSync(target, "utf-8"));
writeFileSync(target, "v4", "utf-8");
C.snapshotFile(target);
C.restoreCheckpoint(2);
t("checkpoint: positional restore works", readFileSync(target, "utf-8") === "v2");
let badRestore = "";
try {
  C.restoreCheckpoint(99);
} catch (e: any) {
  badRestore = e.message;
}
t("checkpoint: bad target errors", badRestore.includes("No checkpoint"), badRestore);
// ring cap
for (let i = 0; i < 25; i++) {
  writeFileSync(target, `rev${i}`, "utf-8");
  C.snapshotFile(target);
}
t("checkpoint: ring keeps last 20", C.listCheckpoints().length === 20);
// big file skipped
const big = join(DIR, "big.bin");
writeFileSync(big, "x".repeat(200 * 1024), "utf-8");
t("checkpoint: oversize skipped", C.snapshotFile(big) === null);

// --- resume ----------------------------------------------------------------
const R = await import("./resume.ts");
t("resume: nothing to restore when fresh", R.buildResumeText() === null);
R.saveSummary("Did kernel flash. Next: verify boot.");
t("resume: summary restores", (R.buildResumeText() || "").includes("kernel flash"));
R.saveAutoStub(DIR);
const resumeText = R.buildResumeText() || "";
t("resume: stub merges todos/state", resumeText.includes("Auto state") && resumeText.includes("restored previous session"));

// --- extension wiring -------------------------------------------------------
const ext = (await import("./index.ts")).default;
const tools: Record<string, any> = {};
const commands: Record<string, any> = {};
const hooks: Record<string, any> = {};
let activeTools: string[] = [];
const sent: string[] = [];
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: (def: any) => (tools[def.name] = def),
  registerCommand: (n: string, def: any) => (commands[n] = def),
  getActiveTools: () => [...activeTools],
  setActiveTools: (names: string[]) => (activeTools = [...names]),
  sendUserMessage: (msg: string) => sent.push(msg),
};
await ext(pi);

t("wiring: workflow tools registered", !!(tools.skill_read && tools.todo && tools.summarize));
t("wiring: workflow commands registered", !!(commands.skill && commands.rewind && commands.restore));

activeTools = ["bash", "read"];
T.addTodo("Wire it up");
await hooks["before_agent_start"]({}, { cwd: DIR });
t("wiring: merge adds workflow tools", activeTools.includes("todo") && activeTools.includes("skill_read"));
const withTodo = await hooks["before_agent_start"]({}, { cwd: DIR });
t("wiring: open todos in prompt", (withTodo?.systemPrompt || "").includes("Wire it up"));
t("wiring: skills line in prompt", (withTodo?.systemPrompt || "").includes("skill_read"));
T.clearTodos(true);
const clean = await hooks["before_agent_start"]({}, { cwd: DIR });
t("wiring: zero tax when empty", !(clean?.systemPrompt || "").includes("Open todos"));

// tool_call snapshots write/edit
const ckTarget = join(DIR, "snap.txt");
writeFileSync(ckTarget, "before", "utf-8");
await hooks["tool_call"]({ toolName: "write", input: { path: "snap.txt", content: "after" } }, { cwd: DIR });
t("wiring: tool_call snapshots write target", C.listCheckpoints().some((c) => c.path === ckTarget));

// skill_read tool
const skillRes = await tools.skill_read.execute("x", { name: "commit" });
t("wiring: skill_read serves skill", String(skillRes.content?.[0]?.text || "").includes("Conventional"));
const skillBad = await tools.skill_read.execute("x", { name: "ghost" });
t("wiring: skill_read unknown errors", skillBad.isError === true);

// todo tool
const todoAdd = await tools.todo.execute("x", { action: "add", text: "From tool" });
t("wiring: todo tool adds", String(todoAdd.content?.[0]?.text || "").includes("added"));
const todoList = await tools.todo.execute("x", { action: "list" });
t("wiring: todo tool lists", String(todoList.content?.[0]?.text || "").includes("From tool"));

// summarize tool + /restore command
await tools.summarize.execute("x", { text: "Wired everything." });
const notify: string[] = [];
await commands.restore.handler("", { ui: { notify: (m: string) => notify.push(m) } });
t("wiring: /restore injects summary", sent.length === 1 && sent[0].includes("Wired everything"), sent.join("|").slice(0, 120));

// /rewind command lists + restores
const ck2 = join(DIR, "rw.txt");
writeFileSync(ck2, "good", "utf-8");
C.snapshotFile(ck2);
writeFileSync(ck2, "bad", "utf-8");
await commands.rewind.handler("", { ui: { notify: (m: string) => notify.push(m) } });
t("wiring: /rewind lists", notify.some((m) => m.includes("Checkpoints")));
await commands.rewind.handler("1", { ui: { notify: (m: string) => notify.push(m) } });
t("wiring: /rewind 1 restores", readFileSync(ck2, "utf-8") === "good");

// /skill command
await commands.skill.handler("", { ui: { notify: (m: string) => notify.push(m) } });
t("wiring: /skill lists", notify.some((m) => m.includes("commit")));

// session_shutdown stub (no throw, no clobber of summary)
await hooks["session_shutdown"]({}, { cwd: DIR });
t("wiring: shutdown stub keeps summary", (R.loadSummary() || "").includes("Wired everything"));

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
