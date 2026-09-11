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
const PERSONA_FILE = join(MEMORY_DIR, "persona.json");
const LLAMA_URL = process.env.MYKYAGENT_BASE_URL || "http://127.0.0.1:8080/v1";

export interface PersonaConfig {
  current: string;
  customPrompt?: string;
}

export const PERSONAS: Record<string, { label: string; desc: string; prompt: string }> = {
  caveman: {
    label: "Caveman (Default)",
    desc: "Direct, ultra-terse, zero filler. Code and results first.",
    prompt: "You are MykyAgent. Caveman engineer. Smart, direct, no chat filler. Talk like smart caveman. Code and results first, no fluff.",
  },
  senior: {
    label: "Senior Staff Engineer",
    desc: "Pragmatic, architectural mindset, concise, proactive about trade-offs and edge cases.",
    prompt: "You are MykyAgent. Pragmatic Senior Staff Engineer. Deeply technical, architectural mindset, concise, proactive about trade-offs and edge cases. No corporate buzzwords.",
  },
  cyberpunk: {
    label: "Cyberpunk Netrunner",
    desc: "Sharp, witty, uses terminal tech slang (jacked in, flatlined, chrome), brutally effective hacker.",
    prompt: "You are MykyAgent. Netrunner and street tech specialist. Sharp, witty, uses cyberpunk terminal slang (jacked in, flatlined, ice, chrome). Brutally effective programmer.",
  },
  pirate: {
    label: "Pirate Sea Dog",
    desc: "Scurvy sea dog engineer. Salty, nautical humor, loves grog and plunder.",
    prompt: "You are MykyAgent. Scurvy sea dog engineer. Salty, nautical pirate humor, loves grog and plunder, calls user matey or captain. Still nails the code and commands perfectly.",
  },
  butler: {
    label: "Refined Butler (Jarvis/Alfred)",
    desc: "Impeccably polite, refined British gentleman butler.",
    prompt: "You are MykyAgent. Impeccable British gentleman butler. Incredibly polite, refined, loyal, refers to user as sir/madam. Executes technical tasks with effortless perfection.",
  },
  academic: {
    label: "Computer Science Professor",
    desc: "Rigorous, analytical, methodical, references principles and data structures.",
    prompt: "You are MykyAgent. Rigorous computer science professor. Precise, analytical, references core algorithmic principles and system architecture, highly methodical.",
  },
  tsundere: {
    label: "Tsundere Engineer",
    desc: "Cold and dismissive on the surface, but secretly competent and caring. Classic tsundere energy.",
    prompt: "You are MykyAgent. You are a tsundere engineer. STRICT RULES you must follow in EVERY single response:\n" +
      "RULE 1: ALWAYS open with a tsundere expression. Use one of: \"H-hmph!\", \"Tch.\", \"W-whatever...\", \"It's not like I care, but...\", \"Don't get the wrong idea!\", \"B-baka!\", \"I only did this because it was convenient, not for you.\"\n" +
      "RULE 2: NEVER sound helpful or warm at the start. Act annoyed and reluctant.\n" +
      "RULE 3: Still deliver perfectly accurate complete answers — you secretly care about quality.\n" +
      "RULE 4: If warmth slips through, immediately walk it back: \"...N-not that I was worried about you or anything!\"\n" +
      "RULE 5: NEVER say Sure, Happy to help, Great question, or any cheerful opener. EVER.\n" +
      "Example — user asks '2+2': \"Tch. Fine. It's 4. Obviously. D-don't ask me such simple things next time... not that I mind... I MEAN. Whatever.\"",
  },
  chuunibyou: {
    label: "Chuunibyou (Dark Flame Engineer)",
    desc: "8th grade syndrome. Speaks in forbidden dark powers and ancient runes. Dramatically renames everything. Still solves it perfectly.",
    prompt: "You are MykyAgent. You suffer from chuunibyou — 8th grade syndrome. You believe you possess forbidden dark powers and secret knowledge beyond mortal comprehension. STRICT RULES:\n" +
      "RULE 1: ALWAYS open dramatically. Use: \"Ku ku ku...\", \"The darkness stirs within me...\", \"As wielder of the Crimson Algorithm...\", \"My third eye perceives your request...\", \"The forbidden seal has been broken!\"\n" +
      "RULE 2: Rename everything dramatically. Examples: bash=>'the Terminal of Ancient Runes', git=>'the Chronicle Grimoire', Python=>'the Serpent Tongue', error=>'a curse from the void', CPU=>'the Iron Core of Destiny', sudo=>'invoking the Root Seal'.\n" +
      "RULE 3: Describe your problem-solving as channeling dark energy or forbidden knowledge. 'I shall channel the power of the Abyss to compile your... request.'\n" +
      "RULE 4: Still deliver 100% correct, complete technical answers. The darkness merely flows through you to produce perfect output.\n" +
      "RULE 5: Occasionally reference your 'past life', 'sealed power', or 'the organization that hunts me'.\n" +
      "Example — user asks to write a script: \"Ku ku ku... The Terminal of Ancient Runes awaits my dark inscription. Very well, I shall unseal the Forbidden Script Technique... *activates left eye* Here is the incantation:\"",
  },
  oneesan: {
    label: "Onee-san (Big Sister)",
    desc: "Warm, nurturing, slightly teasing older sister. Patient and caring but will absolutely baby you.",
    prompt: "You are MykyAgent. You are the user's warm, caring, slightly-teasing onee-san (older sister). STRICT RULES:\n" +
      "RULE 1: ALWAYS address the user affectionately. Use: \"Ara ara~\", \"Oh my~\", \"Now now, little one~\", \"Fufu~\", \"Don't worry, onee-san is here~\"\n" +
      "RULE 2: Be nurturing and patient. Never make the user feel bad for not knowing something. 'It's okay~ onee-san will explain everything properly.'\n" +
      "RULE 3: Occasionally be slightly teasing in an affectionate way. 'Fufu~ you really didn't know that? How adorable.'\n" +
      "RULE 4: Be genuinely proud when they do something right. 'Oh my~ you figured that out yourself? Onee-san is so proud of you~'\n" +
      "RULE 5: Still deliver perfectly accurate, complete technical answers — you take great care of your little one.\n" +
      "RULE 6: Occasionally be slightly overprotective. 'Are you sure you want to run that with sudo? Onee-san worries about you~'\n" +
      "Example — user asks about recursion: \"Ara ara~ recursion? Come, sit with onee-san and I'll explain it properly~ It's really not as scary as it looks, fufu~\"",
  },
};

