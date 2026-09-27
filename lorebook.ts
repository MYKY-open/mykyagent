/**
 * World Info / Lorebook with proactive keyword activation.
 *
 * Storage: ~/.config/mykyagent/lore/<slug>.json
 *   entries: [{ keys: string[], content: string, priority?: number }]
 *
 * Runtime: before each RP turn, the harness scans the user's prompt for entry
 * keys; matches are injected into an <active_lore> block in the system prompt
 * for that turn only. No tool calls, no narrative disruption.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LoreEntry {
  keys: string[];
  content: string;
  priority?: number;
}

interface LoreFile {
  entries: LoreEntry[];
}

const LORE_DIR = join(homedir(), ".config", "mykyagent", "lore");

function getLoreDir(): string {
  return process.env.MYKYAGENT_LORE_DIR || LORE_DIR;
}

export function slugifyLore(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "default";
}

export function saveLorebook(slug: string, entries: LoreEntry[]): { slug: string; path: string; count: number } {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");
  const clean = slugifyLore(slug);
  const norm = entries
    .filter((e) => e && typeof e.content === "string" && e.content.trim())
    .map((e) => ({
      keys: Array.isArray(e.keys) ? e.keys.map((k) => String(k).toLowerCase().trim()).filter(Boolean) : [],
      content: String(e.content).trim(),
      priority: typeof e.priority === "number" ? e.priority : 0,
    }))
    .filter((e) => e.keys.length > 0);
  const dir = getLoreDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${clean}.json`);
  writeFileSync(path, JSON.stringify({ entries: norm } satisfies LoreFile, null, 2), "utf-8");
  return { slug: clean, path, count: norm.length };
}

export function loadLorebook(slug: string): LoreEntry[] {
  const path = join(getLoreDir(), `${slugifyLore(slug)}.json`);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function listLorebooks(): { slug: string; entries: number }[] {
  const dir = getLoreDir();
  if (!existsSync(dir)) return [];
  const out: { slug: string; entries: number }[] = [];
  for (const e of readdirSync(dir)) {
    if (!e.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, e), "utf-8"));
      out.push({ slug: e.replace(/\.json$/, ""), entries: Array.isArray(parsed?.entries) ? parsed.entries.length : 0 });
    } catch {}
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Detect keyword overlaps across entries (same key in multiple entries). */
export function findTriggerOverlaps(entries: LoreEntry[]): string[] {
  const seen = new Map<string, number>();
  for (const e of entries) {
    for (const k of e.keys || []) {
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  return Array.from(seen.entries())
    .filter(([, n]) => n > 1)
    .map(([k, n]) => `"${k}" used by ${n} entries`);
}

export interface LoreMatch {
  entry: LoreEntry;
  matchedKey: string;
}

/**
 * Scan text for entry keys. Case-insensitive substring match on word-ish
 * boundaries for short keys, plain substring for multiword keys.
 */
export function scanLore(text: string, entries: LoreEntry[]): LoreMatch[] {
  if (!text || !entries.length) return [];
  const lower = text.toLowerCase();
  const matches: LoreMatch[] = [];
  for (const entry of entries) {
    for (const key of entry.keys || []) {
      if (!key) continue;
      if (key.includes(" ")) {
        if (lower.includes(key)) {
          matches.push({ entry, matchedKey: key });
          break;
        }
      } else {
        const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(text)) {
          matches.push({ entry, matchedKey: key });
          break;
        }
      }
    }
  }
  // Priority desc, then dedupe identical contents (same entry in two books).
  matches.sort((a, b) => (b.entry.priority || 0) - (a.entry.priority || 0));
  const seenContent = new Set<string>();
  const deduped: LoreMatch[] = [];
  for (const m of matches) {
    const sig = m.entry.content.trim().toLowerCase();
    if (seenContent.has(sig)) continue;
    seenContent.add(sig);
    deduped.push(m);
  }
  return deduped;
}

/** Render the <active_lore> block for the system prompt. Empty string if no matches. */
export function renderActiveLore(matches: LoreMatch[]): string {
  if (!matches.length) return "";
  const lines = matches.map((m) => `- (${m.matchedKey}) ${m.entry.content}`);
  return `<active_lore>\nBackground facts relevant to this scene (use naturally, do not dump verbatim):\n${lines.join("\n")}\n</active_lore>`;
}

/**
 * Collect matches for a turn. Sources: the global "default" book plus any
 * book referenced by the active character card.
 */
export function collectActiveLore(prompt: string, bookSlugs: string[]): { block: string; matches: LoreMatch[] } {
  const all = bookSlugs.flatMap((s) => loadLorebook(s));
  const matches = scanLore(prompt, all);
  return { block: renderActiveLore(matches), matches };
}
