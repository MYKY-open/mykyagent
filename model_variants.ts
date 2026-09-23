/**
 * OpenRouter model variants (:free, :nitro, :floor, :thinking, ...).
 *
 * OpenRouter accepts variant suffixes on any model id (e.g.
 * "z-ai/glm-5.3-flash:floor"), but its /models catalog only lists base ids
 * (plus some :free entries). pi's model registry is built from that catalog,
 * so variant ids are unselectable everywhere (/model picker, /model-web, ...).
 *
 * Fix: materialize the variant as a REAL model entry in
 * ~/.pi/agent/models.json under providers.openrouter.models. pi's composer
 * (applyModelsJson) upserts those onto the built-in openrouter catalog by id,
 * and the id is sent verbatim to the OpenRouter API — so the variant streams
 * natively, with correct auth and headers. The base model's metadata is
 * cloned from the live registry, or fetched from OpenRouter's public catalog
 * when the registry doesn't know the base model yet.
 *
 * Plain (suffixless) ids work too: pi refreshes openrouter from pi.dev's
 * catalog mirror, which lacks some models (e.g. stealth/*), so a plain add
 * rescues them from OpenRouter's live /models endpoint.
 *
 * The base id must NOT already be a variant entry (no nested variants).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function modelsJsonPath(): string {
  return process.env.MYKYAGENT_MODELS_JSON || join(homedir(), ".pi", "agent", "models.json");
}

/** Known suffixes and the metadata tweaks the variant implies. */
const VARIANT_HINTS: Record<string, { costZero?: boolean; reasoning?: boolean; note: string }> = {
  free: { costZero: true, note: "$0 pricing (rate-limited pool)" },
  nitro: { note: "fastest endpoint, same price" },
  floor: { note: "guaranteed floor price" },
  thinking: { reasoning: true, note: "reasoning variant" },
  online: { note: "web-grounded results" },
  exacto: { note: "precision-tuned" },
};
const KNOWN_SUFFIXES = Object.keys(VARIANT_HINTS);
/** Exported for /model-variant argument autocompletion. */
export const suffixHints = () => VARIANT_HINTS;

export interface ParsedTarget {
  base: string; // "z-ai/glm-5.3-flash"
  suffix: string; // "floor" ("" when no suffix — plain model add)
  variantId: string; // "z-ai/glm-5.3-flash:floor" (or just base)
  known: boolean;
}

/** Parse "<provider/>base[:suffix]" (provider prefix tolerated, dropped).
 *  A plain id (no suffix) is also valid — lets /model-variant rescue models
 *  missing from pi's catalog (e.g. stealth/ models pi.dev doesn't mirror). */
export function parseTarget(raw: string): ParsedTarget | { error: string } {
  const trimmed = raw.trim().replace(/^openrouter\//, "");
  if (!trimmed) return { error: "empty target" };
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) {
    return { base: trimmed, suffix: "", variantId: trimmed, known: false };
  }
  if (colon === 0) return { error: `missing base id (e.g. ${trimmed}z-ai/model:floor)` };
  if (colon === trimmed.length - 1) {
    return { error: `empty suffix after ":" (e.g. ${trimmed}floor)` };
  }
  const base = trimmed.slice(0, colon);
  const suffix = trimmed.slice(colon + 1);
  if (!/^[a-z0-9_-]+$/i.test(suffix)) return { error: `invalid suffix ":${suffix}"` };
  // Catalog base ids never contain "\:" — a colon here means a nested variant
  // ("x:y:free") or malformed input; both unresolvable against the catalog.
  if (base.includes(":")) return { error: `nested variants not supported ("${base}")` };
  return { base, suffix, variantId: `${base}:${suffix}`, known: KNOWN_SUFFIXES.includes(suffix) };
}

interface VariantDefinition {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
}

