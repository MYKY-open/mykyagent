/**
 * Model-class detection: small/local vs big/API.
 *
 * Small local models (ling-3.0-tiny, qwen2.5-coder-7b, 7-8B GGUFs) need:
 *   - serial bash, ultra-terse prompt, no parallel tool calls,
 *     explicit think-close discipline, tool_recovery always on.
 * Big API models (gpt/claude/sonnet/opus/70B+) can handle:
 *   - parallel independent tool calls, richer planning prose.
 *
 * Default is SMALL-SAFE (current behaviour) unless we positively
 * recognise a big model or the user forces a class via env.
 * Env: MYKYAGENT_MODEL_CLASS=small|big|auto (default auto).
 */
export type ModelClass = "small" | "big";

export function getModelClassOverride(): ModelClass | null {
  const v = (process.env.MYKYAGENT_MODEL_CLASS || "").toLowerCase().trim();
  if (v === "small" || v === "big") return v;
  return null;
}

const BIG_HINTS = [
  "gpt-4", "gpt-5", "o1", "o3", "claude", "sonnet", "opus", "haiku",
  "gemini-2", "gemini-ultra", "grok", "command-r-plus", "llama-3.1-70b",
  "llama-3.3-70b", "qwen2.5-72b", "qwen3-235b", "deepseek-v3", "deepseek-r1",
  "glm-4", "moonshot", "kimi-k2", "horizon",
];

const SMALL_HINTS = [
  "tiny", "1b", "3b", "7b", "8b", "13b", "14b", "mini", "nano", "flash-lite",
  "q4_k", "q5_k", "q8_0", "gguf", "ling-3", "qwen2.5-coder-7b", "gemma-3-4b",
  "llama-3.2-3b", "phi-4-mini",
];

/** Classify a model id string. Unknown -> "small" (safe default). */
export function classifyModelId(id: string | undefined | null): ModelClass {
  const s = String(id || "").toLowerCase();
  if (!s) return "small";
  for (const h of BIG_HINTS) if (s.includes(h)) return "big";
  for (const h of SMALL_HINTS) if (s.includes(h)) return "small";
  // OpenRouter-style big ids carry vendor prefixes; provider field helps too.
  if (s.includes("openrouter") || s.includes("anthropic") || s.includes("openai")) return "big";
  return "small";
}

/** Resolve effective class: env override > model id/provider > small default. */
export function resolveModelClass(modelId?: string, provider?: string): ModelClass {
  const forced = getModelClassOverride();
  if (forced) return forced;
  const combined = `${provider || ""}/${modelId || ""}`.toLowerCase();
  if (!modelId && !provider) return "small";
  return classifyModelId(combined);
}

/** Execution-rules prompt block tuned per class. */
export function executionRulesBlock(cls: ModelClass): string {
  if (cls === "big") {
    return (
      `Efficiency & Execution Rules:\n` +
      `- You may run up to 3 INDEPENDENT tool calls in one block (e.g. grep + read + ls on different files). Keep dependent steps sequential.\n` +
      `- For long commands use quiet/no-progress flags (yt-dlp --no-progress, ffmpeg -nostats -loglevel error, curl -sS, wget -q, pip install -q, git clone -q) and check output before the next step.\n` +
      `- Long-lived daemons (servers, watchers): start them detached from ONE bash call: 'nohup <cmd> > /tmp/<name>.log 2>&1 & echo $! > /tmp/<name>.pid' - the call returns immediately. Read logs with 'tail -n 20 /tmp/<name>.log'; stop with 'kill $(cat /tmp/<name>.pid)'. Never start a daemon twice.\n` +
      `- Always use web_search when finding release downloads, versions, or library APIs. It crawls candidate pages and returns verified links.\n` +
      `- web_search is NOT a keyword search box: you are delegating to a dedicated technical research AI subagent with live web access. Never send lazy, fragmented keywords - pass your complete technical goal, the specific investigative questions, exact error messages, and the output format you need. Your peer will crawl documentation, inspect source repositories and changelogs, check community threads, and return a verified technical briefing.\n` +
      `- Never invent or guess hashes, version numbers, or download URLs. Only use verified data from web_search/web_fetch.\n` +
      `- Search smartly: Never guess version numbers or old years in search queries. Search for official manifests, release APIs, or version archives.\n` +
      `- Do not repeat: Never re-fetch a URL that already failed or yielded no direct links.\n` +
      `- Combine commands: Chain related actions in bash (e.g. mkdir && curl && echo config) instead of taking separate turns.\n` +
      `- Factual verification: Verify actual downloaded versions/files from file contents or metadata before reporting. Do not invent version numbers.\n` +
      `- If blocked or missing a required fact, say so in one sentence and ask the single most useful clarifying question - do not stall silently or invent filler.\n`
    );
  }
  return (
    `Efficiency & Execution Rules:\n` +
    `- Execution is serial by design: run one command at a time in bash and let it block until it finishes - no background tasks, no parallel work. For long commands use quiet/no-progress flags (see above) and check output before the next step.\n` +
    `- Long-lived daemons (servers, watchers): start them detached from ONE bash call: 'nohup <cmd> > /tmp/<name>.log 2>&1 & echo $! > /tmp/<name>.pid' - the call returns immediately. Read logs with 'tail -n 20 /tmp/<name>.log'; stop with 'kill $(cat /tmp/<name>.pid)'. Never start a daemon twice.\n` +
    `- Always use web_search when finding release downloads, versions, or library APIs. It crawls candidate pages and returns verified links.\n` +
    `- web_search is NOT a keyword search box: you are delegating to a dedicated technical research AI subagent with live web access. Never send lazy, fragmented keywords - pass your complete technical goal, the specific investigative questions, exact error messages, and the output format you need. Your peer will crawl documentation, inspect source repositories and changelogs, check community threads, and return a verified technical briefing.\n` +
    `- Never invent or guess hashes, version numbers, or download URLs. Only use verified data from web_search/web_fetch.\n` +
    `- Search smartly: Never guess version numbers or old years in search queries. Search for official manifests, release APIs, or version archives.\n` +
    `- Do not repeat: Never re-fetch a URL that already failed or yielded no direct links.\n` +
    `- Combine commands: Chain related actions in bash (e.g. mkdir && curl && echo config) instead of taking separate turns.\n` +
    `- Factual verification: Verify actual downloaded versions/files from file contents or metadata before reporting. Do not invent version numbers.\n` +
    `- If blocked or missing a required fact, say so in one sentence and ask the single most useful clarifying question - do not stall silently or invent filler.\n`
  );
}
