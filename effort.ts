/**
 * Effort levels: how hard the agent works, separated from how it talks.
 *
 * Persona owns VOICE. Effort owns DEPTH. Mixing them was the bug: a terse
 * persona ("no fluff, code first") reads as "minimum code, stop early".
 *
 * Levels: low | high | max   (default: high)
 *   low  — smallest correct change, one command proves it.
 *   high — done-criteria up front, bugs reproduced before fixing, real output.
 *   max  — plan + architecture + tests + manual run + polish + acceptance report.
 *
 * No level is a per-turn ritual: every block scales the proof to the change. A
 * question must not grow a build pipeline just because the stored level is max;
 * max means "not shallow when the work is real", not "ceremony always".
 *
 * Per message: a leading "low:", "high:" or "max:" overrides the stored level
 * for that one turn. The stored level never changes, so nothing needs
 * switching before every start.
 *
 * Storage: ~/.config/mykyagent/effort.json  (env: MYKYAGENT_EFFORT_FILE)
 *
 * Effort is a coding work standard, not a prose one. It applies in code mode;
 * a plain rp scene has its own prompt and never carries it, and rp-creator
 * (Story Studio) takes it only from a per-message `low:` / `high:` / `max:`
 * prefix. An explicit ask beats any default; a stored level is code-only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isFeatureEnabled } from "./toggles.ts";

const EFFORT_FILE = join(homedir(), ".config", "mykyagent", "effort.json");

export function getEffortFile(): string {
  return process.env.MYKYAGENT_EFFORT_FILE || EFFORT_FILE;
}

export const EFFORT_LEVELS = ["low", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: EffortLevel = "high";

export const EFFORT_HELP: Record<EffortLevel, string> = {
  low: "Smallest correct change, one proving command. Typos, one-liners, throwaway probes.",
  high: "Real output for anything you claim; a reported bug is reproduced before it is fixed.",
  max: "Plan, tests, manual run, polish, acceptance report. New projects you will ship.",
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
    `- Verify with output, not by re-reading your own diff. Scale the proof to the change: a one-line fix needs one command that would fail if you are wrong, not a test suite; a risky or stateful change gets the 1-2 probes that would actually catch it.\n` +
    `- Self-review your own diff: pick the 2 weakest spots (error paths, state, edge cases) and fix or report them.\n` +
    `- End with one line per user ask: DONE with the command that proved it, or NOT DONE with what is missing. Never claim success without evidence.`,
  max:
    `Work standard (effort=max):\n` +
    `- Size the ceremony to the change: question or explanation -> just answer it; one-line or targeted fix -> make it and run one command that proves it; feature, bug hunt, multi-file or stateful change -> the full standard below. Depth is judgment, not ritual.\n` +
    `- Plan first: state assumptions and up to 3 open questions. For anything big, sketch the architecture (files, data, state) before writing.\n` +
    `- Build in slices, each one runnable — no big-bang dump at the end.\n` +
    `- Bug report: reproduce the exact symptom in a test or probe first, then fix.\n` +
    `- Write real tests for core logic and run them.\n` +
    `- Manual pass: start the thing and use it like a user would. For games, playable end-to-end beats more features.\n` +
    `- Polish pass: input handling, error states, edge cases, save/load integrity, obvious perf traps.\n` +
    `- Validate at boundaries (user input, external APIs). Do not guard impossible internal cases — that is bloat, not depth.\n` +
    `- Delete dead code outright: no compat shims, no renamed unused vars, no "// removed" tombstones.\n` +
    `- No command injection, SQL injection, or XSS; if you notice you wrote it, fix it before reporting.\n` +
    `- Do not re-verify what you did not touch: the proof covers the change, not the whole repo.\n` +
    `- Reference code as file_path:line_number so the user can jump straight there.\n` +
    `- Final report: for a feature or a build, an acceptance checklist with pass/fail evidence, known limitations, next steps; for a small fix, one line with the command that proved it.`,
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
  const header = `Effort: ${cur}${isEffortExplicit() ? "" : " (default)"}${isFeatureEnabled("effort") ? "" : " — feature OFF, /effort <level> turns it on"}`;
  return [header, ...lines, "Set with /effort <level>, or prefix one message: low: / high: / max:. Code mode only."].join("\n");
}

/** Leading `low:` / `high:` / `max:` on a user message, or null. */
export function parseEffortPrefix(prompt: string): EffortLevel | null {
  const m = /^\s*(low|high|max)\s*:/i.exec(prompt || "");
  return m ? (m[1].toLowerCase() as EffortLevel) : null;
}

/**
 * Level to inject for this turn, or null when nothing should be injected.
 *
 * Effort is a coding work standard: it belongs to code mode. Story modes talk
 * about characters and scenes, not builds, so they get it only from an explicit
 * per-message prefix (rp-creator); a plain rp scene has its own prompt and
 * never reaches the block at all.
 */
export function effortForTurn(opts: { prompt?: string; mode?: string }): EffortLevel | null {
  if (!isFeatureEnabled("effort")) return null;
  const typed = parseEffortPrefix(opts.prompt ?? "");
  if (typed) return typed;
  if (opts.mode === "rp" || opts.mode === "rp-creator") return null;
  return getEffort();
}

export function renderEffortBlock(level: EffortLevel): string {
  return BLOCKS[level];
}
