/**
 * Conversation tints: lightweight additive style tags ("noir", "cozy",
 * "terse", "poetic", ...) that color wording without replacing the
 * persona (code mode) or the character card (rp mode).
 *
 * Storage: ~/.config/mykyagent/tags.json  (env: MYKYAGENT_TAGS_FILE)
 *   { "tags": ["noir", "terse"] }
 *
 * Rules: freeform strings, normalized to lowercase; max 10 tags, each max
 * 24 chars, total prompt line capped. Empty = no tint (zero prompt tax).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TAGS_MAX = 10;
export const TAG_MAX_CHARS = 24;

const TAGS_FILE = join(homedir(), ".config", "mykyagent", "tags.json");

function getTagsFile(): string {
  return process.env.MYKYAGENT_TAGS_FILE || TAGS_FILE;
}

export function normalizeTag(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_ ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TAG_MAX_CHARS)
    .trim();
}

export function getTags(): string[] {
  try {
    const file = getTagsFile();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      const arr = Array.isArray(parsed?.tags) ? parsed.tags : [];
      const out: string[] = [];
      for (const t of arr) {
        const n = normalizeTag(String(t));
        if (n && !out.includes(n)) out.push(n);
        if (out.length >= TAGS_MAX) break;
      }
      return out;
    }
  } catch {}
  return [];
}

function writeTags(tags: string[]): string[] {
  const clean: string[] = [];
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n && !clean.includes(n)) clean.push(n);
    if (clean.length >= TAGS_MAX) break;
  }
  const file = getTagsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ tags: clean }, null, 2), "utf-8");
  return clean;
}

export function setTags(tags: string[]): string[] {
  return writeTags(tags);
}

export function addTags(tags: string[]): { tags: string[]; added: string[] } {
  const cur = getTags();
  const added: string[] = [];
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n && !cur.includes(n) && cur.length < TAGS_MAX) {
      cur.push(n);
      added.push(n);
    }
  }
  return { tags: writeTags(cur), added };
}

export function removeTags(tags: string[]): { tags: string[]; removed: string[] } {
  const drop = new Set(tags.map(normalizeTag).filter(Boolean));
  const cur = getTags();
  const kept = cur.filter((t) => !drop.has(t));
  const removed = cur.filter((t) => drop.has(t));
  return { tags: writeTags(kept), removed };
}

export function clearTags(): void {
  writeTags([]);
}

/**
 * One-line prompt tint. Empty string when no tags (zero tax when unused).
 * Worded as *flavor*, explicitly subordinate to character/persona/task rules
 * so a tint like "noir" can never justify breaking RP rules or task output.
 */
export function renderTagsBlock(): string {
  const tags = getTags();
  if (!tags.length) return "";
  return `Active conversation tints (subtle flavor only — never override character voice, persona, or task rules): ${tags.join(", ")}.`;
}
