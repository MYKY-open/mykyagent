/**
 * Narrative style dials: structured, validated storytelling rules inspired by
 * SillyTavern's Writer's Block preset family (modes, momentum, tense, POV,
 * length, dialogue, intensity, ...), miniaturized for small local models.
 *
 * Philosophy: EVERY dial is unset by default. Unset dials cost zero prompt
 * tax — the block renders only what you explicitly set. Freeform mood stays
 * in /tags; /style is the machinery (exact levels models can actually obey).
 *
 * Storage: ~/.config/mykyagent/style.json  (env: MYKYAGENT_STYLE_FILE)
 *   { "tense": "past", "pov": "3rd" }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SettingItem } from "@earendil-works/pi-tui";
import { isFeatureEnabled, setFeatureEnabled } from "./toggles.ts";

const STYLE_FILE = join(homedir(), ".config", "mykyagent", "style.json");

function getStyleFile(): string {
  return process.env.MYKYAGENT_STYLE_FILE || STYLE_FILE;
}

export interface StyleDial {
  key: string;
  label: string;
  desc: string;
  /** One or two sentences: what it does, when to reach for it, with a mini-example. */
  help: string;
  /** Fixed levels, or null for freeform (tone). */
  levels: string[] | null;
  /** Max entries for freeform dials. */
  maxEntries?: number;
  render: (value: string) => string;
}

const free = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9-_ ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 24).trim();

