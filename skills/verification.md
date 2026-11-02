# Adversarial verification: prove it works, or name exactly what fails

Use when the user says verify / check / "did it really work", after any big implementation, or before declaring a feature done. Author is never the judge of their own work — same model, same blind spots.

## Protocol

1. **Collect claims.** List every "done" sentence you made: works, saves, loads, handles X, no crash, persists. Each one is a test target. No claims, no verification.
2. **One command per claim.** For each claim: the exact command that would fail if the claim were false, then run it. Paste the output line that decides it. Reading the code again is NOT evidence.
3. **Three probes.** Name the three most likely ways this breaks, then actually try each:
   - **boundary** — empty input, huge input, unicode, zero, negative, missing file, wrong type
   - **state** — run twice, kill mid-way, restart, stale file, read-only dir, concurrent second instance
   - **honesty** — does the happy path work when the user does the obvious wrong thing first?
4. **Verdict per claim** — exactly one of PASS / PARTIAL / FAIL / UNVERIFIED, one line each:
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
