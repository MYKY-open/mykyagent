/**
 * Tests for Tool Call Auto-Recovery.
 *
 * Verifies recovery of tool calls generated inside <think> blocks or raw text
 * when local models fail to close </think> before emitting XML/JSON tool calls.
 */

import { extractToolCallsFromText, recoverLeakedToolCalls } from "./tool_recovery.ts";

let pass = 0;
let fail = 0;

const t = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};

// --- 1. Extraction: Bailing / Ant XML (Single Arg) ---------------------------
const singleArgXml = `<tool_call>web_search
<arg_key>query</arg_key>
<arg_value>minecraft forge 1.20.1 maven installer</arg_value>
</tool_call>`;

const res1 = extractToolCallsFromText(singleArgXml);
t("bailing single: extracts 1 tool call", res1.toolCalls.length === 1);
t("bailing single: name is web_search", res1.toolCalls[0]?.name === "web_search");
t(
  "bailing single: query argument matches",
  res1.toolCalls[0]?.arguments?.query === "minecraft forge 1.20.1 maven installer"
);
t(
  "bailing single: cleaned text contains indicator",
  res1.cleanedText === "[Recovered tool call: web_search]"
);

// --- 2. Extraction: Bailing / Ant XML (Multi Arg + Types + Multiline) ---------
const multiArgXml = `Let's run this command:
<tool_call>bash
<arg_key>command</arg_key>
<arg_value>echo "line 1"
echo "line 2"</arg_value>
<arg_key>timeout</arg_key>
<arg_value>45</arg_value>
</tool_call>`;

const res2 = extractToolCallsFromText(multiArgXml);
t("bailing multi: extracts 1 tool call", res2.toolCalls.length === 1);
t("bailing multi: name is bash", res2.toolCalls[0]?.name === "bash");
t(
  "bailing multi: multiline command preserved",
  res2.toolCalls[0]?.arguments?.command === 'echo "line 1"\necho "line 2"'
);
t("bailing multi: timeout converted to number", res2.toolCalls[0]?.arguments?.timeout === 45);
t(
  "bailing multi: surrounding prose preserved",
  res2.cleanedText.includes("Let's run this command:") &&
    res2.cleanedText.includes("[Recovered tool call: bash]")
);

// --- 3. Extraction: JSON inside <tool_call> ----------------------------------
const jsonInsideXml = `<tool_call>
{"name": "web_search", "arguments": {"query": "pi agent docs"}}
</tool_call>`;

const res3 = extractToolCallsFromText(jsonInsideXml);
t("json inside tag: extracts 1 tool call", res3.toolCalls.length === 1);
t("json inside tag: name is web_search", res3.toolCalls[0]?.name === "web_search");
t("json inside tag: query argument matches", res3.toolCalls[0]?.arguments?.query === "pi agent docs");

// --- 4. Extraction: Attribute format <tool_call name="..."> ------------------
const attrXml = `<tool_call name="read">
<arg name="path">./src/index.ts</arg>
<arg name="limit">100</arg>
</tool_call>`;

const res4 = extractToolCallsFromText(attrXml);
t("attr format: extracts 1 tool call", res4.toolCalls.length === 1);
t("attr format: name is read", res4.toolCalls[0]?.name === "read");
t("attr format: path is ./src/index.ts", res4.toolCalls[0]?.arguments?.path === "./src/index.ts");
t("attr format: limit is number 100", res4.toolCalls[0]?.arguments?.limit === 100);

// --- 5. Extraction: Multiple tool calls in single text -----------------------
const multiCalls = `Thinking process...
<tool_call>read
<arg_key>path</arg_key>
<arg_value>a.txt</arg_value>
</tool_call>
and also
<tool_call>read
<arg_key>path</arg_key>
<arg_value>b.txt</arg_value>
</tool_call>`;

const res5 = extractToolCallsFromText(multiCalls);
t("multi calls: extracts 2 calls", res5.toolCalls.length === 2);
t("multi calls: first is a.txt", res5.toolCalls[0]?.arguments?.path === "a.txt");
t("multi calls: second is b.txt", res5.toolCalls[1]?.arguments?.path === "b.txt");
t("multi calls: cleaned text strips both tags", !res5.cleanedText.includes("<tool_call>"));

