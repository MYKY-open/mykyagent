/**
 * Session brief: the user's own words about what this session is.
 *
 * Replaces the old "conversation tints" tag list. "noir, terse" made the model
 * guess what those words meant; one sentence it can read ("porting the A155F
 * patch, C only, no hand-holding") costs the same tokens and leaves nothing to
 * interpret. It is context for code mode and RP alike — never a rule that
 * overrides the current message, the character, or the persona.
 *
 * Store: ~/.config/mykyagent/brief.json  (env: MYKYAGENT_BRIEF_FILE)
 *   { "text": "..." }
 *
 * Pi-free (fs only).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BRIEF_FILE = join(homedir(), ".config", "mykyagent", "brief.json");

/** Chars rendered into the prompt. Longer briefs are clipped, not rejected. */
export const BRIEF_MAX = 600;
/** Chars kept on disk, so a pasted paragraph is not lost to a typo. */
export const BRIEF_STORE_MAX = 2000;

export function briefFile(): string {
  return process.env.MYKYAGENT_BRIEF_FILE || BRIEF_FILE;
}

export function getBrief(): string {
  try {
    const file = briefFile();
    if (!existsSync(file)) return "";
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return typeof parsed?.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

/** Store a brief. Empty throws — use clearBrief() for that. */
export function setBrief(text: string): string {
  const clean = (text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, BRIEF_STORE_MAX);
  if (!clean) throw new Error("Session brief is empty. Use /brief clear to remove it.");
  const file = briefFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ text: clean }, null, 2) + "\n", "utf-8");
  return clean;
}

export function clearBrief(): void {
  const file = briefFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ text: "" }, null, 2) + "\n", "utf-8");
}

/** Prompt block, clipped. "" when there is no brief (zero tax). */
export function renderBriefBlock(): string {
  const text = getBrief();
  if (!text) return "";
  const body = text.length > BRIEF_MAX ? text.slice(0, BRIEF_MAX).trimEnd() + "…" : text;
  return (
    "## Session brief (what this session is about)\n" +
    "The user wrote this to frame the session. Follow it where it applies; the current message, " +
    "the character and the persona still win on conflict.\n" +
    body
  );
}

/** Card for bare /brief. */
export function describeBrief(): string {
  const text = getBrief();
  if (!text) {
    return [
      "No session brief.",
      "Set one with /brief <text> — what this session is about, in your own words.",
      "  /brief porting the A155F kernel patch, C only, skip the hand-holding",
      "  /brief slow-burn harbour heist, Vex POV, keep replies short",
      "It lands in the prompt in code and RP alike (toggle: /mykyagent toggle brief).",
    ].join("\n");
  }
  return [text, "", "/brief <new text> replaces it · /brief clear removes it"].join("\n");
}
