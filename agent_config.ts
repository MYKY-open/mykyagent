/**
 * agent_config: one façade over MykyAgent's switch files.
 *
 * History: each killswitch grew its own file (webkill.json, webbrowser.json,
 * mcpkill.json, webmodel.json, persona.json). Behaviour stays identical, but
 * all access now funnels through here so:
 *   - env overrides keep working (tests rely on them),
 *   - legacy files are still honoured (no migration surprise),
 *   - a future single config.json can shadow them without touching callers.
 *
 * Precedence per key: env file override > legacy file > default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MEMORY_DIR = join(homedir(), ".config", "mykyagent");
const WEBKILL_FILE = join(MEMORY_DIR, "webkill.json");
const WEBBROWSER_FILE = join(MEMORY_DIR, "webbrowser.json");
const WEBMODEL_FILE = join(MEMORY_DIR, "webmodel.json");

export type BrowserMode = "auto" | "force" | "off";
export const WEB_TOOL_NAMES = ["web_search", "web_fetch"];

function readJson(file: string): any | null {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  } catch {}
  return null;
}

function writeJson(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
}

export function getWebKillFile(): string {
  return process.env.MYKYAGENT_WEBKILL_FILE || WEBKILL_FILE;
}

export function webDisabled(): boolean {
  return !!readJson(getWebKillFile())?.disabled;
}

export function setWebDisabled(disabled: boolean): void {
  writeJson(getWebKillFile(), { disabled });
}

export function getBrowserFile(): string {
  return process.env.MYKYAGENT_WEBBROWSER_FILE || WEBBROWSER_FILE;
}

export function getBrowserMode(): BrowserMode {
  const mode = readJson(getBrowserFile())?.mode;
  if (mode === "force" || mode === "off" || mode === "auto") return mode;
  return "auto";
}

export function setBrowserMode(mode: BrowserMode): void {
  writeJson(getBrowserFile(), { mode });
}

export interface WebModelConfig {
  provider: string;
  id: string;
}

export function getWebModelFile(): string {
  return process.env.MYKYAGENT_WEBMODEL_FILE || WEBMODEL_FILE;
}

export function loadWebModel(): WebModelConfig | null {
  const cfg = readJson(getWebModelFile());
  if (cfg?.provider && cfg?.id) return { provider: String(cfg.provider), id: String(cfg.id) };
  return null;
}

export function saveWebModel(cfg: WebModelConfig | null): void {
  if (cfg) writeJson(getWebModelFile(), cfg);
  else writeJson(getWebModelFile(), { follow: true });
}

/** One-line status for /web-toggle status and diagnostics. */
export function webStatusLine(): string {
  return `web tools: ${webDisabled() ? "OFF" : "ON"}, browser: ${getBrowserMode()}, distill: ${loadWebModel() ? `${loadWebModel()!.provider}/${loadWebModel()!.id}` : "follow main model"}`;
}
