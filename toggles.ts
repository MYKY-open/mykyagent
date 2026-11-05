import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MEMORY_DIR = join(homedir(), ".config", "mykyagent");
const TOGGLES_FILE = join(MEMORY_DIR, "toggles.json");

export function getTogglesFile(): string {
  return process.env.MYKYAGENT_TOGGLES_FILE || TOGGLES_FILE;
}

export interface TogglesConfig {
  /** boolean = every mode (legacy); per-mode map = separate settings per mode. */
  tools?: Record<string, boolean | Record<string, boolean>>;
  skills?: {
    enabled?: boolean;
    disabled?: string[];
  };
  features?: Record<string, boolean>;
}

export interface ToggleItem {
  id: string;
  name: string;
  category: "tool" | "skill" | "feature";
  label: string;
  description: string;
  enabled: boolean;
}

export const BUILTIN_TOOL_DEFS: Record<string, string> = {
  read: "Safe chunk file reading",
  write: "Create or overwrite files",
  edit: "Targeted file find/replace",
  bash: "Execute shell commands",
  grep: "Regex search file contents",
  find: "Find files by glob pattern",
  ls: "List directory contents",
  web_search: "Autonomous deep research & multi-hop crawl",
  web_fetch: "Clean technical web extraction & distillation",
  memory: "Persistent memory topics (read/write/edit/forget/list/search/rename/move)",
  mcp_connect: "Connect to MCP server and register tools",
  mcp_disconnect: "Disconnect MCP server and unregister tools",
  mcp_list: "List connected MCP servers and tools",
  skill_read: "Read an on-disk skill pack by name",
  todo: "Tiny task scratch: add/list/done/clear",
  summarize: "Save a session summary for later /resume",
  task_start: "Start a detached long command",
  task_output: "Read new task log bytes",
  task_wait: "Block for task output or exit",
  task_stop: "Stop a running task",
  task_list: "List tracked tasks",
  character_save: "RP-Creator: write/update a character card",
  character_read: "RP-Creator: read a character card",
  character_delete: "RP-Creator: delete a character card",
  lorebook_save: "RP-Creator: write a lorebook (world info) file",
  lorebook_read: "RP-Creator: read a lorebook file",
  lorebook_list: "RP-Creator: list lorebooks",
  lorebook_delete: "RP-Creator: delete a lorebook file",
  card_audit: "RP-Creator: audit a character card",
  dice_roll: "RPG: cryptographically fair dice rolls",
  game_state: "RPG: persistent game state get/set",
  advance_time: "RPG: advance in-world time",
};

export const FEATURE_DEFS: Record<string, string> = {
  memory: "Persistent topic memory index & prompt injection",
  persona: "Persona speaking style in system prompt",
  tool_recovery: "Auto-recovery for leaked tool calls (OPT-IN, off by default)",
  output_sanitizer: "Strip terminal progress tickers/ANSI escapes from output",
  web: "Master switch for web research & fetch tools",
  mcp: "Master switch for MCP adapter and all MCP tools",
  rp: "Master switch for RP subsystem (modes, characters, creator, RPG tools)",
  lorebook: "Auto-inject keyword-triggered <active_lore> in RP mode",
  authors_note: "Author's Note steering block (/an) in RP mode",
  rp_creator: "RP-Creator card/lore authoring tools",
  rpg_tools: "RPG tools (dice_roll, game_state, advance_time)",
  brief: "Session brief (/brief) — the user's description of the session — in prompt",
  style: "Structured narrative dials (/style) in prompt",
  effort: "Work standard / effort level (/effort) in prompt — OFF by default, /effort <level> turns it on",
};

export function loadToggles(): TogglesConfig {
  try {
    const file = getTogglesFile();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (parsed && typeof parsed === "object") {
        return {
          tools: typeof parsed.tools === "object" && parsed.tools !== null ? parsed.tools : {},
          skills: {
            enabled: parsed.skills?.enabled !== false,
            disabled: Array.isArray(parsed.skills?.disabled) ? parsed.skills.disabled : [],
          },
          features: typeof parsed.features === "object" && parsed.features !== null ? parsed.features : {},
        };
      }
    }
  } catch {}
  return {
    tools: {},
    skills: { enabled: true, disabled: [] },
    features: {},
  };
}

