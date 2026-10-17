/**
 * RP-Creator Studio: creator tools the agent uses in rp-creator mode to build,
 * inspect, and audit character cards and lorebooks.
 *
 * Exports pi-compatible tool definition factories (no pi dependency) plus the
 * audit logic used by both the card_audit tool and tests.
 */
import {
  deleteCharacter,
  duplicateCharacter,
  listCharacters,
  loadCharacter,
  renameCharacter,
  saveCharacter,
  validateCard,
  type CharacterCard,
} from "./character.ts";
import { deleteLorebook, findTriggerOverlaps, listLorebooks, loadLorebook, saveLorebook, type LoreEntry } from "./lorebook.ts";

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
  const bookSlug = card.lorebook;
  const bookEntries = bookSlug ? loadLorebook(bookSlug) : [];
  const overlaps = bookSlug ? findTriggerOverlaps(bookEntries) : [];
  const lines: string[] = [`Card "${card.name}" (slug ${slug}): ~${v.tokenEstimate} tokens`];
  for (const e of v.errors) lines.push(`  ERROR: ${e}`);
  for (const w of v.warnings) lines.push(`  WARN: ${w}`);
  for (const o of overlaps) lines.push(`  LORE OVERLAP: ${o}`);
  if (bookSlug) {
    const loreChars = bookEntries.reduce((n, e) => n + (e.content || "").length, 0);
    if (bookEntries.length > 30) lines.push(`  WARN: lorebook "${bookSlug}" has ${bookEntries.length} entries — only the top ~10 matches inject per turn; split or trim triggers`);
    else if (loreChars > 12000) lines.push(`  WARN: lorebook "${bookSlug}" is ~${Math.ceil(loreChars / 4)} tokens — per-turn injection is capped at ~500 tokens; trim low-priority entries`);
    else lines.push(`  lorebook "${bookSlug}": ${bookEntries.length} entries`);
  }
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

export function characterDeleteTool() {
  return {
    name: "character_delete",
    label: "Character Delete",
    description: "Delete a character card file in ~/.config/mykyagent/characters/<slug>.json. Does not touch game state or memories (use /character reset first if a clean wipe is needed).",
    parameters: {
      type: "object",
      properties: { slug: { type: "string", description: "Card slug or name" } },
      required: ["slug"],
    },
    async execute(_id: string, { slug }: { slug: string }) {
      const ok = deleteCharacter(slug);
      return ok
        ? { content: [{ type: "text", text: `Deleted character card "${slug}".` }] }
        : { content: [{ type: "text", text: `No character card "${slug}".` }], isError: true };
    },
  };
}

export function characterDuplicateTool() {
  return {
    name: "character_duplicate",
    label: "Character Duplicate",
    description: "Copy a character card under a new name (same world, new slug). Fails if the target slug already exists.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Source card slug or name" },
        name: { type: "string", description: "Display name for the copy (slug derived from it)" },
      },
      required: ["slug", "name"],
    },
    async execute(_id: string, { slug, name }: { slug: string; name: string }) {
      try {
        const saved = duplicateCharacter(slug, name);
        return { content: [{ type: "text", text: `Duplicated as "${name}" (slug: ${saved.slug}).` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `character_duplicate failed: ${err.message}` }], isError: true };
      }
    },
  };
}

export function characterRenameTool() {
  return {
    name: "character_rename",
    label: "Character Rename",
    description: "Rename a character card (moves the file; the lorebook link travels with it). Does not touch the active-character setting.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Current card slug or name" },
        name: { type: "string", description: "New display name (new slug derived from it)" },
      },
      required: ["slug", "name"],
    },
    async execute(_id: string, { slug, name }: { slug: string; name: string }) {
      try {
        const saved = renameCharacter(slug, name);
        return { content: [{ type: "text", text: `Renamed to "${name}" (slug: ${saved.slug}).` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `character_rename failed: ${err.message}` }], isError: true };
      }
    },
  };
}

export function lorebookReadTool() {
  return {
    name: "lorebook_read",
    label: "Lorebook Read",
    description: "Read a lorebook file from ~/.config/mykyagent/lore/ to inspect entries before revising it.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string", description: "Lorebook slug" } },
      required: ["slug"],
    },
    async execute(_id: string, { slug }: { slug: string }) {
      const entries = loadLorebook(slug);
      if (!entries.length) return { content: [{ type: "text", text: `No lorebook "${slug}" (or it has no entries).` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ slug, entries }, null, 2) }] };
    },
  };
}

export function lorebookListTool() {
  return {
    name: "lorebook_list",
    label: "Lorebook List",
    description: "List every lorebook slug with its entry count.",
    parameters: { type: "object", properties: {} },
    async execute(_id: string) {
      const books = listLorebooks();
      return { content: [{ type: "text", text: books.length ? books.map((b) => `• ${b.slug} (${b.entries} entries)`).join("\n") : "No lorebooks yet." }] };
    },
  };
}

export function lorebookDeleteTool() {
  return {
    name: "lorebook_delete",
    label: "Lorebook Delete",
    description: "Delete a lorebook file in ~/.config/mykyagent/lore/<slug>.json.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string", description: "Lorebook slug" } },
      required: ["slug"],
    },
    async execute(_id: string, { slug }: { slug: string }) {
      const ok = deleteLorebook(slug);
      return ok
        ? { content: [{ type: "text", text: `Deleted lorebook "${slug}".` }] }
        : { content: [{ type: "text", text: `No lorebook "${slug}".` }], isError: true };
    },
  };
}
