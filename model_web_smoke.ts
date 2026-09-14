/**
 * Offline smoke test for the /model-web command + distill override.
 * Fake registry, real webmodel.json state (backed up + restored).
 */
import ext from "./index.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// pi's keyHint/DynamicBorder read the global theme; the real TUI inits it at
// startup, so mirror that here before the picker component is constructed.
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

const WM = join(homedir(), ".config", "mykyagent", "webmodel.json");
const backup = existsSync(WM) ? readFileSync(WM, "utf-8") : null;
const notify = (m: string) => console.log("  [notify]", m.split("\n").join(" | "));

const commands: Record<string, any> = {};
(ext as any)({
  on: () => {},
  registerTool: () => {},
  registerCommand: (name: string, def: any) => (commands[name] = def),
});

const fakeModel = { provider: "llama-local", id: "FAKE-MAIN" };
const registry = {
  find: (p: string, id: string) =>
    p === "llama-local" && (id === "Qwen3.5-9B" || id === "FAKE-MAIN")
      ? { provider: p, id }
      : undefined,
  getAvailable: () => [
    { provider: "llama-local", id: "FAKE-MAIN" },
    { provider: "llama-local", id: "Qwen3.5-9B" },
  ],
  getError: () => undefined,
  refresh: async () => ({ aborted: false, errors: new Map() }),
};

const ctx: any = {
  modelRegistry: registry,
  model: fakeModel,
  ui: { notify, select: async (_t: string, opts: string[]) => opts[1] }, // picks first real model
};

console.log("--- 1. /model-web (no args, picker picks entry 1) ---");
await commands["model-web"].handler("", ctx);
console.log("file:", readFileSync(WM, "utf-8").replace(/\s+/g, " "));

console.log("--- 2. /model-web set llama-local/Qwen3.5-9B ---");
await commands["model-web"].handler("set llama-local/Qwen3.5-9B", ctx);

console.log("--- 3. /model-web set bogus/nope (should fail) ---");
await commands["model-web"].handler("set bogus/nope", ctx);

console.log("--- 4. /model-web list ---");
await commands["model-web"].handler("list", ctx);

console.log("--- 5. /model-web clear ---");
await commands["model-web"].handler("clear", ctx);
console.log("file:", readFileSync(WM, "utf-8").replace(/\s+/g, " "));

console.log("--- 6. registry resolve: override model reaches complete() ---");
await commands["model-web"].handler("set llama-local/Qwen3.5-9B", ctx);
const tools: Record<string, any> = {};
(ext as any)({
  on: () => {},
  registerTool: (t: any) => (tools[t.name] = t),
  registerCommand: () => {},
});
// local HTTP server so the helper's fetch stage succeeds and distill runs
const http = await import("node:http");
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<html><head><title>Smoke Page</title></head><body><h1>Model Web Smoke</h1><p>Version 1.2.3 released 2026-09-14.</p></body></html>");
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as any).port;
// fake registry whose complete() records which model it got
let gotModel: any = null;
registry.complete = async (model: any) => {
  gotModel = model;
  return { content: [{ type: "text", text: "smoke-ok" }], usage: { input: 1, output: 1 } };
};
const r = await tools["web_fetch"].execute(
  "smoke",
  { url: `http://127.0.0.1:${port}/`, query: "version" },
  undefined,
  undefined,
  { model: fakeModel, modelRegistry: registry, cwd: process.cwd() }
);
const text = (r.content || []).map((c: any) => c.text).join("\n");
console.log("  override model seen by complete():", gotModel?.id);
console.log("  distill output present:", text.includes("smoke-ok"));
server.close();

console.log("--- 7. restore original webmodel state ---");
if (backup === null) {
  const { unlinkSync } = await import("node:fs");
  try { unlinkSync(WM); } catch {}
} else {
  writeFileSync(WM, backup, "utf-8");
}

console.log("--- 8. pi's ModelSelectorComponent: filter + enter ---");
let pickerCmp: any = null;
{
  let pickedValue: any;
  const tuiStub = { requestRender() {} };
  const handlerP = commands["model-web"].handler("", {
    modelRegistry: registry,
    model: fakeModel,
    ui: {
      notify,
      custom: (factory: any) =>
        new Promise<string | undefined>((res) => {
          pickerCmp = factory(tuiStub, undefined, undefined, (v: any) => {
            pickedValue = v;
            res(v);
          });
        }),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  if (!pickerCmp) throw new Error("picker component not built");
  for (const ch of "qwen") pickerCmp.handleInput(ch);
  await new Promise((r) => setTimeout(r, 50));
  console.log("  state: closed=", pickerCmp.closed, "n=", pickerCmp.filteredModels.length, "sel=", pickerCmp.selectedIndex);
  try {
    pickerCmp.handleInput("\r");
    await new Promise((r) => setTimeout(r, 50));
  } catch (e) {
    console.log("  handleInput(\\r) threw:", e?.message);
  }
  console.log("  after enter: closed=", pickerCmp.closed, "picked=", pickedValue);
  await handlerP;
  console.log(
    "  picked:",
    pickedValue ? `${pickedValue.provider}/${pickedValue.id}` : pickedValue,
    "| file:",
    readFileSync(WM, "utf-8").replace(/\s+/g, " ")
  );
}

console.log("--- 9. esc cancels without change ---");
{
  const before = readFileSync(WM, "utf-8");
  let picker2: any = null;
  const tuiStub = { requestRender() {} };
  const handlerP = commands["model-web"].handler("", {
    modelRegistry: registry,
    model: fakeModel,
    ui: {
      notify,
      custom: (factory: any) =>
        new Promise<string | undefined>((res) => {
          picker2 = factory(tuiStub, undefined, undefined, res);
        }),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  picker2.handleInput("\x1b"); // escape
  await handlerP;
  console.log("  file unchanged:", readFileSync(WM, "utf-8") === before);
}

console.log("--- 10. no-match filter renders without crash ---");
{
  let picker3: any = null;
  const tuiStub = { requestRender() {} };
  const handlerP = commands["model-web"].handler("", {
    modelRegistry: registry,
    model: fakeModel,
    ui: {
      notify,
      custom: (factory: any) =>
        new Promise<string | undefined>((res) => {
          picker3 = factory(tuiStub, undefined, undefined, res);
        }),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  for (const ch of "zzzz") picker3.handleInput(ch);
  const lines = picker3.render(100).join("\n");
  console.log("  render ok:", typeof lines === "string" && lines.length > 0);
  picker3.handleInput("\x1b");
  await handlerP;
}

console.log("--- 11. picker lists default entry; picking it clears override ---");
{
  // set an override first
  await commands["model-web"].handler("set llama-local/Qwen3.5-9B", ctx);
  let picker4: any = null;
  const tuiStub = { requestRender() {} };
  const handlerP = commands["model-web"].handler("", {
    modelRegistry: registry,
    model: fakeModel,
    ui: {
      notify,
      custom: (factory: any) =>
        new Promise<string | undefined>((res) => {
          picker4 = factory(tuiStub, undefined, undefined, res);
        }),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  console.log("  all entries:", picker4.allModels.map((i: any) => `${i.provider}/${i.id}`).join(", "));
  for (const ch of "follow") picker4.handleInput(ch);
  await new Promise((r) => setTimeout(r, 30));
  picker4.handleInput("\r");
  await handlerP;
  console.log("  file after picking default:", readFileSync(WM, "utf-8").replace(/\s+/g, " "));
}
console.log("done");
