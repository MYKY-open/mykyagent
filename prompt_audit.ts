/**
 * System-prompt audit harness: builds the REAL system prompt from the
 * before_agent_start hook for every persona and reports size. Offline; uses a
 * temp memory dir so the real memory index does not pollute the numbers.
 *   ./run_prompt_audit.sh   (bundles with esbuild like the smoke test)
 */
import ext, { PERSONAS } from "./index.ts";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYKYAGENT_MEMORY_DIR = mkdtempSync(join(tmpdir(), "mykyaudit-mem-"));

const PERSONA_FILE = join(process.env.HOME || "", ".config", "mykyagent", "persona.json");
const personaBackup = existsSync(PERSONA_FILE) ? readFileSync(PERSONA_FILE, "utf-8") : null;

const hooks: Record<string, any> = {};
(ext as any)({
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: () => {},
  registerCommand: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
});

const ctx = { getModel: () => undefined, cwd: process.cwd(), ui: {} };
const restore = () => {
  if (personaBackup === null) {
    try {
      unlinkSync(PERSONA_FILE);
    } catch {}
  } else {
    writeFileSync(PERSONA_FILE, personaBackup, "utf-8");
  }
};

console.log("=== system prompt size per persona (empty memory index) ===");
for (const key of Object.keys(PERSONAS)) {
  writeFileSync(PERSONA_FILE, JSON.stringify({ current: key }), "utf-8");
  const res = await hooks["before_agent_start"]({}, ctx);
  const sp: string = res?.systemPrompt || "";
  console.log(`  ${key.padEnd(12)} ${String(sp.length).padStart(6)} chars  ~${Math.round(sp.length / 4)} tok`);
}
restore();

// custom persona: typical short custom prompt
writeFileSync(PERSONA_FILE, JSON.stringify({ current: "custom", customPrompt: "You are a terse sysadmin. Answer with commands first." }), "utf-8");
const customRes = await hooks["before_agent_start"]({}, ctx);
const customSp: string = customRes?.systemPrompt || "";
console.log(`  ${"custom(eg)".padEnd(12)} ${String(customSp.length).padStart(6)} chars  ~${Math.round(customSp.length / 4)} tok`);
restore();

// dump one full prompt for eyeballing
writeFileSync(PERSONA_FILE, JSON.stringify({ current: "caveman" }), "utf-8");
const res = await hooks["before_agent_start"]({}, ctx);
console.log("\n=== FULL CAVEPROMPT ===");
console.log(res?.systemPrompt);

rmSync(process.env.MYKYAGENT_MEMORY_DIR!, { recursive: true, force: true });