export const STYLE_DIALS: StyleDial[] = [
  { key: "mode", label: "Narrative mode", desc: "who drives the scene", help: "Who the words belong to. roleplay = pure scene, you only play you; director = you are an invisible stagehand giving directions, never addressed in-scene; persona = the AI expands your one-liner into full action, dialogue and thoughts. Reach for director to stage-manage, persona when your fingers are tired.", levels: ["roleplay", "director", "persona"],
    render: (v) => v === "roleplay" ? "pure roleplay: never write for the user" : v === "director" ? "director mode: the user is an invisible director, never address them in-scene" : "active persona: expand the user's input with dialogue, thoughts and action" },
  { key: "momentum", label: "Plot momentum", desc: "how hard scenes push forward", help: "How hard each reply pushes the plot. reactive = nothing new happens, pure response; active = the scene moves forward; driving = every reply ends on an open door — action, threat, or question. Scene gone stale? driving.", levels: ["reactive", "active", "driving"],
    render: (v) => v === "reactive" ? "reactive plot: introduce no new events" : v === "active" ? "active plot: move the scene forward" : "driving plot: end on open action, threat or question" },
  { key: "tone", label: "Narrator tone", desc: "freeform, up to 3 (e.g. noir, playful)", help: "Free mood-paint on the narrator (up to 3 words, e.g. noir, playful). Subtle flavour only — for machinery the model can actually obey (tense, POV, length), use the real dials.", levels: null, maxEntries: 3,
    render: (v) => `tone: ${v}` },
  { key: "length", label: "Response length", desc: "reply size", help: "Reply size. short = under 4 paragraphs (quick beats), medium = under 8, long = 4–12 paragraphs (set pieces), adaptive = the model matches size to the moment.", levels: ["short", "medium", "long", "adaptive"],
    render: (v) => v === "short" ? "short replies (under 4 paragraphs)" : v === "medium" ? "medium replies (under 8 paragraphs)" : v === "long" ? "long replies (4-12 paragraphs)" : "reply length fits the scene" },
  { key: "density", label: "Paragraph density", desc: "paragraph count", help: "Paragraph count per reply, from minimal (1–2, breathless) to dense (8+, wall of prose) — or adaptive to let the model decide. Small models obey this better than length alone.", levels: ["minimal", "light", "standard", "full", "dense", "adaptive"],
    render: (v) => ({ minimal: "1-2 paragraphs", light: "1-3 paragraphs", standard: "1-5 paragraphs", full: "1-8 paragraphs", dense: "8+ paragraphs", adaptive: "adaptive paragraphing" } as Record<string, string>)[v] || v },
  { key: "rhythm", label: "Sentence rhythm", desc: "sentence shape", help: "Sentence shape. percussive = short punches (Tension. Now.); sprawling = long clause-heavy waves; dynamic mixes both; standard stays neutral.", levels: ["standard", "sprawling", "percussive", "dynamic"],
    render: (v) => v === "standard" ? "standard multiclausal sentences" : v === "sprawling" ? "long clause-heavy sentences" : v === "percussive" ? "short punchy sentences" : "mix of long and short sentences" },
  { key: "figurative", label: "Figurative language", desc: "metaphor frequency", help: "Metaphor frequency. none = plain facts, sparse = an occasional image, moderate = seasoned, rich = everything shimmers, saturated = drowning in it. rich plus purple vocab = maximum velvet.", levels: ["none", "sparse", "moderate", "rich", "saturated"],
    render: (v) => `${v} figurative language` },
  { key: "tense", label: "Tense", desc: "narrative tense", help: "past = 'she walked' (remembered, classic); present = 'she walks' (immediate, urgent).", levels: ["past", "present"],
    render: (v) => `${v} tense` },
  { key: "pov", label: "Point of view", desc: "narrative camera", help: "Camera owner. 1st = 'I' (intimate, limited); 2nd = 'you' (talks to the reader — intense, easy to overdo); 3rd = 'she/he' limited (the RP default); shifting 3rd = head-hopping between characters' viewpoints.", levels: ["1st", "2nd", "3rd", "shifting 3rd"],
    render: (v) => v === "shifting 3rd" ? "shifting 3rd person" : `${v} person${v === "3rd" ? " limited" : ""}` },
  { key: "distance", label: "Narrative distance", desc: "how close the camera sits", help: "How close the camera sits. remote = distant chronicle, objective = camera-eye, standard = normal novel, close = breath on skin; free indirect = thoughts bleed into narration with no tags.", levels: ["remote", "objective", "standard", "close", "free indirect"],
    render: (v) => `${v} narrative distance` },
  { key: "showtell", label: "Show vs tell", desc: "showing balance", help: "tell = states feelings ('she was sad'); show = only actions and senses, never names the feeling; the weighted steps live between.", levels: ["tell", "tell-weighted", "balanced", "show-weighted", "show"],
    render: (v) => v === "tell" ? "tell, don't show" : v === "show" ? "show, don't tell" : v === "balanced" ? "balanced showing and telling" : v },
  { key: "dialogue", label: "Dialogue frequency", desc: "how much talking", help: "How much of the reply talks. silent = nearly none (0–10%, all action), sparse = some, balanced = about half, often = mostly talk, talkative = dialogue-led (80–90%).", levels: ["silent", "sparse", "balanced", "often", "talkative"],
    render: (v) => ({ silent: "almost no dialogue (0-10%)", sparse: "sparse dialogue (20-30%)", balanced: "dialogue about half the reply", often: "frequent dialogue (~70%)", talkative: "dialogue-led replies (80-90%)" } as Record<string, string>)[v] || v },
  { key: "speech", label: "Dialogue naturalism", desc: "how dialogue sounds", help: "How dialogue sounds. literary = polished lines, colloquial = casual everyday talk, verbatim = raw, unfinished, overlapping — messiest, most human.", levels: ["literary", "colloquial", "verbatim"],
    render: (v) => v === "literary" ? "literary dialogue" : v === "colloquial" ? "casual colloquial dialogue" : "raw verbatim dialogue" },
  { key: "heat", label: "Intensity", desc: "violence/darkness level", help: "Violence/darkness ceiling. restrained = fade to black; grounded = honest but not lingering; unflinching = looks straight at it; visceral = everything felt in the body.", levels: ["restrained", "grounded", "unflinching", "visceral"],
    render: (v) => v === "restrained" ? "restrained intensity, fade to black" : `${v} intensity` },
  { key: "intimacy", label: "Intimacy", desc: "romantic explicitness (adults, consensual)", help: "How far romance goes, for adult characters. discreet = chaste, fade to black; romantic = sensual but never explicit; explicit = adult intimacy may be explicit.", levels: ["discreet", "romantic", "explicit"],
    render: (v) => v === "discreet" ? "romance stays chaste; intimate scenes fade to black" : v === "romantic" ? "sensual romantic content, nothing explicit" : "adult intimacy may be explicit" },
  { key: "profanity", label: "Profanity", desc: "swearing level", help: "Swearing. none = clean mouths; mild = damns and hells where in character; strong = full sailor where the voice earns it.", levels: ["none", "mild", "strong"],
    render: (v) => v === "none" ? "no profanity" : v === "mild" ? "mild profanity where in character" : "strong language where it fits" },
  { key: "combat", label: "Combat choreography", desc: "fight-scene style", help: "Fight-scene style. stylized = cool poses; cinematic = camera-work and pacing; brutal = fast, ugly, consequential; realistic = trained, tactical, tiring.", levels: ["stylized", "cinematic", "brutal", "realistic"],
    render: (v) => `${v} combat` },
  { key: "consequences", label: "Consequence persistence", desc: "do actions stick", help: "Do actions stick? reset = each scene starts clean; soft = bruises fade; persistent = wounds and debts carry; realistic = nothing is free.", levels: ["reset", "soft", "persistent", "realistic"],
    render: (v) => v === "reset" ? "consequences reset each scene" : v === "soft" ? "soft consequences" : v === "realistic" ? "realistic lasting consequences" : "persistent consequences" },
  { key: "change", label: "Character change", desc: "how people evolve", help: "How people evolve. fluid = change fast; responsive = adapt to events; resistant = dig in; entrenched = never change, ever — good for walls, bad for arcs.", levels: ["fluid", "responsive", "resistant", "entrenched"],
    render: (v) => v === "fluid" ? "characters change fluidly" : v === "responsive" ? "characters respond and adapt" : v === "resistant" ? "characters resist change" : "characters stay entrenched" },
  { key: "vocab", label: "Vocabulary", desc: "word richness", help: "Word richness. plain = simple words; clean = tidy neutral; literary = chosen words; purple = lush, ornate, maximum velvet.", levels: ["plain", "clean", "literary", "purple"],
    render: (v) => v === "plain" ? "plain vocabulary" : v === "clean" ? "clean vocabulary" : v === "literary" ? "literary vocabulary" : "lush purple vocabulary" },
  { key: "volatility", label: "Tonal volatility", desc: "how fast tone shifts", help: "How fast the tone shifts. stable = one tone all the way; shifting = tone changes scene by scene; whiplash = tone whips paragraph by paragraph. Whiplash is chaos — use on purpose.", levels: ["stable", "shifting", "whiplash"],
    render: (v) => v === "stable" ? "steady tone throughout" : v === "shifting" ? "tone shifts scene by scene" : "tone whips paragraph by paragraph" },
  { key: "depth", label: "Dialogue depth", desc: "how deep talk goes", help: "How deep talk goes. surface = plans and facts only; grounded = real feeling; layered = subtext under the words; philosophical = big ideas through small moments; realistic = layered and philosophical when earned.", levels: ["surface", "grounded", "layered", "philosophical", "realistic"],
    render: (v) => v === "surface" ? "surface-level talk: plans and facts only" : v === "grounded" ? "grounded talk with real feeling" : v === "layered" ? "layered talk: subtext under the words" : v === "philosophical" ? "philosophical talk: big ideas through small moments" : "realistic talk: layered, philosophical when earned" },
  { key: "thoughts", label: "Other minds", desc: "whose thoughts show", help: "Whose inner thoughts the narration may reveal. own = only the viewpoint character's head; open = other characters' thoughts may surface too. Open is risky with 1st person — heads blur.", levels: ["own", "open"],
    render: (v) => v === "own" ? "reveal only the viewpoint character's inner thoughts" : "other characters' inner thoughts may surface too" },
];

