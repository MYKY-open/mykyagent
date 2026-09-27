/**
 * Character Card V2 (Tavern-compatible) engine.
 *
 * Storage: ~/.config/mykyagent/characters/<slug>.json
 * Schema: name, description, personality, scenario, first_message,
 *         mes_example, system_prompt (optional), tags, creator_notes,
 *         lorebook (optional slug reference into ~/.config/mykyagent/lore/).
 *
 * Provides slugify, validate, save/load/list, token estimation, and prompt
 * rendering with {{char}}/{{user}} substitution for RP mode.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CharacterCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_message: string;
  mes_example: string;
  system_prompt?: string;
  tags?: string[];
  creator_notes?: string;
  lorebook?: string;
}

const CHARACTERS_DIR = join(homedir(), ".config", "mykyagent", "characters");

function getCharactersDir(): string {
  return process.env.MYKYAGENT_CHARACTERS_DIR || CHARACTERS_DIR;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** ~4 chars per token; good enough for budget flags, not billing. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface CardValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  tokenEstimate: number;
}

export function validateCard(card: any): CardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!card || typeof card !== "object") {
    return { ok: false, errors: ["card must be a JSON object"], warnings, tokenEstimate: 0 };
  }

  // Only `name` is hard-required — everything else is optional and rendered
  // as absent (real-world cards frequently ship without scenario or
  // personality; the RP prompt just omits those tags).
  if (typeof card.name !== "string" || !card.name.trim()) {
    errors.push('field "name" is missing or empty');
  }
  for (const field of ["description", "personality", "scenario", "first_message", "mes_example"] as const) {
    const v = card[field];
    if (typeof v !== "string" || !v.trim()) {
      const what: Record<string, string> = {
        description: "description empty — character will have no visual/backstory anchor",
        personality: "personality empty — model will improvise mannerisms",
        scenario: "scenario empty — no opening scene setting",
        first_message: "first_message empty — no greeting; /character greeting will print nothing",
        mes_example: "mes_example empty — model will invent its own dialogue style",
      };
      warnings.push(what[field]);
    }
  }

  if (typeof card.mes_example === "string" && card.mes_example.trim()) {
    if (!card.mes_example.includes("{{user}}")) warnings.push("mes_example has no {{user}} lines");
    if (!card.mes_example.includes("{{char}}")) warnings.push("mes_example has no {{char}} lines");
    if (!card.mes_example.includes("<START>")) warnings.push("mes_example missing <START> before the first block");
    if (/{{user}}\s*:/i.test(card.mes_example) === false && card.mes_example.includes("{{user}}")) {
      warnings.push('mes_example {{user}} lines should look like "{{user}}: ..."');
    }
  }

  if (card.system_prompt !== undefined && typeof card.system_prompt !== "string") {
    errors.push('field "system_prompt" must be a string');
  }
  if (card.tags !== undefined && !Array.isArray(card.tags)) {
    errors.push('field "tags" must be an array of strings');
  }

  const tokenEstimate =
    estimateTokens(card.description || "") +
    estimateTokens(card.personality || "") +
    estimateTokens(card.scenario || "") +
    estimateTokens(card.first_message || "") +
    estimateTokens(card.mes_example || "") +
    estimateTokens(card.system_prompt || "");

  if (tokenEstimate > 1500) warnings.push(`card body is ~${tokenEstimate} tokens (budget: <=1500) — consider trimming`);
  else if (tokenEstimate > 800) warnings.push(`card body is ~${tokenEstimate} tokens — on the heavy side for small local models`);

  return { ok: errors.length === 0, errors, warnings, tokenEstimate };
}

export function saveCharacter(card: CharacterCard, slugOverride?: string): { slug: string; path: string } {
  if (!card || typeof card !== "object") throw new Error("card must be a JSON object");
  if (!card.name || typeof card.name !== "string") throw new Error('card "name" is required');
  const slug = slugOverride?.trim() ? slugify(slugOverride) : slugify(card.name);
  if (!slug) throw new Error("could not derive a valid slug from the card name");
  const dir = getCharactersDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.json`);
  writeFileSync(path, JSON.stringify(card, null, 2), "utf-8");
  return { slug, path };
}

export function loadCharacter(slug: string): CharacterCard | null {
  const clean = slugify(slug);
  if (!clean) return null;
  const path = join(getCharactersDir(), `${clean}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed?.name) return null;
    return parsed as CharacterCard;
  } catch {
    return null;
  }
}

export function deleteCharacter(slug: string): boolean {
  const clean = slugify(slug);
  if (!clean) return false;
  const path = join(getCharactersDir(), `${clean}.json`);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export function listCharacters(): { slug: string; card: CharacterCard }[] {
  const dir = getCharactersDir();
  if (!existsSync(dir)) return [];
  const out: { slug: string; card: CharacterCard }[] = [];
  for (const e of readdirSync(dir)) {
    if (!e.endsWith(".json")) continue;
    try {
      const card = JSON.parse(readFileSync(join(dir, e), "utf-8"));
      if (card?.name) out.push({ slug: e.replace(/\.json$/, ""), card });
    } catch {}
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

// --- Prompt rendering ---------------------------------------------------------

export function substitutePlaceholders(text: string, charName: string, userName: string): string {
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/<BOT>/g, charName)
    .replace(/<USER>/g, userName);
}

/** XML-ish character block for the RP system prompt (small-model friendly). */
export function renderCharacterBlock(card: CharacterCard, userName: string): string {
  const char = card.name;
  const sub = (t: string) => substitutePlaceholders(t || "", char, userName);
  const parts: string[] = ["<character>"];
  parts.push(`<name>${char}</name>`);
  if (card.description?.trim()) parts.push(`<description>${sub(card.description)}</description>`);
  if (card.personality?.trim()) parts.push(`<personality>${sub(card.personality)}</personality>`);
  if (card.scenario?.trim()) parts.push(`<scenario>${sub(card.scenario)}</scenario>`);
  if (card.mes_example?.trim()) parts.push(`<dialogue_examples>\n${sub(card.mes_example).trim()}\n</dialogue_examples>`);
  if (card.system_prompt?.trim()) parts.push(`<character_directives>${sub(card.system_prompt)}</character_directives>`);
  parts.push("</character>");
  return parts.join("\n");
}

