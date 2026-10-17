/**
 * Offline tests for the read tool's vision fallback: image-capable models get
 * raw vision blocks; models without image input get a server-side description;
 * failures are honest errors, not silent drops.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFileSync } from "node:child_process";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-read-"));
process.env.MYKYAGENT_TOGGLES_FILE = join(DIR, "toggles.json");

let pass = 0,
  fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
  if (ok) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};

// 1x1 transparent PNG (68 bytes)
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const imgPath = join(DIR, "tiny.png");
writeFileSync(imgPath, PNG_1X1);

const ext = (await import("./index.ts")).default;
const tools: Record<string, any> = {};
const hooks: Record<string, any> = {};
const pi: any = {
  on: (n: string, f: any) => (hooks[n] = f),
  registerTool: (def: any) => (tools[def.name] = def),
  registerCommand: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
};
await ext(pi);
t("read tool registered", !!tools["read"]);

const realFetch = (globalThis as any).fetch;

// image-capable model: raw vision blocks, no HTTP
{
  let fetchCalls = 0;
  (globalThis as any).fetch = async () => { fetchCalls++; throw new Error("must not be called"); };
  try {
    const res = await tools["read"].execute("x", { path: imgPath }, undefined, undefined, {
      cwd: DIR,
      model: { provider: "test", id: "seer", input: ["text", "image"] },
    });
    const hasImage = Array.isArray(res.content) && res.content.some((c: any) => c?.type === "image");
    t("capable model gets vision blocks", !res.isError && hasImage && fetchCalls === 0, JSON.stringify(res.content?.[0]).slice(0, 120));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

// incapable model: HTTP vision description
{
  const seen: any[] = [];
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    seen.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "A very cursed cat." } }] }) };
  };
  try {
    const res = await tools["read"].execute("x", { path: imgPath }, undefined, undefined, {
      cwd: DIR,
      model: { provider: "llama-local", id: "text-only", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    const text = String(res.content?.[0]?.text || "");
    const sentImage = seen.length === 1 && JSON.stringify(seen[0]).includes("image_url");
    t("incapable model gets a description", !res.isError && text.includes("A very cursed cat.") && sentImage, text.slice(0, 160));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

// vision server down: honest error naming the fix
{
  (globalThis as any).fetch = async () => ({ ok: false, status: 500 });
  try {
    const res = await tools["read"].execute("x", { path: imgPath }, undefined, undefined, {
      cwd: DIR,
      model: { provider: "llama-local", id: "text-only", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    t("vision failure is an honest error", res.isError === true && String(res.content?.[0]?.text).includes("models.json"), String(res.content?.[0]?.text).slice(0, 200));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

// oversize image: clean refusal, no HTTP attempt
{
  let fetchCalls = 0;
  (globalThis as any).fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({ choices: [] }) }; };
  try {
    const bigPath = join(DIR, "big.png");
    writeFileSync(bigPath, Buffer.alloc(7 * 1024 * 1024, 0));
    const res = await tools["read"].execute("x", { path: bigPath }, undefined, undefined, {
      cwd: DIR,
      model: { provider: "llama-local", id: "text-only" },
    });
    t("oversize image refused cleanly", res.isError === true && fetchCalls === 0, String(res.content?.[0]?.text).slice(0, 120));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

// avif autoconverts straight through (needs an ffmpeg with an avif encoder)
{
  const avifPath = join(DIR, "tiny.avif");
  let haveAvif = false;
  try {
    execFileSync("ffmpeg", ["-nostats", "-loglevel", "error", "-y", "-i", imgPath, avifPath], { timeout: 30000 });
    haveAvif = true;
  } catch {
    haveAvif = false;
  }
  if (!haveAvif) {
    t("avif skipped (no ffmpeg avif encoder)", true);
  } else {
    const res = await tools["read"].execute("x", { path: avifPath }, undefined, undefined, {
      cwd: DIR,
      model: { provider: "test", id: "seer", input: ["text", "image"] },
    });
    const text = String(res.content?.[0]?.text || "");
    const hasImage = Array.isArray(res.content) && res.content.some((c: any) => c?.type === "image" && c?.mimeType === "image/png");
    t("avif autoconverts to vision blocks", !res.isError && hasImage && text.includes("auto-converted from .avif"), text.slice(0, 140));
  }
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