export function saveToggles(cfg: TogglesConfig): void {
  const file = getTogglesFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

/**
 * Tools pi defines on every platform but only one can run. powershell throws
 * "The powershell tool is only available on Windows" anywhere else, so showing
 * it in a board or activating it is pure context noise.
 */
export function isToolRunnableHere(name: string): boolean {
  if (name === "powershell") return process.platform === "win32";
  return true;
}

/** Features that default OFF (opt-in). Everything else defaults ON. */
export const OPT_IN_FEATURES: Set<string> = new Set(["tool_recovery", "effort"]);

/**
 * Tools whose whole lifecycle belongs to one feature master switch. The feature
 * row already flips them (web/mcp killswitches, memory gate), so a second row
 * reads as if the same thing were configurable twice — and the memory tool row
 * is indistinguishable from the memory feature row. `skill_read` is covered the
 * same way by the Skills master row and is skipped separately.
 * Discovered MCP server tools (mcp_<server>_<tool>) are NOT listed here: each
 * one is a real, separately togglable tool.
 */
export const FEATURE_OWNED_TOOLS: Record<string, string[]> = {
  memory: ["memory"],
  mcp: ["mcp_connect", "mcp_disconnect", "mcp_list"],
};

const FEATURE_OWNED_TOOL_SET: ReadonlySet<string> = new Set(Object.values(FEATURE_OWNED_TOOLS).flat());

export function isFeatureEnabled(name: string): boolean {
  const cfg = loadToggles();
  // Opt-in features: off unless explicitly enabled. Recovery executes
  // things the model didn't properly call — under direct supervision that
  // must be a deliberate choice, not a default.
  if (OPT_IN_FEATURES.has(name)) return cfg.features?.[name] === true;
  return cfg.features?.[name] !== false;
}

export function setFeatureEnabled(name: string, enabled: boolean): void {
  const cfg = loadToggles();
  cfg.features = cfg.features || {};
  cfg.features[name] = enabled;
  saveToggles(cfg);
}

export function isSkillsMasterEnabled(): boolean {
  const cfg = loadToggles();
  if (cfg.features?.skills === false) return false;
  return cfg.skills?.enabled !== false;
}

export function isSkillEnabled(name: string): boolean {
  if (!isSkillsMasterEnabled()) return false;
  const cfg = loadToggles();
  const disabled = cfg.skills?.disabled || [];
  return !disabled.includes(name.toLowerCase());
}

export function setSkillsMasterEnabled(enabled: boolean): void {
  const cfg = loadToggles();
  cfg.skills = cfg.skills || { enabled: true, disabled: [] };
  cfg.skills.enabled = enabled;
  cfg.features = cfg.features || {};
  cfg.features.skills = enabled;
  saveToggles(cfg);
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  const cfg = loadToggles();
  cfg.skills = cfg.skills || { enabled: true, disabled: [] };
  const list = new Set((cfg.skills.disabled || []).map((s) => s.toLowerCase()));
  const key = name.toLowerCase();
  if (enabled) {
    list.delete(key);
  } else {
    list.add(key);
  }
  cfg.skills.disabled = Array.from(list);
  saveToggles(cfg);
}

export function isToolEnabled(name: string, mode?: string): boolean {
  const cfg = loadToggles();
  // Master feature switches
  if (name.startsWith("web_") && cfg.features?.web === false) return false;
  if (name.startsWith("mcp_") && cfg.features?.mcp === false) return false;
  if ((name === "memory" || name.startsWith("memory_")) && cfg.features?.memory === false) return false;
  // The skills master is the only switch for the skills system: with it off
  // there is no index to read from, so a live skill_read tool would be dead
  // weight in the toolset.
  if (name === "skill_read" && !isSkillsMasterEnabled()) return false;

  const v = cfg.tools?.[name];
  if (typeof v === "boolean") return v; // legacy global: applies to every mode
  if (v && typeof v === "object") {
    if (!mode) return true;
    const mv = (v as Record<string, boolean>)[mode];
    return typeof mv === "boolean" ? mv : true;
  }
  return true;
}

/** Tool names from before the single `memory` tool. */
export const LEGACY_MEMORY_TOOLS = [
  "memory_read",
  "memory_write",
  "memory_edit",
  "memory_forget",
  "memory_list",
  "memory_search",
  "memory_rename",
  "memory_move",
];

/**
 * Fold the eight old memory tool settings into the merged `memory` tool and
 * drop the stale keys, so /mykyagent does not keep showing tools that no
 * longer exist. A mode is off when every old memory tool was off there.
 * Idempotent; returns true when it changed the file.
 */
/**
 * Rename retired feature switches to their current names so an old
 * toggles.json does not silently re-enable something the user turned off.
 * Currently: tags -> brief (the tint list became a session description).
 */
export function migrateLegacyFeatureToggles(): boolean {
  const cfg = loadToggles();
  const features = cfg.features || {};
  if (!("tags" in features)) return false;
  if (!("brief" in features)) features.brief = features.tags;
  delete features.tags;
  cfg.features = features;
  saveToggles(cfg);
  return true;
}

export function migrateLegacyMemoryToggles(): boolean {
  const cfg = loadToggles();
  const tools = cfg.tools || {};
  const legacy = LEGACY_MEMORY_TOOLS.filter((k) => k in tools);
  if (!legacy.length) return false;
  if (!("memory" in tools)) {
    const modes = new Set<string>();
    let legacyGlobalOff = false;
    for (const k of legacy) {
      const v = tools[k];
      if (v === false) legacyGlobalOff = true;
      else if (v && typeof v === "object") for (const m of Object.keys(v)) modes.add(m);
    }
    const merged: Record<string, boolean> = {};
    for (const m of modes) {
      const values = legacy.map((k) => {
        const v = tools[k];
        return v && typeof v === "object" ? v[m] : v;
      });
      const known = values.filter((v): v is boolean => typeof v === "boolean");
      if (known.length && known.every((v) => v === false)) merged[m] = false;
    }
    if (legacyGlobalOff && Object.keys(merged).length === 0) tools.memory = false;
    else if (Object.keys(merged).length) tools.memory = merged;
  }
  for (const k of legacy) delete tools[k];
  cfg.tools = tools;
  saveToggles(cfg);
  return true;
}

export function setToolEnabled(name: string, enabled: boolean, mode?: string): void {
  const cfg = loadToggles();
  cfg.tools = cfg.tools || {};
  if (!mode) {
    cfg.tools[name] = enabled;
  } else {
    const cur = cfg.tools[name];
    const obj = cur && typeof cur === "object" ? { ...(cur as Record<string, boolean>) } : {};
    obj[mode] = enabled;
    cfg.tools[name] = obj;
  }
  saveToggles(cfg);
}

export function resetAllToggles(): void {
  saveToggles({
    tools: {},
    skills: { enabled: true, disabled: [] },
    features: {},
  });
}

export interface ToggleListOptions {
  /** Current mode: tool `enabled` reflects it, and mode-blocked tools hide. */
  mode?: string;
  /** Returns false for tools unavailable right now (mode gating). */
  isAllowed?: (tool: string) => boolean;
}

export function getAllToggleableItems(
  discoveredSkills: string[] = [],
  registeredTools: string[] = [],
  opts: ToggleListOptions = {}
): ToggleItem[] {
  const items: ToggleItem[] = [];

  // 1. Features
  for (const [feat, desc] of Object.entries(FEATURE_DEFS)) {
    items.push({
      id: `feat:${feat}`,
      name: feat,
      category: "feature",
      label: `Feature: ${feat}`,
      description: desc,
      enabled: isFeatureEnabled(feat),
    });
  }

  // 2. Skills
  items.push({
    id: "skill:__master__",
    name: "skills",
    category: "skill",
    label: "Skills: (Master toggle)",
    description: "Skills system: prompt index, per-skill toggles, and the skill_read tool",
    enabled: isSkillsMasterEnabled(),
  });

  const skillSet = new Set(discoveredSkills.map((s) => s.toLowerCase()));
  const cfg = loadToggles();
  for (const d of cfg.skills?.disabled || []) {
    skillSet.add(d.toLowerCase());
  }

  for (const sk of Array.from(skillSet).sort()) {
    items.push({
      id: `skill:${sk}`,
      name: sk,
      category: "skill",
      label: `Skill: ${sk}`,
      description: `Skill instruction package (${sk})`,
      enabled: isSkillEnabled(sk),
    });
  }

  // 3. Tools (mode-blocked tools hide when an isAllowed gate is given)
  const allToolNames = Array.from(
    new Set([...Object.keys(BUILTIN_TOOL_DEFS), ...registeredTools, ...Object.keys(cfg.tools || {})])
  ).sort();

  for (const t of allToolNames) {
    if (!isToolRunnableHere(t)) continue;
    if (t === "skill_read") continue; // covered by the Skills master row
    if (FEATURE_OWNED_TOOL_SET.has(t)) continue; // covered by its feature row (mcp, memory)
    if (opts.isAllowed && !opts.isAllowed(t)) continue;
    const desc = BUILTIN_TOOL_DEFS[t] || (t.startsWith("mcp_") ? "Discovered MCP tool" : "Registered tool");
    items.push({
      id: `tool:${t}`,
      name: t,
      category: "tool",
      label: `Tool: ${t}`,
      description: desc,
      enabled: isToolEnabled(t, opts.mode),
    });
  }

  return items;
}

/** Tools hidden by the mode gate (for the "N hidden" note). Features/skills never hide. */
export function modeHiddenTools(
  registeredTools: string[] = [],
  isAllowed?: (tool: string) => boolean
): string[] {
  if (!isAllowed) return [];
  const cfg = loadToggles();
  const all = new Set([...Object.keys(BUILTIN_TOOL_DEFS), ...registeredTools, ...Object.keys(cfg.tools || {})]);
  return Array.from(all)
    .filter((t) => isToolRunnableHere(t) && !FEATURE_OWNED_TOOL_SET.has(t) && !isAllowed(t))
    .sort();
}

export function toggleByName(
  target: string,
  explicitState?: boolean,
  discoveredSkills: string[] = [],
  mode?: string
): { ok: boolean; name: string; enabled: boolean; category: string; message: string } {
  const norm = target.trim().toLowerCase();
  // `tool:` / `feat:` disambiguate names that exist in both categories (the
  // `memory` master feature and the `memory` tool). Bare names resolve to the
  // feature first, which is the master switch anyway.
  const forcedTool = norm.startsWith("tool:");
  const forcedFeature = norm.startsWith("feat:");
  const bare = forcedTool ? norm.slice(5) : forcedFeature ? norm.slice(4) : norm;

  // 1. Match feature
  if (!forcedTool && bare in FEATURE_DEFS) {
    const next = explicitState !== undefined ? explicitState : !isFeatureEnabled(bare);
    setFeatureEnabled(bare, next);
    return {
      ok: true,
      name: bare,
      enabled: next,
      category: "feature",
      message: `Feature "${bare}" is now ${next ? "ENABLED" : "DISABLED"}.`,
    };
  }

  // 2. Match master skills (bare skill_read included: the tool tracks the master)
  if (norm === "skills" || norm === "skill" || (!forcedTool && norm === "skill_read")) {
    const next = explicitState !== undefined ? explicitState : !isSkillsMasterEnabled();
    setSkillsMasterEnabled(next);
    return {
      ok: true,
      name: "skills",
      enabled: next,
      category: "skill",
      message: `Skills system is now ${next ? "ENABLED" : "DISABLED"}.`,
    };
  }

  // 3. Match individual skill (with or without 'skill:' prefix)
  const skillName = norm.startsWith("skill:") ? norm.slice(6) : norm;
  const cfg = loadToggles();
  const knownSkills = new Set([
    ...discoveredSkills.map((s) => s.toLowerCase()),
    ...(cfg.skills?.disabled || []).map((s) => s.toLowerCase()),
  ]);

  if (knownSkills.has(skillName)) {
    const next = explicitState !== undefined ? explicitState : !isSkillEnabled(skillName);
    setSkillEnabled(skillName, next);
    return {
      ok: true,
      name: skillName,
      enabled: next,
      category: "skill",
      message: `Skill "${skillName}" is now ${next ? "ENABLED" : "DISABLED"}.`,
    };
  }

  const toolMsg = (toolName: string, next: boolean) =>
    `Tool "${toolName}" is now ${next ? "ENABLED" : "DISABLED"}${mode ? ` in ${mode} mode` : ""}.`;

  // 4. Match tool (with or without 'tool:' prefix)
  const toolName = forcedTool ? bare : norm;
  if (toolName in BUILTIN_TOOL_DEFS || toolName.startsWith("mcp_") || toolName in (cfg.tools || {})) {
    const next = explicitState !== undefined ? explicitState : !isToolEnabled(toolName, mode);
    setToolEnabled(toolName, next, mode);
    return {
      ok: true,
      name: toolName,
      enabled: next,
      category: "tool",
      message: toolMsg(toolName, next),
    };
  }

  // If prefixed explicitly:
  if (norm.startsWith("skill:")) {
    const next = explicitState !== undefined ? explicitState : !isSkillEnabled(skillName);
    setSkillEnabled(skillName, next);
    return {
      ok: true,
      name: skillName,
      enabled: next,
      category: "skill",
      message: `Skill "${skillName}" is now ${next ? "ENABLED" : "DISABLED"}.`,
    };
  }
  if (norm.startsWith("tool:")) {
    const next = explicitState !== undefined ? explicitState : !isToolEnabled(toolName, mode);
    setToolEnabled(toolName, next, mode);
    return {
      ok: true,
      name: toolName,
      enabled: next,
      category: "tool",
      message: toolMsg(toolName, next),
    };
  }

  // Generic fallback: treat as tool
  const next = explicitState !== undefined ? explicitState : !isToolEnabled(toolName, mode);
  setToolEnabled(toolName, next, mode);
  return {
    ok: true,
    name: toolName,
    enabled: next,
    category: "tool",
    message: toolMsg(toolName, next),
  };
}

export function formatTogglesSummary(
  discoveredSkills: string[] = [],
  registeredTools: string[] = [],
  opts: ToggleListOptions = {}
): string {
  const items = getAllToggleableItems(discoveredSkills, registeredTools, opts);

  const features = items.filter((i) => i.category === "feature");
  const skills = items.filter((i) => i.category === "skill");
  const tools = items.filter((i) => i.category === "tool");

  const fmt = (item: ToggleItem) =>
    `  ${item.enabled ? "🟢 [ON] " : "🔴 [OFF]"} ${item.name.padEnd(18)} - ${item.description}`;

  const lines: string[] = [
    `=== MykyAgent Toggles Status${opts.mode ? ` [${opts.mode} mode]` : ""} ===`,
    "",
    "Features:",
    ...features.map(fmt),
    "",
    "Skills:",
    ...skills.map(fmt),
    "",
    "Tools:",
    ...tools.map(fmt),
  ];
  const hidden = modeHiddenTools(registeredTools, opts.isAllowed);
  if (hidden.length && opts.mode) {
    lines.push("", `(${hidden.length} tools hidden — unavailable in ${opts.mode} mode: ${hidden.slice(0, 8).join(", ")}${hidden.length > 8 ? ", …" : ""})`);
  }
  lines.push("", "Usage: /mykyagent [toggle <name> | on <name> | off <name> | profile ... | reset | status]", "Profiles: /profile [list | new <name> [--default] | use <name> | save | delete <name>]");

  return lines.join("\n");
}
