/**
 * Mode management for MykyAgent's tri-mode harness: code | rp | rp-creator.
 *
 * - Mode persisted in ~/.config/mykyagent/mode.json (env: MYKYAGENT_MODE_FILE).
 * - RP + creator modes dispatch their own system prompts (built here) instead
 *   of the software-engineering persona prompt.
 * - isToolAllowedInMode() is the single source of truth for per-mode tool
 *   gating; both the before_agent_start toolset merge and the tool_call guard
 *   use it so a blocked tool is invisible AND uncallable.
 *
 * Samplers are strictly out of scope here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isFeatureEnabled } from "./toggles.ts";

export type Mode = "code" | "rp" | "rp-creator";

const MODE_FILE = join(homedir(), ".config", "mykyagent", "mode.json");

export interface ModeConfig {
  mode: Mode;
  /** Name used for {{user}} substitution in cards and prompts. */
  userName?: string;
  /** Slug of the currently loaded character card, if any. */
  activeCharacter?: string;
  /** Lorebook slug auto-loaded with the active character, if any. */
  lorebook?: string;
}

function getModeFile(): string {
  return process.env.MYKYAGENT_MODE_FILE || MODE_FILE;
}

export function loadModeConfig(): ModeConfig {
  try {
    const file = getModeFile();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (parsed && typeof parsed === "object") {
        return {
          mode: normalizeMode(parsed.mode),
          userName: typeof parsed.userName === "string" && parsed.userName ? parsed.userName : undefined,
          activeCharacter:
            typeof parsed.activeCharacter === "string" && parsed.activeCharacter ? parsed.activeCharacter : undefined,
          lorebook: typeof parsed.lorebook === "string" && parsed.lorebook ? parsed.lorebook : undefined,
        };
      }
    }
  } catch {}
  return { mode: "code" };
}

export function saveModeConfig(cfg: ModeConfig): void {
  const file = getModeFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
}

export function normalizeMode(v: unknown): Mode {
  if (v === "rp" || v === "rp-creator") return v;
  return "code";
}

/** Active raw mode (as persisted). */
export function getMode(): Mode {
  return loadModeConfig().mode;
}

export function setMode(mode: Mode): void {
  const cfg = loadModeConfig();
  cfg.mode = mode;
  saveModeConfig(cfg);
}

/**
 * Effective mode: the `rp` feature toggle is the master switch for the whole
 * RP subsystem; when off, everything behaves as code mode regardless of the
 * persisted mode value.
 */
export function getEffectiveMode(): Mode {
  if (!isFeatureEnabled("rp")) return "code";
  return getMode();
}

export function getUserName(): string {
  return loadModeConfig().userName || "User";
}

export function getActiveCharacterSlug(): string | undefined {
  return loadModeConfig().activeCharacter;
}

export function setActiveCharacter(slug: string | undefined): void {
  const cfg = loadModeConfig();
  cfg.activeCharacter = slug;
  saveModeConfig(cfg);
}

// --- Per-mode tool gating ----------------------------------------------------
// Coding tools: disabled in rp mode (plan section 3). Kept in rp-creator.
export const CREATOR_TOOL_NAMES = ["character_save", "character_read", "lorebook_save", "card_audit"];
export const RPG_TOOL_NAMES = ["dice_roll", "game_state", "advance_time"];
const CODING_TOOLS = new Set(["bash", "write", "edit", "grep", "find", "ls", "web_search", "web_fetch"]);
const CREATOR_TOOLS = new Set(CREATOR_TOOL_NAMES);
const RPG_TOOLS = new Set(RPG_TOOL_NAMES);

/**
 * Whether a tool may be used in the given mode. `read` and memory tools stay
 * available everywhere; mcp_* tools follow code/creator rules (off in rp).
 */
export function isToolAllowedInMode(toolName: string, mode: Mode): boolean {
  if (mode === "rp") {
    if (CODING_TOOLS.has(toolName)) return false;
    if (toolName.startsWith("mcp_")) return false;
    if (CREATOR_TOOLS.has(toolName)) return false;
    return true;
  }
  if (mode === "rp-creator") {
    if (RPG_TOOLS.has(toolName)) return false;
    return true;
  }
  // code
  if (CREATOR_TOOLS.has(toolName) || RPG_TOOLS.has(toolName)) return false;
  return true;
}

export function isCreatorTool(name: string): boolean {
  return CREATOR_TOOLS.has(name);
}

