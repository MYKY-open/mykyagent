/**
 * Todo: tiny persistent scratch for multi-step work. Weak models lose the
 * thread; one compact block fixes it at ~100 tokens/turn, and only on turns
 * where todos exist (todoBlock() returns "" when empty — zero tax otherwise).
 *
 * Store: single JSON file (MYKYAGENT_TODO_FILE or ~/.config/mykyagent/todo.json).
 * Pi-free. IDs are stable numbers; done() also accepts 1-based list position.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  created: string;
}

const TODO_BLOCK_ITEMS = 10;
const TODO_BLOCK_CHARS = 800;

export function todoFile(): string {
  return process.env.MYKYAGENT_TODO_FILE || join(homedir(), ".config", "mykyagent", "todo.json");
}

export function loadTodos(): TodoItem[] {
  try {
    const parsed = JSON.parse(readFileSync(todoFile(), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t: any) => t && typeof t.text === "string").map((t: any) => ({
      id: Number(t.id) || 0,
      text: String(t.text),
      done: t.done === true,
      created: typeof t.created === "string" ? t.created : "",
    }));
  } catch {
    return [];
  }
}

function saveTodos(items: TodoItem[]): void {
  const file = todoFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(items, null, 2) + "\n", "utf-8");
}

export function addTodo(text: string): TodoItem {
  const clean = text.trim().slice(0, 200);
  if (!clean) throw new Error("Todo text is empty.");
  const items = loadTodos();
  const id = items.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  const item: TodoItem = { id, text: clean, done: false, created: new Date().toISOString() };
  items.push(item);
  saveTodos(items);
  return item;
}

export function doneTodo(target: string | number): TodoItem {
  const items = loadTodos();
  const open = items.filter((t) => !t.done);
  let found: TodoItem | undefined;
  const n = Number(target);
  if (Number.isInteger(n) && n > 0) {
    found = items.find((t) => t.id === n) ?? open[n - 1];
  } else {
    const q = String(target).trim().toLowerCase();
    found = open.find((t) => t.text.toLowerCase().includes(q));
  }
  if (!found) throw new Error(`No open todo matches "${target}".`);
  found.done = true;
  saveTodos(items);
  return found;
}

/** Remove done items (default) or everything (all=true). Returns removed count. */
export function clearTodos(all = false): number {
  const items = loadTodos();
  const kept = all ? [] : items.filter((t) => !t.done);
  saveTodos(kept);
  return items.length - kept.length;
}

export function openTodos(): TodoItem[] {
  return loadTodos().filter((t) => !t.done);
}

/** Prompt block, bounded. "" when nothing open. */
export function todoBlock(): string {
  const open = openTodos();
  if (open.length === 0) return "";
  const lines = open.slice(0, TODO_BLOCK_ITEMS).map((t) => `${t.id}. ${t.text}`);
  let block = `Open todos (${open.length}):\n${lines.join("\n")}\nMark finished work via the todo tool; add new steps as they appear.`;
  if (block.length > TODO_BLOCK_CHARS) block = block.slice(0, TODO_BLOCK_CHARS) + "…";
  if (open.length > TODO_BLOCK_ITEMS) block += ` (+${open.length - TODO_BLOCK_ITEMS} more — use the todo tool to list all)`;
  return block;
}
