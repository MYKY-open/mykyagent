/**
 * Author's Note: a lightweight steering block injected near the bottom of the
 * context (RP mode) to direct pacing, tone, and plot without breaking
 * character. Managed via the /an command.
 *
 * Storage: ~/.config/mykyagent/authors_note.json  (env: MYKYAGENT_AN_FILE)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AuthorNoteConfig {
  text?: string;
  depth: number; // 1 = last turn; informational only in v1 (injected at prompt tail)
}

const AN_FILE = join(homedir(), ".config", "mykyagent", "authors_note.json");

function getAnFile(): string {
  return process.env.MYKYAGENT_AN_FILE || AN_FILE;
}

export function getAuthorNote(): AuthorNoteConfig {
  try {
    const file = getAnFile();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      return {
        text: typeof parsed?.text === "string" ? parsed.text : undefined,
        depth: typeof parsed?.depth === "number" && parsed.depth >= 1 ? Math.floor(parsed.depth) : 1,
      };
    }
  } catch {}
  return { depth: 1 };
}

export function setAuthorNote(text: string): void {
  const file = getAnFile();
  mkdirSync(dirname(file), { recursive: true });
  const cfg = getAuthorNote();
  cfg.text = text.trim();
  writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

export function setAuthorNoteDepth(depth: number): void {
  const file = getAnFile();
  mkdirSync(dirname(file), { recursive: true });
  const cfg = getAuthorNote();
  cfg.depth = Math.max(1, Math.floor(depth));
  writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

export function clearAuthorNote(): void {
  const cfg = getAuthorNote();
  const file = getAnFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ depth: cfg.depth }, null, 2), "utf-8");
}

/** Rendered [Author's Note: ...] block; empty string when unset/disabled. */
export function renderAuthorNoteBlock(): string {
  const cfg = getAuthorNote();
  if (!cfg.text) return "";
  return `[Author's Note (insert at depth ${cfg.depth}): ${cfg.text}]`;
}
