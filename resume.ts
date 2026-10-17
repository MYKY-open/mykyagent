/**
 * Resume: continuity without replay.
 *
 * - `summarize` tool (model-facing): user says "summarize", model writes the
 *   summary text here. Bounded 6KB.
 * - session_shutdown hook: auto-writes a machine stub (date, cwd, open-todo
 *   count, checkpoint count) to auto_state.md — never touches the summary.
 * - /restore command: summary + stub + open todos, injected via
 *   pi.sendUserMessage so the model actually receives it.
 *
 * Pi-free except the todo/checkpoint imports for the stub.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openTodos } from "./todo.ts";
import { listCheckpoints } from "./checkpoints.ts";
import { loadModeConfig } from "./mode.ts";

const SUMMARY_MAX = 6 * 1024;

export function sessionFile(): string {
  return process.env.MYKYAGENT_SESSION_FILE || join(homedir(), ".config", "mykyagent", "last_session.md");
}

function autoFile(): string {
  return join(dirname(sessionFile()), "auto_state.md");
}

function autoJsonFile(): string {
  return join(dirname(sessionFile()), "auto_state.json");
}

export interface AutoState {
  date: string;
  cwd: string;
  mode?: string;
  activeCharacter?: string;
  lorebook?: string;
  openTodos: { id: number; text: string }[];
  checkpoints: number;
}

/** Structured machine state (mode + character), for /restore to re-apply. */
export function loadAutoState(): AutoState | null {
  try {
    if (!existsSync(autoJsonFile())) return null;
    const parsed = JSON.parse(readFileSync(autoJsonFile(), "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      date: typeof parsed.date === "string" ? parsed.date : "",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      mode: typeof parsed.mode === "string" ? parsed.mode : undefined,
      activeCharacter: typeof parsed.activeCharacter === "string" ? parsed.activeCharacter : undefined,
      lorebook: typeof parsed.lorebook === "string" ? parsed.lorebook : undefined,
      openTodos: Array.isArray(parsed.openTodos) ? parsed.openTodos : [],
      checkpoints: typeof parsed.checkpoints === "number" ? parsed.checkpoints : 0,
    };
  } catch {
    return null;
  }
}

export function saveSummary(text: string): number {
  const clean = text.trim().slice(0, SUMMARY_MAX);
  if (!clean) throw new Error("Summary text is empty.");
  const file = sessionFile();
  mkdirSync(dirname(file), { recursive: true });
  const stamped = `# Last session (${new Date().toISOString().slice(0, 10)})\n\n${clean}\n`;
  writeFileSync(file, stamped, "utf-8");
  return clean.length;
}

export function loadSummary(): string | null {
  try {
    if (!existsSync(sessionFile())) return null;
    return readFileSync(sessionFile(), "utf-8");
  } catch {
    return null;
  }
}

/** Machine stub on shutdown: structured JSON (for /restore) plus the legacy
 * human-readable .md (kept for old readers and eyeballs). Never clobbers
 * the summary. */
export function saveAutoStub(cwd: string): void {
  try {
    const todos = openTodos();
    const ckpts = listCheckpoints().length;
    const cfg = loadModeConfig();
    const state: AutoState = {
      date: new Date().toISOString(),
      cwd,
      mode: cfg.mode,
      activeCharacter: cfg.activeCharacter,
      lorebook: cfg.lorebook,
      openTodos: todos.map((t) => ({ id: t.id, text: t.text })).slice(0, 20),
      checkpoints: ckpts,
    };
    const file = autoJsonFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    const stub =
      `# Auto state (${new Date().toISOString()})\n` +
      `cwd: ${cwd}\n` +
      `open todos: ${todos.length}${todos.length ? " — " + todos.map((t) => `${t.id}. ${t.text}`).join("; ").slice(0, 400) : ""}\n` +
      `checkpoints: ${ckpts}\n`;
    const mdFile = autoFile();
    mkdirSync(dirname(mdFile), { recursive: true });
    writeFileSync(mdFile, stub, "utf-8");
  } catch {}
}

/** Full restore text, or null when there is nothing to restore. */
export function buildResumeText(): string | null {
  const parts: string[] = [];
  const summary = loadSummary();
  if (summary) parts.push(summary.trim());
  const st = loadAutoState();
  if (st?.mode) {
    parts.push(
      `[last session state: mode=${st.mode}${st.activeCharacter ? `, character=${st.activeCharacter}` : ""}${st.lorebook ? `, lorebook=${st.lorebook}` : ""}]`
    );
  }
  try {
    if (existsSync(autoFile())) parts.push(readFileSync(autoFile(), "utf-8").trim());
  } catch {}
  if (parts.length === 0) return null;
  return `[restored previous session — continue from here]\n\n${parts.join("\n\n")}`;
}
