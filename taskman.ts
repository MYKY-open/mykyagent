/**
 * Serial task runner: long commands without blindness.
 *
 * Philosophy: the AGENT stays serial (one thing at a time), but OS-level
 * tasks run detached with cursor-based output — poll returns only NEW bytes
 * since the last read, so watching a build costs tokens once, not every
 * poll. Logs capped, concurrent tasks capped (models make fleets of
 * mistakes); wait() blocks server-side up to a deadline instead of the
 * model guessing sleep durations.
 *
 * Store: MYKYAGENT_TASKS_DIR or ~/.config/mykyagent/tasks/.
 * Pi-free. Reattach-safe: state lives in meta.json + log files.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TaskInfo {
  id: string;
  name: string;
  command: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  started: string;
  ended: string | null;
  logBytes: number;
}

export interface TaskPoll {
  info: TaskInfo;
  output: string; // new bytes since last poll (or tail when fresh reader)
  truncated: boolean;
}

const MAX_TASKS = 3;
const LOG_CAP = 512 * 1024;
const POLL_CAP = 4 * 1024;
const TAIL_LINES = 30;

export function tasksDir(): string {
  return process.env.MYKYAGENT_TASKS_DIR || join(homedir(), ".config", "mykyagent", "tasks");
}

function metaPath(id: string): string {
  return join(tasksDir(), id, "meta.json");
}

function logPath(id: string): string {
  return join(tasksDir(), id, "output.log");
}

function cursorPath(id: string): string {
  return join(tasksDir(), id, "cursor");
}

function readMeta(id: string): any | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf-8"));
  } catch {
    return null;
  }
}

function writeMeta(id: string, meta: any): void {
  mkdirSync(join(tasksDir(), id), { recursive: true });
  writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), "utf-8");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function refreshState(id: string): TaskInfo | null {
  const meta = readMeta(id);
  if (!meta) return null;
  const alive = pidAlive(meta.pid ?? null);
  if (meta.running && !alive && meta.exitCode === null) {
    // Process gone without recorded exit (restart, kill -9): mark dead.
    meta.running = false;
    meta.ended = meta.ended || new Date().toISOString();
    writeMeta(id, meta);
  }
  let logBytes = 0;
  try {
    const st = readFileSync(logPath(id));
    logBytes = st.length;
  } catch {}
  return {
    id,
    name: meta.name,
    command: meta.command,
    pid: meta.pid ?? null,
    running: meta.running && alive,
    exitCode: meta.exitCode,
    started: meta.started,
    ended: meta.ended,
    logBytes,
  };
}

/** Start a detached task. Throws when at cap. Returns id. */
export function startTask(command: string, name?: string, cwd?: string): string {
  const clean = command.trim();
  if (!clean) throw new Error("Command is empty.");
  const live = listTasks().filter((t) => t.running);
  if (live.length >= MAX_TASKS) {
    throw new Error(`Already ${live.length} tasks running (${live.map((t) => t.id).join(", ")}). Stop one first — serial discipline.`);
  }
  const id = `${Date.now().toString(36)}-${slugify(name || clean.split(/\s+/)[0])}`;
  const dir = join(tasksDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(logPath(id), "", "utf-8");
  writeFileSync(cursorPath(id), "0", "utf-8");
  const meta = {
    name: name?.trim() || clean.split(/\s+/)[0],
    command: clean,
    pid: null as number | null,
    running: true,
    exitCode: null as number | null,
    started: new Date().toISOString(),
    ended: null as string | null,
  };
  writeMeta(id, meta);

  // Single spawn: shell append-redirects into the log so output survives
  // restarts and the cursor logic can reattach by pid liveness.
  const child: ChildProcess = spawn("bash", ["-c", `exec >> ${JSON.stringify(logPath(id))} 2>&1; ${clean}`], {
    cwd: cwd || process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  meta.pid = child.pid ?? null;
  writeMeta(id, meta);
  child.on("exit", (code) => {
    const m = readMeta(id);
    if (m) {
      m.running = false;
      m.exitCode = code ?? 0;
      m.ended = new Date().toISOString();
      try {
        writeMeta(id, m);
      } catch {}
    }
  });
  return id;
}

/** Read new bytes since cursor (or tail when reset). Advances cursor. */
export function pollTask(id: string, tailLines = TAIL_LINES): TaskPoll {
  const info = refreshState(id);
  if (!info) throw new Error(`Unknown task "${id}".`);
  let cursor = 0;
  try {
    cursor = Number.parseInt(readFileSync(cursorPath(id), "utf-8"), 10) || 0;
  } catch {}
  let raw: Buffer;
  try {
    raw = readFileSync(logPath(id)) as Buffer;
  } catch {
    raw = Buffer.alloc(0);
  }
  if (raw.length > LOG_CAP) {
    raw = raw.subarray(raw.length - LOG_CAP);
    cursor = Math.max(cursor, info.logBytes - LOG_CAP);
  }
  let slice: Buffer;
  let truncated = false;
  if (cursor >= raw.length) {
    slice = Buffer.alloc(0);
  } else if (raw.length - cursor > POLL_CAP) {
    slice = raw.subarray(raw.length - POLL_CAP);
    truncated = true;
  } else {
    slice = raw.subarray(cursor);
  }
  let output = slice.toString("utf-8").replace(/\uFFFD+$/, "");
  if (truncated) {
    // Show complete lines only when cutting mid-stream.
    const lines = output.split("\n");
    output = (lines.length > tailLines ? lines.slice(-tailLines).join("\n") : output) + `\n[... ${raw.length - cursor} new bytes, showing tail ...]`;
  }
  try {
    writeFileSync(cursorPath(id), String(raw.length), "utf-8");
  } catch {}
  return { info: refreshState(id)!, output, truncated };
}

/** Final tail of a task (last N lines, cursor to end). For quiet waits. */
export function tailTask(id: string, tailLines = TAIL_LINES): TaskPoll {
  const info = refreshState(id);
  if (!info) throw new Error(`Unknown task "${id}".`);
  let raw: Buffer;
  try {
    raw = readFileSync(logPath(id)) as Buffer;
  } catch {
    raw = Buffer.alloc(0);
  }
  if (raw.length > LOG_CAP) raw = raw.subarray(raw.length - LOG_CAP);
  const text = raw.toString("utf-8").replace(/\uFFFD+$/, "");
  const lines = text.split("\n");
  const tail = lines.slice(-tailLines).join("\n").slice(-POLL_CAP);
  try {
    writeFileSync(cursorPath(id), String(raw.length), "utf-8");
  } catch {}
  return { info: refreshState(id)!, output: tail, truncated: lines.length > tailLines };
}

/** Block up to timeoutMs for fresh output or exit. Returns a poll.
 *  Settles briefly when the process just died so exitCode is populated.
 *  quiet=true: ignore intermediate output, return only the final tail. */
export async function waitTask(id: string, timeoutMs = 30000, tailLines = TAIL_LINES, quiet = false): Promise<TaskPoll> {
  const deadline = Date.now() + Math.max(1000, Math.min(300000, timeoutMs));
  if (quiet) {
    // One bill: say nothing until exit or deadline, then the tail.
    while (Date.now() < deadline) {
      const p = pollTask(id, tailLines);
      if (!p.info.running) return tailTask(id, tailLines);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return tailTask(id, tailLines);
  }
  // Fast path: already-new output or already dead. A 250ms grace lets a
  // just-finished process deliver SIGCHLD before we report it running.
  let first = pollTask(id, tailLines);
  if (first.info.running && first.output.length > 0) {
    await new Promise((r) => setTimeout(r, 250));
    const second = pollTask(id, tailLines);
    // Keep the first output (the re-poll only refreshes liveness); merge
    // anything newer the process wrote during the grace window.
    first = { ...second, output: first.output + second.output };
  }
  if (first.output.length > 0 || !first.info.running) return settleExit(id, first, tailLines);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const p = pollTask(id, tailLines);
    if (p.output.length > 0 || !p.info.running) return settleExit(id, p, tailLines);
  }
  return settleExit(id, pollTask(id, tailLines), tailLines);
}

/** If the process is dead but the exit event hasn't landed, wait up to 2s.
 *  Keeps the original output (settle polls consume nothing new). */
async function settleExit(id: string, p: TaskPoll, tailLines: number): Promise<TaskPoll> {
  if (p.info.running || p.info.exitCode !== null) return p;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const q = pollTask(id, tailLines);
    if (q.info.exitCode !== null || q.info.running) return { ...q, output: p.output || q.output };
  }
  return p;
}

/** SIGTERM, then SIGKILL after 3s. Returns final state. */
export async function stopTask(id: string): Promise<TaskInfo> {
  const info = refreshState(id);
  if (!info) throw new Error(`Unknown task "${id}".`);
  if (info.running && info.pid) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {}
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pidAlive(info.pid)) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (pidAlive(info.pid)) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {}
    }
  }
  const meta = readMeta(id) || {};
  meta.running = false;
  meta.ended = meta.ended || new Date().toISOString();
  try {
    writeMeta(id, meta);
  } catch {}
  return refreshState(id)!;
}

export function listTasks(): TaskInfo[] {
  let dirs: string[] = [];
  try {
    mkdirSync(tasksDir(), { recursive: true });
    dirs = readdirSync(tasksDir()).filter((d) => existsSync(metaPath(d)));
  } catch {
    return [];
  }
  return dirs.map((d) => refreshState(d)!).filter(Boolean).sort((a, b) => (a.started < b.started ? 1 : -1));
}

/** Forget a finished task (logs + meta). Refuses while running. */
export function clearTask(id: string): void {
  const info = refreshState(id);
  if (!info) throw new Error(`Unknown task "${id}".`);
  if (info.running) throw new Error(`Task "${id}" is still running — stop it first.`);
  rmSync(join(tasksDir(), id), { recursive: true, force: true });
}
