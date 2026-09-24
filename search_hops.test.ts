import { runSearchHops, parseFollowup, parseMissing, mergeUsage, type ResearchPayload } from "./search_hops.ts";

let pass = 0, fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(` PASS  ${name}`); }
  else { fail++; console.log(` FAIL  ${name} ${extra}`); }
};
const page = (u: string) => ({ url: u, title: "t", content: "c".repeat(200) });
const render = (raw: ResearchPayload, o: { note?: string }) =>
  (o.note ? `NOTE:${o.note}\n` : "") + `PAGES:${(raw.pages || []).map((p: any) => p.url).join(",")}`;

// 1. answer stands -> no extra research round
{
  let researchCalls = 0;
  const r = await runSearchHops("q", {
    maxHops: 2,
    research: async () => { researchCalls++; return { pages: [page("a.com")] }; },
    render,
    distill: async () => ({ text: "The answer is 42." }),
  });
  t("no followup => exactly 1 research call", researchCalls === 1, `got ${researchCalls}`);
  t("no followup => answer passthrough", r.answer === "The answer is 42.");
  t("no followup => hops 0", r.hops === 0);
}

// 2. model declares insufficiency -> one extra hop, FOLLOWUP stripped from answer
{
  const calls: string[] = [];
  let n = 0;
  const r = await runSearchHops("original", {
    maxHops: 2,
    research: async (q) => { calls.push(q); return { pages: [page(q === "original" ? "a.com" : "b.com")] }; },
    render,
    distill: async (bundle) => {
      n++;
      return n === 1
        ? { text: "Partial answer.\nFOLLOWUP: deeper query" }
        : { text: "Full answer now." };
    },
  });
  t("followup triggers 2nd research with new query", calls.length === 2 && calls[1] === "deeper query", JSON.stringify(calls));
  t("later hop's answer wins", r.answer === "Full answer now.", JSON.stringify(r.answer));
  t("FOLLOWUP never leaks into answer", !r.answer.includes("FOLLOWUP"), JSON.stringify(r.answer));
  t("intermediate FOLLOWUP answer not leaked raw", !r.answer.includes("Partial answer."), JSON.stringify(r.answer));
  t("hops counted", r.hops === 1);
}

// 3. followup yields no NEW urls -> stop, don't burn a round
{
  let researchCalls = 0;
  const r = await runSearchHops("q", {
    maxHops: 3,
    research: async () => { researchCalls++; return { pages: [page("same.com")] }; },
    render,
    distill: async () => ({ text: "x\nFOLLOWUP: another" }),
  });
  t("no fresh pages => stops after 2 research calls", researchCalls === 2, `got ${researchCalls}`);
  t("no fresh pages => hops capped at 1", r.hops === 1, `got ${r.hops}`);
}

// 4. maxHops enforced
{
  let researchCalls = 0;
  const r = await runSearchHops("q", {
    maxHops: 2,
    research: async (q) => { researchCalls++; return { pages: [page(`u${researchCalls}.com`)] }; },
    render,
    distill: async () => ({ text: `ans${researchCalls}\nFOLLOWUP: q${researchCalls}` }),
  });
  t("maxHops=2 => exactly 3 research calls", researchCalls === 3, `got ${researchCalls}`);
  t("maxHops=2 => hops 2", r.hops === 2, `got ${r.hops}`);
}

// 5. maxHops=0 disables hopping entirely
{
  let researchCalls = 0;
  const r = await runSearchHops("q", {
    maxHops: 0,
    research: async () => { researchCalls++; return { pages: [page("a.com")] }; },
    render,
    distill: async () => ({ text: "x\nFOLLOWUP: never" }),
  });
  t("maxHops=0 => 1 call only", researchCalls === 1 && r.hops === 0);
  t("maxHops=0 => FOLLOWUP stripped anyway", r.answer === "x", JSON.stringify(r.answer));
}

// 6. repeated identical followup is rejected (loop guard)
{
  let researchCalls = 0;
  const r = await runSearchHops("q", {
    maxHops: 3,
    research: async () => { researchCalls++; return { pages: [page(`u${researchCalls}.com`)] }; },
    render,
    distill: async () => ({ text: "x\nFOLLOWUP: q" }),  // same as original query
  });
  t("followup equal to original is rejected", researchCalls === 1 && r.hops === 0, `got ${researchCalls}`);
}

