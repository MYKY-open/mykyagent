/**
 * Background tasks: long-running commands the agent can start and then keep
 * working while they run, checking back later.
 *
 * The problem with the plain `bash` tool is that the agent blocks on it: a
 * build, a download, a server start or a test suite ties up the whole turn,
 * and progress spam floods the context. A background task instead:
 *
 *   - spawns DETACHED (own process group, unref'd), so the command outlives
 *     the tool call and the agent can continue immediately;
 *   - appends stdout+stderr to a log file, so nothing reaches the context
 *     until the agent explicitly asks for a bounded tail of it;
 *   - records an exit-code file when the command finishes, which makes
 *     "done vs still running vs died hard" distinguishable even though the
 *     spawning process is long gone;
 *   - persists metadata under the config root, so tasks survive an agent
 *     restart and can still be inspected afterwards.
 *
 * Everything here is plain fs + child_process with no pi runtime dependency,
 * so it is unit-testable. Override the store with MYKYAGENT_TASKS_DIR.
 */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ROOT = join(homedir(), ".config", "mykyagent", "tasks");

/** Bound on a single task_output read — mirrors the read tool's 15KB guard. */
export const TASK_OUTPUT_MAX_BYTES = 15 * 1024;
/** How long task metadata sticks around after /tasks clean. */
export const TASK_DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface TaskMeta {
  id: string;
  command: string;
  label: string;
  cwd: string;
  pid: number;
  started: string; // ISO timestamp
  log: string;
  exitFile: string;
}

export type TaskState = "running" | "done" | "dead" | "stopped";

export interface TaskStatus {
  meta: TaskMeta;
  state: TaskState;
  exitCode: number | null;
  finishedAgoMs: number | null;
}

/** Resolved per call, not at import time, so tests can redirect it. */
export function tasksRoot(): string {
  return process.env.MYKYAGENT_TASKS_DIR || DEFAULT_ROOT;
}

function ensureRoot(): void {
  if (!existsSync(tasksRoot())) mkdirSync(tasksRoot(), { recursive: true });
}

/**
 * Exit codes are written by the spawned wrapper (a normal exit), by task_stop
 * (a kill), or not at all (SIGKILL / crash / machine restart) — the absence of
 * a live pid AND an exit file is what the "dead" state reports.
 */
export function readExitCode(exitFile: string): number | null {
  try {
    const raw = readFileSync(exitFile, "utf-8").trim();
    if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  } catch {}
  return null;
}

/** Is a pid alive right now? kill(pid, 0) is the portable probe. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    return e?.code === "EPERM"; // exists but not ours — still alive
  }
  // Zombie trap: detached children are reaped only when THIS process exits, so
  // a finished task's wrapper lingers as an unreaped zombie and kill(pid, 0)
  // keeps succeeding. A 'Z' in /proc/<pid>/stat means it is already dead.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const state = stat.slice(stat.lastIndexOf(") ") + 2, stat.lastIndexOf(") ") + 3);
    if (state === "Z") return false;
  } catch {}
  return true;
}

export function taskStatus(meta: TaskMeta): TaskStatus {
  const exitCode = readExitCode(meta.exitFile);
  if (exitCode !== null) {
    let finishedAgoMs: number | null = null;
    try {
      finishedAgoMs = Date.now() - statSync(meta.exitFile).mtimeMs;
    } catch {}
    return { meta, state: exitCode === 0 ? "done" : "stopped", exitCode, finishedAgoMs };
  }
  // pidAlive can false-positive right after a recycled pid, but the exit file
  // is written milliseconds after exit, so the window is negligible.
  return { meta, state: pidAlive(meta.pid) ? "running" : "dead", exitCode: null, finishedAgoMs: null };
}

export function listTasks(): TaskStatus[] {
  ensureRoot();
  let files: string[] = [];
  try {
    files = readdirSync(tasksRoot()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: TaskStatus[] = [];
  for (const f of files.sort()) {
    try {
      const meta = JSON.parse(readFileSync(join(tasksRoot(), f), "utf-8")) as TaskMeta;
      if (meta && typeof meta.pid === "number" && typeof meta.command === "string") {
        out.push(taskStatus(meta));
      }
    } catch {}
  }
  return out;
}

export function loadTask(id: string): TaskMeta | null {
  const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return null;
  const path = join(tasksRoot(), `${safe}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TaskMeta;
  } catch {
    return null;
  }
}

/**
 * Start a command in the background. Returns the task metadata immediately;
 * the agent keeps working and checks back with taskStatus/task output later.
 *
 * The wrapper `(...); echo $? > exitFile` records the exit code without
 * keeping any node process attached. detached+unref means the task is fully
 * independent of this process.
 */
