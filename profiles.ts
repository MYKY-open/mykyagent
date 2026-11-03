/**
 * Profiles: named snapshots of the settings you keep flipping.
 *
 * A profile stores the raw JSON of the live stores — effort, toggles, persona,
 * style dials, tags — so switching one writes those files and every module
 * picks the change up on its next read. No other module knows profiles exist.
 *
 *   ~/.config/mykyagent/profiles/<slug>/profile.json   (env MYKYAGENT_PROFILES_DIR)
 *   ~/.config/mykyagent/profile.json                   (env MYKYAGENT_PROFILE_FILE) {active: slug}
 *
 * Rules:
 * - The name is free text (spaces fine); the slug is the directory. Two names
 *   that slugify the same are the same profile.
 * - Switching saves the outgoing profile first, so tweaks made while it was
 *   active are not lost.
 * - profile.json is user-editable, so every section is validated before it
 *   lands in a live store: one bad section fails the whole apply instead of
 *   half-writing a mixed configuration.
 * - A snapshot always stores all five sections. A store that does not exist
 *   yet is captured as empty, so switching restores the saved state instead of
 *   blending it with whatever was live.
 * - mode, active character and user name are session state in mode.json, not
 *   profile state. A profile never switches who you are playing.
 *
 * Pi-free (fs only).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EFFORT_LEVELS, getEffortFile } from "./effort.ts";
import { getStyleFile } from "./style.ts";
import { getTagsFile } from "./tags.ts";
import { getTogglesFile } from "./toggles.ts";

const HOME_DIR = join(homedir(), ".config", "mykyagent");
const PERSONA_FILE = join(HOME_DIR, "persona.json");
const PROFILES_DIR = join(HOME_DIR, "profiles");
const ACTIVE_FILE = join(HOME_DIR, "profile.json");

export const PROFILE_NAME_MAX = 40;
const PROFILE_MAX = 50;

/** Section ids, in the order they are written. Unknown ids in a profile file are ignored. */
export const PROFILE_SECTIONS = ["effort", "persona", "style", "tags", "toggles"] as const;
export type ProfileSectionId = (typeof PROFILE_SECTIONS)[number];

let personaFileOverride: (() => string) | null = null;

/** index.ts owns persona.json (it predates this module); hand the getter over once. */
export function configureProfiles(opts: { personaFile?: () => string }): void {
  if (opts.personaFile) personaFileOverride = opts.personaFile;
}

function profilesDir(): string {
  return process.env.MYKYAGENT_PROFILES_DIR || PROFILES_DIR;
}

function activeFile(): string {
  return process.env.MYKYAGENT_PROFILE_FILE || ACTIVE_FILE;
}

function personaFile(): string {
  if (personaFileOverride) return personaFileOverride();
  return process.env.MYKYAGENT_PERSONA_FILE || PERSONA_FILE;
}

function sectionFile(id: ProfileSectionId): string {
  switch (id) {
    case "effort":
      return getEffortFile();
    case "toggles":
      return getTogglesFile();
    case "persona":
      return personaFile();
    case "style":
      return getStyleFile();
    case "tags":
      return getTagsFile();
  }
}

export interface ProfileMeta {
  name: string;
  slug: string;
  created: string;
  updated: string;
  sections: string[];
  /** effort level captured in the profile, when it has one. */
  effort: string | null;
}

interface ProfileFile {
  name: string;
  slug: string;
  created: string;
  updated: string;
  settings: Record<string, unknown>;
}

// --- names ------------------------------------------------------------------

/** Filesystem-safe directory name. Same slug = same profile. */
export function slugifyProfileName(name: string): string {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROFILE_NAME_MAX);
}

function cleanName(name: string): string {
  const raw = (name || "").replace(/\s+/g, " ").trim();
  if (!raw) throw new Error("Profile name must not be empty.");
  if (raw.length > PROFILE_NAME_MAX) throw new Error(`Profile name is longer than ${PROFILE_NAME_MAX} characters.`);
  if (!slugifyProfileName(raw)) throw new Error(`Profile name "${raw}" has no letters or digits — pick another.`);
  return raw;
}

