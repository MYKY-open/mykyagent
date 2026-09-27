/**
 * Non-coding RPG / interactive-fiction state tools for game-master scenarios.
 *
 * dice_roll("2d6+3")  — crypto-RNG tabletop dice (NdM +/- K, incl. dF fudge)
 * game_state          — persistent key/value state (dotted keys) per campaign
 * advance_time        — in-world clock: hours/minutes/days, day/night cycle
 *
 * Storage: ~/.config/mykyagent/gamestate/<slug>.json (env: MYKYAGENT_GAMESTATE_DIR)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const GAMESTATE_DIR = join(homedir(), ".config", "mykyagent", "gamestate");

function getStateDir(): string {
  return process.env.MYKYAGENT_GAMESTATE_DIR || GAMESTATE_DIR;
}

function statePath(slug: string): string {
  const clean = (slug || "default").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-") || "default";
  return join(getStateDir(), `${clean}.json`);
}

export function loadGameState(slug: string = "default"): Record<string, any> {
  const p = statePath(slug);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveGameState(slug: string, state: Record<string, any>): void {
  const p = statePath(slug);
  mkdirSync(getStateDir(), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

export function resetGameState(slug: string = "default"): void {
  const p = statePath(slug);
  if (existsSync(p)) {
    try {
      rmSync(p);
    } catch {}
  }
}

// --- dotted key paths ---------------------------------------------------------

export function getStateValue(state: Record<string, any>, key: string): any {
  if (!key) return undefined;
  let cur: any = state;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setStateValue(state: Record<string, any>, key: string, value: any): void {
  const parts = key.split(".").filter(Boolean);
  if (!parts.length) throw new Error("key must not be empty");
  let cur = state;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// --- dice ----------------------------------------------------------------------

export interface DiceRollResult {
  spec: string;
  rolls: number[];
  modifier: number;
  total: number;
}

/**
 * Parse and roll dice specs: "d20", "2d6+3", "4dF", "3d10-2", "2d20kh1"
 * (keep highest n). Returns null for unparseable/absurd specs.
 */
export function rollDice(spec: string): DiceRollResult | null {
  const m = /^\s*(\d{0,3})d(\d{1,4}|F)(?:(kh|kl)(\d{1,3}))?\s*(?:([+-])\s*(\d{1,4}))?\s*$/i.exec(spec);
  if (!m) return null;
  const count = Math.min(Math.max(parseInt(m[1] || "1", 10) || 1, 1), 100);
  const dieRaw = m[2];
  const keep = m[3] as "kh" | "kl" | undefined;
  const keepN = keep ? Math.min(parseInt(m[4], 10) || 1, count) : undefined;
  const sign = m[5] === "-" ? -1 : 1;
  const modifier = m[6] ? sign * parseInt(m[6], 10) : 0;

  let rolls: number[];
  if (dieRaw.toUpperCase() === "F") {
    // Fudge dice: -1, 0, +1
    rolls = Array.from({ length: count }, () => randomInt(-1, 2));
  } else {
    const sides = parseInt(dieRaw, 10);
    if (sides < 2) return null;
    rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
  }

  let counted = rolls;
  if (keep && keepN !== undefined) {
    const sorted = [...rolls].sort((a, b) => (keep === "kh" ? b - a : a - b));
    counted = sorted.slice(0, keepN);
  }

  const total = counted.reduce((a, b) => a + b, 0) + modifier;
  return { spec: spec.trim(), rolls, modifier, total };
}

// --- in-world time --------------------------------------------------------------

export interface WorldTime {
  day: number;
  hour: number;
  minute: number;
}

export function getWorldTime(state: Record<string, any>): WorldTime {
  const t = state?.world?.time;
  if (
    t &&
    typeof t.day === "number" &&
    typeof t.hour === "number" &&
    typeof t.minute === "number"
  ) {
    return { day: t.day, hour: t.hour, minute: t.minute };
  }
  // Campaign start: Day 1, 08:00
  return { day: 1, hour: 8, minute: 0 };
}

export function advanceWorldTime(state: Record<string, any>, hours = 0, minutes = 0, days = 0): WorldTime {
  const t = getWorldTime(state);
  let total = t.day * 1440 + t.hour * 60 + t.minute;
  total += days * 1440 + hours * 60 + minutes;
  total = Math.max(0, total);
  // day is 1-based and already encoded in total (day 1 = 1440), so no +1 here.
  const day = Math.max(1, Math.floor(total / 1440));
  const hour = Math.floor((total % 1440) / 60);
  const minute = total % 60;
  const nt = { day, hour, minute };
  setStateValue(state, "world.time", nt);
  return nt;
}

export function describeWorldTime(t: WorldTime): string {
  const phase =
    t.hour < 5 ? "deep night" : t.hour < 8 ? "dawn" : t.hour < 12 ? "morning" : t.hour < 17 ? "afternoon" : t.hour < 21 ? "evening" : "night";
  return `Day ${t.day}, ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")} (${phase})`;
}
