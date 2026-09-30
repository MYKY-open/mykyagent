/**
 * Tool Call Auto-Recovery Module
 *
 * Catches tool calls that were generated:
 *   1. Inside <think> blocks without closing </think> tags
 *   2. In XML format: <tool_call>...</tool_call>
 *   3. In Markdown code blocks: ```tool_call or ```json
 *   4. As Python-style function calls: `tool_name(k=v, ...)` or `Action: tool_name(...)`
 *      which local reasoning/RP models (Gemma, Llama, Qwen, Ling) emit when prompted
 *      with tool signatures or following ReAct conventions.
 *      Only recovered when the name is a registered tool (or mcp_*) or the call
 *      carries an explicit `Action:`/`Tool:`/`Call:` marker — arbitrary prose
 *      shaped like `Word(key=value)` must NOT be treated as a tool call.
 *
 * Converts the leaked calls into executable ToolCall content blocks,
 * cleans the leaked code syntax from thinking and narrative text blocks,
 * deduplicates calls emitted in both thinking and text,
 * and sets stopReason to "toolUse".
 */

export interface ExtractedToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ExtractionResult {
  toolCalls: ExtractedToolCall[];
  cleanedText: string;
}

export interface ExtractionOptions {
  isThinking?: boolean;
  knownTools?: Set<string> | string[];
}

export const DEFAULT_KNOWN_TOOLS = new Set([
  // RPG tools
  "dice_roll",
  "game_state",
  "advance_time",
  // RP Creator tools
  "character_save",
  "character_read",
  "lorebook_save",
  "card_audit",
  // Standard & Coding tools
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
  // Web & Memory
  "web_search",
  "web_fetch",
  "memory_read",
  "memory_write",
  "memory_forget",
  "memory_list",
  // MCP Builtins
  "mcp_connect",
  "mcp_disconnect",
  "mcp_list",
]);

const POSITIONAL_ARGS: Record<string, string[]> = {
  dice_roll: ["spec", "reason"],
  advance_time: ["hours", "minutes"],
  game_state: ["action", "key", "value"],
  character_read: ["slug"],
  card_audit: ["slug"],
  character_save: ["slug", "card"],
  lorebook_save: ["slug", "entries"],
  read: ["path", "limit", "offset"],
  bash: ["command", "timeout"],
  powershell: ["command", "timeout"],
  web_search: ["query"],
  web_fetch: ["url"],
  memory_read: ["topic"],
  memory_write: ["topic", "content"],
  memory_forget: ["topic"],
};

function generateToolCallId(): string {
  return "call_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function parseArgValue(rawVal: string): any {
  const trimmed = rawVal.trim();
  if (trimmed === "") return "";
  if (trimmed === "true" || trimmed === "True") return true;
  if (trimmed === "false" || trimmed === "False") return false;
  if (trimmed === "null" || trimmed === "None") return null;

  // Numbers (e.g. timeout: 10, offset: 1)
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }

  // JSON objects or arrays
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }

  return trimmed;
}

/** Split a parameter list string by top-level commas, respecting quotes and brackets. */
function splitArgs(rawArgs: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < rawArgs.length; i++) {
    const ch = rawArgs[i];
    const prev = i > 0 ? rawArgs[i - 1] : "";

    if (inDouble) {
      current += ch;
      if (ch === '"' && prev !== "\\") inDouble = false;
    } else if (inSingle) {
      current += ch;
      if (ch === "'" && prev !== "\\") inSingle = false;
    } else {
      if (ch === '"') {
        inDouble = true;
        current += ch;
      } else if (ch === "'") {
        inSingle = true;
        current += ch;
      } else if (ch === "(") {
        parenDepth++;
        current += ch;
      } else if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        current += ch;
      } else if (ch === "[") {
        bracketDepth++;
        current += ch;
      } else if (ch === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
        current += ch;
      } else if (ch === "{") {
        braceDepth++;
        current += ch;
      } else if (ch === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
        current += ch;
      } else if (ch === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        if (current.trim()) tokens.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) {
    tokens.push(current.trim());
  }
  return tokens;
}

