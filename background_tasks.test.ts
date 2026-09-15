/**
 * Tests for background tasks.
 *
 * These run REAL processes (sleep/echo) because the load-bearing properties are
 * behavioural: a started task is detached (the tool call returns before the
 * command finishes), its exit code eventually lands in the exit file, a kill
 * reaches the whole process group, and log output is bounded on the way out.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-tasks-"));
process.env.MYKYAGENT_TASKS_DIR = DIR;

const M = await import("./background_tasks.ts");

let pass = 0,
  fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};

async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

// --- start: validation + immediate return -----------------------------------
t("start: empty command rejected", (() => {
  try {
    M.startTask("   ");
    return false;
  } catch {
    return true;
  }
})());

const fast = M.startTask("echo fast-out", { label: "echo test" });
t("start: returns id + positive pid", fast.id.startsWith("t") && fast.pid > 0, `pid=${fast.pid}`);
t("start: metadata json written", existsSync(join(DIR, `${fast.id}.json`)));
t("start: log file written", existsSync(fast.log));
t("start: label is stored", readFileSync(join(DIR, `${fast.id}.json`), "utf-8").includes("echo test"));

// The tool call returns immediately even for a long command: measure that the
// call itself does not block for the command's duration.
const t0 = Date.now();
const slow = M.startTask("sleep 3 && echo slow-done");
const elapsed = Date.now() - t0;
t("start: does not block on long command", elapsed < 1000, `${elapsed}ms`);

// --- status: running vs done ------------------------------------------------
const slowStatus = M.taskStatus(M.loadTask(slow.id)!);
t("status: long task is running right after start", slowStatus.state === "running", slowStatus.state);

const fastDone = await until(() => M.taskStatus(M.loadTask(fast.id)!).exitCode !== null);
t("status: finished task reports exit code 0", fastDone && M.taskStatus(M.loadTask(fast.id)!).exitCode === 0);
const fastFinal = M.taskStatus(M.loadTask(fast.id)!);
t("status: exit 0 => state done", fastFinal.state === "done", fastFinal.state);
t("status: finishedAgoMs is set for finished task", fastFinal.finishedAgoMs !== null && fastFinal.finishedAgoMs >= 0);

// --- output: bounded tail ---------------------------------------------------
const fastOut = M.taskOutput(fast.id);
t("output: captures stdout", fastOut?.includes("fast-out") === true, JSON.stringify(fastOut));

// A task producing lots of lines: tail must cap line count and announce hiding.
const noisy = M.startTask("for i in $(seq 1 300); do echo line$i; done");
const noisyOk = await until(() => (M.taskOutput(noisy.id) || "").includes("line300"));
const noisyOut = M.taskOutput(noisy.id, 50) || "";
const noisyLines = noisyOut.split("\n").length;
t("output: tail respects line cap", noisyOk && noisyLines <= 51, `${noisyLines} lines`);
t("output: hides earlier lines and names the log", noisyOut.startsWith("[") && noisyOut.includes("earlier line(s) hidden") && noisyOut.includes(noisy.id));

// Byte cap: one enormous line gets cut, not delivered whole.
const huge = M.startTask("head -c 40000 /dev/zero | tr '\\0' 'x'");
await until(() => (M.taskOutput(huge.id) || "").length > 0);
const hugeOut = M.taskOutput(huge.id) || "";
t("output: byte-capped at 15KB", Buffer.byteLength(hugeOut, "utf-8") <= M.TASK_OUTPUT_MAX_BYTES + 200, `${Buffer.byteLength(hugeOut, "utf-8")} bytes`);

t("output: unknown task returns null", M.taskOutput("nope") === null);

// --- stop: kills the process group ------------------------------------------
const stopped = M.startTask("sleep 60", { label: "kill me" });
const runningOk = await until(() => M.taskStatus(M.loadTask(stopped.id)!).state === "running");
t("stop: setup - task is running", runningOk);
const stopRes = M.stopTask(stopped.id);
const stopStatus = M.taskStatus(M.loadTask(stopped.id)!);
t("stop: reports success", stopRes.ok, stopRes.message);
t("stop: task left in stopped state", stopStatus.state === "stopped", stopStatus.state);
t("stop: exit code recorded", stopStatus.exitCode !== null, `${stopStatus.exitCode}`);

t("stop: unknown task fails cleanly", M.stopTask("nope").ok === false);
t("stop: already-finished task is a no-op", M.stopTask(fast.id).ok === false);

// force kill path on a fresh task
const killed9 = M.startTask("sleep 60");
M.stopTask(killed9.id, true);
const k9Status = M.taskStatus(M.loadTask(killed9.id)!);
t("stop: force kill leaves exit 137", k9Status.exitCode === 137, `${k9Status.exitCode}`);
t("stop: force kill process actually dead", !M.pidAlive(M.loadTask(killed9.id)!.pid));

// --- dead state: pid gone without an exit file ------------------------------
const fake = {
  id: "tfaketest",
  command: "pretend",
  label: "",
  cwd: DIR,
  pid: 999999999, // almost certainly not a live pid
  started: new Date().toISOString(),
  log: join(DIR, "tfaketest.log"),
  exitFile: join(DIR, "tfaketest.exit"),
};
writeFileSync(join(DIR, "tfaketest.json"), JSON.stringify(fake), "utf-8");
const deadStatus = M.taskStatus(M.loadTask("tfaketest")!);
t("dead: missing exit file + dead pid => dead", deadStatus.state === "dead", deadStatus.state);

// --- list + load + clean ----------------------------------------------------
const listed = M.listTasks();
t("list: includes started tasks", listed.some((s) => s.meta.id === stopped.id));
t("list: exposes metadata not log bodies", listed.every((s) => !JSON.stringify(s).includes("line299")));

t("load: unknown id returns null", M.loadTask("does-not-exist") === null);
t("load: traversal id is neutralised", M.loadTask("../../etc/passwd") === null);

// cleanTasks(0) removes everything finished; running tasks survive.
const stillRunning = M.startTask("sleep 30");
const removed = M.cleanTasks(0);
t("clean: removes finished tasks", removed.includes(fast.id) && removed.includes(stopped.id), removed.join(","));
t("clean: keeps running tasks", M.loadTask(stillRunning.id) !== null);
M.stopTask(stillRunning.id, true);

// stopped-just-now tasks are NOT cleaned when the retention window applies.
const recent = M.startTask("true");
await until(() => M.taskStatus(M.loadTask(recent.id)!).exitCode !== null);
t("clean: honours retention window", M.cleanTasks(TASK_RETENTION()).length === 0);

function TASK_RETENTION(): number {
  return 24 * 60 * 60 * 1000;
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
