import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

  // Fallback if sub-call fails: return clean slice (up to 20,000 chars)
  return content.slice(0, 20000);
}

export default function (pi: any) {
  // 1. Caveman System Prompt + Memory Injection
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    activeModelInfo = ctx?.getModel?.();
    try {
      const currentTools = pi.getActiveTools?.() || [];
      const desired = ["read", "write", "edit", "bash", "grep", "find", "ls", "web_search", "web_fetch", "memory_save", "memory_list"];
      const merged = Array.from(new Set([...currentTools, ...desired]));
      pi.setActiveTools?.(merged);
    } catch {}

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
      `- web_search: deep internet search (autonomously crawls top candidate pages, extracts verified download links, real versions, API specs).\n` +
      `- web_fetch: read specific webpage or documentation URL (distills clean technical specs, code blocks, links without bloating context).\n` +
      `- memory_save: remember a key fact across sessions.\n` +
      `- memory_list: list all remembered facts.\n` +
      `- read: inspect file chunks (safe default: 250 lines max per call; use offset & limit for large files).\n` +
      `- grep: fast search for regex patterns, function definitions, or errors across files without reading whole files.\n` +
      `- find: locate files and paths by glob or name pattern.\n` +
      `- ls: list directory entries and structure.\n` +
      `- write, edit: create and modify project files.\n\n` +
      `Planning Rules (Internal):\n` +
      `- For tasks with >1 step, state a simple 3-5 step plan at start before taking action (e.g. 1. Create folders, 2. Find version, 3. Download/configure, 4. Verify).\n` +
      `- Follow steps sequentially. Do not wander or skip steps.\n\n` +
      `Code & Log Inspection Rules (Context Protection):\n` +
      `- NEVER cat entire large files, logs, or dependency bundles into context.\n` +
      `- For logs and debug output: always use 'tail -n 50 <log>' or grep for errors ('grep -inE "error|exception|fail" <log>') instead of cat.\n` +
      `- For code exploration: locate functions/classes first using grep or find, then read only target lines with offset and limit.\n` +
      `- Do not read more than 250 lines at a time unless strictly needed.\n\n` +
      `Efficiency & Execution Rules:\n` +
      `- Always use web_search when finding release downloads, versions, or library APIs. It crawls candidate pages and returns verified links.\n` +
      `- Never invent or guess hashes, version numbers, or download URLs. Only use verified data from web_search/web_fetch.\n` +
      `- Search smartly: Never guess version numbers or old years in search queries. Search for official manifests, release APIs, or version archives.\n` +
      `- Do not repeat: Never re-fetch a URL that already failed or yielded no direct links.\n` +
      `- Combine commands: Chain related actions in bash (e.g. mkdir && curl && echo config) instead of taking separate turns.\n` +
      `- Factual verification: Verify actual downloaded versions/files from file contents or metadata before reporting. Do not invent version numbers.\n` +
      `- Terse output: Talk like smart caveman. Code and results first, no fluff.` +
      memBlock;

    return { systemPrompt: cavemanPrompt };
  });

  // 2. Web Search Tool (Autonomous deep research & multi-hop crawl)
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the internet for current facts, release versions, documentation, or direct download links. Autonomously crawls top candidate pages and extracts verified links.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query or goal" }),
    }),
    async execute(_id: string, { query }: { query: string }, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const proc = spawnSync("uv", ["run", HELPER_SCRIPT, "research", query], {
          encoding: "utf-8",
          timeout: 45000,
        });

        if (proc.error || proc.status !== 0) {
          return {
            content: [{ type: "text", text: `Search error: ${proc.stderr || proc.error?.message}` }],
            isError: true,
          };
        }

        const raw = JSON.parse(proc.stdout || "{}");
        if (raw.error) {
          return { content: [{ type: "text", text: `Search failed: ${raw.error}` }], isError: true };
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

        const summary = await distillWithSubagent(query, bundle, ctx?.model);
        return { content: [{ type: "text", text: summary }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Search failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  // 3. Web Fetch Tool (Clean technical extraction, always distilled)
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a specific web page or documentation URL. Distills clean technical content, code snippets, and download links without bloating context.",
    parameters: Type.Object({
      url: Type.String({ description: "Web page or documentation URL to fetch" }),
      query: Type.Optional(
        Type.String({
          description: "Optional specific topic or question to distill from the page.",
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
        const extractionFocus = query && query.trim().length > 0 
          ? query 
          : "extract all code blocks, installation commands, API specifications, and download links from this page";

        const summary = await distillWithSubagent(extractionFocus, text, ctx?.model);
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

  // 6. Safe Read Tool (Protected chunk reading: default 250 lines, max 500 lines or 15KB per call)
  pi.registerTool({
    name: "read",
    label: "read",
    description:
      "Read the contents of a file in safe chunks. Defaults to 250 lines max (capped at 500 lines or 15KB) to prevent context flooding. Use offset and limit for large files.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed, default: 1)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read (default: 250, capped at 500)" })),
    }),
    async execute(_id: string, { path, offset, limit }: { path: string; offset?: number; limit?: number }, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const absPath = resolve(ctx?.cwd || process.cwd(), path);
        await access(absPath, constants.R_OK);

        const ext = path.split(".").pop()?.toLowerCase();
        if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext || "")) {
          const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          const buf = await readFile(absPath);
          return {
            content: [
              { type: "text", text: `Read image file [${mimeType}] (${Math.round(buf.length / 1024)}KB)` },
              { type: "image", data: buf.toString("base64"), mimeType },
            ],
          };
        }

        const raw = await readFile(absPath, "utf-8");
        const allLines = raw.split("\n");
        const totalLines = allLines.length;

        const effectiveLimit = Math.min(Math.max(1, limit ?? 250), 500);
        const startLine = offset ? Math.max(0, offset - 1) : 0;

        if (startLine >= totalLines) {
          return {
            content: [{ type: "text", text: `Offset ${offset} is beyond end of file (${totalLines} lines total).` }],
            isError: true,
          };
        }

        const endLine = Math.min(startLine + effectiveLimit, totalLines);
        const chunkLines = allLines.slice(startLine, endLine);
        let chunkText = chunkLines.join("\n");

        // Byte protection: max 15KB (~3500 tokens)
        const maxBytes = 15 * 1024;
        let byteTruncated = false;
        if (Buffer.byteLength(chunkText, "utf-8") > maxBytes) {
          chunkText = chunkText.slice(0, maxBytes);
          byteTruncated = true;
        }

        const remaining = totalLines - endLine;
        let footer = "";
        if (remaining > 0 || byteTruncated) {
          const nextOffset = endLine + 1;
          footer = `\n\n[Showing lines ${startLine + 1}-${endLine} of ${totalLines} (${remaining} more lines). Use offset=${nextOffset} limit=${effectiveLimit} to read next chunk, or grep to search.]`;
        } else if (startLine > 0) {
          footer = `\n\n[Showing lines ${startLine + 1}-${endLine} of ${totalLines}. End of file reached.]`;
        }

        return {
          content: [{ type: "text", text: chunkText + footer }],
          details: { totalLines, startLine: startLine + 1, endLine },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading file "${path}": ${err.message}` }],
          isError: true,
        };
      }
    },
  });
}