// --- json helpers -----------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(file: string): unknown | undefined {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Write to a sibling temp file; returns it for a later commit. */
function stageJson(file: string, value: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  return tmp;
}

/** Temp file + rename: a killed switch must not leave a half-written config. */
function writeJsonAtomic(file: string, value: unknown): void {
  renameSync(stageJson(file, value), file);
}

// --- active profile ---------------------------------------------------------

export function getActiveProfile(): string | null {
  const parsed = readJson(activeFile());
  const slug = isPlainObject(parsed) ? String(parsed.active || "").trim() : "";
  if (!slug) return null;
  return existsSync(profileFile(slug)) ? slug : null;
}

function setActive(slug: string | null): void {
  writeJsonAtomic(activeFile(), { active: slug });
}

// --- read / list ------------------------------------------------------------

function profileFile(slug: string): string {
  return join(profilesDir(), slug, "profile.json");
}

function readProfile(slug: string): ProfileFile | null {
  const parsed = readJson(profileFile(slug));
  if (!isPlainObject(parsed) || !isPlainObject(parsed.settings)) return null;
  const sections = PROFILE_SECTIONS.filter((id) => isPlainObject(parsed.settings[id]));
  return {
    name: String(parsed.name || slug),
    slug,
    created: String(parsed.created || ""),
    updated: String(parsed.updated || ""),
    settings: parsed.settings,
  };
}

/** Resolve a user-typed name to a slug: exact slug, then slugified, then display name. */
export function resolveProfileSlug(name: string): string | null {
  const wanted = (name || "").trim();
  if (!wanted) return null;
  const bySlug = slugifyProfileName(wanted);
  if (bySlug && existsSync(profileFile(bySlug))) return bySlug;
  for (const p of listProfiles()) {
    if (p.name.toLowerCase() === wanted.toLowerCase()) return p.slug;
  }
  return null;
}

