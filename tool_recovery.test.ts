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

// --- Summary -----------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