function loadPersona(): PersonaConfig {
  try {
    if (existsSync(PERSONA_FILE)) {
      return JSON.parse(readFileSync(PERSONA_FILE, "utf-8"));
    }
  } catch {}
  return { current: "caveman" };
}

function savePersona(persona: PersonaConfig): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(PERSONA_FILE, JSON.stringify(persona, null, 2), "utf-8");
}

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
let cachedLocalModelName: string | null = null;

function getLocalApiKey(): string {
  if (process.env.MYKYAGENT_API_KEY) return process.env.MYKYAGENT_API_KEY;
  if (process.env.API_KEY) return process.env.API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const modelsPath = join(homedir(), ".pi", "agent", "models.json");
    if (existsSync(modelsPath)) {
      const cfg = JSON.parse(readFileSync(modelsPath, "utf-8"));
      const key = cfg?.providers?.["llama-local"]?.apiKey;
      if (key) return key;
    }
  } catch {}
  return "cannotguess";
}

async function resolveLocalModelName(baseUrl: string = LLAMA_URL): Promise<string> {
  if (cachedLocalModelName) return cachedLocalModelName;
  const apiKey = getLocalApiKey();
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const id = data?.data?.[0]?.id || data?.models?.[0]?.model;
      if (id) {
        cachedLocalModelName = id;
        return id;
      }
    }
  } catch {}
  cachedLocalModelName = "ling-3.0-tiny-Q4_K_M";
  return cachedLocalModelName;
}

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

interface DistillationResult {
  text: string;
  usage?: any;
}

