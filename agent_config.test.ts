import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agentcfg-"));
process.env.MYKYAGENT_WEBKILL_FILE = join(dir, "webkill.json");
process.env.MYKYAGENT_WEBBROWSER_FILE = join(dir, "webbrowser.json");
process.env.MYKYAGENT_WEBMODEL_FILE = join(dir, "webmodel.json");

const cfg = await import("./agent_config.ts");
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(` ${ok ? "PASS" : "FAIL"}  ${n} ${ok ? "" : extra}`); };

t("web default on", cfg.webDisabled() === false);
cfg.setWebDisabled(true);
t("web off persists", cfg.webDisabled() === true);
cfg.setWebDisabled(false);
t("web on again", cfg.webDisabled() === false);
t("browser default auto", cfg.getBrowserMode() === "auto");
cfg.setBrowserMode("force");
t("browser force", cfg.getBrowserMode() === "force");
cfg.setBrowserMode("off");
t("browser off", cfg.getBrowserMode() === "off");
cfg.setBrowserMode("auto");
t("webmodel default null", cfg.loadWebModel() === null);
cfg.saveWebModel({ provider: "openrouter", id: "x/y" });
t("webmodel roundtrip", cfg.loadWebModel()?.id === "x/y");
cfg.saveWebModel(null);
t("webmodel clear -> follow", cfg.loadWebModel() === null);
t("status line mentions browser", cfg.webStatusLine().includes("browser"));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
