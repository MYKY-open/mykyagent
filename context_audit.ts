/**
 * Full per-turn context audit: system prompt + every registered tool schema
 * (name + description + parameters JSON — what pi declares to the model).
 * Offline; temp dirs so real configs don't pollute numbers.
 *   ./run_context_audit.sh
 */
import ext from "./index.ts";
import { writeMemoryEntry } from "./memory.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "mykyctx-"));
for (const k of ["MEMORY", "MCP", "MCPKILL", "WEBKILL", "WEBBROWSER", "TOGGLES", "MODE", "WEBMODEL"]) {
  process.env[`MYKYAGENT_${k}_FILE`] = join(tmp, `${k.toLowerCase()}.json`);
  process.env[`MYKYAGENT_${k}_DIR`] = join(tmp, `${k.toLowerCase()}.d`);
}
process.env.MYKYAGENT_TOGGLES_FILE = join(tmp, "toggles.json");
process.env.MYKYAGENT_MODE_FILE = join(tmp, "mode.json");
process.env.MYKYAGENT_WEBMODEL_FILE = join(tmp, "webmodel.json");

const tools: Record<string, any> = {};
const hooks: Record<string, any> = {};
let activeTools: string[] = [];
(ext as any)({
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: (def: any) => (tools[def.name] = def),
  registerCommand: () => {},
  getActiveTools: () => [...activeTools],
  setActiveTools: (t: string[]) => (activeTools = [...t]),
});

activeTools = ["bash", "read"];
const res = await hooks["before_agent_start"]({}, { cwd: process.cwd(), getModel: () => undefined });
const sp: string = res?.systemPrompt || "";

console.log("=== SYSTEM PROMPT ===");
console.log(`  ${sp.length} chars  ~${Math.round(sp.length / 4)} tok`);

// Section breakdown: split on the known headers
const headers = ["Planning Rules", "Code & Log Inspection Rules", "File Path & Output Rules", "Efficiency & Execution Rules", "Response Rules", "Tool Calling Rules", "Available Tools"];
let pos = 0;
console.log("\n=== SYSTEM PROMPT SECTIONS (prompt order) ===");
const ordered = ["Available Tools", "Planning Rules", "Code & Log Inspection Rules", "File Path & Output Rules", "Efficiency & Execution Rules", "Response Rules", "Tool Calling Rules"];
const headBlock = sp.slice(0, sp.indexOf("Available Tools") >= 0 ? sp.indexOf("Available Tools") : sp.length);
console.log(`  header(persona+date+cwd+goal)  ${headBlock.length} chars  ~${Math.round(headBlock.length / 4)} tok`);
for (let i = 0; i < ordered.length; i++) {
  const h = ordered[i];
  const start = sp.indexOf(h);
  if (start < 0) {
    console.log(`  ${h}  MISSING`);
    continue;
  }
  const nextStarts = ordered.slice(i + 1).map((nh) => sp.indexOf(nh, start + h.length)).filter((x) => x > start);
  const end = nextStarts.length ? Math.min(...nextStarts) : sp.length;
  const len = end - start;
  console.log(`  ${h.padEnd(28)} ${String(len).padStart(5)} chars  ~${Math.round(len / 4)} tok`);
}

console.log("\n=== TOOL SCHEMAS (as declared to model) ===");
let total = 0;
const rows: [string, number, number][] = [];
for (const [name, def] of Object.entries(tools)) {
  const schemaJson = JSON.stringify({ name, description: (def as any).description, parameters: (def as any).parameters });
  rows.push([name, schemaJson.length, Math.round(schemaJson.length / 4)]);
  total += schemaJson.length;
}
rows.sort((a, b) => b[1] - a[1]);
for (const [name, chars, tok] of rows) console.log(`  ${name.padEnd(18)} ${String(chars).padStart(6)} chars  ~${tok} tok`);
console.log(`  ${"TOTAL tools".padEnd(18)} ${String(total).padStart(6)} chars  ~${Math.round(total / 4)} tok`);

console.log("\n=== PER-TURN TOTAL (system + schemas) ===");
console.log(`  ${sp.length + total} chars  ~${Math.round((sp.length + total) / 4)} tok`);

// Active toolset after merge (what model actually sees)
console.log("\n=== ACTIVE TOOLSET AFTER MERGE ===");
console.log(`  ${activeTools.join(", ")}`);

// Memory index with 3 typical topics: measures index-block cost
writeMemoryEntry("s10e_kernel_project", "S10e kernel: OC2808/88C/UV, flash verified, thermal-HAL trip stomp", "body ".repeat(200));
writeMemoryEntry("mykyagent_rp_harness", "MykyAgent RP harness: tri-mode, files, env vars, commands", "body ".repeat(200));
writeMemoryEntry("cardputer_build_env", "Cardputer Arduino build env: arduino-cli 1.5.1, esp32 core", "body ".repeat(100));
const resMem = await hooks["before_agent_start"]({}, { cwd: process.cwd(), getModel: () => undefined });
const spMem: string = resMem?.systemPrompt || "";
console.log("\n=== MEMORY INDEX (3 topics) ===");
console.log(`  delta vs empty: ${spMem.length - sp.length} chars  ~${Math.round((spMem.length - sp.length) / 4)} tok`);

rmSync(tmp, { recursive: true, force: true });
