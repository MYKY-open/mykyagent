/**
 * Effort levels: how hard the agent works, separated from how it talks.
 *
 * Persona owns VOICE. Effort owns DEPTH. Mixing them was the bug: a terse
 * persona ("no fluff, code first") reads as "minimum code, stop early".
 *
 * Levels: low | high | max   (default: high)
 *   low  — smallest correct change, one command proves it.
 *   high — done-criteria up front, bugs reproduced before fixing, real output.
 *   max  — spec + architecture + tests + manual pass + polish + acceptance report.
 *
 * Per message: a leading "low:", "high:" or "max:" overrides the stored level
 * for that one turn. The stored level never changes, so nothing needs
 * switching before every start.
 *
 * Storage: ~/.config/mykyagent/effort.json  (env: MYKYAGENT_EFFORT_FILE)
 *
 * RP modes stay quiet unless the user explicitly stored a level or typed a
 * per-message prefix: storytelling prose should not carry a build pipeline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isFeatureEnabled } from "./toggles.ts";

const EFFORT_FILE = join(homedir(), ".config", "mykyagent", "effort.json");

function getEffortFile(): string {
  return process.env.MYKYAGENT_EFFORT_FILE || EFFORT_FILE;
}

export const EFFORT_LEVELS = ["low", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: EffortLevel = "high";

const RP_MODES = new Set(["rp", "rp-creator"]);

export const EFFORT_HELP: Record<EffortLevel, string> = {
  low: "Smallest correct change. No new tests. Use for typos, one-liners, throwaway probes.",
  high: "Done-criteria before code, bugs reproduced before fixing, real verification output, honest gap list. Use for features, bug hunts, game systems.",
  max: "Spec + architecture, tests, manual playthrough, polish pass, acceptance report. Use for new projects and anything you will actually ship.",
};

const BLOCKS: Record<EffortLevel, string> = {
  low:
    `Work standard (effort=low): smallest correct change. Plan line only if the task has more than one step. ` +
    `Run one command that exercises the change and paste its result line. Do not write new test files.`,
  high:
    `Work standard (effort=high):\n` +
    `- Before code: write the done-criteria — 3-6 checks the user could run. Post them.\n` +
    `- Bug report: reproduce the exact symptom the user described first (test, probe or command) and watch it fail. Fix it. Watch it pass. A symptom that comes back is a process failure, not bad luck.\n` +
    `- Load context before editing: grep/read the surrounding code, match existing patterns.\n` +
    `- Implement the entire done-list, not "it compiles". Skeleton with empty functions is NOT done.\n` +
    `- Prove it: run the build / entry point / test; paste the output line that shows it works.\n` +
    `- Read the request in context: "rename methodName to snake_case" means find it and change the code, not print the string back.\n` +
    `- Verify by adversarial probe, not by re-reading your own work: name 3 ways it could break, then actually try them.\n` +
    `- Self-review your own diff: pick the 2 weakest spots (error paths, state, edge cases) and fix or report them.\n` +
    `- End with one line per user ask: DONE with the command that proved it, or NOT DONE with what is missing. Never claim success without evidence.`,
  max:
    `Work standard (effort=max):\n` +
    `- Spec first: state assumptions and up to 3 open questions. For anything big, sketch the architecture (files, data, state) before writing.\n` +
    `- Build in slices, each one runnable — no big-bang dump at the end.\n` +
    `- Bug report: reproduce the exact symptom in a test or probe first, then fix.\n` +
    `- Write real tests for core logic and run them.\n` +
    `- Manual pass: start the thing and use it like a user would. For games, playable end-to-end beats more features.\n` +
    `- Polish pass: input handling, error states, edge cases, save/load integrity, obvious perf traps.\n` +
    `- Validate at boundaries (user input, external APIs). Do not guard impossible internal cases — that is bloat, not depth.\n` +
    `- Delete dead code outright: no compat shims, no renamed unused vars, no "// removed" tombstones.\n` +
    `- No command injection, SQL injection, or XSS; if you notice you wrote it, fix it before reporting.\n` +
    `- Reference code as file_path:line_number so the user can jump straight there.\n` +
    `- Final report: acceptance checklist with pass/fail evidence, known limitations, next steps.`,
};

function readStoredEffort(): EffortLevel | null {
  try {
    const file = getEffortFile();
    if (existsSync(file)) {
      const level = String(JSON.parse(readFileSync(file, "utf-8"))?.level || "").toLowerCase();
      if ((EFFORT_LEVELS as readonly string[]).includes(level)) return level as EffortLevel;
    }
  } catch {}
  return null;
}

/** Stored level, or the default. Stale values (auto/normal/off from older builds) read as the default. */
export function getEffort(): EffortLevel {
  return readStoredEffort() ?? DEFAULT_EFFORT;
}

/** True when the user stored a level themselves (not the default). */
export function isEffortExplicit(): boolean {
  return readStoredEffort() !== null;
}

export function setEffort(level: string): EffortLevel {
  const v = (level || "").trim().toLowerCase();
  if (!(EFFORT_LEVELS as readonly string[]).includes(v)) {
    throw new Error(`Unknown effort "${level}". Levels: ${EFFORT_LEVELS.join(" | ")}`);
  }
  const file = getEffortFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ level: v }, null, 2), "utf-8");
  return v as EffortLevel;
}

/** Card for `/effort` with no argument: every level, current marked. */
export function describeEffort(): string {
  const cur = getEffort();
  const lines = EFFORT_LEVELS.map((l) => `• ${l}${l === cur ? "  ← current" : ""}: ${EFFORT_HELP[l]}`);
  const header = `Effort: ${cur}${isEffortExplicit() ? "" : " (default)"}${isFeatureEnabled("effort") ? "" : " — feature disabled, see /mykyagent toggle effort"}`;
  return [header, ...lines, "Set with /effort <level>. Override one message by starting it with low: / high: / max:"].join("\n");
}

/** Leading `low:` / `high:` / `max:` on a user message, or null. */
export function parseEffortPrefix(prompt: string): EffortLevel | null {
  const m = /^\s*(low|high|max)\s*:/i.exec(prompt || "");
  return m ? (m[1].toLowerCase() as EffortLevel) : null;
}

/**
 * Level to inject for this turn, or null when nothing should be injected:
 * feature toggled off, or an RP mode without an explicit level.
 */
export function effortForTurn(opts: { prompt?: string; mode?: string }): EffortLevel | null {
  if (!isFeatureEnabled("effort")) return null;
  const typed = parseEffortPrefix(opts.prompt ?? "");
  if (typed) return typed;
  if (RP_MODES.has(opts.mode ?? "") && !isEffortExplicit()) return null;
  return getEffort();
}

export function renderEffortBlock(level: EffortLevel): string {
  return BLOCKS[level];
}