export function startTask(command: string, opts: { label?: string; cwd?: string } = {}): TaskMeta {
  const cmd = (command || "").trim();
  if (!cmd) throw new Error("command must not be empty");
  ensureRoot();

  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const log = join(tasksRoot(), `${id}.log`);
  const exitFile = join(tasksRoot(), `${id}.exit`);
  const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd.trim() : process.cwd();

  const meta: TaskMeta = { id, command: cmd, label: (opts.label || "").slice(0, 120), cwd, pid: -1, started: new Date().toISOString(), log, exitFile };
  writeFileSync(join(tasksRoot(), `${id}.json`), JSON.stringify(meta, null, 2), "utf-8");

  // A file descriptor opened in append mode is shared by stdout and stderr so
  // the two streams keep their interleaving instead of racing over the file.
  const logFd = openSync(log, "a");
  const wrapper = `${cmd}\n__myky_exit=$?\necho "$__myky_exit" > '${exitFile}'\n`;
  try {
    const child = spawn("bash", ["-c", wrapper], {
      detached: true,
      cwd,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    meta.pid = child.pid ?? -1;
    child.unref();
  } catch (e) {
    // Don't leave a pid-less ghost task behind on a spawn failure.
    try {
      rmSync(join(tasksRoot(), `${id}.json`), { force: true });
    } catch {}
    closeSync(logFd);
    throw e;
  }
  closeSync(logFd);
  if (meta.pid <= 0) throw new Error("failed to spawn background task");
  writeFileSync(join(tasksRoot(), `${id}.json`), JSON.stringify(meta, null, 2), "utf-8");
  return meta;
}

/**
 * Tail of a task's log, capped like the read tool. Returns null when nothing
 * has been written yet.
 */
export function taskOutput(id: string, tailLines = 50): string | null {
  const meta = loadTask(id);
  if (!meta || !existsSync(meta.log)) return null;
  let raw = "";
  try {
    raw = readFileSync(meta.log, "utf-8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  const allLines = raw.split("\n");
  if (allLines.length && allLines[allLines.length - 1] === "") allLines.pop();
  const n = Math.min(Math.max(1, tailLines), 250);
  let text = allLines.slice(-n).join("\n");
  if (Buffer.byteLength(text, "utf-8") > TASK_OUTPUT_MAX_BYTES) {
    text = Buffer.from(text, "utf-8").subarray(-TASK_OUTPUT_MAX_BYTES).toString("utf-8").replace(/^[^\n]*\n?/, "");
  }
  const hidden = allLines.length - text.split("\n").length;
  return (hidden > 0 ? `[${hidden} earlier line(s) hidden - full log: ${meta.log}]\n` : "") + text;
}

/**
 * Kill a task's whole process group (detached spawn => own pgid) and mark the
 * exit code so the task does not linger in "running" forever.
 */
export function stopTask(id: string, force = false): { ok: boolean; message: string } {
  const meta = loadTask(id);
  if (!meta) return { ok: false, message: `No task "${id}".` };
  const exitCode = readExitCode(meta.exitFile);
  if (exitCode !== null) return { ok: false, message: `Task ${id} already finished (exit ${exitCode}).` };
  if (!pidAlive(meta.pid)) {
    // Process is gone without an exit file (killed -9 / crash): record that
    // instead of reporting a dead task as running forever.
    writeFileSync(meta.exitFile, "143\n", "utf-8");
    return { ok: true, message: `Task ${id} was already gone; marked stopped.` };
  }
  const sig = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-meta.pid, sig); // negative pid = the whole process group
  } catch {
    try {
      process.kill(meta.pid, sig);
    } catch {}
  }
  if (!force) {
    // Give the wrapper a moment to write its own exit code; if it did not,
    // write 143 ourselves so the state resolves.
    try {
      execFileSync("sleep", ["0.3"]);
    } catch {}
    if (readExitCode(meta.exitFile) === null) writeFileSync(meta.exitFile, "143\n", "utf-8");
  } else {
    writeFileSync(meta.exitFile, "137\n", "utf-8");
  }
  return { ok: true, message: `Task ${id} ${force ? "force-killed" : "stopped"} (exit 143).` };
}

/**
 * Remove finished tasks older than the retention window (metadata + log +
 * exit marker). Running tasks are never touched. Returns the ids removed.
 */
export function cleanTasks(retentionMs: number = TASK_DONE_RETENTION_MS): string[] {
  const removed: string[] = [];
  for (const s of listTasks()) {
    if (s.state === "running") continue;
    if (s.finishedAgoMs !== null && s.finishedAgoMs < retentionMs) continue;
    try {
      rmSync(join(tasksRoot(), `${s.meta.id}.json`), { force: true });
      rmSync(s.meta.log, { force: true });
      rmSync(s.meta.exitFile, { force: true });
      removed.push(s.meta.id);
    } catch {}
  }
  return removed;
}

/** One-line human summary used by task_status and the /tasks command. */
export function formatTaskStatus(s: TaskStatus): string {
  const started = s.meta.started.replace("T", " ").slice(0, 19);
  const name = s.meta.label ? ` (${s.meta.label})` : "";
  if (s.state === "running") {
    return `• ${s.meta.id}${name} RUNNING since ${started} — cmd: ${s.meta.command}`;
  }
  if (s.state === "done") {
    const ago = s.finishedAgoMs !== null ? `, finished ${fmtAgo(s.finishedAgoMs)}` : "";
    return `• ${s.meta.id}${name} DONE (exit 0${ago}) — cmd: ${s.meta.command}`;
  }
  if (s.state === "stopped") {
    return `• ${s.meta.id}${name} STOPPED (exit ${s.exitCode}) — cmd: ${s.meta.command}`;
  }
  return `• ${s.meta.id}${name} DEAD (no exit code, pid gone — crashed or killed -9) — cmd: ${s.meta.command}`;
}

function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