// 7. total research failure surfaces as error, no distill call
{
  let distilled = 0;
  const r = await runSearchHops("q", {
    maxHops: 2,
    research: async () => ({ error: "all engines rate limited", pages: [] }),
    render,
    distill: async () => { distilled++; return { text: "x" }; },
  });
  t("hard failure => error returned", r.error === "all engines rate limited");
  t("hard failure => no distill call (no tokens burned)", distilled === 0);
}

// 8. usage accumulates across hops
{
  let n = 0;
  const r = await runSearchHops("q", {
    maxHops: 1,
    research: async (q) => ({ pages: [page(q === "q" ? "a.com" : "b.com")] }),
    render,
    distill: async () => {
      n++;
      return { text: n === 1 ? "x\nFOLLOWUP: more" : "y", usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.01 } } };
    },
  });
  t("usage summed across 2 distills", r.usage?.input === 200 && r.usage?.totalTokens === 220 && Math.abs(r.usage?.cost?.total - 0.02) < 1e-9, JSON.stringify(r.usage));
}

// 9. parser edge cases
{
  t("parse: no followup", parseFollowup("just an answer").followup === null);
  t("parse: indented + quoted", parseFollowup("a\n  FOLLOWUP: \"quoted q\"\n").followup === "quoted q");
  t("parse: empty followup rejected", parseFollowup("a\nFOLLOWUP:\n").followup === null);
  t("parse: mid-text FOLLOWUP not matched in prose", parseFollowup("I will not FOLLOWUP: x here").followup === null);
  t("missing: none", parseMissing("plain answer").length === 0);
  t("missing: extracts items", JSON.stringify(parseMissing("a\nMISSING: exact version\nb\nMISSING: fixed-in commit")) === JSON.stringify(["exact version", "fixed-in commit"]));
  t("missing: empty item rejected", parseMissing("a\nMISSING:\nb").length === 0);
}

// 10. distilled findings from earlier rounds are passed as preamble (no amnesia)
{
  const preambles: (string | undefined)[] = [];
  let n = 0;
  await runSearchHops("original", {
    maxHops: 2,
    research: async (q) => ({ pages: [page(q === "original" ? "a.com" : "b.com")] }),
    render,
    distill: async (_bundle, _allow, preamble) => {
      n++;
      preambles.push(preamble);
      return n === 1
        ? { text: "Round-1 found 80% of the architecture.\nFOLLOWUP: check version flag" }
        : { text: "Round-2 answer merged." };
    },
  });
  t("first round has no preamble", preambles[0] === undefined, JSON.stringify(preambles[0]));
  t("second round preamble carries round-1 findings", !!preambles[1] && preambles[1]!.includes("80% of the architecture"), JSON.stringify(preambles[1]));
  t("preamble labelled with round number", !!preambles[1] && preambles[1]!.includes("Round 0"));
}

// 11. MISSING gaps drive the next hop when no FOLLOWUP is given
{
  const calls: string[] = [];
  let n = 0;
  const r = await runSearchHops("original", {
    maxHops: 2,
    research: async (q) => { calls.push(q); return { pages: [page(`u${calls.length}.com`)] }; },
    render,
    distill: async () => {
      n++;
      return n === 1
        ? { text: "Partial answer.\nMISSING: parameter 21 count\nMISSING: Channel 291 build" }
        : { text: "Gaps filled." };
    },
  });
  t("gap-only round triggers followup from MISSING items", calls.length === 2 && calls[1] === "parameter 21 count Channel 291 build", JSON.stringify(calls));
  t("MISSING lines stripped from final answer", r.answer === "Gaps filled.", JSON.stringify(r.answer));
  t("hops counted for gap-driven round", r.hops === 1);
}

// 12. unresolved gaps are surfaced on the final result
{
  const r = await runSearchHops("q", {
    maxHops: 1,
    research: async (q) => ({ pages: [page(q === "q" ? "a.com" : "b.com")] }),
    render,
    distill: async () => ({ text: "Answer.\nMISSING: still unknown" }),
  });
  t("missing items reported", JSON.stringify(r.missing) === JSON.stringify(["still unknown"]), JSON.stringify(r.missing));
  t("missing appended to answer", r.answer.includes("Missing information") && r.answer.includes("still unknown"), JSON.stringify(r.answer));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
