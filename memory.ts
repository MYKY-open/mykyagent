/**
 * Persistent memory: one markdown file per topic, under a memory root.
 *
 * The design constraint is that memory must not grow the per-turn prompt cost.
 * So a topic has two parts:
 *
 *   - a one-line `summary`, which is the ONLY thing injected into the system
 *     prompt (see `memoryIndexBlock`) and is therefore hard-capped, single-line,
 *     and sanitised;
 *   - a `body`, which is never injected and is only loaded when the model calls
 *     `memory_read` for that topic.
 *
 * That keeps the prompt cost roughly constant whether there are 4 topics or 400,
 * and keeps model-authored prose out of the highest-trust region of the context
 * (a multi-line "summary" injected into a system prompt is a prompt-injection
 * write primitive).
 *
 * Everything here is plain fs + string work with no pi runtime dependency, so it
 * is unit-testable. Override the store location with MYKYAGENT_MEMORY_DIR.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_ROOT = join(homedir(), ".config", "mykyagent", "memory");

export const MEMORY_INDEX_MAX = Number(process.env.MYKYAGENT_MEMORY_INDEX_CHARS) || 1800;
export const MEMORY_BODY_MAX = Number(process.env.MYKYAGENT_MEMORY_BODY_CHARS) || 12000;
export const MEMORY_SUMMARY_MAX = 140;

export interface MemoryEntry {
  name: string;
  summary: string;
  updated: string;
  body: string;
  chars: number;
}

/** Resolved per call, not at import time, so tests and callers can redirect it. */
export function memoryRoot(): string {
  return process.env.MYKYAGENT_MEMORY_DIR || DEFAULT_ROOT;
}

/** Root-relative name of the pre-migration flat store. */
export function legacyMemoryFile(): string {
  return join(dirname(memoryRoot()), "memory.json");
}

/** Restrict to [a-z0-9_-] so the result can never escape the memory root. */
export function memorySlug(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}

export function memoryPath(name: string): string | null {
  const slug = memorySlug(name);
  return slug ? join(memoryRoot(), `${slug}.md`) : null;
}

/** Case- and separator-insensitive key, so "Proj Alpha" finds "proj_alpha". */
const loose = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Map a caller-supplied topic name onto the slug actually on disk. Exact match
 * wins; otherwise fall back to a loose comparison, because the model will
 * sometimes rephrase a topic it wrote earlier.
 */
export function resolveMemoryName(name: string): string | null {
  const exact = memorySlug(name);
  if (exact && existsSync(join(memoryRoot(), `${exact}.md`))) return exact;

  const want = loose(name);
  if (!want) return null;
  for (const e of listMemoryEntries()) {
    if (loose(e.name) === want) return e.name;
  }
  return null;
}

function ensureRoot(): void {
  const root = memoryRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

export function parseMemoryFile(name: string, raw: string): MemoryEntry {
  let summary = "";
  let updated = "";
  let body = raw;

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[1] === "summary") summary = kv[2].trim();
      else if (kv[1] === "updated") updated = kv[2].trim();
    }
  }
  body = body.trim();

  if (!summary) {
    // Hand-written files with no frontmatter still need an index entry.
    const firstLine = body.split(/\r?\n/)[0] || "";
    summary = (firstLine.split(/(?<=\.)\s/)[0] || firstLine).slice(0, MEMORY_SUMMARY_MAX).trim();
  }

  return { name, summary, updated, body, chars: body.length };
}

export function readMemoryEntry(name: string): MemoryEntry | null {
  const slug = resolveMemoryName(name);
  if (!slug) return null;
  try {
    return parseMemoryFile(slug, readFileSync(join(memoryRoot(), `${slug}.md`), "utf-8"));
  } catch {
    return null;
  }
}

export function listMemoryEntries(): MemoryEntry[] {
  ensureRoot();
  let files: string[] = [];
  try {
    files = readdirSync(memoryRoot()).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const f of files.sort()) {
    try {
      out.push(parseMemoryFile(f.replace(/\.md$/, ""), readFileSync(join(memoryRoot(), f), "utf-8")));
    } catch {}
  }
  return out;
}

export function writeMemoryEntry(name: string, summary: string, body: string): MemoryEntry {
  const slug = memorySlug(name);
  if (!slug) throw new Error("memory name needs at least one letter or digit");
  ensureRoot();

  // Collapse to a single line: this string is injected into the system prompt,
  // and a newline there would let stored text pose as extra instructions.
  const cleanSummary = (summary || "").replace(/\s+/g, " ").trim().slice(0, MEMORY_SUMMARY_MAX);
  const over = body.length > MEMORY_BODY_MAX;
  const cleanBody = over ? body.slice(0, MEMORY_BODY_MAX) : body;
  const updated = new Date().toISOString().slice(0, 10);

  const file =
    `---\nsummary: ${cleanSummary}\nupdated: ${updated}\n---\n\n` +
    cleanBody.trim() +
    (over ? `\n\n[... truncated at ${MEMORY_BODY_MAX} chars]` : "") +
    "\n";

  writeFileSync(join(memoryRoot(), `${slug}.md`), file, "utf-8");
  return {
    name: slug,
    summary: cleanSummary,
    updated,
    body: cleanBody.trim(),
    chars: cleanBody.trim().length,
  };
}

export function forgetMemoryEntry(name: string): boolean {
  const slug = resolveMemoryName(name);
  if (!slug) return false;
  try {
    unlinkSync(join(memoryRoot(), `${slug}.md`));
    return true;
  } catch {
    return false;
  }
}

/** One-time import of the old flat memory.json into per-topic files. */
export function migrateLegacyMemory(): number {
  const legacy = legacyMemoryFile();
  if (!existsSync(legacy)) return 0;

  let migrated = 0;
  try {
    const data = JSON.parse(readFileSync(legacy, "utf-8"));
    for (const [k, v] of Object.entries<string>(data)) {
      if (typeof v !== "string" || !v.trim()) continue;
      if (readMemoryEntry(k)) continue;
      const first = (v.trim().split(/(?<=\.)\s/)[0] || v).replace(/\s+/g, " ").trim();
      writeMemoryEntry(k, first, v);
      migrated++;
    }
    renameSync(legacy, `${legacy}.migrated`);
  } catch {
    // Leave the legacy file alone rather than half-migrating and losing data.
    return migrated;
  }
  return migrated;
}

/**
 * The ONLY memory text that reaches the system prompt: topic names plus
 * one-line summaries, capped at MEMORY_INDEX_MAX characters.
 */
export function memoryIndexBlock(): string {
  const entries = listMemoryEntries();
  if (entries.length === 0) return "";

  const lines: string[] = [];
  let used = 0;
  let hidden = 0;
  for (const e of entries) {
    const line = `- ${e.name}: ${e.summary || "(no summary)"}`;
    if (lines.length > 0 && used + line.length + 1 > MEMORY_INDEX_MAX) {
      hidden = entries.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  let block =
    "\n\n## Persistent Memory (index only - bodies are NOT loaded)\n" +
    "Call `memory_read` with the exact topic name when one becomes relevant. " +
    "Never assume you know the contents of a topic you have not read this session.\n" +
    lines.join("\n");

  if (hidden > 0) block += `\n(${hidden} further topic(s) not shown - use memory_list)`;
  return block;
}