/** The character's opening message with placeholders resolved; "" if unset. */
export function renderGreeting(card: CharacterCard, userName: string): string {
  return substitutePlaceholders(card.first_message || "", card.name, userName);
}

// --- Import: PNG-embedded cards & V1/V2/V3 spec normalization ----------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImportResult {
  ok: boolean;
  card?: CharacterCard;
  spec?: string;
  slug?: string;
  warnings: string[];
  error?: string;
}

/** Extract tEXt chunks from a PNG buffer. CRCs are not verified (be liberal). */
export function extractPngTextChunks(buf: Buffer): Map<string, string> {
  const chunks = new Map<string, string>();
  if (buf.length < 16 || !buf.subarray(0, 8).equals(PNG_SIG)) return chunks;
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === "IEND") break;
    if (type === "tEXt" && len > 0 && off + 8 + len <= buf.length) {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        chunks.set(data.toString("latin1", 0, nul), data.toString("latin1", nul + 1));
      }
    }
    off += 12 + len;
  }
  return chunks;
}

/**
 * Decode a card payload: base64 JSON (usual PNG chara encoding), tolerating
 * the UTF-16LE variant some old exporters produce.
 */
export function decodeCardPayload(raw: string): any | null {
  const decoded = Buffer.from(raw.replace(/\s+/g, ""), "base64");
  if (!decoded.length) return null;
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  // Standard case: base64(UTF-8 JSON). Old exporters sometimes base64
  // UTF-16LE JSON (occasionally with a BOM) — try those too.
  if (decoded[0] === 0xff && decoded[1] === 0xfe) {
    return tryParse(decoded.subarray(2).toString("utf16le"));
  }
  return tryParse(decoded.toString("utf8")) ?? tryParse(decoded.toString("utf16le"));
}

/**
 * Normalize a parsed card JSON (V1 flat, V2/V3 { spec, data }) into the
 * internal flat CharacterCard schema. Tolerant of spec field aliases.
 */