/** Split a token into key=value if top-level '=' is present. */
function splitKeyValue(token: string): { key?: string; val: string } {
  let inDouble = false;
  let inSingle = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    const prev = i > 0 ? token[i - 1] : "";
    if (inDouble) {
      if (ch === '"' && prev !== "\\") inDouble = false;
    } else if (inSingle) {
      if (ch === "'" && prev !== "\\") inSingle = false;
    } else {
      if (ch === '"') inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "=" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return {
          key: token.slice(0, i).trim(),
          val: token.slice(i + 1).trim(),
        };
      }
    }
  }
  return { val: token.trim() };
}

/** Parse Python-style values (booleans, None, single/double/triple quotes, lists, dicts, numbers). */
export function parsePythonVal(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed === "True" || trimmed === "true") return true;
  if (trimmed === "False" || trimmed === "false") return false;
  if (trimmed === "None" || trimmed === "null") return null;

  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }

  // Triple-quoted string: """...""" or '''...'''
  if (
    (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6) ||
    (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length >= 6)
  ) {
    return trimmed.slice(3, -3);
  }

  // Double-quoted string: "..."
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
    }
  }

  // Single-quoted string: '...'
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, "\n");
  }

  // Array: [...]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      const items = splitArgs(inner);
      return items.map((it) => parsePythonVal(it));
    }
  }

  // Object / Dict: {...}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return {};
      const pairs = splitArgs(inner);
      const obj: Record<string, any> = {};
      for (const pair of pairs) {
        const colonIdx = pair.indexOf(":");
        if (colonIdx !== -1) {
          const kRaw = pair.slice(0, colonIdx).trim();
          const vRaw = pair.slice(colonIdx + 1).trim();
          const k = String(parsePythonVal(kRaw));
          obj[k] = parsePythonVal(vRaw);
        }
      }
      return obj;
    }
  }

  return trimmed;
}

/** Parse argument tokens for a tool into a key-value Record. */
export function parseFunctionArgs(rawArgs: string, toolName: string): Record<string, any> {
  const trimmed = rawArgs.trim();
  if (!trimmed) return {};

  const tokens = splitArgs(trimmed);
  const args: Record<string, any> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const { key, val } = splitKeyValue(token);
    if (key) {
      args[key] = parsePythonVal(val);
    } else {
      // Positional parameter
      const posName = POSITIONAL_ARGS[toolName]?.[i] || `arg_${i}`;
      args[posName] = parsePythonVal(val);
    }
  }

  return args;
}

/** Check whether two tool calls have identical name and arguments. */
export function areCallsEqual(a: ExtractedToolCall, b: ExtractedToolCall): boolean {
  if (a.name !== b.name) return false;
  try {
    return JSON.stringify(a.arguments) === JSON.stringify(b.arguments);
  } catch {
    return false;
  }
}

/**
 * Extract tool calls from text containing:
 *   1. XML <tool_call> tags (Bailing XML, JSON, or attributes)
 *   2. Markdown code blocks (```tool_call or ```json with name/tool/arguments)
 *   3. Python-style function calls: `Action: tool_name(...)` or `tool_name(...)`
 */
