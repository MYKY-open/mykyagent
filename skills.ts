/**
 * Skills-lite: on-demand capability packs, zero per-turn tax.
 *
 * A skill is `skills/<name>.md` or `skills/<name>/SKILL.md` (first `#`
 * heading or first non-empty line = one-line description). The system prompt
 * carries ONE line listing names; the model pulls full text via skill_read
 * only when relevant. Nothing is injected eagerly, unlike pi's skill blocks.
 *
 * Pi-free (fs only). Dirs: <repo>/skills, ~/.config/mykyagent/skills,
 * plus MYKYAGENT_SKILLS_DIR (extra dir, prepended).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

const SKILL_BODY_MAX = 12 * 1024;

function repoSkillsDir(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "skills");
  } catch {
    return join(process.cwd(), "skills");
  }
}

export function skillsDirs(): string[] {
  const dirs = [repoSkillsDir(), join(homedir(), ".config", "mykyagent", "skills")];
  const extra = process.env.MYKYAGENT_SKILLS_DIR;
  if (extra && extra.trim()) dirs.unshift(extra.trim());
  return dirs;
}

function describeSkill(text: string, fallback: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^#+\s*/, "");
    if (!line) continue;
    if (/^(skill|name)\s*:/i.test(line)) continue;
    return line.slice(0, 120);
  }
  return fallback;
}

export function listSkills(): SkillInfo[] {
  const out = new Map<string, SkillInfo>();
  for (const dir of skillsDirs()) {
    let names: { name: string; isDir: boolean }[] = [];
    try {
      const dirents = readdirSync(dir, { withFileTypes: true });
      names = dirents
        .filter((d) => !d.name.startsWith("."))
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      continue;
    }
    for (const { name, isDir } of names) {
      if (isDir) {
        const p = join(dir, name, "SKILL.md");
        if (!existsSync(p)) continue;
        if (out.has(name)) continue;
        try {
          out.set(name, { name, description: describeSkill(readFileSync(p, "utf-8"), name), path: p });
        } catch {}
      } else if (name.endsWith(".md")) {
        const skillName = name.slice(0, -3);
        if (out.has(skillName)) continue;
        const p = join(dir, name);
        try {
          out.set(skillName, { name: skillName, description: describeSkill(readFileSync(p, "utf-8"), skillName), path: p });
        } catch {}
      }
    }
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Full skill text (capped), or null when unknown. */
export function readSkill(name: string): string | null {
  const slug = name.trim().toLowerCase();
  for (const s of listSkills()) {
    if (s.name.toLowerCase() === slug) {
      try {
        const raw = readFileSync(s.path, "utf-8");
        if (Buffer.byteLength(raw, "utf-8") > SKILL_BODY_MAX) {
          return Buffer.from(raw, "utf-8").subarray(0, SKILL_BODY_MAX).toString("utf-8") + "\n\n[... skill truncated at 12KB ...]";
        }
        return raw;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** One prompt line, or "" when no skills exist (zero tax). */
export function skillsPromptLine(): string {
  const skills = listSkills();
  if (skills.length === 0) return "";
  return `Skills on disk: ${skills.map((s) => s.name).join(", ")} — read any via skill_read when the task matches.`;
}

export function ensureSkillsDirs(): void {
  for (const dir of skillsDirs()) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }
}