export function listProfiles(): ProfileMeta[] {
  let dirents: string[] = [];
  try {
    dirents = readdirSync(profilesDir());
  } catch {
    return [];
  }
  const out: ProfileMeta[] = [];
  for (const slug of dirents) {
    if (slug.startsWith(".")) continue;
    let isDir = false;
    try {
      isDir = statSync(join(profilesDir(), slug)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const p = readProfile(slug);
    if (!p) continue;
    const effort = isPlainObject(p.settings.effort) ? String(p.settings.effort.level || "") : "";
    out.push({
      name: p.name,
      slug: p.slug,
      created: p.created,
      updated: p.updated,
      sections: PROFILE_SECTIONS.filter((id) => isPlainObject(p.settings[id])),
      effort: effort || null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// --- validation -------------------------------------------------------------

/**
 * A profile file is user-editable, so nothing in it is trusted. Returns the
 * list of problems; apply refuses when it is not empty.
 */
export function validateProfileSettings(settings: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!isPlainObject(settings)) return ["settings must be an object"];

  for (const id of PROFILE_SECTIONS) {
    if (!(id in settings)) continue;
    const section = settings[id];
    if (!isPlainObject(section)) {
      problems.push(`${id}: must be an object`);
      continue;
    }
    if (id === "effort" && "level" in section) {
      const level = String(section.level);
      if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
        problems.push(`effort: unknown level "${level}" (low | high | max)`);
      }
    }
    if (id === "toggles") {
      for (const key of ["tools", "skills", "features"]) {
        if (key in section && !isPlainObject(section[key])) problems.push(`toggles.${key}: must be an object`);
      }
    }
    if (id === "persona") {
      if ("current" in section && typeof section.current !== "string") problems.push("persona.current: must be a string");
      if ("customPrompt" in section && typeof section.customPrompt !== "string") problems.push("persona.customPrompt: must be a string");
    }
    if (id === "style") {
      for (const [k, v] of Object.entries(section)) {
        if (typeof v !== "string") problems.push(`style.${k}: must be a string`);
      }
    }
    if (id === "tags") {
      const tags = isPlainObject(section) ? section.tags : undefined;
      if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) {
        problems.push("tags.tags: must be an array of strings");
      }
    }
  }
  return problems;
}

// --- write ------------------------------------------------------------------

/** Read every live store into a settings object. Missing/corrupt = empty section. */
export function snapshotSettings(): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const id of PROFILE_SECTIONS) {
    const value = readJson(sectionFile(id));
    settings[id] = isPlainObject(value) ? value : {};
  }
  return settings;
}

function writeProfileFile(slug: string, name: string, settings: Record<string, unknown>): ProfileMeta {
  const now = new Date().toISOString();
  const prev = readProfile(slug);
  const cleanSettings: Record<string, unknown> = {};
  for (const id of PROFILE_SECTIONS) {
    if (isPlainObject(settings[id])) cleanSettings[id] = settings[id];
  }
  writeJsonAtomic(profileFile(slug), {
    name,
    slug,
    created: prev?.created || now,
    updated: now,
    settings: cleanSettings,
  });
  const effort = isPlainObject(cleanSettings.effort) ? String(cleanSettings.effort.level || "") : "";
  return {
    name,
    slug,
    created: prev?.created || now,
    updated: now,
    sections: PROFILE_SECTIONS.filter((id) => isPlainObject(cleanSettings[id])),
    effort: effort || null,
  };
}

export interface CreateOptions {
  /** Switch to the new profile after saving it. Default: true. */
  activate?: boolean;
}

/** Save the current live settings as a new profile. */
export function createProfile(name: string, opts: CreateOptions = {}): ProfileMeta {
  const clean = cleanName(name);
  const slug = slugifyProfileName(clean);
  if (existsSync(profileFile(slug))) {
    throw new Error(`Profile "${clean}" already exists — /profile save ${clean} updates it.`);
  }
  if (listProfiles().length >= PROFILE_MAX) throw new Error(`Profile limit (${PROFILE_MAX}) reached — /profile delete one first.`);
  const meta = writeProfileFile(slug, clean, snapshotSettings());
  if (opts.activate !== false) setActive(slug);
  return meta;
}

/** Overwrite a profile (default: the active one) with the current live settings. */
export function saveProfile(name?: string): ProfileMeta {
  const slug = name ? resolveProfileSlug(name) : getActiveProfile();
  if (!slug) {
    const known = listProfiles().map((p) => p.name);
    throw new Error(
      name
        ? `No profile named "${name}".${known.length ? ` Saved: ${known.join(", ")}` : ""}`
        : `No active profile — /profile use <name> switches${known.length ? ` (saved: ${known.join(", ")})` : ", /profile new <name> creates one from the current settings"}.`
    );
  }
  const existing = readProfile(slug);
  if (!existing) throw new Error(`Profile "${name || slug}" is unreadable — delete it and save again.`);
  const meta = writeProfileFile(slug, existing.name, snapshotSettings());
  setActive(slug);
  return meta;
}

export interface ApplyResult {
  applied: ProfileMeta;
  /** Name of the profile that was saved before switching, if any. */
  saved: string | null;
}

/** Switch to a profile: save the outgoing one, then write its settings into the live stores. */
export function applyProfile(name: string): ApplyResult {
  const slug = resolveProfileSlug(name);
  if (!slug) {
    const known = listProfiles().map((p) => p.name);
    throw new Error(`No profile named "${name}".${known.length ? ` Saved: ${known.join(", ")}` : " No profiles yet — /profile new <name>."}`);
  }
  const profile = readProfile(slug);
  if (!profile) throw new Error(`Profile "${slug}" is unreadable — delete it and save again.`);

  // Validate everything before touching a single live file.
  const problems = validateProfileSettings(profile.settings);
  if (problems.length) {
    throw new Error(`Profile "${profile.name}" is invalid — nothing applied:\n- ${problems.join("\n- ")}`);
  }

  let saved: string | null = null;
  const activeSlug = getActiveProfile();
  if (activeSlug && activeSlug !== slug) {
    const outgoing = readProfile(activeSlug);
    if (outgoing) {
      writeProfileFile(activeSlug, outgoing.name, snapshotSettings());
      saved = outgoing.name;
    }
  }

  // Two-phase: stage every live file first, then rename them into place. A
  // failure while staging removes the temps and leaves the live config as it
  // was, instead of applying half a profile.
  const staged: { tmp: string; file: string }[] = [];
  try {
    for (const id of PROFILE_SECTIONS) {
      const section = profile.settings[id];
      if (!isPlainObject(section)) continue;
      const file = sectionFile(id);
      staged.push({ tmp: stageJson(file, section), file });
    }
  } catch (err) {
    for (const s of staged) {
      try {
        rmSync(s.tmp, { force: true });
      } catch {}
    }
    throw err;
  }
  for (const s of staged) renameSync(s.tmp, s.file);
  setActive(slug);
  return { applied: profileMeta(profile), saved };
}

function profileMeta(p: ProfileFile): ProfileMeta {
  const effort = isPlainObject(p.settings.effort) ? String(p.settings.effort.level || "") : "";
  return {
    name: p.name,
    slug: p.slug,
    created: p.created,
    updated: p.updated,
    sections: PROFILE_SECTIONS.filter((id) => isPlainObject(p.settings[id])),
    effort: effort || null,
  };
}

export function deleteProfile(name: string): ProfileMeta {
  const slug = resolveProfileSlug(name);
  if (!slug) throw new Error(`No profile named "${name}".`);
  const profile = readProfile(slug);
  const meta = profile ? profileMeta(profile) : { name: name.trim(), slug, created: "", updated: "", sections: [], effort: null };
  const wasActive = activeSlugRaw() === slug;
  rmSync(join(profilesDir(), slug), { recursive: true, force: true });
  if (wasActive) setActive(null);
  return meta;
}

/** Raw active slug even when its directory is already gone. */
function activeSlugRaw(): string | null {
  const parsed = readJson(activeFile());
  const slug = isPlainObject(parsed) ? String(parsed.active || "").trim() : "";
  return slug || null;
}

export function renameProfile(from: string, to: string): ProfileMeta {
  const slug = resolveProfileSlug(from);
  if (!slug) throw new Error(`No profile named "${from}".`);
  const existing = readProfile(slug);
  if (!existing) throw new Error(`Profile "${from}" is unreadable — delete it and save again.`);
  const clean = cleanName(to);
  const nextSlug = slugifyProfileName(clean);
  if (nextSlug === slug) {
    const meta = writeProfileFile(slug, clean, existing.settings);
    return meta;
  }
  if (existsSync(profileFile(nextSlug))) throw new Error(`Profile "${clean}" already exists.`);
  mkdirSync(profilesDir(), { recursive: true });
  renameSync(join(profilesDir(), slug), join(profilesDir(), nextSlug));
  const meta = writeProfileFile(nextSlug, clean, existing.settings);
  if (activeSlugRaw() === slug) setActive(nextSlug);
  return meta;
}

// --- card -------------------------------------------------------------------

export function describeProfiles(): string {
  const profiles = listProfiles();
  const active = getActiveProfile();
  if (profiles.length === 0) {
    return [
      "Profiles: none yet.",
      "A profile saves the settings you keep flipping — persona, effort, style, tags, toggles — under one name.",
      "/profile new <name> snapshots the current settings and switches to it.",
    ].join("\n");
  }
  const lines = profiles.map((p) => {
    const bits = [`${p.sections.length} sections`];
    if (p.effort) bits.push(`effort ${p.effort}`);
    const stamp = p.updated ? ` · updated ${p.updated.slice(0, 10)}` : "";
    return `  ${p.slug === active ? "●" : "○"} ${p.name} — ${bits.join(" · ")}${stamp}`;
  });
  return [
    `Profiles: ${profiles.length} saved${active ? ` · active: ${profiles.find((p) => p.slug === active)?.name || active}` : " · none active"}`,
    ...lines,
    "/profile new <name> | use <name> | save [name] | delete <name> | rename <old> <new>",
  ].join("\n");
}

/** One-line badge for the /mykyagent board. */
export function profileBadge(): string {
  const active = getActiveProfile();
  const count = listProfiles().length;
  if (!count) return "no profiles (/profile new <name>)";
  if (!active) return `${count} saved, none active (/profile use <name>)`;
  const meta = listProfiles().find((p) => p.slug === active);
  return `${meta?.name || active} active · ${count} saved`;
}