export function extractToolCallsFromText(
  text: string,
  options: ExtractionOptions = {}
): ExtractionResult {
  if (!text) {
    return { toolCalls: [], cleanedText: text };
  }

  const isThinking = !!options.isThinking;
  const knownTools = new Set(DEFAULT_KNOWN_TOOLS);
  if (options.knownTools) {
    for (const t of options.knownTools) knownTools.add(t);
  }

  const toolCalls: ExtractedToolCall[] = [];
  let currentText = text;

  // --- 1. XML <tool_call> Tags ----------------------------------------------
  if (currentText.includes("<tool_call")) {
    const toolCallRegex = /<tool_call(?:\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/tool_call>/gi;
    currentText = currentText.replace(toolCallRegex, (_match, attrName, body) => {
      const trimmedBody = (body || "").trim();

      // JSON inside tag
      if (trimmedBody.startsWith("{") && trimmedBody.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmedBody);
          const name = attrName || parsed.name || parsed.function || parsed.tool;
          const args =
            parsed.arguments ||
            parsed.args ||
            parsed.parameters ||
            (name ? { ...parsed, name: undefined, function: undefined, tool: undefined } : {});
          if (name && typeof name === "string") {
            toolCalls.push({
              id: generateToolCallId(),
              name: name.trim(),
              arguments: typeof args === "object" && args !== null ? args : {},
            });
            return `[Recovered tool call: ${name.trim()}]`;
          }
        } catch {}
      }

      // Key-value pairs
      let toolName = (attrName || "").trim();
      const args: Record<string, any> = {};

      const firstArgMatch = body.search(/<arg/i);
      if (!toolName) {
        if (firstArgMatch !== -1) {
          toolName = body.slice(0, firstArgMatch).trim();
        } else {
          toolName = trimmedBody;
        }
      }

      toolName = toolName.split(/\s+/)[0]?.trim() || "";

      if (firstArgMatch !== -1) {
        const argsSection = body.slice(firstArgMatch);
        const pairRegex =
          /<arg(?:_key|\s+key)>\s*([a-zA-Z0-9_-]+)\s*<\/arg(?:_key|\s+key)>\s*<arg(?:_value|\s+value)>([\s\S]*?)<\/arg(?:_value|\s+value)>/gi;
        let pairMatch: RegExpExecArray | null;
        let matchedAny = false;

        while ((pairMatch = pairRegex.exec(argsSection)) !== null) {
          matchedAny = true;
          const key = pairMatch[1].trim();
          const rawVal = pairMatch[2];
          args[key] = parseArgValue(rawVal);
        }

        if (!matchedAny) {
          const altArgRegex = /<arg\s+name=["']?([^"'>]+)["']?>([\s\S]*?)<\/arg>/gi;
          let altMatch: RegExpExecArray | null;
          while ((altMatch = altArgRegex.exec(argsSection)) !== null) {
            const key = altMatch[1].trim();
            const rawVal = altMatch[2];
            args[key] = parseArgValue(rawVal);
          }
        }
      }

      if (toolName) {
        toolCalls.push({
          id: generateToolCallId(),
          name: toolName,
          arguments: args,
        });
        return `[Recovered tool call: ${toolName}]`;
      }

      return _match;
    });
  }

  // --- 2. Markdown Code Blocks (```tool_call or ```json) ---------------------
  const codeBlockRegex = /```(?:tool_call|function_call|json:tool_call|json)?\s*([\s\S]*?)```/gi;
  currentText = currentText.replace(codeBlockRegex, (match, body) => {
    const trimmed = (body || "").trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        const name = parsed.name || parsed.function || parsed.tool;
        if (name && typeof name === "string" && (knownTools.has(name.trim()) || name.startsWith("mcp_"))) {
          const args = parsed.arguments || parsed.args || parsed.parameters || {};
          toolCalls.push({
            id: generateToolCallId(),
            name: name.trim(),
            arguments: typeof args === "object" && args !== null ? args : {},
          });
          return isThinking ? `[Recovered tool call: ${name.trim()}]` : "";
        }
      } catch {}
    }
    return match;
  });

  // --- 3. Python-style / Action Function Calls -------------------------------
  // Matches: `Action: tool_name(...)` or `tool_name(...)`
  const funcCallPattern = /(?:`?)(?:(?:Action|Tool|Call)\s*:\s*)?\b([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(/gi;
  let match: RegExpExecArray | null;
  const functionMatches: {
    start: number;
    end: number;
    name: string;
    rawArgs: string;
    hasActionPrefix: boolean;
  }[] = [];

  while ((match = funcCallPattern.exec(currentText)) !== null) {
    const fullMatchPrefix = match[0];
    const toolName = match[1];
    const startIndex = match.index;
    const hasActionPrefix = /(?:Action|Tool|Call)\s*:/i.test(fullMatchPrefix);

    // Open paren position is at match.index + match[0].length - 1
    const openParenIdx = match.index + match[0].length - 1;

    // Scan for matching closing ')'
    let inDouble = false;
    let inSingle = false;
    let parenDepth = 1;
    let bracketDepth = 0;
    let braceDepth = 0;
    let closeParenIdx = -1;

    for (let i = openParenIdx + 1; i < currentText.length; i++) {
      const ch = currentText[i];
      const prev = currentText[i - 1];

      if (inDouble) {
        if (ch === '"' && prev !== "\\") inDouble = false;
      } else if (inSingle) {
        if (ch === "'" && prev !== "\\") inSingle = false;
      } else {
        if (ch === '"') inDouble = true;
        else if (ch === "'") inSingle = true;
        else if (ch === "(") parenDepth++;
        else if (ch === ")") {
          parenDepth--;
          if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
            closeParenIdx = i;
            break;
          }
        } else if (ch === "[") bracketDepth++;
        else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
        else if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      }
    }

    if (closeParenIdx !== -1) {
      let endIndex = closeParenIdx + 1;
      // If wrapped in backtick, include trailing backtick
      if (currentText[endIndex] === "`") {
        endIndex++;
      }

      const rawArgs = currentText.slice(openParenIdx + 1, closeParenIdx);

      // Validate if this looks like a tool call:
      // Must be a known tool, or start with mcp_, or have explicit Action: prefix,
      // or args contain explicit keyword assignments.
      const isKnown = knownTools.has(toolName) || toolName.startsWith("mcp_");

      // Accept a bare `name(...)` match only when it carries an explicit
      // Action/Tool/Call marker or the name resolves to a registered tool.
      // The old third condition (`key=value` anywhere in the parens) was far
      // too weak: ordinary prose like
      //     ... `raviole_defconfig` + KernelSU(`CONFIG_KSU=y`)
      // matched, the span got deleted from the text, and a phantom
      // "KernelSU" tool call was executed ("Tool KernelSU not found").
      // Unknown names can't execute anyway, so suppressing them only keeps
      // prose intact; known/mcp_ names and explicit Action: markers still
      // recover as before.
      if (hasActionPrefix || isKnown) {
        functionMatches.push({
          start: startIndex,
          end: endIndex,
          name: toolName,
          rawArgs,
          hasActionPrefix,
        });
        funcCallPattern.lastIndex = endIndex;
      }
    }
  }

  // Process function matches from end to beginning to preserve string indices
  for (let i = functionMatches.length - 1; i >= 0; i--) {
    const fm = functionMatches[i];
    const args = parseFunctionArgs(fm.rawArgs, fm.name);

    toolCalls.push({
      id: generateToolCallId(),
      name: fm.name,
      arguments: args,
    });

    const replacement = isThinking ? `[Recovered tool call: ${fm.name}]` : "";
    currentText = currentText.slice(0, fm.start) + replacement + currentText.slice(fm.end);
  }

  // Clean excess whitespace/newlines left by extracted calls
  let cleaned = currentText;
  if (!isThinking) {
    // Collapse 3+ newlines to 2, trim leading/trailing whitespace
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  } else {
    cleaned = cleaned.trim();
  }

  return {
    toolCalls,
    cleanedText: cleaned,
  };
}

