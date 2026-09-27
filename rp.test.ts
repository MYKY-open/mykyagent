/**
 * Offline unit tests for the RP subsystem: mode management, character cards,
 * lorebook scanning, author's note, RPG tools, and card audit.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-rp-"));
process.env.MYKYAGENT_MODE_FILE = join(DIR, "mode.json");
process.env.MYKYAGENT_CHARACTERS_DIR = join(DIR, "characters");
process.env.MYKYAGENT_LORE_DIR = join(DIR, "lore");
process.env.MYKYAGENT_AN_FILE = join(DIR, "authors_note.json");
process.env.MYKYAGENT_GAMESTATE_DIR = join(DIR, "gamestate");
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

// --- mode.ts -----------------------------------------------------------------
const mode = await import("./mode.ts");

t("default mode is code", mode.getMode() === "code");
mode.setMode("rp");
t("mode persists as rp", mode.getMode() === "rp");
t("normalizeMode falls back to code", mode.normalizeMode("bogus") === "code");
t("normalizeMode keeps rp-creator", mode.normalizeMode("rp-creator") === "rp-creator");

t("rp mode blocks coding tools", mode.isToolAllowedInMode("bash", "rp") === false);
t("rp mode blocks web tools", mode.isToolAllowedInMode("web_search", "rp") === false);
t("rp mode blocks creator tools", mode.isToolAllowedInMode("character_save", "rp") === false);
t("rp mode keeps read + memory", mode.isToolAllowedInMode("read", "rp") && mode.isToolAllowedInMode("memory_read", "rp"));
t("rp mode keeps rpg tools", RPG_ALLOWS());
function RPG_ALLOWS() {
  return ["dice_roll", "game_state", "advance_time"].every((x) => mode.isToolAllowedInMode(x, "rp"));
}

t("code mode blocks creator + rpg tools", !mode.isToolAllowedInMode("character_save", "code") && !mode.isToolAllowedInMode("dice_roll", "code"));
t("code mode allows coding tools", mode.isToolAllowedInMode("bash", "code") && mode.isToolAllowedInMode("edit", "code"));
t("creator mode allows creator + coding tools", mode.isToolAllowedInMode("character_save", "rp-creator") && mode.isToolAllowedInMode("bash", "rp-creator"));
t("creator mode blocks rpg tools", !mode.isToolAllowedInMode("dice_roll", "rp-creator"));

mode.setMode("rp");
const { setFeatureEnabled } = await import("./toggles.ts");
setFeatureEnabled("rp", false);
t("rp feature off forces code mode", mode.getEffectiveMode() === "code");
setFeatureEnabled("rp", true);
t("rp feature on restores mode", mode.getEffectiveMode() === "rp");

mode.setActiveCharacter("evelyn");
t("active character persists", mode.getActiveCharacterSlug() === "evelyn");

// --- character.ts -------------------------------------------------------------
const ch = await import("./character.ts");

t("slugify normalizes names", ch.slugify("  Ada von Code-Sample! ") === "ada-von-code-sample");
t("estimateTokens ~len/4", ch.estimateTokens("x".repeat(40)) === 10);

const badCard = { name: "", description: "x" };
const vb = ch.validateCard(badCard);
t("validateCard rejects empty name", vb.ok === false && vb.errors.some((e) => e.includes("name")));

// optional fields: minimal name-only card is valid with warnings
const minimal = ch.validateCard({ name: "Just A Name" });
t("minimal card validates with warnings", minimal.ok === true && minimal.warnings.length === 5, JSON.stringify(minimal.warnings));
t("minimal card token estimate 0", minimal.tokenEstimate === 0);

const goodCard = ch.STARTER_CARDS[0].card;
const vg = ch.validateCard(goodCard);
t("validateCard passes starter card", vg.ok === true, JSON.stringify(vg.errors));
t("starter card token estimate sane", vg.tokenEstimate > 50 && vg.tokenEstimate < 1500, String(vg.tokenEstimate));

const saved = ch.saveCharacter(goodCard);
t("saveCharacter derives slug", saved.slug === "evelyn");
t("loadCharacter roundtrip", ch.loadCharacter("evelyn")?.name === "Evelyn");
t("loadCharacter missing returns null", ch.loadCharacter("ghost") === null);
t("listCharacters finds card", ch.listCharacters().some((e) => e.slug === "evelyn"));

const rendered = ch.renderCharacterBlock(goodCard, "Kai");
t("render includes character tags", rendered.includes("<character>") && rendered.includes("<personality>"));
const phCard = { ...goodCard, first_message: "Hello, {{user}}. I am {{CHAR}}.", mes_example: "<START>\n{{user}}: hi\n{{char}}: *nods*" };
t("substitutes {{char}}/{{user}}", ch.renderGreeting(phCard, "Kai") === "Hello, Kai. I am Evelyn." && !ch.renderGreeting(phCard, "Kai").includes("{{user}}"));
t("substitutePlaceholders case-insensitive", ch.substitutePlaceholders("{{USER}} and {{CHAR}}", "Eve", "Bob") === "Bob and Eve");

const mesWarn = ch.validateCard({ ...goodCard, mes_example: "just text, no placeholders" });
t("mes_example placeholder warnings", mesWarn.warnings.some((w) => w.includes("{{user}}")));

// seed + starters
const chDir2 = join(DIR, "seeded");
process.env.MYKYAGENT_CHARACTERS_DIR = chDir2;
ch.seedStarterCharacters();
t("seedStarterCharacters writes 3 cards", ch.listCharacters().length === 3);
process.env.MYKYAGENT_CHARACTERS_DIR = join(DIR, "characters");

// --- import: PNG chara/ccv3 + V1/V2/V3 normalization --------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngWithTextChunks(texts: { keyword: string; text: string }[]): Buffer {
  const parts: Buffer[] = [PNG_SIG];
  for (const { keyword, text } of texts) {
    const data = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write("tEXt", 4, "latin1");
    parts.push(head, data, Buffer.alloc(4)); // CRC placeholder, parser ignores
  }
  const iend = Buffer.alloc(12);
  iend.writeUInt32BE(0, 0);
  iend.write("IEND", 4, "latin1");
  parts.push(iend);
  return Buffer.concat(parts);
}

const V2_PAYLOAD = {
  spec: "chara_card_v2",
  data: {
    name: "Kira",
    description: "Test desc",
    personality: "Test pers",
    scenario: "Test scenario",
    first_mes: "Hello {{user}}.",
    mes_example: "<START>\n{{user}}: hi\n{{char}}: yo",
    system_prompt: "be cool",
    creator_notes: "made for tests",
    tags: ["test"],
    alternate_greetings: ["alt one", "alt two"],
    extensions: { depth_prompt: { depth: 4 } },
  },
};

const pngBuf = pngWithTextChunks([{ keyword: "chara", text: Buffer.from(JSON.stringify(V2_PAYLOAD), "utf8").toString("base64") }]);
const pngPath = join(DIR, "kira.png");
writeFileSync(pngPath, pngBuf);

const imp = await ch.importCharacter(pngPath);
t("png import decodes V2 card", imp.ok === true && imp.card?.name === "Kira" && imp.spec === "chara_card_v2", imp.error || "");
t("png import maps first_mes", imp.card?.first_message === "Hello {{user}}.");
t("png import warns about dropped extras", imp.warnings.some((w) => w.includes("alternate_greeting")) && imp.warnings.some((w) => w.includes("extensions")));
t("png import saves card", ch.loadCharacter("kira")?.name === "Kira");

// UTF-16LE encoded payload (old exporter style)
const utf16Buf = pngWithTextChunks([
  { keyword: "chara", text: Buffer.from(JSON.stringify({ name: "Old16", description: "d", personality: "p", scenario: "s", first_mes: "g", mes_example: "m" }), "utf16le").toString("base64") },
]);
const utf16Path = join(DIR, "old16.png");
writeFileSync(utf16Path, utf16Buf);
const imp16 = await ch.importCharacter(utf16Path);
t("utf16le payload decodes", imp16.ok === true && imp16.card?.name === "Old16", imp16.error || "");

// V3 ccv3 chunk preferred over chara
const v3Payload = { spec: "chara_card_v3", data: { ...V2_PAYLOAD.data, name: "V3Name" } };
const v3Buf = pngWithTextChunks([
  { keyword: "chara", text: Buffer.from(JSON.stringify(V2_PAYLOAD), "utf8").toString("base64") },
  { keyword: "ccv3", text: Buffer.from(JSON.stringify(v3Payload), "utf8").toString("base64") },
]);
const v3Path = join(DIR, "v3card.png");
writeFileSync(v3Path, v3Buf);
const imp3 = await ch.importCharacter(v3Path);
t("ccv3 chunk preferred over chara", imp3.ok === true && imp3.card?.name === "V3Name" && imp3.spec === "chara_card_v3", imp3.error || "");

// PNG without card chunk
const plainPng = join(DIR, "plain.png");
writeFileSync(plainPng, pngWithTextChunks([{ keyword: "Comment", text: "just a comment" }]));
const impPlain = await ch.importCharacter(plainPng);
t("png without chara chunk errors", impPlain.ok === false && impPlain.error!.includes("no chara/ccv3"));

// corrupt base64 payload
const corruptPng = join(DIR, "corrupt.png");
writeFileSync(corruptPng, pngWithTextChunks([{ keyword: "chara", text: "!!!notbase64json!!!" }]));
const impCorrupt = await ch.importCharacter(corruptPng);
t("corrupt payload errors cleanly", impCorrupt.ok === false && impCorrupt.error!.includes("did not decode"));

// V1 flat JSON file (spec field names: first_mes, creatorcomment)
const v1Path = join(DIR, "v1flat.json");
writeFileSync(v1Path, JSON.stringify({ name: "Old V1", description: "d", personality: "p", scenario: "s", first_mes: "g", mes_example: "m", creatorcomment: "old note" }));
const impV1 = await ch.importCharacter(v1Path);
t("V1 flat json imports", impV1.ok === true && impV1.spec === "v1" && impV1.card?.creator_notes === "old note", impV1.error || "");

// V2 nested JSON file
const v2Path = join(DIR, "v2nested.json");
writeFileSync(v2Path, JSON.stringify(V2_PAYLOAD));
const impV2 = await ch.importCharacter(v2Path);
t("V2 nested json imports", impV2.ok === true && impV2.card?.name === "Kira");

// invalid card (no name) rejected by validation
const badPath = join(DIR, "bad.json");
writeFileSync(badPath, JSON.stringify({ spec: "chara_card_v2", data: { description: "no name here" } }));
const impBad = await ch.importCharacter(badPath);
t("card without name gets fallback name", impBad.ok === true && impBad.card?.name === "Unnamed Import", JSON.stringify(impBad));
t("minimal card saves and loads", (() => {
  ch.saveCharacter({ name: "Minimalist" } as any, "minimalist");
  const loaded = ch.loadCharacter("minimalist");
  return loaded?.name === "Minimalist" && loaded?.description === undefined;
})());
t("renderCharacterBlock skips absent fields", !ch.renderCharacterBlock({ name: "Bare" } as any, "U").includes("<personality>") && ch.renderCharacterBlock({ name: "Bare" } as any, "U").includes("<name>Bare</name>"));
t("renderGreeting empty when no first_message", ch.renderGreeting({ name: "Bare" } as any, "U") === "");

// missing file / non-card json
const impMissing = await ch.importCharacter(join(DIR, "nope.png"));
t("missing file errors", impMissing.ok === false && impMissing.error!.includes("could not read"));
const junkPath = join(DIR, "junk.json");
writeFileSync(junkPath, "{ not json");
const impJunk = await ch.importCharacter(junkPath);
t("non-JSON file errors", impJunk.ok === false && impJunk.error!.includes("neither a PNG"));

t("decodeCardPayload: plain base64 json", (() => {
  const v = ch.decodeCardPayload(Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64"));
  return v?.a === 1;
})());
t("decodeCardPayload: empty returns null", ch.decodeCardPayload("") === null);

// --- lorebook.ts ---------------------------------------------------------------
const lore = await import("./lorebook.ts");

lore.saveLorebook("neo-kyoto", [
  { keys: ["neo-kyoto", "the city"], content: "Neo-Kyoto is a vertical megacity of 40M stacked souls.", priority: 10 },
  { keys: ["the syndicate"], content: "The Chrome Lotus syndicate runs the harbor districts.", priority: 5 },
  { keys: ["drift"], content: "Drift is the cheap neural net drug kids cook from signal boosters.", priority: 1 },
]);

t("saveLorebook filters keyless entries", lore.loadLorebook("neo-kyoto").length === 3);
const emptyOk = lore.saveLorebook("junk", [{ keys: [], content: "orphan" }, { keys: ["real"], content: "kept" }]);
t("entries without keys dropped", emptyOk.count === 1);

const scan1 = lore.scanLore("We take the maglev across Neo-Kyoto at dusk.", lore.loadLorebook("neo-kyoto"));
t("scanLore matches word-boundary key", scan1.length === 1 && scan1[0].matchedKey === "neo-kyoto");
t("scanLore no false positive on substring", lore.scanLore("neokyotan expat", lore.loadLorebook("neo-kyoto")).length === 0);
const scan2 = lore.scanLore("the city sleeps, the syndicate watches", lore.loadLorebook("neo-kyoto"));
t("multiword keys match", scan2.length === 2);

const overlaps = lore.findTriggerOverlaps([
  { keys: ["gold", "coins"], content: "a" },
  { keys: ["gold"], content: "b" },
]);
t("findTriggerOverlaps detects dupes", overlaps.length === 1 && overlaps[0].includes('"gold"'));

const block = lore.renderActiveLore(scan2);
t("renderActiveLore block format", block.startsWith("<active_lore>") && block.includes("(the city)"));
t("renderActiveLore empty when no matches", lore.renderActiveLore([]) === "");

const prio = lore.scanLore("drift and the syndicate", lore.loadLorebook("neo-kyoto"));
t("priority orders matches", prio[0].matchedKey === "the syndicate");

const dup = lore.scanLore("drift", [{ keys: ["drift"], content: "same" }, { keys: ["drift"], content: "SAME" }]);
t("duplicate content suppressed", dup.length === 1);

// --- authors_note.ts -------------------------------------------------------------
const an = await import("./authors_note.ts");

t("author note default empty", an.getAuthorNote().text === undefined && an.getAuthorNote().depth === 1);
an.setAuthorNote("Focus on sensory tension.");
an.setAuthorNoteDepth(3);
t("author note persists", an.getAuthorNote().text === "Focus on sensory tension." && an.getAuthorNote().depth === 3);
t("depth floors at 1", (an.setAuthorNoteDepth(0), an.getAuthorNote().depth === 1));
t("renderAuthorNoteBlock format", an.renderAuthorNoteBlock().includes("[Author's Note (insert at depth 1): Focus on sensory tension.]"));
an.clearAuthorNote();
t("clear keeps depth, drops text", an.getAuthorNote().text === undefined && an.renderAuthorNoteBlock() === "");

// --- rpg_tools.ts ------------------------------------------------------------------
const rpg = await import("./rpg_tools.ts");

t("rollDice rejects garbage", rpg.rollDice("banana") === null && rpg.rollDice("2d1") === null);
const d20 = rpg.rollDice("d20");
t("d20 in range", !!d20 && d20.rolls.length === 1 && d20.total >= 1 && d20.total <= 20);
const spec = rpg.rollDice("2d6+3");
t("2d6+3 total in range", !!spec && spec.total >= 5 && spec.total <= 15 && spec.modifier === 3);
const fudge = rpg.rollDice("4dF");
t("4dF fudge in range", !!fudge && fudge.total >= -4 && fudge.total <= 4);
const kh = rpg.rollDice("2d20kh1");
t("2d20kh1 keeps one die", !!kh && kh.rolls.length === 2 && kh.total >= 1 && kh.total <= 20);
const neg = rpg.rollDice("3d10-2");
t("3d10-2 modifier", !!neg && neg.modifier === -2 && neg.total >= 1 && neg.total <= 28);

t("dotted get/set roundtrip", (() => {
  const s: Record<string, any> = {};
  rpg.setStateValue(s, "inventory.gold", 150);
  return rpg.getStateValue(s, "inventory.gold") === 150 && rpg.getStateValue(s, "inventory.missing") === undefined;
})());

t("game state persists to disk", (() => {
  const s = rpg.loadGameState("test-campaign");
  rpg.setStateValue(s, "hp", 12);
  rpg.saveGameState("test-campaign", s);
  return rpg.loadGameState("test-campaign").hp === 12;
})());

t("world time default Day 1 08:00", (() => {
  const t2 = rpg.getWorldTime({});
  return t2.day === 1 && t2.hour === 8;
})());
const advanced = rpg.advanceWorldTime({}, 4, 30, 0);
t("advance 4h30m", advanced.hour === 12 && advanced.minute === 30);
const nextDay = rpg.advanceWorldTime({ world: { time: { day: 1, hour: 23, minute: 30 } } }, 1, 0, 0);
t("rolls into next day", nextDay.day === 2 && nextDay.hour === 0 && nextDay.minute === 30);
t("describeWorldTime has phase", rpg.describeWorldTime({ day: 2, hour: 3, minute: 5 }).includes("deep night"));

// --- rp_creator.ts ------------------------------------------------------------------
const rc = await import("./rp_creator.ts");

const auditGood = rc.auditCard("evelyn");
t("auditCard passes good card", auditGood.found === true && auditGood.ok === true, JSON.stringify(auditGood.errors));
const auditGhost = rc.auditCard("ghost-card");
t("auditCard reports missing card", auditGhost.found === false && auditGhost.summary.includes("No character card"));

// audit catches lore overlaps through card.lorebook link
const badLoreCard = { ...goodCard, lorebook: "overlap-book" };
ch.saveCharacter(badLoreCard, "evelyn-lore");
lore.saveLorebook("overlap-book", [
  { keys: ["amulet"], content: "a" },
  { keys: ["amulet", "silver"], content: "b" },
]);
const auditOverlap = rc.auditCard("evelyn-lore");
t("auditCard detects lore overlaps", auditOverlap.loreOverlaps!.length === 1);

// tool execute paths
const saveTool = rc.characterSaveTool();
const rejected = await saveTool.execute("x", { slug: "nope", card: { name: "" } });
t("character_save rejects invalid card", rejected.isError === true);
const accepted = await saveTool.execute("x", { slug: "Test Card!", card: { ...goodCard, name: "Test Card" } });
t("character_save accepts valid card", accepted.isError !== true && String(accepted.content[0].text).includes("slug: test-card"));

const readTool = rc.characterReadTool();
const readMiss = await readTool.execute("x", { slug: "ghost" });
t("character_read errors on missing", readMiss.isError === true);
const readHit = await readTool.execute("x", { slug: "test-card" });
t("character_read returns card JSON", readHit.isError !== true && String(readHit.content[0].text).includes('"name": "Test Card"'));

const loreTool = rc.lorebookSaveTool();
const loreSaved = await loreTool.execute("x", { slug: "Tool Book", entries: [{ keys: ["k"], content: "v" }] });
t("lorebook_save slugs and counts", String(loreSaved.content[0].text).includes('"tool-book"') && String(loreSaved.content[0].text).includes("1 valid entries"));

const auditTool = rc.cardAuditTool();
const auditRes = await auditTool.execute("x", { slug: "evelyn" });
t("card_audit tool returns summary", String(auditRes.content[0].text).includes("token"));

// --- prompt builders ------------------------------------------------------------------
const rpPrompt = mode.buildRpSystemPrompt({
  characterBlock: "<character>TEST</character>",
  loreBlock: "<active_lore>LORE</active_lore>",
  authorsNoteBlock: "[Author's Note: AN]",
  userName: "Kai",
});
t("rp prompt embeds all blocks", rpPrompt.includes("<character>TEST</character>") && rpPrompt.includes("<active_lore>LORE</active_lore>") && rpPrompt.includes("[Author's Note: AN]"));
t("rp prompt names user", rpPrompt.includes("Kai"));
t("rp prompt forbids AI talk", rpPrompt.includes("Never mention being an AI"));
t("creator prompt covers workflows", mode.buildCreatorSystemPrompt().includes("character_save") && mode.buildCreatorSystemPrompt().includes("card_audit"));

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
