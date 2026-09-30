/**
 * rp_prompt: RP-mode prompt assembly, extracted from index.ts unchanged.
 *
 * RP stays a first-class citizen (not ripped out): this module owns the
 * "gather card + lore + author's note + tool hints + memory + greeting"
 * recipe so index.ts stays thin and the recipe is unit-testable.
 */
import { buildRpSystemPrompt } from "./mode.ts";
import { collectActiveLore } from "./lorebook.ts";
import { renderAuthorNoteBlock } from "./authors_note.ts";
import {
  loadCharacter,
  renderCharacterBlock,
  renderGreeting,
  type CharacterCard,
} from "./character.ts";
import { getUserName, loadModeConfig, type Mode } from "./mode.ts";
import { isFeatureEnabled, isToolEnabled } from "./toggles.ts";
import { memoryIndexBlock } from "./memory.ts";

export interface RpAssemblyInput {
  prompt?: string;
  modeCfg?: ReturnType<typeof loadModeConfig>;
  card?: CharacterCard | null;
  rpgOff?: boolean;
}

export function assembleRpPrompt(input: RpAssemblyInput = {}): { systemPrompt: string; cardName?: string } {
  const modeCfg = input.modeCfg || loadModeConfig();
  const userName = modeCfg.userName || getUserName();
  const card = input.card !== undefined ? input.card : modeCfg.activeCharacter
    ? loadCharacter(modeCfg.activeCharacter)
    : null;
  const characterBlock = card
    ? renderCharacterBlock(card, userName)
    : "<character>\n(no character card loaded — roleplay freely; suggest the user load one with /character load <name>)\n</character>";

  let loreBlock = "";
  if (isFeatureEnabled("lorebook")) {
    const bookSlugs = Array.from(
      new Set([modeCfg.lorebook || (card as any)?.lorebook || "", "default"].filter(Boolean) as string[])
    );
    loreBlock = collectActiveLore(input.prompt || "", bookSlugs).block;
  }

  const anBlock = isFeatureEnabled("authors_note") ? renderAuthorNoteBlock() : "";
  const rpgOff = input.rpgOff ?? !isFeatureEnabled("rpg_tools");

  const toolHints: string[] = [];
  if (!rpgOff && isToolEnabled("dice_roll")) {
    toolHints.push(
      `- dice_roll: Use when the scene involves chance, a contest, or risk. Weave the result into the story. Never invent a roll outcome you could have rolled.`
    );
    toolHints.push(
      "- game_state: Track what persists between scenes: wounds, gold, inventory, relationship meters, quest flags. Update it when the scene changes something durable; check it when continuity matters."
    );
    toolHints.push(
      "- advance_time: Advance the in-world clock when time passes in the story (travel, rest, a long negotiation). Mention the resulting time of day naturally."
    );
  }
  const toolHintsBlock = toolHints.length
    ? "Narration Tools (invoke via tool calling when relevant, NEVER print raw function calls in prose):\n" + toolHints.join("\n")
    : "";

  const greetingReminder = ((card as any)?.first_message || "").trim()
    ? `Scene Opener (what you already said to begin this scene):\n"""\n${renderGreeting(card!, userName)}\n"""\nContinue from here. Do not reintroduce yourself, do not restate the scene, do not repeat this opener.`
    : "";

  const rpMemBlock = !isFeatureEnabled("memory") ? "" : memoryIndexBlock(undefined);
  return {
    systemPrompt: buildRpSystemPrompt({
      characterBlock, loreBlock, authorsNoteBlock: anBlock,
      toolHintsBlock, memoryBlock: rpMemBlock, userName, greetingReminder,
    }),
    cardName: (card as any)?.name,
  };
}

export type { Mode };
