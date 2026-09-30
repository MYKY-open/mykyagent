import { classifyModelId, executionRulesBlock, resolveModelClass } from "./model_class.ts";

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(` ${ok ? "PASS" : "FAIL"}  ${n} ${ok ? "" : extra}`); };

t("tiny gguf -> small", classifyModelId("/home/x/ling-3.0-tiny-Q4_K_M.gguf") === "small");
t("7b coder -> small", classifyModelId("qwen2.5-coder-7b") === "small");
t("empty -> small (safe)", classifyModelId("") === "small");
t("claude sonnet -> big", classifyModelId("openrouter/anthropic/claude-sonnet-4.5") === "big");
t("gpt-4 -> big", classifyModelId("openai/gpt-4o") === "big");
t("resolve default small", resolveModelClass(undefined, undefined) === "small");
process.env.MYKYAGENT_MODEL_CLASS = "big";
t("env override wins", resolveModelClass("ling-tiny") === "big");
delete process.env.MYKYAGENT_MODEL_CLASS;
t("small block is serial", executionRulesBlock("small").includes("serial by design"));
t("big block allows parallel", executionRulesBlock("big").includes("up to 3 INDEPENDENT"));
t("small block lacks parallel", !executionRulesBlock("small").includes("up to 3 INDEPENDENT"));
t("both keep web_search guidance", executionRulesBlock("small").includes("web_search") && executionRulesBlock("big").includes("web_search"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