function readModelsJson(): any {
  const path = modelsJsonPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeModelsJson(doc: any): { ok: true } | { ok: false; error: string } {
  try {
    writeFileSync(modelsJsonPath(), JSON.stringify(doc, null, 2) + "\n", "utf-8");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Current entries under providers.openrouter.models (variants AND plain
 *  rescued models — anything /model-variant or the user put there). */
export function listVariants(): VariantDefinition[] {
  try {
    const doc = readModelsJson();
    const models = doc?.providers?.openrouter?.models;
    return Array.isArray(models) ? models.filter((m: any) => typeof m?.id === "string") : [];
  } catch {
    return [];
  }
}

/** pi's models.json schema only allows input modalities "text" | "image"
 *  (TypeBox Literal union). OpenRouter's live catalog advertises "video" etc. —
 *  an unsanitized array makes pi reject the WHOLE models.json at startup. */
export function sanitizeInput(modalities: unknown): string[] {
  const allowed = ["text", "image"];
  if (Array.isArray(modalities)) {
    const filtered = modalities.filter((m: any) => allowed.includes(m));
    if (filtered.length) return filtered;
  }
  return ["text"];
}

/** OpenRouter public catalog (no auth needed) — fallback when the registry
 *  doesn't know the base model (stale pi model cache, brand-new release). */
async function fetchBaseFromCatalog(base: string): Promise<VariantDefinition | { error: string }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `OpenRouter catalog HTTP ${res.status}` };
    const data: any = await res.json();
    const entry = data?.data?.find((m: any) => m?.id === base);
    if (!entry) return { error: `base model "${base}" not in OpenRouter catalog` };
    const perMil = (v: any) => {
      const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
      return Number.isFinite(n) ? n * 1_000_000 : 0;
    };
    const maxTokens = entry?.top_provider?.max_completion_tokens;
    const contextWindow = entry?.context_length;
    return {
      id: base,
      name: entry.name ?? base,
      api: "openai-completions",
      reasoning: Array.isArray(entry?.supported_parameters) ? entry.supported_parameters.includes("reasoning") : false,
      input: sanitizeInput(entry?.architecture?.input_modalities),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000,
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      cost: {
        input: perMil(entry?.pricing?.prompt),
        output: perMil(entry?.pricing?.completion),
        cacheRead: perMil(entry?.pricing?.input_cache_read),
        cacheWrite: 0,
      },
    };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

/** Clone base metadata from the live pi registry. */
function cloneFromRegistry(registry: any, base: string): VariantDefinition | null {
  const model = registry?.find?.("openrouter", base) ?? null;
  if (!model) return null;
  const clone: any = JSON.parse(JSON.stringify(model));
  delete clone.provider;
  delete clone.baseUrl;
  return clone as VariantDefinition;
}

/** Add (or update) a variant entry in models.json. Does NOT refresh the live
 *  registry — call /model-refresh (or reopen /model) afterwards. */
export async function addVariant(
  raw: string,
  registry?: any
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const parsed = parseTarget(raw);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const { base, suffix, variantId } = parsed;

  // Plain add of a model pi already knows: nothing to rescue, upserting a
  // clone would only shadow the catalog entry.
  if (!suffix && registry?.find?.("openrouter", base)) {
    return { ok: true, message: `openrouter/${base} is already in pi's catalog — nothing to add.` };
  }

  let def: VariantDefinition | { error: string } | null = cloneFromRegistry(registry, base);
  if (!def) def = await fetchBaseFromCatalog(base);
  if (!def || "error" in def) {
    const err = def && "error" in def ? def.error : "unknown failure";
    return { ok: false, error: `cannot resolve base "${base}": ${err}` };
  }

  const hint = suffixHints()[suffix];
  const entry: VariantDefinition = {
    ...def,
    id: variantId,
    name: suffix ? `${def.name ?? base} (${suffix})` : (def.name ?? base),
    ...(hint?.reasoning ? { reasoning: true } : {}),
    ...(hint?.costZero ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}),
  };

  let doc: any;
  try {
    doc = readModelsJson();
  } catch (err: any) {
    return { ok: false, error: `models.json unparseable: ${err?.message ?? err}` };
  }
  doc.providers = doc.providers ?? {};
  doc.providers.openrouter = doc.providers.openrouter ?? {};
  const models: any[] = Array.isArray(doc.providers.openrouter.models) ? doc.providers.openrouter.models : [];
  const idx = models.findIndex((m: any) => m?.id === variantId);
  const replaced = idx >= 0;
  if (idx >= 0) models[idx] = entry;
  else models.push(entry);
  doc.providers.openrouter.models = models;

  const res = writeModelsJson(doc);
  if (!res.ok) return { ok: false, error: `write failed: ${res.error}` };
  const note = suffix ? (hint?.note ? ` (${hint.note})` : "") : " (rescued from OpenRouter's live catalog — not in pi's pi.dev mirror)";
  return {
    ok: true,
    message: `${replaced ? "Updated" : "Added"} openrouter/${variantId} in models.json${note}\nRun /model-refresh (or reopen /model) to use it now.`,
  };
}

/** Remove a variant entry by full id ("z-ai/glm-5.3-flash:floor"). */
export function removeVariant(variantId: string): { ok: true; message: string } | { ok: false; error: string } {
  let doc: any;
  try {
    doc = readModelsJson();
  } catch (err: any) {
    return { ok: false, error: `models.json unparseable: ${err?.message ?? err}` };
  }
  const models = doc?.providers?.openrouter?.models;
  if (!Array.isArray(models)) return { ok: false, error: "no openrouter models in models.json" };
  const idx = models.findIndex((m: any) => m?.id === variantId);
  if (idx < 0) return { ok: false, error: `"${variantId}" not in models.json (see /model-variant list)` };
  models.splice(idx, 1);
  if (!models.length) {
    delete doc.providers.openrouter.models;
    if (!Object.keys(doc.providers.openrouter).length) delete doc.providers.openrouter;
    if (!Object.keys(doc.providers).length) delete doc.providers;
  }
  const res = writeModelsJson(doc);
  if (!res.ok) return { ok: false, error: `write failed: ${res.error}` };
  return { ok: true, message: `Removed openrouter/${variantId} from models.json.\nRun /model-refresh to drop it from the live registry.` };
}

/*
 * 2026-09-23: argument autocompletion wired in index.ts (getArgumentCompletions).
 * pi replaces the WHOLE argument text with item.value on accept, so values must
 * bake in the subcommand ("add z-ai/..."). Registry reaches completions via a
 * module-level stash filled by before_agent_start (callbacks get no ctx).
 * fuzzyFilter from @earendil-works/pi-tui splits query on whitespace + slash.
 */
