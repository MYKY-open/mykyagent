/**
 * RP-Creator Studio: creator tools the agent uses in rp-creator mode to build,
 * inspect, and audit character cards and lorebooks.
 *
 * Exports pi-compatible tool definition factories (no pi dependency) plus the
 * audit logic used by both the card_audit tool and tests.
 */
import {
  loadCharacter,
  saveCharacter,
  validateCard,
  type CharacterCard,
} from "./character.ts";
import { findTriggerOverlaps, loadLorebook, saveLorebook, type LoreEntry } from "./lorebook.ts";

export interface CardAuditResult {
  slug: string;
  found: boolean;
  ok?: boolean;
  errors?: string[];
  warnings?: string[];
  tokenEstimate?: number;
  loreOverlaps?: string[];
  summary: string;
}

export function auditCard(slug: string): CardAuditResult {
  const card = loadCharacter(slug);
  if (!card) {
    return { slug, found: false, summary: `No character card "${slug}".` };
  }
  const v = validateCard(card);
  const overlaps = card.lorebook ? findTriggerOverlaps(loadLorebook(card.lorebook)) : [];
  const lines: string[] = [`Card "${card.name}" (slug ${slug}): ~${v.tokenEstimate} tokens`];
  for (const e of v.errors) lines.push(`  ERROR: ${e}`);
  for (const w of v.warnings) lines.push(`  WARN: ${w}`);
  for (const o of overlaps) lines.push(`  LORE OVERLAP: ${o}`);
  if (v.ok && !v.warnings.length && !overlaps.length) lines.push("  all checks passed");
  return {
    slug,
    found: true,
    ok: v.ok && overlaps.length === 0,
    errors: v.errors,
    warnings: v.warnings,
    tokenEstimate: v.tokenEstimate,
    loreOverlaps: overlaps,
    summary: lines.join("\n"),
  };
}

export function characterSaveTool() {
  return {
    name: "character_save",
    label: "Character Save",
    description:
      "Write or update a Character Card V2 file in ~/.config/mykyagent/characters/<slug>.json. Fields: name (required), description, personality, scenario, first_message, mes_example, optional system_prompt/tags/creator_notes/lorebook.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug for the file name; defaults to a slugified card name" },
        card: { type: "object", description: "Full Character Card V2 JSON object" },
      },
      required: ["card"],
    },
    async execute(_id: string, { slug, card }: { slug?: string; card: CharacterCard }) {
      try {
        const v = validateCard(card);
        if (!v.ok) {
          return {
            content: [{ type: "text", text: `Card rejected:\n${v.errors.join("\n")}` }],
            isError: true,
          };
        }
        const saved = saveCharacter(card, slug);
        const warn = v.warnings.length ? `\nWarnings:\n${v.warnings.map((w) => `- ${w}`).join("\n")}` : "";
        return {
          content: [{ type: "text", text: `Saved character card to ${saved.path} (slug: ${saved.slug}, ~${v.tokenEstimate} tokens).${warn}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `character_save failed: ${err.message}` }], isError: true };
      }
    },
  };
}

export function characterReadTool() {
  return {
    name: "character_read",
    label: "Character Read",
    description:
      "Read an existing character card JSON from ~/.config/mykyagent/characters/ to inspect or revise it. Accepts a slug or card name.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string", description: "Card slug or name" } },
      required: ["slug"],
    },
    async execute(_id: string, { slug }: { slug: string }) {
      const card = loadCharacter(slug);
      if (!card) {
        return { content: [{ type: "text", text: `No character card "${slug}".` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(card, null, 2) }] };
    },
  };
}

export function lorebookSaveTool() {
  return {
    name: "lorebook_save",
    label: "Lorebook Save",
    description:
      "Write a lorebook (world info) file to ~/.config/mykyagent/lore/<slug>.json. entries: [{ keys: ['keyword', ...], content: 'world fact', priority: number }]. Keys are matched against the user's messages each RP turn; matching entries are injected as <active_lore>.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Lorebook slug, e.g. the character's lorebook reference or 'default'" },
        entries: {
          type: "array",
          description: "Array of { keys: string[], content: string, priority?: number }",
        },
      },
      required: ["slug", "entries"],
    },
    async execute(_id: string, { slug, entries }: { slug: string; entries: LoreEntry[] }) {
      try {
        const saved = saveLorebook(slug, entries);
        const overlaps = findTriggerOverlaps(loadLorebook(saved.slug));
        const overlapNote = overlaps.length ? `\nTrigger overlaps: ${overlaps.join("; ")}` : "";
        return {
          content: [{ type: "text", text: `Saved lorebook "${saved.slug}" with ${saved.count} valid entries.${overlapNote}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `lorebook_save failed: ${err.message}` }], isError: true };
      }
    },
  };
}

export function cardAuditTool() {
  return {
    name: "card_audit",
    label: "Card Audit",
    description:
      "Run automated checks on a saved character card: token budget, {{user}}/{{char}} presence in mes_example, missing greeting, and lorebook trigger-key overlaps.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string", description: "Card slug or name" } },
      required: ["slug"],
    },
    async execute(_id: string, { slug }: { slug: string }) {
      const res = auditCard(slug);
      return { content: [{ type: "text", text: res.summary }], ...(res.found ? {} : { isError: true }) };
    },
  };
}