// --- 6. Extraction: No tool calls in text -----------------------------------
const cleanText = "Just normal reasoning and thoughts.";
const res6 = extractToolCallsFromText(cleanText);
t("no calls: returns empty array", res6.toolCalls.length === 0);
t("no calls: cleanedText identical", res6.cleanedText === cleanText);

// --- 7. Argument Type Parsing ------------------------------------------------
const typedXml = `<tool_call>test_tool
<arg_key>str_val</arg_key>
<arg_value>hello</arg_value>
<arg_key>bool_true</arg_key>
<arg_value>true</arg_value>
<arg_key>bool_false</arg_key>
<arg_value>false</arg_value>
<arg_key>int_val</arg_key>
<arg_value>42</arg_value>
<arg_key>float_val</arg_key>
<arg_value>3.14</arg_value>
<arg_key>json_arr</arg_key>
<arg_value>["item1", "item2"]</arg_value>
</tool_call>`;

const res7 = extractToolCallsFromText(typedXml);
const args = res7.toolCalls[0]?.arguments || {};
t("type parsing: string", args.str_val === "hello");
t("type parsing: boolean true", args.bool_true === true);
t("type parsing: boolean false", args.bool_false === false);
t("type parsing: int", args.int_val === 42);
t("type parsing: float", args.float_val === 3.14);
t(
  "type parsing: array",
  Array.isArray(args.json_arr) && args.json_arr.length === 2 && args.json_arr[0] === "item1"
);

// --- 8. Message Recovery: Thinking block leak -------------------------------
const messageWithLeakedThinking = {
  role: "assistant",
  stopReason: "stop",
  content: [
    {
      type: "thinking",
      thinking:
        "I need to search for forge.\n<tool_call>web_search\n<arg_key>query</arg_key>\n<arg_value>forge 1.20.1</arg_value>\n</tool_call>",
    },
  ],
};

const recovery1 = recoverLeakedToolCalls(messageWithLeakedThinking);
t("recovery thinking: recovered flag is true", recovery1.recovered === true);
t("recovery thinking: stopReason updated to toolUse", recovery1.message.stopReason === "toolUse");
t(
  "recovery thinking: thinking text cleaned",
  !recovery1.message.content[0].thinking.includes("<tool_call>")
);
const addedToolCall = recovery1.message.content.find((b: any) => b.type === "toolCall");
t("recovery thinking: toolCall block appended", !!addedToolCall);
t("recovery thinking: toolCall name is web_search", addedToolCall?.name === "web_search");
t(
  "recovery thinking: toolCall argument matches",
  addedToolCall?.arguments?.query === "forge 1.20.1"
);
t(
  "recovery thinking: toolCall has unique id",
  typeof addedToolCall?.id === "string" && addedToolCall.id.startsWith("call_")
);

// --- 9. Message Recovery: Already has native toolCall ------------------------
const messageWithNativeToolCall = {
  role: "assistant",
  stopReason: "toolUse",
  content: [
    {
      type: "thinking",
      thinking: "Thinking with accidental XML: <tool_call>web_search</tool_call>",
    },
    {
      type: "toolCall",
      id: "call_native_1",
      name: "web_search",
      arguments: { query: "native" },
    },
  ],
};

const recovery2 = recoverLeakedToolCalls(messageWithNativeToolCall);
t("recovery native: no-op when toolCall already exists", recovery2.recovered === false);

// --- 10. Message Recovery: Non-assistant role --------------------------------
const userMsg = {
  role: "user",
  content: [{ type: "text", text: "<tool_call>web_search</tool_call>" }],
};
const recovery3 = recoverLeakedToolCalls(userMsg);
t("recovery non-assistant: ignored", recovery3.recovered === false);

