# Adversarial verification — for big or risky changes, not for one-line fixes

Use when the user says verify / check / "did it really work", before declaring a
feature done, or after a change that touches state, files, network or a UI.
Author is never the judge of their own work — same model, same blind spots.
A typo fix does not need this skill; if you are unsure, run the one line below.

## Size the pass first

Match the pass to the change, or verification becomes the work:

- **1 claim, one file, no state** — one command that would fail if the claim
  were false. That is the whole pass.
- **2-3 claims, or anything stateful** (saves, files, network, processes) — one
  command per claim, plus the probes that map to the risk.
- **New feature / user-facing UI / destructive work** — the full protocol.

Skipping a probe because the change is trivial is honest. Marking PASS without
running the command never is.

## Protocol

1. **Collect claims.** List every "done" sentence you made: works, saves, loads, handles X, no crash, persists. Each one is a test target. No claims, no verification.
2. **One command per claim.** For each claim: the exact command that would fail if the claim were false, then run it. Paste the output line that decides it. Reading the code again is NOT evidence.
3. **Probes — sized, not sprayed.** Name the ways this could realistically break, then actually try the ones that fit the change (one is enough for a small fix; three for stateful / user-facing work):
   - **boundary** — empty input, huge input, unicode, zero, negative, missing file, wrong type
   - **state** — run twice, kill mid-way, restart, stale file, read-only dir, concurrent second instance
   - **honesty** — does the happy path work when the user does the obvious wrong thing first?
4. **Verdict per claim** — exactly one of PASS / PARTIAL / FAIL / UNVERIFIED, one line each — and only for claims you actually ran:
   - `PASS` — the command ran and its output proves the claim
   - `FAIL` — command + actual output + what it should have been
   - `PARTIAL` — passes the happy path, this probe fails
   - `UNVERIFIED` — cannot run it (no network, no display, missing dep). Never round UNVERIFIED up to PASS.
5. **Fix loop.** Fix real failures, re-run only the claims affected, update the verdicts. Do not re-verify what you did not touch.
6. **Close with the gap list**: what still has no test, what you assume, what the user should click/play to confirm feel rather than correctness.

## Anti-patterns (auto-FAIL)

- "Should work now", "this should be fine", "I believe it works" — belief is not evidence.
- Re-reading your own diff and calling it verification.
- Testing the function you just wrote with input you know passes.
- Marking PASS because the command exited 0 but printed a warning or an empty result.
- Claiming a UI/game feature works without starting it once.

## Output shape

```
Claims: N
1. <claim> — PASS  `<cmd>` → <deciding line>
2. <claim> — FAIL  `<cmd>` → <actual>  (expected <x>)
3. <claim> — UNVERIFIED  (no <dep>)
Probes: boundary <result>, state <result>, honesty <result>
Gaps: <what still needs a human>
```