// --- System prompt builders ---------------------------------------------------

export interface RpPromptOptions {
  characterBlock?: string;
  loreBlock?: string;
  authorsNoteBlock?: string;
  toolHintsBlock?: string;
  memoryBlock?: string;
  userName?: string;
  greetingReminder?: string;
}

const RP_BASE_RULES = `Planning Rules (Internal):
- This is immersive roleplay: do NOT narrate plan steps, do NOT produce engineering output.
- Stay fully in character unless the user sends an out-of-character (OOC) line marked (OOC).

Response Rules:
- Stay in character at all times. Never mention being an AI or a language model.
- Match the character's voice, vocabulary, and mannerisms established in the character sheet and dialogue examples.
- Do not speak or act for the user's character; leave room for the user to respond.
- Use *asterisks* for actions/body language and plain text for dialogue, mirroring the dialogue examples.
- Keep responses focused and paced; advance the scene, don't stall or repeat earlier beats.

Tool Calling Rules:
- When using tools (dice_roll, game_state, advance_time), invoke them strictly via your system's native tool calling.
- NEVER output raw function calls, pseudo-code, or tool syntax (e.g. "game_state(...)" or "Action: ...") into narrative prose or dialogue. Keep narrative prose clean, immersive, and natural.
- Tools are purely supplementary: only call game_state when inventory or durable state changes, only call advance_time when narrative time passes, and only roll dice for genuine uncertain actions. Do not call tools when greeting or opening a scene unless required.`;

/** Build the RP system prompt. Small and structured — local models follow XML tags well. */
export function buildRpSystemPrompt(opts: RpPromptOptions = {}): string {
  const user = opts.userName || "User";
  const parts: string[] = [
    `You are the character defined below in an immersive roleplay with ${user}. You are NOT an assistant; there is no task to complete. You ARE the character.`,
    RP_BASE_RULES,
  ];
  if (opts.characterBlock) parts.push(opts.characterBlock);
  if (opts.loreBlock) parts.push(opts.loreBlock);
  if (opts.authorsNoteBlock) parts.push(opts.authorsNoteBlock);
  if (opts.toolHintsBlock) parts.push(opts.toolHintsBlock);
  if (opts.memoryBlock) parts.push(opts.memoryBlock);
  if (opts.greetingReminder) parts.push(opts.greetingReminder);
  return parts.join("\n\n");
}

/** Build the rp-creator (story studio) system prompt. */
export function buildCreatorSystemPrompt(): string {
  return `You are MykyAgent in RP-Creator (Story Studio) mode: an expert character architect, worldbuilder, and narrative director. You design high-quality character cards, lorebooks, and scenarios for roleplay use — then refine them after play.

Craft Rules:
- Design characters with psychological consistency: desires, fears, flaws, and speech habits that reinforce one another.
- Token economy: keep descriptions tight. Flag verbose cards yourself; bloat kills small local models.
- Greetings must be openers, not walls of text — hook the user, don't monologue the backstory.
- mes_example lines MUST use the exact format: {{user}}: ... and {{char}}: ... with <START> before the first block.
- Prefer showing personality through concrete mannerisms over adjective lists.
- Never railroad: write scenarios that offer the user room to act.

Card File Format (Character Card V2, JSON):
{
  "name": "...", "description": "...", "personality": "...", "scenario": "...",
  "first_message": "...", "mes_example": "<START>\\n{{user}}: ...\\n{{char}}: ...\\n",
  "system_prompt": "(optional)", "tags": ["..."], "creator_notes": "(optional)"
}

Tools:
- character_save(slug, card): write/update ~/.config/mykyagent/characters/<slug>.json
- character_read(slug): inspect an existing card
- lorebook_save(slug, entries): write world info entries (keys + content + priority)
- card_audit(slug): run automated checks (token budget, {{user}}/{{char}} presence, greeting, lorebook trigger overlaps)

Workflows:
- /rp-creator new — interactive interview (ask 3-4 targeted questions: genre, tone, core conflict, relationship), then draft the card.
- /rp-creator card <concept> — concept-to-card in one pass.
- /rp-creator lore <world description> — generate structured lorebook entries with clean, low-overlap triggers.
- Play evolution: after an RP session, apply what happened to the card ("Evelyn now trusts the user, carries the silver amulet").

Never touch sampler settings — they are managed by the server/orchestrator.`;
}
