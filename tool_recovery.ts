/**
 * Tool Call Auto-Recovery Module
 *
 * Catches tool calls that were generated inside <think> blocks (or raw text)
 * without closing </think> tags first, which occurs with local reasoning models
 * (e.g. Ling-3.0-tiny or Qwen on llama.cpp).
 *
 * Converts the leaked XML/JSON into executable ToolCall content blocks,
 * cleans the raw XML from thinking/text, and sets stopReason to "toolUse".
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

function generateToolCallId(): string {
  return "call_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function parseArgValue(rawVal: string): any {
  const trimmed = rawVal.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

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

/**
 * Extract tool calls from text containing <tool_call>...</tool_call> tags.
 * Supports:
 *   1. Bailing / Ant XML format:
 *        <tool_call>name\n<arg_key>k</arg_key>\n<arg_value>v</arg_value>\n</tool_call>
 *   2. JSON inside tag:
 *        <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *   3. Attribute format:
 *        <tool_call name="..."><arg name="...">...</arg></tool_call>
 */
export function extractToolCallsFromText(text: string): ExtractionResult {
  if (!text || !text.includes("<tool_call")) {
    return { toolCalls: [], cleanedText: text };
  }

  const toolCalls: ExtractedToolCall[] = [];
  const toolCallRegex = /<tool_call(?:\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/tool_call>/gi;

  const cleanedText = text.replace(toolCallRegex, (_match, attrName, body) => {
    const trimmedBody = (body || "").trim();

    // 1. JSON-inside-tag check
    if (trimmedBody.startsWith("{") && trimmedBody.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmedBody);
        const name = attrName || parsed.name || parsed.function;
        const args = parsed.arguments || parsed.args || parsed.parameters || (name ? { ...parsed, name: undefined, function: undefined } : {});
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

    // 2. Bailing / Ant XML key-value pairs
    // Format:
    // <tool_call>tool_name
    // <arg_key>param1</arg_key>
    // <arg_value>val1</arg_value>
    let toolName = (attrName || "").trim();
    const args: Record<string, any> = {};

    // If toolName not from attribute, it is the text before the first <arg... tag
    const firstArgMatch = body.search(/<arg/i);
    if (!toolName) {
      if (firstArgMatch !== -1) {
        toolName = body.slice(0, firstArgMatch).trim();
      } else {
        // Just the tool name without args
        toolName = trimmedBody;
      }
    }

    // Clean any leading punctuation/whitespace from toolName (e.g. "\nweb_search")
    toolName = toolName.split(/\s+/)[0]?.trim() || "";

    if (firstArgMatch !== -1) {
      const argsSection = body.slice(firstArgMatch);

      // Match pairs: <arg_key>k</arg_key> followed by <arg_value>v</arg_value>
      const pairRegex = /<arg(?:_key|\s+key)>\s*([a-zA-Z0-9_-]+)\s*<\/arg(?:_key|\s+key)>\s*<arg(?:_value|\s+value)>([\s\S]*?)<\/arg(?:_value|\s+value)>/gi;
      let pairMatch: RegExpExecArray | null;
      let matchedAny = false;

      while ((pairMatch = pairRegex.exec(argsSection)) !== null) {
        matchedAny = true;
        const key = pairMatch[1].trim();
        const rawVal = pairMatch[2];
        args[key] = parseArgValue(rawVal);
      }

      // If no pair matched, try <arg name="key">val</arg> format
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

  return {
    toolCalls,
    cleanedText: cleanedText.trim(),
  };
}

/**
 * Inspect an assistant message. If it finished with stopReason "stop" or pending,
 * has no native toolCall blocks, but contains unparsed <tool_call> tags in thinking
 * or text blocks, recovers the tool calls and converts the message to stopReason "toolUse".
 */
export function recoverLeakedToolCalls(message: any): { recovered: boolean; message: any } {
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
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.includes("<tool_call")) {
      const { toolCalls, cleanedText } = extractToolCallsFromText(block.thinking);
      if (toolCalls.length > 0) {
        allExtracted.push(...toolCalls);
        block.thinking = cleanedText;
      }
    } else if (block.type === "text" && typeof block.text === "string" && block.text.includes("<tool_call")) {
      const { toolCalls, cleanedText } = extractToolCallsFromText(block.text);
      if (toolCalls.length > 0) {
        allExtracted.push(...toolCalls);
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
