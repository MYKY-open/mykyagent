import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-mm-"));
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");
process.env.MYKYAGENT_WEBKILL_FILE = join(DIR, "webkill.json");
process.env.MYKYAGENT_WEBBROWSER_FILE = join(DIR, "webbrowser.json");
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
// Tiny cap so the "oversized" fixture stays small on disk.
process.env.MYKYAGENT_IMAGE_MAX_BYTES = String(1024);

const ext = (await import("./index.ts")).default;
const tools: Record<string, any> = {};
const pi: any = {
  on: () => {},
  registerTool: (d: any) => (tools[d.name] = d),
  registerCommand: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
};
await ext(pi);

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(` ${ok ? "PASS" : "FAIL"}  ${n} ${ok ? "" : extra}`); };

// 1x1 transparent PNG (68 bytes) — under cap, must return image block.
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
writeFileSync(join(DIR, "tiny.png"), tinyPng);
writeFileSync(join(DIR, "big.png"), Buffer.alloc(2048, 7));

const read = tools.read;
t("read tool registered", !!read);
const okRes: any = await read.execute("1", { path: join(DIR, "tiny.png") }, undefined, undefined, { cwd: DIR });
t("small image returns image block",
  okRes?.content?.some((c: any) => c.type === "image" && c.mimeType === "image/png") === true);
t("small image keeps text note",
  okRes?.content?.some((c: any) => c.type === "text" && c.text.includes("Read image file")) === true);

const bigRes: any = await read.execute("2", { path: join(DIR, "big.png") }, undefined, undefined, { cwd: DIR });
t("oversized image rejected", bigRes?.isError === true);
t("rejection names shrink path",
  bigRes?.content?.[0]?.text?.includes("ffmpeg") === true);
t("rejection names env knob",
  bigRes?.content?.[0]?.text?.includes("MYKYAGENT_IMAGE_MAX_BYTES") === true);

// Prompt advertises vision path.
const hooks: Record<string, any> = {};
const pi2: any = { ...pi, on: (n: string, f: any) => (hooks[n] = f), getActiveTools: () => ["read"], setActiveTools: () => {} };
await ext(pi2);
const { systemPrompt } = await hooks.before_agent_start({}, { cwd: DIR });
t("prompt mentions image paths", systemPrompt.includes("image paths"));
t("prompt covers text-only fallback", systemPrompt.includes("lacks vision"));

delete process.env.MYKYAGENT_IMAGE_MAX_BYTES; // restore default 3MB cap for conversion tests
// Modern formats: real fixtures via magick when available, else skip positives.
let haveMagick = false;
try { execFileSync("magick", ["-version"], { stdio: "ignore" }); haveMagick = true; } catch {}
t("magick backend detected (info)", true, haveMagick ? "present" : "absent - positives skipped");
if (haveMagick) {
  // 64x64 red square -> keeps converted PNG well under the default 3MB cap.
  execFileSync("magick", ["-size", "64x64", "xc:red", join(DIR, "sq.png")]);
  for (const fmt of ["avif", "jxl"]) {
    try {
      execFileSync("magick", [join(DIR, "sq.png"), join(DIR, `sq.${fmt}`)], { stdio: "ignore" });
    } catch { /* encoder missing - skip this format */ }
    if (!existsSync(join(DIR, `sq.${fmt}`))) continue;
    const r: any = await read.execute("c", { path: join(DIR, `sq.${fmt}`) }, undefined, undefined, { cwd: DIR });
    t(`${fmt} converts to png image block`,
      r?.content?.some((c: any) => c.type === "image" && c.mimeType === "image/png") === true,
      r?.content?.[0]?.text?.slice(0, 120) || "");
    t(`${fmt} note names source format`,
      r?.content?.some((c: any) => c.type === "text" && c.text.includes(`.${fmt}`)) === true);
  }
}
// Corrupt modern-format file: must fail gracefully with install hint, never throw.
writeFileSync(join(DIR, "bad.avif"), Buffer.alloc(512, 3));
const badRes: any = await read.execute("d", { path: join(DIR, "bad.avif") }, undefined, undefined, { cwd: DIR });
t("corrupt avif rejected gracefully", badRes?.isError === true);
t("corrupt avif names a converter", /magick|ffmpeg/i.test(badRes?.content?.[0]?.text || ""));
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
