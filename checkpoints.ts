/**
 * Checkpoints: undo for write/edit, no permission gates attached.
 *
 * The tool_call hook snapshots a file's pre-write content; /rewind restores.
 * Ring buffer (last 20), 100KB/file cap, unchanged-content writes skipped.
 * Store: MYKYAGENT_CHECKPOINTS_DIR or ~/.config/mykyagent/checkpoints/.
 * Pi-free. Restores mkdir -p the original path.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface CheckpointEntry {
  id: string; // sortable: <epoch_ms>-<slug>
  time: string; // ISO
  path: string; // absolute original path
  bytes: number;
}

const KEEP = 20;
const FILE_CAP = 100 * 1024;
let seq = 0;

export function checkpointsDir(): string {
  return process.env.MYKYAGENT_CHECKPOINTS_DIR || join(homedir(), ".config", "mykyagent", "checkpoints");
}

function manifestPath(): string {
  return join(checkpointsDir(), "manifest.json");
}

export function loadManifest(): CheckpointEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e: any) => e && typeof e.id === "string" && typeof e.path === "string");
  } catch {
    return [];
  }
}

function saveManifest(entries: CheckpointEntry[]): void {
  mkdirSync(checkpointsDir(), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

function slugOf(absPath: string): string {
  return absPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-40);
}

/** Snapshot current content of an absolute path. Returns entry or null (missing/too big/unchanged). */
export function snapshotFile(absPath: string): CheckpointEntry | null {
  let content: Buffer;
  try {
    content = readFileSync(absPath) as Buffer;
  } catch {
    return null; // new file or unreadable — nothing to restore
  }
  if (content.length > FILE_CAP) return null;
  const entries = loadManifest();
  const latest = entries.filter((e) => e.path === absPath).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  if (latest) {
    try {
      const prev = readFileSync(join(checkpointsDir(), `${latest.id}.bak`));
      if (prev.equals(content)) return null; // unchanged — don't spam the ring
    } catch {}
  }
  const id = `${Date.now()}-${String(seq++).padStart(4, "0")}-${slugOf(absPath)}`;
  mkdirSync(checkpointsDir(), { recursive: true });
  writeFileSync(join(checkpointsDir(), `${id}.bak`), content);
  const entry: CheckpointEntry = { id, time: new Date().toISOString(), path: absPath, bytes: content.length };
  entries.push(entry);
  // Prune oldest beyond KEEP (manifest + files).
  entries.sort((a, b) => (a.id < b.id ? -1 : 1));
  while (entries.length > KEEP) {
    const drop = entries.shift()!;
    try {
      rmSync(join(checkpointsDir(), `${drop.id}.bak`), { force: true });
    } catch {}
  }
  saveManifest(entries);
  return entry;
}

/** Newest-first. */
export function listCheckpoints(): CheckpointEntry[] {
  return loadManifest().sort((a, b) => (a.id < b.id ? 1 : -1));
}

/**
 * Restore by 1-based position in listCheckpoints() (default 1 = latest)
 * or by id prefix. Returns the restored path.
 */
export function restoreCheckpoint(target?: string | number): string {
  const list = listCheckpoints();
  if (list.length === 0) throw new Error("No checkpoints.");
  let entry: CheckpointEntry | undefined;
  if (target === undefined || target === "") {
    entry = list[0];
  } else if (Number.isInteger(Number(target)) && Number(target) > 0) {
    entry = list[Number(target) - 1];
  } else {
    entry = list.find((e) => e.id.startsWith(String(target)));
  }
  if (!entry) throw new Error(`No checkpoint matches "${target}".`);
  const content = readFileSync(join(checkpointsDir(), `${entry.id}.bak`));
  mkdirSync(dirname(entry.path), { recursive: true });
  writeFileSync(entry.path, content);
  return entry.path;
}

/** Resolve a tool-call path against cwd (mirrors the read tool). */
export function resolveToolPath(cwd: string, p: string): string {
  return resolve(cwd || process.cwd(), p);
}