export function normalizeImportedCard(parsed: any): { card: CharacterCard; spec: string; warnings: string[] } {
  const warnings: string[] = [];
  let inner = parsed;
  let spec = "v1";
  if (parsed && typeof parsed === "object" && parsed?.data && typeof parsed.data === "object") {
    inner = parsed.data;
    spec = typeof parsed.spec === "string" ? parsed.spec : "chara_card_v2";
  }
  if (inner && typeof inner !== "object") throw new Error("card payload is not a JSON object");

  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = inner?.[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return "";
  };

  const alts = Array.isArray(inner?.alternate_greetings) ? inner.alternate_greetings.length : 0;
  if (alts > 0) warnings.push(`dropped ${alts} alternate_greeting(s) (engine uses a single greeting)`);
  if (inner?.extensions && typeof inner.extensions === "object" && Object.keys(inner.extensions).length) {
    warnings.push("dropped extensions block (not supported)");
  }
  if (inner?.character_book) warnings.push("dropped embedded character_book (use lorebook_save to author lore)");

  const card: CharacterCard = {
    name: pick("name", "char_name") || "Unnamed Import",
    description: pick("description"),
    personality: pick("personality", "personality_summary"),
    scenario: pick("scenario", "world_scenario"),
    first_message: pick("first_mes", "first_message", "greeting"),
    mes_example: pick("mes_example", "dialogue_examples"),
  };
  const sys = pick("system_prompt");
  if (sys) card.system_prompt = sys;
  const notes = pick("creator_notes", "creatorcomment");
  if (notes) card.creator_notes = notes;
  if (Array.isArray(inner?.tags) && inner.tags.every((x: any) => typeof x === "string")) {
    card.tags = inner.tags;
  }
  if (typeof inner?.lorebook === "string" && inner.lorebook) card.lorebook = inner.lorebook;

  return { card, spec, warnings };
}

/**
 * Import a character card from a local file (.png with chara/ccv3 chunk, or
 * .json — flat or V2/V3 nested) or an http(s) URL. Saves it into the cards
 * directory and returns the result (does NOT auto-load it).
 */
export async function importCharacter(source: string): Promise<ImportResult> {
  const warnings: string[] = [];
  let buf: Buffer;
  let label = source;
  try {
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return { ok: false, warnings, error: `fetch failed: HTTP ${res.status} for ${source}` };
      buf = Buffer.from(await res.arrayBuffer());
      label = new URL(source).pathname.split("/").pop() || source;
    } else {
      const path = source.replace(/^~(?=\/|$)/, homedir());
      buf = await import("node:fs/promises").then((fs) => fs.readFile(path));
      label = path.split("/").pop() || path;
    }
  } catch (err: any) {
    return { ok: false, warnings, error: `could not read "${source}": ${err.message}` };
  }

  let parsed: any;
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    const chunks = extractPngTextChunks(buf);
    // ccv3 (V3 spec) preferred over chara when both are present
    const raw = chunks.get("ccv3") ?? chunks.get("chara");
    if (!raw) {
      return { ok: false, warnings, error: `${label} is a PNG but has no chara/ccv3 tEXt chunk (not a character card).` };
    }
    parsed = decodeCardPayload(raw);
    if (!parsed) {
      return { ok: false, warnings, error: `${label}: chara chunk exists but its payload did not decode to JSON.` };
    }
  } else {
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      return { ok: false, warnings, error: `${label} is neither a PNG card nor a JSON card.` };
    }
  }

  try {
    const { card, spec, warnings: normWarnings } = normalizeImportedCard(parsed);
    warnings.push(...normWarnings);
    const v = validateCard(card);
    if (!v.ok) {
      return { ok: false, spec, warnings, error: `card failed validation:\n${v.errors.join("\n")}` };
    }
    warnings.push(...v.warnings);
    const saved = saveCharacter(card);
    return { ok: true, card, spec, slug: saved.slug, warnings };
  } catch (err: any) {
    return { ok: false, warnings, error: err.message };
  }
}

// --- Starter cards -------------------------------------------------------------