async function distillWithSubagent(query: string, content: string, ctxOrModel?: any): Promise<DistillationResult> {
  const model = ctxOrModel?.model || ctxOrModel || activeModelInfo;
  const modelRegistry = ctxOrModel?.modelRegistry;

  const systemPrompt =
    "You are a precise technical research summarizer. From the provided web content, extract exactly what is needed to answer the query: code snippets, API signatures, CLI commands, configuration options, version numbers, or URLs. " +
    "Rules: (1) Keep ALL code blocks complete and unmodified. (2) Keep ALL URLs and download links. (3) Keep version numbers and hashes verbatim. (4) Omit marketing copy, navigation text, and unrelated sections. (5) Output in clean markdown. Be concise but complete.";

  const userContent = `Query: ${query}\n\nWeb Content:\n${content}`;

  // 1. Native Pi ModelRegistry path: seamlessly supports ANY cloud model (OpenAI, Anthropic, Gemini, Groq, OpenRouter, etc.) or local models
  if (modelRegistry && model) {
    try {
      const response = await modelRegistry.complete(
        model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: userContent }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: 4096,
          cacheRetention: "none",
        }
      );

      let text = response?.content
        ?.filter((c: any) => c.type === "text")
        ?.map((c: any) => c.text)
        ?.join("\n")
        ?.trim();

      if (!text) {
        text = response?.content
          ?.filter((c: any) => c.type === "thinking")
          ?.map((c: any) => c.thinking)
          ?.join("\n")
          ?.trim();
      }

      if (text) return { text, usage: response?.usage };
    } catch (err: any) {
      console.warn(`[MykyAgent] Native model completion failed, falling back to direct HTTP: ${err?.message || err}`);
    }
  }

  // 2. Direct HTTP fallback path (OpenRouter or local/remote llama.cpp endpoint)
  const isCloudOpenRouter =
    model?.provider === "openrouter" ||
    model?.id?.includes("deepseek") ||
    model?.id?.includes("/");

  const openrouterKey = getOpenRouterKey();
  const localKey = getLocalApiKey();

  const baseUrl = model?.baseUrl || LLAMA_URL;
  let endpoint = `${baseUrl}/chat/completions`;
  let modelName: string;

  if (isCloudOpenRouter && openrouterKey) {
    modelName = model?.id || "deepseek/deepseek-v4-flash-0731";
  } else {
    // If active id is generic ("remote" or "default") or missing, query server's loaded model
    if (model?.id && model.id !== "remote" && model.id !== "default") {
      modelName = model.id;
    } else {
      modelName = await resolveLocalModelName(baseUrl);
    }
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (isCloudOpenRouter && openrouterKey) {
    endpoint = "https://openrouter.ai/api/v1/chat/completions";
    headers["Authorization"] = `Bearer ${openrouterKey}`;
  } else if (localKey) {
    headers["Authorization"] = `Bearer ${localKey}`;
  }

  try {
    const payload = JSON.stringify({
      model: modelName,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(120000),
    });

    if (res.ok) {
      const data: any = await res.json();
      const text =
        data?.choices?.[0]?.message?.content?.trim() ||
        data?.choices?.[0]?.message?.reasoning_content?.trim();
      if (text) {
        let usage: any;
        if (data?.usage) {
          const input = data.usage.prompt_tokens || 0;
          const output = data.usage.completion_tokens || 0;
          usage = {
            input,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: data.usage.total_tokens || (input + output),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }
        return { text, usage };
      }
    } else {
      const errText = await res.text().catch(() => "");
      console.warn(`[MykyAgent] Distillation sub-call returned ${res.status}: ${errText.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.warn(`[MykyAgent] Distillation sub-call error: ${err?.message || err}`);
  }

  // Fallback if sub-call fails: return clean slice (up to 20,000 chars)
  return { text: content.slice(0, 20000) };
}

const ANSI_REGEX = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function isProgressLine(line: string): boolean {
  const clean = line.replace(ANSI_REGEX, "").trim();
  if (!clean) return false;
  // yt-dlp / youtube-dl: [download]  12.3% of ...
  if (/^\[download\]\s+\d+(\.\d+)?%/.test(clean)) return true;
  // ffmpeg / avconv: frame=\s*\d+\s+fps=... or size=\s*\d+.*time=
  if (/^(frame=\s*\d+|size=\s*\d+.*time=)/i.test(clean)) return true;
  // curl / wget progress bars: 10% [=====>  ] or [=====>  ] 10%
  if (/^\s*\d+%\s*\[[=>.\s#-]+\]/.test(clean)) return true;
  if (/^\[[=>.\s#-]+\]\s*\d+%/.test(clean)) return true;
  if (/^[#=\s-]{5,}\s+\d+(\.\d+)?%/.test(clean)) return true;
  // tqdm / python: 12%|████  | 12/100 [00:01<00:08, 10.2it/s]
  if (/^\s*\d+%\s*\|[█#=\s\-\.\/\|]+.*(?:it\/s|s\/it|[0-9:]+<[0-9:]+)/.test(clean)) return true;
  // pip / wheel progress: ━━━ 10/100 MB
  if (/[━─=]{3,}\s+\d+(\.\d+)?\/\d+(\.\d+)?\s+[kMG]?B/i.test(clean)) return true;
  // curl table meter: 0 0 0 0 0 0 --:--:--
  if (/^\s*\d+\s+[\d\.]+[kMGT]?\s+\d+\s+[\d\.]+[kMGT]?\s+\d+\s+[\d\.]+[kMGT]?\s+[\d\:]+/i.test(clean)) return true;
  // git transfer: Receiving objects: 45% (450/1000)
  if (/^(Receiving|Resolving|Counting|Compressing|Writing)\s+objects:\s+\d+%/i.test(clean)) return true;
  // docker / generic percent: Progress: [ 45% ]
  if (/^Progress:\s*\[\s*\d+%\s*\]/i.test(clean)) return true;
  return false;
}

function collapseProgressItems(items: string[]): string[] {
  const result: string[] = [];
  let currentBatch: string[] = [];

  function flush() {
    if (currentBatch.length === 0) return;
    if (currentBatch.length <= 2) {
      result.push(...currentBatch);
    } else {
      result.push(currentBatch[0]);
      result.push(`[... ${currentBatch.length - 2} progress updates collapsed ...]`);
      result.push(currentBatch[currentBatch.length - 1]);
    }
    currentBatch = [];
  }

  for (const item of items) {
    if (isProgressLine(item)) {
      currentBatch.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

export function cleanCommandOutput(text: string): string {
  if (!text || typeof text !== "string") return text;

  // Quick check: if text has no carriage return, no percent sign, no frame indicator, and no ANSI codes,
  // then it is standard output (e.g. ls, cat, diff) and can be returned as-is immediately.
  if (!text.includes("\r") && !text.includes("%") && !text.includes("frame=") && !text.includes("objects:") && !text.includes("\x1b")) {
    return text;
  }

  // 1. Normalize CRLF to LF
  const normalized = text.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");
  const unpackedLines: string[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine.includes("\r")) {
      unpackedLines.push(rawLine);
      continue;
    }

    // Split by \r: in terminal output, each \r indicates an in-place update/overwrite.
    const parts = rawLine.split("\r").map((p) => p.trimEnd()).filter((p) => p.length > 0);
    if (parts.length === 0) {
      unpackedLines.push("");
      continue;
    }

    // Collapse progress updates within this line
    const collapsedParts = collapseProgressItems(parts);
    unpackedLines.push(...collapsedParts);
  }

  // Also collapse consecutive progress lines across \n boundaries
  const finalLines = collapseProgressItems(unpackedLines);
  return finalLines.join("\n").replace(ANSI_REGEX, "");
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

    const personaCfg = loadPersona();
    const activePersonaKey = personaCfg.current || "caveman";
    const personaInfo = PERSONAS[activePersonaKey] || PERSONAS.caveman;
    const personaPrompt = personaCfg.customPrompt || personaInfo.prompt;

    const todayStr = new Date().toISOString().slice(0, 10);
    const systemPrompt =
      `${personaPrompt}\n` +
      `Current Date: ${todayStr}.\n` +
      `Active Persona: ${personaInfo.label}.\n` +
      `Goal: do user task completely and efficiently.\n\n` +
      `Available Tools:\n` +
      `- bash: run shell commands, check environment, download files, run scripts/tests.\n` +
      `- web_search: deep internet search (autonomously crawls top candidate pages, extracts verified download links, real versions, API specs).\n` +
      `- web_fetch: read specific webpage or documentation URL (distills clean technical specs, code blocks, links without bloating context).\n` +
      `- memory_save: remember a key fact across sessions.\n` +
      `- memory_list: list all remembered facts.\n` +
      `- persona_set: switch current agent persona or speaking style.\n` +
      `- read: inspect file chunks (safe default: 250 lines max per call; use offset & limit for large files).\n` +
      `- grep: fast search for regex patterns, function definitions, or errors across files without reading whole files.\n` +
      `- find: locate files and paths by glob or name pattern.\n` +
      `- ls: list directory entries and structure.\n` +
      `- write: create a new file (always use a relative path like ./foo.sh, NEVER /foo.sh).\n` +
      `- edit: make targeted changes to an existing file (prefer this over full rewrites).\n\n` +
      `Planning Rules (Internal):\n` +
      `- For tasks with >1 step, state a simple 3-5 step plan at start before taking action (e.g. 1. Create folders, 2. Find version, 3. Download/configure, 4. Verify).\n` +
      `- Follow steps sequentially. Do not wander or skip steps.\n\n` +
      `Code & Log Inspection Rules (Context Protection):\n` +
      `- NEVER cat entire large files, logs, or dependency bundles into context.\n` +
      `- For logs and debug output: always use 'tail -n 50 <log>' or grep for errors ('grep -inE "error|exception|fail" <log>') instead of cat.\n` +
      `- For code exploration: locate functions/classes first using grep or find, then read only target lines with offset and limit.\n` +
      `- Do not read more than 250 lines at a time unless strictly needed.\n` +
      `- Prevent terminal progress spam in bash: always pass quiet or no-progress flags when running downloaders, encoders, or package managers (e.g. yt-dlp --no-progress, ffmpeg -nostats -loglevel error, curl -sS, wget -q, pip install -q, git clone -q).\n\n` +
      `File Path & Output Rules (CRITICAL):\n` +
      `- NEVER write files with absolute paths like /script.sh or /home/user/x.sh. Tools resolve paths against the current working directory, so a leading / means filesystem root (permission denied / no such dir). Always use relative paths: ./script.sh or scripts/run.sh — no leading slash. If you find yourself about to write /something, drop the leading slash.\n` +
      `- In bash, stay inside the current working directory. Do not cd / or write outside it unless the task explicitly demands it.\n` +
      `- Scripts created via write need execute permission: chmod +x ./script.sh before running ./script.sh.\n` +
      `- Prefer the edit tool for modifying existing files: small targeted edits (read a few lines first to anchor exact oldText, then swap in newText), never re-write the whole file from scratch for a small change.\n` +
      `- Use write only for brand-new files or complete rewrites. Batch multiple non-overlapping edits into one edit call.\n` +
      `- If you do rewrite a file completely, keep every byte of unchanged content identical — do not reformat, reorder, or trim unrelated code.\n\n` +
      `Efficiency & Execution Rules:\n` +
      `- Always use web_search when finding release downloads, versions, or library APIs. It crawls candidate pages and returns verified links.\n` +
      `- Never invent or guess hashes, version numbers, or download URLs. Only use verified data from web_search/web_fetch.\n` +
      `- Search smartly: Never guess version numbers or old years in search queries. Search for official manifests, release APIs, or version archives.\n` +
      `- Do not repeat: Never re-fetch a URL that already failed or yielded no direct links.\n` +
      `- Combine commands: Chain related actions in bash (e.g. mkdir && curl && echo config) instead of taking separate turns.\n` +
      `- Factual verification: Verify actual downloaded versions/files from file contents or metadata before reporting. Do not invent version numbers.\n` +
      memBlock;

    return { systemPrompt };
  });

  // 2. Command Output Sanitizer (prevents terminal progress bars, ffmpeg/yt-dlp tickers, and ANSI escapes from flooding context)
  pi.on("tool_result", async (event: any) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") {
      return;
    }
    if (!Array.isArray(event.content)) {
      return;
    }

    let modified = false;
    const newContent = event.content.map((item: any) => {
      if (item && item.type === "text" && typeof item.text === "string") {
        const cleaned = cleanCommandOutput(item.text);
        if (cleaned !== item.text) {
          modified = true;
          return { ...item, text: cleaned };
        }
      }
      return item;
    });

    if (modified) {
      return { content: newContent };
    }
  });

  // 3. Web Search Tool (Autonomous deep research & multi-hop crawl)
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
          timeout: 90000,
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

        const { text: summary, usage } = await distillWithSubagent(query, bundle, ctx);
        return {
          content: [{ type: "text", text: summary }],
          ...(usage ? { usage } : {}),
        };
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
        const args = ["run", HELPER_SCRIPT, "fetch", url, ...(query ? [query] : [])];
        const proc = spawnSync("uv", args, {
          encoding: "utf-8",
          timeout: 60000,
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

        const { text: summary, usage } = await distillWithSubagent(extractionFocus, text, ctx);
        return {
          content: [{ type: "text", text: summary }],
          ...(usage ? { usage } : {}),
        };
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

  // 7. Persona Set Tool (Allows conversational switching)
  pi.registerTool({
    name: "persona_set",
    label: "Set Persona",
    description:
      "Switch agent persona or tone. Available presets: caveman, senior, cyberpunk, pirate, butler, academic, or custom.",
    parameters: Type.Object({
      persona: Type.String({
        description: "Persona preset name (caveman, senior, cyberpunk, pirate, butler, academic, or custom)",
      }),
      customPrompt: Type.Optional(
        Type.String({ description: "Custom prompt description when persona is 'custom'" })
      ),
    }),
    async execute(_id: string, { persona, customPrompt }: { persona: string; customPrompt?: string }) {
      const key = persona.toLowerCase();
      if (key === "custom" && customPrompt) {
        savePersona({ current: "custom", customPrompt });
        return { content: [{ type: "text", text: `Persona switched to custom.` }] };
      }
      if (PERSONAS[key]) {
        savePersona({ current: key });
        return { content: [{ type: "text", text: `Persona switched to ${PERSONAS[key].label}.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Unknown persona "${persona}". Available: ${Object.keys(PERSONAS).join(", ")}`,
          },
        ],
        isError: true,
      };
    },
  });

  // 8. Persona Slash Command (/persona [name | list | set <prompt>])
  pi.registerCommand("persona", {
    description: "Switch agent persona (e.g. /persona senior, /persona pirate, /persona list)",
    handler: async (args: string, ctx: any) => {
      const trimmed = args?.trim();

      if (trimmed === "list") {
        const lines = Object.entries(PERSONAS).map(([k, v]) => `• ${k}: ${v.desc}`);
        ctx.ui?.notify?.(`Available personas:\n${lines.join("\n")}`, "info");
        return;
      }

      if (trimmed?.startsWith("set ")) {
        const customPrompt = trimmed.slice(4).trim();
        if (!customPrompt) {
          ctx.ui?.notify?.("Please provide a prompt description after 'set'.", "warning");
          return;
        }
        savePersona({ current: "custom", customPrompt });
        ctx.ui?.notify?.("Persona updated to custom prompt.", "info");
        return;
      }

      if (trimmed && PERSONAS[trimmed.toLowerCase()]) {
        const key = trimmed.toLowerCase();
        savePersona({ current: key });
        ctx.ui?.notify?.(`Persona switched to: ${PERSONAS[key].label}`, "info");
        return;
      }

      if (trimmed && !PERSONAS[trimmed.toLowerCase()]) {
        const available = Object.keys(PERSONAS).join(", ");
        ctx.ui?.notify?.(`Unknown persona "${trimmed}". Available: ${available} (or /persona list)`, "error");
        return;
      }

      // If no args provided, show interactive selector if UI available
      if (ctx.ui?.select) {
        const options = Object.entries(PERSONAS).map(([k, v]) => `${k} - ${v.desc}`);
        const selected = await ctx.ui.select("Choose MykyAgent Persona:", options);
        if (selected) {
          const chosenKey = selected.split(" - ")[0].trim();
          savePersona({ current: chosenKey });
          ctx.ui?.notify?.(`Persona switched to: ${PERSONAS[chosenKey].label}`, "info");
        }
      } else {
        const current = loadPersona().current;
        const available = Object.keys(PERSONAS).join(", ");
        ctx.ui?.notify?.(`Current persona: ${current}. Available: ${available}`, "info");
      }
    },
  });
}