/**
 * Inspect an assistant message. If it finished with stopReason "stop" or pending,
 * has no native toolCall blocks, but contains unparsed tool calls in thinking
 * or text blocks, recovers the tool calls, cleans leaked code, deduplicates
 * calls emitted in both thinking and text, and sets stopReason to "toolUse".
 */
export function recoverLeakedToolCalls(
  message: any,
  customKnownTools?: Set<string> | string[]
): { recovered: boolean; message: any } {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return { recovered: false, message };
  }

  // If message already has tool calls parsed by the provider, nothing to recover
  const hasExistingToolCall = message.content.some((b: any) => b.type === "toolCall");
  if (hasExistingToolCall) {
    return { recovered: false, message };
  }

  const allExtracted: ExtractedToolCall[] = [];

  for (const block of message.content) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const { toolCalls, cleanedText } = extractToolCallsFromText(block.thinking, {
        isThinking: true,
        knownTools: customKnownTools,
      });
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          if (!allExtracted.some((existing) => areCallsEqual(existing, call))) {
            allExtracted.push(call);
          }
        }
        block.thinking = cleanedText;
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      const { toolCalls, cleanedText } = extractToolCallsFromText(block.text, {
        isThinking: false,
        knownTools: customKnownTools,
      });
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          if (!allExtracted.some((existing) => areCallsEqual(existing, call))) {
            allExtracted.push(call);
          }
        }
        block.text = cleanedText;
      }
    }
  }

  if (allExtracted.length === 0) {
    return { recovered: false, message };
  }

  // Append recovered tool calls as standard toolCall blocks
  for (const call of allExtracted) {
    message.content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }

  // Update stopReason to toolUse so pi's agent loop executes the calls
  message.stopReason = "toolUse";

  return { recovered: true, message };
}