const dialByKey = new Map(STYLE_DIALS.map((d) => [d.key, d]));

export function listStyleDials(): StyleDial[] {
  return STYLE_DIALS;
}

export type StyleMap = Record<string, string>;

export function getStyles(): StyleMap {
  try {
    const file = getStyleFile();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      const out: StyleMap = {};
      for (const d of STYLE_DIALS) {
        const raw = parsed?.[d.key];
        if (typeof raw !== "string" || !raw.trim()) continue;
        if (d.levels) {
          const v = raw.trim().toLowerCase();
          if (d.levels.includes(v)) out[d.key] = v;
        } else {
          const parts = raw.split(",").map(free).filter(Boolean).slice(0, d.maxEntries || 3);
          if (parts.length) out[d.key] = parts.join(", ");
        }
      }
      return out;
    }
  } catch {}
  return {};
}

function writeStyles(map: StyleMap): StyleMap {
  const clean: StyleMap = {};
  for (const d of STYLE_DIALS) {
    const v = map[d.key];
    if (typeof v === "string" && v.trim()) clean[d.key] = v;
  }
  const file = getStyleFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(clean, null, 2), "utf-8");
  return clean;
}

export function setStyle(key: string, value: string): { styles: StyleMap; value: string } {
  const k = (key || "").trim().toLowerCase();
  const dial = dialByKey.get(k);
  if (!dial) throw new Error(`Unknown style dial "${key}". Dials: ${STYLE_DIALS.map((d) => d.key).join(", ")}`);
  let v: string;
  if (dial.levels) {
    v = (value || "").trim().toLowerCase();
    if (!dial.levels.includes(v)) throw new Error(`"${key}" takes: ${dial.levels.join(" | ")}`);
  } else {
    const parts = String(value || "").split(/[,\s]+/).map(free).filter(Boolean).slice(0, dial.maxEntries || 3);
    if (!parts.length) throw new Error(`Give ${dial.key} at least one tone (e.g. /style tone noir, playful).`);
    v = parts.join(", ");
  }
  const cur = getStyles();
  cur[k] = v;
  return { styles: writeStyles(cur), value: v };
}

