import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PERSONAS, loadAllPersonas, parsePersonaFile, personaPromptFor } from "./personas.ts";

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(` ${ok ? "PASS" : "FAIL"}  ${n} ${ok ? "" : extra}`); };

t("builtins have 9 personas incl oneesan", Object.keys(BUILTIN_PERSONAS).length === 9 && !!BUILTIN_PERSONAS.oneesan);
t("oneesan prompt intact (Ara ara)", BUILTIN_PERSONAS.oneesan.prompt.includes("Ara ara~") && BUILTIN_PERSONAS.oneesan.prompt.includes("recursion"));
t("parse frontmatter", (() => { const p = parsePersonaFile("---\nlabel: X\ndesc: Y\n---\nhello"); return !!p && p.label === "X" && p.prompt === "hello"; })());
t("parse rejects no body", parsePersonaFile("---\nlabel: X\ndesc: Y\n---\n") === null);
// file overlay
const dir = mkdtempSync(join(tmpdir(), "personas-"));
process.env.MYKYAGENT_PERSONAS_DIR = dir;
writeFileSync(join(dir, "custom.md"), "---\nlabel: Custom\ndesc: Test custom.\n---\nYou are custom.", "utf-8");
writeFileSync(join(dir, "oneesan.md"), "---\nlabel: Override\ndesc: Overridden.\n---\nOVERRIDDEN PROMPT", "utf-8");
const all = loadAllPersonas();
t("custom file persona loads", all.custom?.prompt === "You are custom.");
t("file overrides builtin same key", all.oneesan?.prompt === "OVERRIDDEN PROMPT");
t("personaPromptFor respects customPrompt", personaPromptFor("caveman", "CUSTOM!") === "CUSTOM!");
delete process.env.MYKYAGENT_PERSONAS_DIR;
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
