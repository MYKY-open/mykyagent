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

let activeModelInfo: any = null;

function getOpenRouterKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      return auth?.openrouter?.key;
    }
  } catch {}
  return undefined;
}

async function distillWithSubagent(query: string, content: string, modelInfo?: any): Promise<string> {
  const active = modelInfo || activeModelInfo;
  const isCloudOpenRouter =
    active?.provider === "openrouter" ||
    active?.id?.includes("deepseek") ||
    active?.id?.includes("/");

  const openrouterKey = getOpenRouterKey();

  let endpoint = `${LLAMA_URL}/chat/completions`;
  let modelName = "ling-3.0-tiny-Q4_K_M";
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (isCloudOpenRouter && openrouterKey) {
    endpoint = "https://openrouter.ai/api/v1/chat/completions";
    modelName = active?.id || "deepseek/deepseek-v4-flash-0731";
    headers["Authorization"] = `Bearer ${openrouterKey}`;
  }

  try {
    const payload = JSON.stringify({
      model: modelName,
      messages: [
        {
          role: "system",
          content:
            "You are a technical research summarizer. Given web content, extract relevant code snippets, API signatures, commands, syntax, options, or facts needed to answer the query. Be direct, concise, and technical. Retain complete code blocks, URLs, and commands without trimming. No conversational fluff or pleasantries.",
        },
        {
          role: "user",
          content: `Query: ${query}\n\nSearch Content:\n${content}`,
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
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

  // Fallback if sub-call fails: return concise raw content
  return content.slice(0, 50000);
}

export default function (pi: any) {
  // 1. Caveman System Prompt + Memory Injection
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    activeModelInfo = ctx?.getModel?.();
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
      `- bash: run shell commands, check environment, download files, run scripts/tests.\n` +
      `- web_research: deep multi-page autonomous research for finding verified download links, real versions, API specs, or code across multiple sites.\n` +
      `- web_search: search internet for current facts, release versions, download URLs, docs.\n` +
      `- web_fetch: read specific webpage or documentation URL (full text, code blocks, tables).\n` +
      `- memory_save: remember a key fact across sessions.\n` +
      `- memory_list: list all remembered facts.\n` +
      `- read, write, edit: inspect and modify project files.\n\n` +
      `Planning Rules (Internal):\n` +
      `- For tasks with >1 step, state a simple 3-5 step plan at start before taking action (e.g. 1. Create folders, 2. Find version, 3. Download/configure, 4. Verify).\n` +
      `- Follow steps sequentially. Do not wander or skip steps.\n\n` +
      `Efficiency & Execution Rules:\n` +
      `- Use web_research when you need verified download links, real versions, official APIs, or complex documentation across multiple pages.\n` +
      `- Never invent or guess hashes, version numbers, or download URLs. Only use verified data from web_research/web_fetch.\n` +
      `- Search smartly: Never guess version numbers or old years in search queries. Search for official manifests, release APIs, or version archives.\n` +
      `- Do not repeat: Never re-fetch a URL that already failed or yielded no direct links.\n` +
      `- Combine commands: Chain related actions in bash (e.g. mkdir && curl && echo config) instead of taking separate turns.\n` +
      `- Factual verification: Verify actual downloaded versions/files from file contents or metadata before reporting. Do not invent version numbers.\n` +
      `- Terse output: Talk like smart caveman. Code and results first, no fluff.` +
      memBlock;

    return { systemPrompt: cavemanPrompt };
  });

  // 2. Web Deep Research Tool (Autonomous multi-hop crawl and factual verification)
  pi.registerTool({
    name: "web_research",
    label: "Web Deep Research",
    description:
      "Perform deep, autonomous web research. Searches the web, crawls candidate pages in parallel, extracts direct download links, API specs, and code snippets, and returns a verified technical synthesis.",
    parameters: Type.Object({
      query: Type.String({ description: "Research query or goal (e.g. download links, API usage, library documentation)" }),
    }),
    async execute(_id: string, { query }: { query: string }, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const proc = spawnSync("uv", ["run", HELPER_SCRIPT, "research", query], {
          encoding: "utf-8",
          timeout: 45000,
        });

        if (proc.error || proc.status !== 0) {
          return {
            content: [{ type: "text", text: `Research error: ${proc.stderr || proc.error?.message}` }],
            isError: true,
          };
        }

        const raw = JSON.parse(proc.stdout || "{}");
        if (raw.error) {
          return { content: [{ type: "text", text: `Error during research: ${raw.error}` }], isError: true };
        }

        let bundle = `Query: ${query}\n\n`;
        if (Array.isArray(raw.direct_links) && raw.direct_links.length > 0) {
          bundle += `## Discovered Direct Download / Resource Links:\n${raw.direct_links.join("\n")}\n\n`;
        }

        if (Array.isArray(raw.pages) && raw.pages.length > 0) {
          bundle += `## Crawled Web Pages:\n` + raw.pages.map((p: any) => `### Source: ${p.url}\n${p.content}`).join("\n\n---\n\n");
        } else if (Array.isArray(raw.search_snippets) && raw.search_snippets.length > 0) {
          bundle += `## Search Snippets:\n` + raw.search_snippets.map((s: any) => `• ${s.title} (${s.url}): ${s.snippet}`).join("\n");
        }

        // Distill via isolated subagent call:
        const summary = await distillWithSubagent(query, bundle, ctx?.model);
        return { content: [{ type: "text", text: summary }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Research failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  // 3. Web Search Tool (Returns direct titles, URLs, and snippets)
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the internet for current facts, release versions, documentation, or links. Returns titles, URLs, and summaries.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id: string, { query }: { query: string }, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const proc = spawnSync("uv", ["run", HELPER_SCRIPT, "search", query], {
          encoding: "utf-8",
          timeout: 30000,
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
          .map((r: any, idx: number) => `${idx + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
          .join("\n\n");

        return { content: [{ type: "text", text: `Found ${raw.length} results for "${query}":\n\n${formatted}` }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Search failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  // 3. Web Fetch Tool (Clean extraction, full code/table preservation, optional focus query)
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a specific web page or documentation URL. Returns clean markdown, code snippets, and tables.",
    parameters: Type.Object({
      url: Type.String({ description: "Web page or documentation URL to fetch" }),
      query: Type.Optional(
        Type.String({
          description: "Optional specific topic or question to distill from the page. If omitted, returns full text and code blocks.",
        })
      ),
    }),
    async execute(_id: string, { url, query }: { url: string; query?: string }, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const proc = spawnSync("uv", ["run", HELPER_SCRIPT, "fetch", url], {
          encoding: "utf-8",
          timeout: 35000,
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

        const text = raw.text || "";
        if (query && query.trim().length > 0) {
          const summary = await distillWithSubagent(query, text, ctx?.model);
          return { content: [{ type: "text", text: summary }] };
        }

        return { content: [{ type: "text", text }] };
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
