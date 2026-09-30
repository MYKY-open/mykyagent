import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rpprompt-"));
process.env.MYKYAGENT_MODE_FILE = join(dir, "mode.json");
process.env.MYKYAGENT_MEMORY_DIR = join(dir, "memory");
process.env.MYKYAGENT_TOGGLES_FILE = join(dir, "toggles.json");

const { assembleRpPrompt } = await import("./rp_prompt.ts");
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(` ${ok ? "PASS" : "FAIL"}  ${n} ${ok ? "" : extra}`); };

const r1 = assembleRpPrompt({ prompt: "hello tavern" });
t("rp prompt mentions character", r1.systemPrompt.includes("<character>"));
t("rp prompt has planning rules", r1.systemPrompt.includes("Planning Rules") || r1.systemPrompt.includes("immersive roleplay"));
t("rp prompt forbids raw calls", r1.systemPrompt.includes("NEVER output raw function calls"));
const r2 = assembleRpPrompt({ prompt: "hello", card: null });
t("null card -> suggest load hint", r2.systemPrompt.includes("/character load"));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
