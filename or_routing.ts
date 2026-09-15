/**
 * OpenRouter routing-preference switch, driven by /or-routing in index.ts.
 *
 * "On" persists `providers.openrouter.compat.openRouterRouting` into
 * ~/.pi/agent/models.json. pi merges provider-level compat into every model of
 * that provider (provider-composer.js mergeCompat) and openai-completions sends
 * it as the `provider` field of the OpenRouter request body — that is exactly
 * the shape of the user-facing example:
 *   { "providers": { "openrouter": { "compat": { "openRouterRouting": { "sort": "price" } } } } }
 *
 * The same state is applied per-request by index.ts's direct-HTTP distillation
 * fallback, which builds its own request payload and bypasses the compat path.
 *
 * pi loads models.json ONCE at startup (immutable ModelConfig snapshot), so
 * models.json edits from the switch take effect on the next pi start; the
 * distillation path picks them up immediately.
 *
 * Deliberately NO pi imports here: this module must bundle standalone for the
 * unit tests (pi packages have to stay --external in esbuild bundles).
 *
 * Env knobs (tests only): MYKYAGENT_MODELS_JSON, MYKYAGENT_ORROUTING_FILE.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ORRouting = Record<string, unknown>;

export function modelsJsonPath(): string {
  return process.env.MYKYAGENT_MODELS_JSON || join(homedir(), ".pi", "agent", "models.json");
}

export function orroutingStateFile(): string {
  return (
    process.env.MYKYAGENT_ORROUTING_FILE ||
    join(homedir(), ".config", "mykyagent", "orrouting.json")
  );
}

/** Stable stringification: object key order must not affect equality checks. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/** Persisted switch state: the routing object itself, or `{}` = off. Null only if unreadable/absent. */
export function loadOpenRouterRouting(): ORRouting | null {
  try {
    const file = orroutingStateFile();
    if (existsSync(file)) {
      const cfg = JSON.parse(readFileSync(file, "utf-8"));
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg) && Object.keys(cfg).length > 0) {
        return cfg as ORRouting;
      }
    }
  } catch {}
  return null;
}

export function saveOpenRouterRouting(routing: ORRouting | null): void {
  const file = orroutingStateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(routing ?? {}, null, 2) + "\n", "utf-8");
}

/** Current openRouterRouting block in models.json (what pi will actually send), or null. */
export function readOpenRouterRoutingFromModelsJson(): ORRouting | null {
  try {
    const path = modelsJsonPath();
    if (!existsSync(path)) return null;
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    const compat = cfg?.providers?.openrouter?.compat;
    const routing = compat?.openRouterRouting;
    if (routing && typeof routing === "object" && !Array.isArray(routing) && Object.keys(routing).length > 0) {
      return routing as ORRouting;
    }
  } catch {}
  return null;
}

/**
 * Write (or remove) providers.openrouter.compat.openRouterRouting in models.json.
 * Surgical: reads the file, patches ONLY our subtree, preserves everything else
 * (other providers, apiKey, baseUrl, sibling compat keys), prunes empty objects
 * on the way out so we never leave a bare `openrouter: {}` behind (pi rejects
 * provider entries with no meaningful keys).
 */
export function syncOpenRouterRoutingToModelsJson(routing: ORRouting | null): { ok: boolean; error?: string } {
  try {
    const path = modelsJsonPath();
    let cfg: any = {};
    if (existsSync(path)) {
      cfg = JSON.parse(readFileSync(path, "utf-8")) ?? {};
    }
    if (!cfg.providers || typeof cfg.providers !== "object" || Array.isArray(cfg.providers)) {
      cfg.providers = {};
    }
    const isPlain = (v: any) => v && typeof v === "object" && !Array.isArray(v);
    const entry = isPlain(cfg.providers.openrouter) ? { ...cfg.providers.openrouter } : {};

    if (routing) {
      const compat = isPlain(entry.compat) ? { ...entry.compat } : {};
      compat.openRouterRouting = routing;
      entry.compat = compat;
      cfg.providers.openrouter = entry;
    } else {
      if (isPlain(entry.compat)) {
        const compat = { ...entry.compat };
        delete compat.openRouterRouting;
        if (Object.keys(compat).length > 0) entry.compat = compat;
        else delete entry.compat;
      }
      if (Object.keys(entry).length > 0) cfg.providers.openrouter = entry;
      else delete cfg.providers.openrouter;
    }

    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Startup reconciliation between the switch state and models.json.
 * - Switch ON + models.json diverged (hand-edited, or a previous run died
 *   between the two writes): models.json follows the switch.
 * - Switch OFF but models.json carries a hand-written openRouterRouting:
 *   ADOPT it into the switch instead of clobbering the user's manual config.
 */
export function reconcileOpenRouterRouting(): void {
  const state = loadOpenRouterRouting();
  const inModels = readOpenRouterRoutingFromModelsJson();
  if (state) {
    if (canonicalJson(state) !== canonicalJson(inModels)) {
      const res = syncOpenRouterRoutingToModelsJson(state);
      if (!res.ok) {
        console.warn(`[MykyAgent] /or-routing: could not update models.json: ${res.error}`);
      }
    }
  } else if (inModels) {
    saveOpenRouterRouting(inModels);
  }
}

/**
 * Parse a /or-routing argument into a routing object.
 * `price` → {"sort":"price"}; `{...}` → verbatim object (advanced: only/order/
 * quantizations/max_price/...); anything else is rejected, never guessed.
 */
export function parseRoutingArg(raw: string): { routing: ORRouting } | { error: string } {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { error: "empty argument" };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: "expected a JSON object" };
      }
      return { routing: parsed as ORRouting };
    } catch (err: any) {
      return { error: err?.message || String(err) };
    }
  }
  if (/^[a-z][a-z0-9_-]*$/i.test(trimmed)) {
    return { routing: { sort: trimmed.toLowerCase() } };
  }
  return { error: `not a sort name or JSON object: ${trimmed}` };
}