export function clearStyle(key?: string): StyleMap {
  const cur = getStyles();
  if (!key) return writeStyles({});
  const k = key.trim().toLowerCase();
  if (!dialByKey.has(k)) throw new Error(`Unknown style dial "${key}".`);
  delete cur[k];
  return writeStyles(cur);
}

/**
 * Full explainer card for one dial: what it does, its levels, current value.
 * Shown by `/style <dial>` and as the picker's selected-row description.
 */
export function describeStyle(key: string): string {
  const k = (key || "").trim().toLowerCase();
  const dial = dialByKey.get(k);
  if (!dial) throw new Error(`Unknown style dial "${key}". Dials: ${STYLE_DIALS.map((d) => d.key).join(", ")}`);
  const cur = getStyles()[dial.key];
  const lines = [`${dial.label} (${dial.key})`, dial.help];
  lines.push(dial.levels ? `Levels: ${dial.levels.join(" | ")}` : "Levels: freeform words (e.g. /style tone noir, playful)");
  lines.push(`Current: ${cur || "off"} — set with /style ${dial.key} <level>, clear with /style clear ${dial.key}.`);
  return lines.join("\n");
}

/**
 * One compact rules line. Empty string when nothing is set (zero prompt tax —
 * this is what keeps 18 dials affordable on small local models).
 */
export function renderStyleBlock(): string {
  const cur = getStyles();
  const parts: string[] = [];
  for (const d of STYLE_DIALS) {
    const v = cur[d.key];
    if (v) parts.push(d.render(v));
  }
  if (!parts.length) return "";
  return `Narrative style (apply these rules): ${parts.join("; ")}.`;
}

/** Master-switch row id used by the interactive picker. */
export const STYLE_MASTER_ID = "style:__master__";

/**
 * Rows for the interactive /style picker (SettingsList-compatible): master
 * switch first, then one row per dial. Every row cycles [off, ...levels], so
 * → steps up, ← steps down, Enter/Space cycles, and "c" jumps to off.
 * Freeform tone can't cycle: it toggles between its current value and off
 * (custom tones are set with `/style tone <...>`).
 */
export function buildStyleSettingItems(): SettingItem[] {
  const cur = getStyles();
  const rows: SettingItem[] = [
    {
      id: STYLE_MASTER_ID,
      label: "Style system (master switch)",
      description: "Master switch for all narrative dials (also: /mykyagent toggle style)",
      currentValue: isFeatureEnabled("style") ? "enabled" : "disabled",
      values: ["enabled", "disabled"],
    },
  ];
  for (const d of STYLE_DIALS) {
    const v = cur[d.key];
    const levels = d.levels ?? (v ? [v] : []);
    rows.push({
      id: `style:${d.key}`,
      label: `${d.label} (${d.key})`,
      description: d.help + (d.levels ? ` Levels: ${d.levels.join(" | ")}` : " Set custom tones with /style tone <...>"),
      currentValue: v || "off",
      values: ["off", ...levels],
    });
  }
  return rows;
}

/**
 * Apply one picker change. Returns a short human summary (for tests/notices).
 */
export function applyStyleSettingChange(id: string, newValue: string): string {
  if (id === STYLE_MASTER_ID) {
    const on = newValue === "enabled";
    setFeatureEnabled("style", on);
    return `Style system ${on ? "ENABLED" : "DISABLED"}.`;
  }
  const key = id.startsWith("style:") ? id.slice("style:".length) : id;
  if (newValue === "off") {
    clearStyle(key);
    return `${key} off.`;
  }
  const r = setStyle(key, newValue);
  return `${key} = ${r.value}.`;
}
