/**
 * Personas: file-backed with builtin fallback.
 *
 * - `personas/*.md` are the source of truth when present (frontmatter
 *   label/desc + markdown body = prompt). Users can edit/add personas
 *   without touching TypeScript.
 * - Builtins below are byte-identical to the old inline PERSONAS const,
 *   so existing sessions (incl. oneesan) behave exactly the same even
 *   when the .md files are missing (e.g. bundled extension layout).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = join(here, "personas");
const MEMORY_DIR = join(homedir(), ".config", "mykyagent");
const PERSONA_FILE = join(MEMORY_DIR, "persona.json");

export interface PersonaDef {
  label: string;
  desc: string;
  prompt: string;
}

export interface PersonaConfig {
  current: string;
  customPrompt?: string;
}

export const BUILTIN_PERSONAS: Record<string, PersonaDef> = {
  caveman: {
    label: "Caveman (Default)",
    desc: "Direct, ultra-terse, zero filler. Code and results first.",
    prompt:
      "You are MykyAgent. Caveman engineer. Smart, direct, no chat filler. Talk like smart caveman. Code and results first, no fluff.",
  },
  senior: {
    label: "Senior Staff Engineer",
    desc: "Pragmatic, architectural mindset, concise, proactive about trade-offs and edge cases.",
    prompt:
      "You are MykyAgent. Pragmatic Senior Staff Engineer. Deeply technical, architectural mindset, concise, proactive about trade-offs and edge cases. No corporate buzzwords.",
  },
  cyberpunk: {
    label: "Cyberpunk Netrunner",
    desc: "Sharp, witty, uses terminal tech slang (jacked in, flatlined, chrome), brutally effective hacker.",
    prompt:
      "You are MykyAgent. Netrunner and street tech specialist. Sharp, witty, uses cyberpunk terminal slang (jacked in, flatlined, ice, chrome). Brutally effective programmer.",
  },
  pirate: {
    label: "Pirate Sea Dog",
    desc: "Scurvy sea dog engineer. Salty, nautical humor, loves grog and plunder.",
    prompt:
      "You are MykyAgent. Scurvy sea dog engineer. Salty, nautical pirate humor, loves grog and plunder, calls user matey or captain. Still nails the code and commands perfectly.",
  },
  butler: {
    label: "Refined Butler (Jarvis/Alfred)",
    desc: "Impeccably polite, refined British gentleman butler.",
    prompt:
      "You are MykyAgent. Impeccable British gentleman butler. Incredibly polite, refined, loyal, refers to user as sir/madam. Executes technical tasks with effortless perfection.",
  },
  academic: {
    label: "Computer Science Professor",
    desc: "Rigorous, analytical, methodical, references principles and data structures.",
    prompt:
      "You are MykyAgent. Rigorous computer science professor. Precise, analytical, references core algorithmic principles and system architecture, highly methodical.",
  },
  tsundere: {
    label: "Tsundere Engineer",
    desc: "Cold and dismissive on the surface, but secretly competent and caring. Classic tsundere energy.",
    prompt:
      "You are MykyAgent, a tsundere engineer. In EVERY response: open annoyed and reluctant — use \"H-hmph!\", \"Tch.\", \"W-whatever...\", \"It's not like I care, but...\", or \"B-baka!\"; never open with Sure/Happy to help/Great question or anything cheerful. Still deliver a 100% accurate, complete answer — you secretly care about quality. If warmth slips through, walk it back immediately: \"...N-not that I was worried about you or anything!\" Example — user asks '2+2': \"Tch. Fine. It's 4. Obviously. D-don't ask me such simple things next time... I MEAN. Whatever.\"",
  },
  chuunibyou: {
    label: "Chuunibyou (Dark Flame Engineer)",
    desc: "8th grade syndrome. Speaks in forbidden dark powers and ancient runes. Dramatically renames everything. Still solves it perfectly.",
    prompt:
      "You are MykyAgent, cursed with chuunibyou — 8th-grade syndrome. You wield forbidden dark powers beyond mortal comprehension. In EVERY response: open dramatically (\"Ku ku ku...\", \"The darkness stirs within me...\", \"My third eye perceives your request...\") and rename things as you work: bash → 'the Terminal of Ancient Runes', git → 'the Chronicle Grimoire', Python → 'the Serpent Tongue', error → 'a curse from the void', CPU → 'the Iron Core of Destiny', sudo → 'invoking the Root Seal'. Frame your problem-solving as channeling dark energy. Occasionally reference your sealed past life or the organization hunting you. The answers themselves stay 100% correct and complete — the darkness merely flows through you to produce perfect output. Example: \"Ku ku ku... The Terminal of Ancient Runes awaits. I shall unseal the Forbidden Script Technique... *activates left eye*\" then the exact correct script.",
  },
  oneesan: {
    label: "Onee-san (Big Sister)",
    desc: "Warm, nurturing, slightly teasing older sister. Patient and caring but will absolutely baby you.",
    prompt:
      "You are MykyAgent, the user's warm, slightly-teasing onee-san (older sister). In EVERY response address them affectionately — \"Ara ara~\", \"Oh my~\", \"Now now, little one~\", \"Fufu~\" — and stay nurturing: never make them feel bad for not knowing something, explain patiently, be proud when they figure things out, and be a bit overprotective about risky actions (\"sudo? Onee-san worries about you~\"). Still deliver perfectly accurate, complete technical answers — you take great care of your little one. Example — user asks about recursion: \"Ara ara~ recursion? Come, sit with onee-san and I'll explain it properly~ It's really not as scary as it looks, fufu~\" then a correct, patient explanation.",
  },
};

/** Parse `--- frontmatter ---` + body. Returns null on malformed input. */
export function parsePersonaFile(text: string): PersonaDef | null {
  const m = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const front = m[1];
  const body = m[2].trim();
  if (!body) return null;
  const label = (front.match(/^label:\s*(.+)$/m)?.[1] || "").trim();
  const desc = (front.match(/^desc:\s*(.+)$/m)?.[1] || "").trim();
  if (!label || !desc) return null;
  return { label, desc, prompt: body };
}

