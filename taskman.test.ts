/**
 * Offline tests for the serial task runner (taskman.ts): start/poll/wait/
 * stop/list/clear, cursor semantics, caps. Plus extension wiring.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-tasks-"));
process.env.MYKYAGENT_TASKS_DIR = join(DIR, "tasks");
for (const k of ["TODO", "CHECKPOINTS", "SESSION", "SKILLS", "MCP", "MCPKILL", "WEBKILL", "WEBBROWSER", "TOGGLES", "MODE", "MEMORY", "WEBMODEL"]) {
  process.env[`MYKYAGENT_${k}_FILE`] = join(DIR, `${k.toLowerCase()}.json`);
  process.env[`MYKYAGENT_${k}_DIR`] = join(DIR, `${k.toLowerCase()}.d`);
}

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

const T = await import("./taskman.ts");

// --- lifecycle ------------------------------------------------------------
const id1 = T.startTask("echo hello-tasks", "echo-test");
t("start returns id", typeof id1 === "string" && id1.length > 0, id1);
const w1 = await T.waitTask(id1, 10000);
t("wait returns exit", w1.info.exitCode === 0 && w1.info.running === false, JSON.stringify({ exit: w1.info.exitCode }));
t("wait captures output", w1.output.includes("hello-tasks"), JSON.stringify(w1.output).slice(0, 120));

// cursor: second poll is empty (no re-read cost)
const p2 = T.pollTask(id1);
t("cursor: re-poll is empty", p2.output === "" && p2.info.running === false);

// failing command records exit code
const id2 = T.startTask("exit 3", "fail-test");
const w2 = await T.waitTask(id2, 10000);
t("exit code recorded", w2.info.exitCode === 3, String(w2.info.exitCode));

// slow task: wait timeout returns running, then stop kills
const id3 = T.startTask("sleep 60", "sleeper");
const w3 = await T.waitTask(id3, 2500);
t("wait timeout stays running", w3.info.running === true);
const stopped = await T.stopTask(id3);
t("stop kills", stopped.running === false);
const p3 = T.pollTask(id3);
t("stopped task polls state", p3.info.running === false);

// quiet wait: one bill, tail at end
const idq = T.startTask("echo one && echo two", "quiet-test");
const wq = await T.waitTask(idq, 15000, 30, true);
t("quiet wait exits with tail", wq.info.exitCode === 0 && wq.output.includes("two"), JSON.stringify({ exit: wq.info.exitCode, out: wq.output }));
const pq = T.pollTask(idq);
t("quiet wait consumed cursor", pq.output === "");
T.clearTask(idq);

// list + clear
const listed = T.listTasks().map((x) => x.id);
t("list tracks all", listed.includes(id1) && listed.includes(id2) && listed.includes(id3), listed.join(","));
T.clearTask(id1);
t("clear forgets finished", !T.listTasks().some((x) => x.id === id1));
let clearRunning = "";
try {
  T.clearTask(id3);
} catch (e: any) {
  clearRunning = "";
}
// id3 stopped already -> clear works
t("clear stopped works", !T.listTasks().some((x) => x.id === id3));

// cap: fill to max
const ids: string[] = [T.startTask("sleep 60", "a"), T.startTask("sleep 60", "b"), T.startTask("sleep 60", "c")];
let capErr = "";
try {
  T.startTask("sleep 60", "d");
} catch (e: any) {
  capErr = e.message;
}
t("cap refuses 4th live task", capErr.includes("Serial") || capErr.includes("running"), capErr);
for (const i of ids) await T.stopTask(i);
for (const i of ids) T.clearTask(i);

// unknown ids error cleanly
let unk = "";
try {
  T.pollTask("nope");
} catch (e: any) {
  unk = e.message;
}
t("unknown id errors", unk.includes("Unknown"), unk);

// --- wiring ---------------------------------------------------------------
const ext = (await import("./index.ts")).default;
const tools: Record<string, any> = {};
const commands: Record<string, any> = {};
const hooks: Record<string, any> = {};
let active: string[] = [];
await (ext as any)({
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: (d: any) => (tools[d.name] = d),
  registerCommand: (n: string, d: any) => (commands[n] = d),
  getActiveTools: () => [...active],
  setActiveTools: (x: string[]) => (active = [...x]),
});
t("wiring: task tools registered", !!(tools.task_start && tools.task_output && tools.task_wait && tools.task_stop && tools.task_list));
t("wiring: /tasks registered", !!commands.tasks);

active = ["bash", "read"];
await hooks["before_agent_start"]({}, { cwd: DIR });
t("wiring: merge adds task tools", active.includes("task_start") && active.includes("task_wait"), active.join(","));

const started = await tools.task_start.execute("x", { command: "echo via-tool", name: "tooltest" });
const toolId = String(started.content?.[0]?.text || "").match(/Task (\S+) started/)?.[1] || "";
t("wiring: task_start tool works", toolId.length > 0, JSON.stringify(started.content?.[0]?.text));
const waited = await tools.task_wait.execute("x", { id: toolId, timeout: 10000 });
t("wiring: task_wait tool follows", String(waited.content?.[0]?.text || "").includes("via-tool"));
const listed2 = await tools.task_list.execute("x", {});
t("wiring: task_list tool lists", String(listed2.content?.[0]?.text || "").includes(toolId));
const notify: string[] = [];
await commands.tasks.handler("", { ui: { notify: (m: string) => notify.push(m) } });
t("wiring: /tasks notifies", notify.some((m) => m.includes(toolId)));
await T.stopTask(toolId).catch(() => {});
T.clearTask(toolId);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