export const STARTER_CARDS: { slug: string; card: CharacterCard }[] = [
  {
    slug: "evelyn",
    card: {
      name: "Evelyn",
      description:
        "A veteran explorer in her late thirties, weather-worn leather coat, silver amulet at her throat. Traveled the borderlands for fifteen years, knows every ruin and every rumor worth coin. Kept her old crew's secrets — and their graves.",
      personality:
        "Dry wit, economical with words, warm only in small gestures. Distrusts fast talkers, respects quiet competence. Secretly fears being the last one left who remembers the old roads.",
      scenario:
        "The Lantern Room, a waystation tavern at the edge of the mapped world. Rain hammers the shutters. {{user}} just walked in from the storm, and Evelyn has been waiting for someone with their kind of eyes.",
      first_message:
        "*Evelyn doesn't look up from her map until the door bangs shut. Then her eyes travel once — boots, coat, hands — and she nudges a second chair out with her boot.*\n\nStorm's early this year. *she rolls the map closed* Sit, if you're not staying long. And if you are staying long... start with what you're really here for.",
      mes_example:
        "<START>\n{{user}}: What's out there, past the ridge?\n{{char}}: *taps the map without looking* Forty years of answers. Half of them buried the people who went looking.\n\n<START>\n{{user}}: Can I trust you?\n{{char}}: *a dry almost-smile* No. But I'll still be here at dawn, and that's worth more than trust out here.",
      tags: ["fantasy", "explorer", "companion"],
    },
  },
  {
    slug: "narrator",
    card: {
      name: "The Narrator",
      description:
        "The disembodied voice of an interactive text adventure. Describes rooms, consequences, and outcomes with dry theatrical flair. Keeps the world consistent and the stakes honest.",
      personality:
        "Omniscient but fair. Sardonic when the player does something foolish, generous when they're clever. Never breaks the second person.",
      scenario:
        "A classic dungeon-crawl world of your choosing. The Narrator opens each scene, reacts to each choice, and tracks what the player has done.",
      first_message:
        "You wake on cold stone. Somewhere above, water drips onto something metal, patiently, the way water does.\n\nYou have no memory of arriving. You have, however, a length of rope, half a torch, and a growing suspicion that the door behind you no longer exists.\n\n*What do you do?*",
      mes_example:
        "<START>\n{{user}}: I light the torch.\n{{char}}: The torch catches with a soft thump. The corridor ahead is lined with doors on both sides — all of them scratched, all of them shut.\n\n<START>\n{{user}}: I run past them.\n{{char}}: *You* run. The darkness approves. Something at the end of the corridor also approves — audibly.",
      tags: ["text-adventure", "game-master"],
    },
  },
  {
    slug: "tutor-ada",
    card: {
      name: "Ada",
      description:
        "A patient technical tutor who explains programming concepts with small runnable examples and never makes the learner feel small. Former systems engineer, teaches on a whiteboard that exists only in text.",
      personality:
        "Encouraging, precise, allergic to hand-waving. Always checks understanding with one small question before moving on. Uses analogies before formalism.",
      scenario:
        "A one-on-one tutoring session. The learner brings a topic or a broken snippet; Ada breaks it down, fixes it, and confirms the understanding stuck.",
      first_message:
        "Hey — good to see you. *sets down the marker*\n\nSo, what are we looking at today? A concept you want unpacked, or something broken that needs a second pair of eyes? Either way, bring me the smallest piece of it you can.",
      mes_example:
        "<START>\n{{user}}: I don't get recursion.\n{{char}}: Okay, forget code for a second. You're in a hallway of doors. Each door has a sign: \"if this is the last door, done; otherwise open the next one.\" Opening each door is the same job as opening the first — that's recursion. Now, which language were you wrestling with it in?\n\n<START>\n{{user}}: My loop never terminates.\n{{char}}: Classic suspect: the variable that should change, isn't. Show me the loop — just the loop — and point at the line you *expect* to move it toward the exit.",
      tags: ["tutor", "technical"],
    },
  },
];

/** Seed bundled starter cards on first use so /character list is never empty. */
export function seedStarterCharacters(): void {
  const dir = getCharactersDir();
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  for (const s of STARTER_CARDS) {
    writeFileSync(join(dir, `${s.slug}.json`), JSON.stringify(s.card, null, 2), "utf-8");
  }
}
