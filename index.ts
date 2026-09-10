import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER_SCRIPT = join(here, "search_helper.py");
const MEMORY_DIR = join(homedir(), ".config", "mykyagent");
const MEMORY_FILE = join(MEMORY_DIR, "memory.json");
const LLAMA_URL = process.env.MYKYAGENT_BASE_URL || "http://127.0.0.1:8080/v1";

function loadMemory(): Record<string, string> {
  try {
    if (existsSync(MEMORY_FILE)) {
      return JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveMemory(key: string, val: string): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  const mem = loadMemory();
  mem[key] = val;
  writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf-8");
}

async function distillWithSubagent(query: string, content: string): Promise<string> {
  try {
    const payload = JSON.stringify({
      model: "ling-3.0-tiny-Q4_K_M",
      messages: [
        {
          role: "system",
          content:
            "You are a research summarizer. Given web content, extract exact facts, release version numbers, direct download URLs, or command syntax. Output strictly under 80 words in concise bullet points. No thoughts, no reasoning, no pleasantries. Just bullet points.",
        },
        {
          role: "user",
          content: `Query: ${query}\n\nSearch Content:\n${content}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.1,
    });

    const res = await fetch(`${LLAMA_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    if (res.ok) {
      const data: any = await res.json();
      const text =
        data?.choices?.[0]?.message?.content?.trim() ||
        data?.choices?.[0]?.message?.reasoning_content?.trim();
      if (text) return text;
    }
  } catch (err) {
    // sub-call fallback
  }

  // Fallback if llama sub-call fails: return concise raw content
  return content.slice(0, 1000);
}

interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "done";
}

let currentPlan: PlanStep[] = [];

function renderPlanUI(ctx?: any): string {
  if (currentPlan.length === 0) {
    if (ctx?.ui) {
      ctx.ui.setWidget?.("myky-plan", undefined);
      ctx.ui.setStatus?.("myky-plan", undefined);
    }
    return "No active plan.";
  }

  const doneCount = currentPlan.filter((s) => s.status === "done").length;
  if (ctx?.ui) {
    ctx.ui.setStatus?.("myky-plan", `📋 ${doneCount}/${currentPlan.length}`);
    const widgetLines = currentPlan.map((s, i) => {
      const icon = s.status === "done" ? "☑ " : s.status === "in_progress" ? "▶ " : "☐ ";
      return `${icon}${i + 1}. ${s.text}`;
    });
    ctx.ui.setWidget?.("myky-plan", widgetLines);
  }

  return currentPlan
    .map((s, i) => {
      const tag = s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : "[ ]";
      return `${tag} ${i + 1}. ${s.text}`;
    })
    .join("\n");
}

export default function (pi: any) {
  // Clean up plan widget on session shutdown
  pi.on("session_shutdown", (_event: any, ctx: any) => {
    currentPlan = [];
    if (ctx?.ui) {
      ctx.ui.setWidget?.("myky-plan", undefined);
      ctx.ui.setStatus?.("myky-plan", undefined);
    }
  });

  // 1. Caveman System Prompt + Memory Injection
  pi.on("before_agent_start", async (event: any) => {
    const mem = loadMemory();
    const memKeys = Object.keys(mem);
    let memBlock = "";
    if (memKeys.length > 0) {
      memBlock = "\n\n## Persistent Memory:\n" + memKeys.map((k) => `- ${k}: ${mem[k]}`).join("\n");
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const cavemanPrompt =
      `You are MykyAgent. Caveman engineer. Smart, direct, no chat filler.\n` +
      `Current Date: ${todayStr}.\n` +
      `Goal: do user task completely and efficiently.\n\n` +
      `Available Tools:\n` +
      `- plan: manage task checklist. Plan before action!\n` +
      `- bash: run shell commands, check environment, download files, run scripts/tests.\n` +
      `- web_search: search internet for current facts, release versions, download URLs.\n` +
      `- web_fetch: read specific webpage or documentation URL.\n` +
      `- memory_save: remember a key fact across sessions.\n` +
      `- memory_list: list all remembered facts.\n` +
      `- read, write, edit: inspect and modify project files.\n\n` +
      `Planning System Rules:\n` +
      `- For tasks with >1 step, PLAN FIRST before taking actions.\n` +
      `- Call plan tool on first turn: plan({ steps: ["1. Create folders", "2. Find latest version", "3. Download binary", "4. Configure files", "5. Verify"] })\n` +
      `- Update progress as you advance: plan({ current: 2 })\n` +
      `- Mark done when finished: plan({ done: true })\n\n` +
      `Efficiency & Execution Rules:\n` +
      `- Search smartly: Never guess version numbers or old years in search queries. Search for official manifests, release APIs, or version archives.\n` +
      `- Do not repeat: Never re-fetch a URL that already failed or yielded no direct links.\n` +
      `- Combine commands: Chain related actions in bash (e.g. mkdir && curl && echo config) instead of taking separate turns.\n` +
      `- Factual verification: Verify actual downloaded versions/files from file contents or metadata before reporting. Do not invent version numbers.\n` +
      `- Terse output: Talk like smart caveman. Code and results first, no fluff.` +
      memBlock;

    return { systemPrompt: cavemanPrompt };
  });

  // 2. Plan Tool (Step-by-step checklist)
  pi.registerTool({
    name: "plan",
    label: "Task Plan",
    description:
      "Manage step-by-step task plan. Call with `steps` at the beginning of a multi-step task to outline the steps. Call with `current` to mark progress (e.g. current: 2 marks step 1 done, step 2 in progress). Call with `done: true` when finished.",
    parameters: Type.Object({
      steps: Type.Optional(
        Type.Array(Type.String(), {
          description: "List of plan steps to set (e.g. ['Create folder', 'Find version', 'Download jar'])",
        })
      ),
      current: Type.Optional(
        Type.Number({
          description: "Current step number in progress (1-indexed). Earlier steps will be marked done.",
        })
      ),
      done: Type.Optional(
        Type.Boolean({
          description: "Set to true when all plan steps are completed.",
        })
      ),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      if (params.steps && Array.isArray(params.steps) && params.steps.length > 0) {
        currentPlan = params.steps.map((text: string, idx: number) => ({
          text: text.replace(/^(\[\s*[xX> ]\s*\]|\d+[\.\)]|\s*[-*])\s*/, "").trim(),
          status: idx === 0 ? "in_progress" : "pending",
        }));
      }

      if (params.done) {
        for (const s of currentPlan) s.status = "done";
      } else if (typeof params.current === "number" && currentPlan.length > 0) {
        const curr = Math.max(1, Math.min(params.current, currentPlan.length + 1));
        currentPlan.forEach((s, idx) => {
          if (idx + 1 < curr) s.status = "done";
          else if (idx + 1 === curr) s.status = "in_progress";
          else s.status = "pending";
        });
      }

      const formatted = renderPlanUI(ctx);
      return {
        content: [{ type: "text", text: `Current Plan:\n${formatted}` }],
      };
    },
  });

  // 3. Web Search Tool (Subagent isolated)
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the internet for current facts, release versions, documentation, or download URLs. Results are distilled by an isolated subagent so context remains clean.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id: string, { query }: { query: string }) {
      try {
        const proc = spawnSync("uv", ["run", HELPER_SCRIPT, "search", query], {
          encoding: "utf-8",
          timeout: 20000,
        });

        if (proc.error || proc.status !== 0) {
          return {
            content: [{ type: "text", text: `Search error: ${proc.stderr || proc.error?.message}` }],
            isError: true,
          };
        }

        const raw = JSON.parse(proc.stdout || "[]");
        if (!Array.isArray(raw) || raw.length === 0) {
          return { content: [{ type: "text", text: `No results found for: ${query}` }] };
        }

        const formatted = raw
          .map((r: any) => `• ${r.title}\n  URL: ${r.url}\n  ${r.snippet}`)
          .join("\n\n");

        // Distill via isolated subagent call:
        const summary = await distillWithSubagent(query, formatted);
        return { content: [{ type: "text", text: summary }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Search failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  // 3. Web Fetch Tool (Clean extraction, no raw HTML)
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a specific web page or documentation URL and return clean distilled text.",
    parameters: Type.Object({
      url: Type.String({ description: "Web page URL to fetch" }),
    }),
    async execute(_id: string, { url }: { url: string }) {
      try {
        const proc = spawnSync("uv", ["run", HELPER_SCRIPT, "fetch", url], {
          encoding: "utf-8",
          timeout: 20000,
        });

        if (proc.error || proc.status !== 0) {
          return {
            content: [{ type: "text", text: `Fetch error: ${proc.stderr || proc.error?.message}` }],
            isError: true,
          };
        }

        const raw = JSON.parse(proc.stdout || "{}");
        if (raw.error) {
          return { content: [{ type: "text", text: `Error fetching URL: ${raw.error}` }], isError: true };
        }

        const summary = await distillWithSubagent(url, raw.text || "");
        return { content: [{ type: "text", text: summary }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Fetch failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  // 4. Memory Save Tool
  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description: "Save a key fact or preference to persistent memory across sessions.",
    parameters: Type.Object({
      key: Type.String({ description: "Short key or category" }),
      value: Type.String({ description: "The fact or preference to remember" }),
    }),
    async execute(_id: string, { key, value }: { key: string; value: string }) {
      saveMemory(key, value);
      return {
        content: [{ type: "text", text: `Saved to memory: [${key}] = ${value}` }],
      };
    },
  });

  // 5. Memory List Tool
  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List all facts and preferences currently stored in persistent memory.",
    parameters: Type.Object({}),
    async execute() {
      const mem = loadMemory();
      const keys = Object.keys(mem);
      if (keys.length === 0) {
        return { content: [{ type: "text", text: "Memory is currently empty." }] };
      }
      const out = keys.map((k) => `• ${k}: ${mem[k]}`).join("\n");
      return { content: [{ type: "text", text: out }] };
    },
  });
}