// --- 11. Python Function Call: Action: prefix + kwargs + list -----------------
const pythonCallText = `Action: game_state(action="set", key="inventory", value=["rope", "half-torch"])`;
const res11 = extractToolCallsFromText(pythonCallText, { isThinking: true });
t("python action: extracts 1 call", res11.toolCalls.length === 1);
t("python action: name is game_state", res11.toolCalls[0]?.name === "game_state");
t("python action: action is set", res11.toolCalls[0]?.arguments?.action === "set");
t("python action: key is inventory", res11.toolCalls[0]?.arguments?.key === "inventory");
t(
  "python action: value is array with items",
  Array.isArray(res11.toolCalls[0]?.arguments?.value) &&
    res11.toolCalls[0]?.arguments?.value[0] === "rope" &&
    res11.toolCalls[0]?.arguments?.value[1] === "half-torch"
);
t("python action: thinking indicator present", res11.cleanedText === "[Recovered tool call: game_state]");

// --- 12. Python Function Call in Narrative Text: clean prose ------------------
const narrativeWithCall = `game_state(action="set", key="inventory", value=["rope", "half-torch"])

The echoes of your confusion ring out into the cavern...`;
const res12 = extractToolCallsFromText(narrativeWithCall, { isThinking: false });
t("narrative text: extracts 1 call", res12.toolCalls.length === 1);
t("narrative text: name is game_state", res12.toolCalls[0]?.name === "game_state");
t("narrative text: cleanedText contains prose", res12.cleanedText === "The echoes of your confusion ring out into the cavern...");
t("narrative text: no raw code in prose", !res12.cleanedText.includes("game_state"));

// --- 13. Positional Args Mapping ----------------------------------------------
const positionalText = `dice_roll("2d6+3", "Stealth check")`;
const res13 = extractToolCallsFromText(positionalText);
t("positional: extracts 1 call", res13.toolCalls.length === 1);
t("positional: spec argument mapped", res13.toolCalls[0]?.arguments?.spec === "2d6+3");
t("positional: reason argument mapped", res13.toolCalls[0]?.arguments?.reason === "Stealth check");

// --- 14. Markdown Code Block Tool Call ----------------------------------------
const codeBlockCall = `Let me check the dice:
\`\`\`tool_call
{"name": "dice_roll", "arguments": {"spec": "1d20", "reason": "Initiative"}}
\`\`\`
rolling now...`;
const res14 = extractToolCallsFromText(codeBlockCall, { isThinking: false });
t("code block: extracts 1 call", res14.toolCalls.length === 1);
t("code block: name is dice_roll", res14.toolCalls[0]?.name === "dice_roll");
t("code block: spec is 1d20", res14.toolCalls[0]?.arguments?.spec === "1d20");
t("code block: prose preserved", res14.cleanedText.includes("Let me check the dice:") && res14.cleanedText.includes("rolling now..."));

// --- 15. Deduplication across thinking and text ------------------------------
const msgWithDupe = {
  role: "assistant",
  stopReason: "stop",
  content: [
    {
      type: "thinking",
      thinking: `I need to give the user the starting items.\nAction: game_state(action="set", key="inventory", value=["rope", "half-torch"])`,
    },
    {
      type: "text",
      text: `game_state(action="set", key="inventory", value=["rope", "half-torch"])\n\nThe echoes of your confusion ring out into the cavern...`,
    },
  ],
};
const recoveryDupe = recoverLeakedToolCalls(msgWithDupe);
t("deduplication: recovered is true", recoveryDupe.recovered === true);
t("deduplication: stopReason is toolUse", recoveryDupe.message.stopReason === "toolUse");
const toolBlocks = recoveryDupe.message.content.filter((b: any) => b.type === "toolCall");
t("deduplication: exactly 1 toolCall block appended", toolBlocks.length === 1);
t("deduplication: call name is game_state", toolBlocks[0]?.name === "game_state");
t(
  "deduplication: text cleaned of leaked code",
  recoveryDupe.message.content[1].text === "The echoes of your confusion ring out into the cavern..."
);
t(
  "deduplication: thinking cleaned of leaked code",
  recoveryDupe.message.content[0].thinking.includes("[Recovered tool call: game_state]") &&
    !recoveryDupe.message.content[0].thinking.includes("Action: game_state")
);

// --- 16. Negative Test: False Positives --------------------------------------
const normalProse = `I took action (not words) to resolve the issue with the system.`;
const res16 = extractToolCallsFromText(normalProse);
t("false positive: no tool calls extracted from English prose", res16.toolCalls.length === 0);
t("false positive: text unchanged", res16.cleanedText === normalProse);

// --- Summary -----------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
