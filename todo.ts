/**
 * Todo: tiny persistent scratch for multi-step work. Weak models lose the
 * thread; one compact block fixes it at ~100 tokens/turn, and only on turns
 * where todos exist (todoBlock() returns "" when empty — zero tax otherwise).
 *
 * Store: single JSON file (MYKYAGENT_TODO_FILE or ~/.config/mykyagent/todo.json).
 * Pi-free. IDs are stable numbers; done() also accepts 1-based list position.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  let block = `Open todos (${open.length}):\n${lines.join("\n")}\nMark finished work via the todo tool; add new steps as they appear; wipe the list when the task is cancelled or done.`;
  if (block.length > TODO_BLOCK_CHARS) block = block.slice(0, TODO_BLOCK_CHARS) + "…";
  if (open.length > TODO_BLOCK_ITEMS) block += ` (+${open.length - TODO_BLOCK_ITEMS} more — use the todo tool to list all)`;
  return block;
}

/** Human-facing list for /todo: open and finished, with the commands that act on them. */
export function describeTodos(): string {
  const items = loadTodos();
  if (items.length === 0) {
    return "Todos: none.\nAdd one with /todo add <text> — the model also gets the list every turn until it is wiped.";
  }
  const open = items.filter((t) => !t.done).length;
  const shown = items.slice(0, 30).map((t) => `${t.done ? "[x]" : "[ ]"} ${t.id}. ${t.text}`);
  if (items.length > shown.length) shown.push(`… +${items.length - shown.length} more`);
  return [
    `Todos: ${open} open · ${items.length - open} done`,
    ...shown,
    "",
    "/todo add <text> | done <id|text> | clear (drop finished) | wipe (drop everything)",
  ].join("\n");
}