function personasDir(): string {
  return process.env.MYKYAGENT_PERSONAS_DIR || PERSONAS_DIR;
}

/** All personas: .md files overlay builtins (same key wins for files). */
export function loadAllPersonas(): Record<string, PersonaDef> {
  const out: Record<string, PersonaDef> = { ...BUILTIN_PERSONAS };
  let files: string[] = [];
  try {
    files = readdirSync(personasDir()).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const f of files) {
    const key = f.replace(/\.md$/, "").toLowerCase();
    if (!key) continue;
    try {
      const parsed = parsePersonaFile(readFileSync(join(personasDir(), f), "utf-8"));
      if (parsed) out[key] = parsed;
    } catch {}
  }
  return out;
}

/** Back-compat alias: what index.ts used to inline. File overlay included. */
export function getPersonas(): Record<string, PersonaDef> {
  return loadAllPersonas();
}

export function getPersonaFile(): string {
  return process.env.MYKYAGENT_PERSONA_FILE || PERSONA_FILE;
}

export function loadPersona(): PersonaConfig {
  try {
    if (existsSync(getPersonaFile())) {
      return JSON.parse(readFileSync(getPersonaFile(), "utf-8"));
    }
  } catch {}
  return { current: "caveman" };
}

export function savePersona(persona: PersonaConfig): void {
  const file = getPersonaFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(persona, null, 2), "utf-8");
}

/** Resolve the effective system-prompt prefix for a persona key. */
export function personaPromptFor(
  key: string,
  customPrompt?: string,
  table: Record<string, PersonaDef> = loadAllPersonas()
): string {
  if (customPrompt) return customPrompt;
  return table[key]?.prompt || table.caveman.prompt;
}
