# MykyAgent 🦍

A lightweight, crash-proof agent overlay for small local reasoning models (like `ling-3.0-tiny` or `qwen2.5-coder-7b`) running on `llama-server`. Built on top of `@earendil-works/pi-coding-agent`.

## Features
- **Seamless `llm` Integration**: Supported natively in the `llm` orchestrator (Mode 12) with automatic context probing and model configuration.
- **Reranked Web Research**: Multi-engine fan-out with reciprocal-rank fusion, authoritative API lookups (GitHub, Modrinth, PyPI, npm, NeoForge Maven), BM25 block extraction, and domain-authority ranking. Engine failover means one throttled search backend cannot kill a query.
- **Token-Disciplined Distillation**: Per-page character budgets, cross-page duplicate-block removal, and hard caps on fallback dumps. A typical search spends ~2k tokens, not ~4k, and bad pages are dropped instead of summarised.
- **Safe Local Code Inspection**: Guardrailed `read` tool enforcing 250-line chunks (max 15KB) to prevent 10,000-line files or logs from flooding local context. Automatic `grep`, `find`, and `ls` activation.
- **Customizable Personas**: In-chat `/persona` slash command with presets (`caveman`, `senior`, `cyberpunk`, `pirate`, `butler`, `academic`, or `custom`) saved to `~/.config/mykyagent/persona.json`.
- **Persistent Memory (index + on-demand)**: Topic files under `~/.config/mykyagent/memory/`. Only a one-line summary per topic is injected into the system prompt; bodies load via `memory_read` when relevant. `memory_write` / `memory_read` / `memory_forget` / `memory_list`.
- **Background Tasks**: Long-running commands (builds, downloads, servers, test suites) launched detached with `task_start`; the agent keeps working and polls `task_status` / bounded `task_output` tails, or kills with `task_stop`. `/tasks` lists them; metadata survives restarts under `~/.config/mykyagent/tasks/`.
- **Ultra Portable**: Clean TypeScript overlay with zero local `node_modules`.

## Quickstart

Clone and run:
```bash
git clone https://github.com/MYKY-open/mykyagent.git ~/mykyagent
cd ~/mykyagent
./install.sh
```

### Launch via `llm` (Recommended)
The `llm` script is the all-in-one orchestrator: it manages models, backends, hardware offload (`-ngl`), starts `llama-server`, dynamically configures `~/.pi/agent/models.json`, and launches the agent:

```bash
# Launch interactive TUI:
llm
# 1. Select your model
# 2. Select mode: 12) MykyAgent
```

Or connect directly to an existing server:
```bash
# Connect to a remote llama-server host
llm -ma 192.168.1.50
```

---

### Direct Agent CLI
If your `llama-server` is already running on `localhost:8080`:
```bash
mykyagent
```

Or connect to a custom endpoint:
```bash
MYKYAGENT_BASE_URL="http://192.168.1.50:8080/v1" mykyagent
```

## In-Chat Personas
Switch the agent's tone and speaking style at any time in chat:
* `/persona` — Open interactive picker
* `/persona pirate` — Switch to pirate mode
* `/persona senior` — Switch to Senior Staff Engineer mode
* `/persona caveman` — Switch back to default caveman mode
* `/persona set <instructions>` — Set a custom persona prompt

## In-Chat Web Model
Route only the `web_search` / `web_fetch` distillation sub-calls to a dedicated
model; the main conversation model (pi's `/model`) is untouched:
* `/model-web` — Open pi's model picker (searchable). First entry "follow main
  model" clears the override; picking any other model saves it permanently.
* `/model-web list` — Show the current override and all available models
* `/model-web set <provider>/<model-id>` — Set directly
* `/model-web clear` — Back to following the main model (default)

Saved to `~/.config/mykyagent/webmodel.json` and persists across sessions.
When no override is set, distillation uses the main model (default state).

## Web Killswitch
* `/web-toggle` — flip web tools on/off
* `/web-toggle off` — remove `web_search` + `web_fetch` from the agent
* `/web-toggle on` — re-enable
* `/web-toggle status` — show current state

Persisted in `~/.config/mykyagent/webkill.json`; survives restarts. When off,
the tools are removed from the active toolset and the system prompt, and the
model is told to answer from memory instead of attempting web lookups.

---

## Web Search Architecture

The `web_search` / `web_fetch` tools drive `search_helper.py`, a PEP 723 script
run through `uv` (same idiom as the rest of the `llm` ecosystem — no shared venv,
no `requirements.txt`).

```
fan-out queries ──► multi-engine SERP ──► RRF fusion ──► domain priors
        │                                                        │
        └──► structured APIs (GitHub/Modrinth/PyPI/npm/Maven/Wikipedia/SO)
                                    │
                          relevance-ranked fetch
                                    │
                 BM25 + section-context extraction (once)
                                    │
              cross-page dedupe ──► bounded bundle ──► summariser
```

**Why it is built this way**

| Problem | Handling |
| --- | --- |
| Search engine throttling | Variants spread one query per engine (DuckDuckGo → Bing → Yahoo → Mojeek → Brave → Google), with failover, a per-run dead-backend cache, and a recovery sweep. |
| Wrong/fake versions & download links | Authoritative APIs are consulted first and rendered in a separate "Authoritative API Data" block the summariser is told to prefer (e.g. NeoForge is read from Maven metadata, not GitHub tags). |
| Low-quality SEO results | Hosting-company and tutorial-farm domains are penalised; official docs, wikis and GitHub are boosted; pages are re-ranked by actual query fit. |
| Token burn | Per-page budget (`MYKYAGENT_PAGE_BUDGET`, default 2200 chars), near-duplicate page collapsing, repeated-block removal across pages, page count capped at 3–4, and fallback dumps capped at 4k chars. |
| Error pages as "content" | Every response is validated for HTTP status and content type (this previously let 504/403 pages through as research). |
| Prompt injection from web text | All fetched text is fenced in `<<<UNTRUSTED_WEB_CONTENT>>>` markers and the summariser is instructed to treat it as data, never instructions. |
| Dead-end queries | If every search engine is unavailable, API providers still return verified results instead of an error. |
| Multi-hop research | The summariser itself declares insufficiency by emitting `FOLLOWUP: <query>`; the agent then runs one more research round seeded with the new query. No extra LLM call is spent detecting gaps, and the loop stops the moment a round yields no new URLs. Capped by `MYKYAGENT_MAX_HOPS` (default 2, max 4). |
| Navigational queries | When the query names its own source ("artificial analysis leaderboard"), the matching host is detected, its landing page is injected as a candidate, and it is boosted at *both* the candidate and page ranking stages. Only multi-word brand matches are trusted, so a generic word cannot hijack the query onto a squatter domain. |
| Recency queries | `new / latest / current / changelog / released` switches the cache to short TTLs (SERP 5 min, pages 15 min) and probes the site's `/changelog`, `/releases`, `/news`, `/updates`, `/blog` paths in parallel. A site's changelog carries the dates its landing page omits. |
| Missing requested field | If the user asked for dates/versions/scores and the fetched pages contain none, one escalation search runs automatically; if the field is still absent a `warnings` entry says so instead of quietly returning an incomplete answer. |
| Sources that disagree | When two URLs report different numbers for the same named entity, a conservative `conflicts` entry names the entity and the values. Requires two distinct values from two distinct sources in the same magnitude band, so it stays quiet on noise. |
| Enumerative queries | `list / top / compare / leaderboard` gives table blocks a separate character allowance, so whole tables survive without paying 3x for every page's prose. |

### `web_fetch`

`web_fetch` fetches one URL and always distils it. Behaviour worth knowing:

- **It reports what it actually gave you.** The tool result is prefixed with a
  metadata block naming the page title, any redirect target, and - critically -
  whether the content came from cache and how old it is. A 24h page cache that
  silently serves yesterday's copy for "check this page" is worse than no cache.
- **`fresh: true` bypasses the cache read** (it still refreshes the entry), so
  the age report is actionable rather than just informative.
- **Long pages need a `query`.** With a query, blocks are BM25-ranked against it
  at `MYKYAGENT_PAGE_BUDGET`. With only a URL there is no relevance signal, so the
  tool keeps whole blocks from the top up to `MYKYAGENT_NO_QUERY_BUDGET`, which is
  larger because the model explicitly asked for that page.
- **Charset handling is explicit.** `requests` reports ISO-8859-1 for `text/html`
  with no charset parameter (the RFC 2616 default), which silently mojibaked every
  page declaring its charset only in `<meta>`. Decoding now consults, in order: BOM,
  HTTP header, `<meta charset>`/`http-equiv`, strict UTF-8, Latin-1.
- PDFs, JSON, and plain text (`text/*`, bare `application/octet-stream` with a
  text-like extension) are handled as first-class content types.

### Query classes

The pipeline deliberately handles four question shapes differently. The first three
were invisible to the original test suite and were added after a real failure:

| Class | Trigger | Behaviour |
| --- | --- | --- |
| Explanatory | default | Normal fan-out, RRF fusion, domain priors. |
| Navigational | query names a site | Resolve to that host, inject and boost it. |
| Recency | `new`, `latest`, `changelog` | Fresh cache TTLs + `/changelog` probing. |
| Enumerative | `list`, `compare`, `leaderboard` | Table blocks get their own budget. |

### Cost

Per-page budget is the main token lever, and the browser pass is skipped when the
plain fetches already contain the fields the user asked for. Measured on a
recency + navigational query, before and after the last round of fixes:

| | tokens | wall time | first source |
| --- | --- | --- | --- |
| before | ~7750 | 66 s | a GitHub mirror |
| after | ~1500 | 8 s | `artificialanalysis.ai/changelog` |

`timings` is returned in every payload, so regressions in where time is spent are
visible instead of guessed at.

### Multi-hop loop

Implemented in `search_hops.ts` (kept free of the pi runtime so it is unit-testable).
The contract:

1. Round 1 researches the query; the summariser may end its answer with `FOLLOWUP: <query>`.
2. If, and only if, that marker is present **and** the hop budget allows, a second research
   round runs on the new query.
3. Only pages with URLs not already seen are passed forward — no paying twice for the same content.
4. The `FOLLOWUP:` line is a control channel and is stripped from the user-visible answer.

It stops on: no marker, budget exhausted, a repeated follow-up query, or a round with zero new URLs.

Run `./run_tests.sh` for the full offline suite: 22 control-flow assertions in
`search_hops.test.ts` plus 26 intent/field/nav/conflict assertions in
`search_helper.py unit`. No network required.

### On cross-encoder rerankers (measured, not adopted)

A `bge-reranker-base` / `ms-marco-MiniLM-L-6-v2` ONNX cross-encoder was benchmarked and is
**not** used. Measured on labelled candidates from real searches:

| method | P@3 (page selection) | nDCG@5 |
| --- | --- | --- |
| BM25 lexical | 0.000 | 0.146 |
| **current: BM25 + domain priors** | **1.000** | **0.869** |
| bge-reranker-base | 0.000 | 0.131 |
| ms-marco-MiniLM-L-6-v2 (quantised) | 0.543 (block level) | block nDCG 0.543 |

Rerankers measure *topical relevance*. SEO spam is topically perfect —
`unanswered.io/guide/how-to-make-minecraft-server-faster` contains the query verbatim — so a
cross-encoder ranks it first. The failure mode here is *authority*, which domain priors handle
and a reranker cannot learn. Cost if ever revisited: `onnxruntime`, `tokenizers`,
`huggingface-hub`, `numpy` plus a 23 MB (fast, 3 ms/pair) or 279 MB (good, 19 ms/pair) model file.

### Modes

```bash
uv run search_helper.py search   "query"            # one SERP, fused + cached
uv run search_helper.py fetch    "URL" [focus]      # one page -> distilled markdown
uv run search_helper.py research "query"            # full pipeline (used by the agent)
uv run search_helper.py unit     x                  # offline heuristic tests (no network)
uv run search_helper.py selftest x                  # live end-to-end harness (network)
```

### Environment knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `MYKYAGENT_SEARCH_DEADLINE` | `75` | Hard internal seconds budget; always emits JSON |
| `MYKYAGENT_MAX_HOPS` | `2` | Extra research rounds (0 disables, max 4) |
| `MYKYAGENT_TABLE_EXTRA` | `2600` | Extra chars allowed for table blocks on enumerative queries |
| `MYKYAGENT_PAGE_BUDGET` | `2200` | Chars of extracted text per page (main token lever) |
| `MYKYAGENT_NO_QUERY_BUDGET` | `4000` | Budget when there is no query to rank blocks against |
| `MYKYAGENT_JSON_BUDGET` | `6000` | Cap on a JSON API response passed through verbatim |
| `MYKYAGENT_NO_BROWSER` | unset | `1` disables Playwright entirely |
| `MYKYAGENT_NO_APIS` | unset | `1` disables structured API providers |
| `MYKYAGENT_CACHE_DIR` | `~/.cache/mykyagent` | SQLite cache location (SERP 1h, pages 24h) |
| `MYKYAGENT_DEBUG` | unset | `1` prints pipeline progress to stderr |

## Persistent Memory

Memory is stored as one markdown file per topic under `~/.config/mykyagent/memory/`:

```markdown
---
summary: search_helper.py architecture - engines, APIs, query classes, knobs
updated: 2026-09-14
---

...the full body, loaded only on demand...
```

**Only the `summary` lines reach the system prompt.** They are injected as a small
index, hard-capped by `MYKYAGENT_MEMORY_INDEX_CHARS`, and the model is told explicitly
that bodies are not loaded:

```
## Persistent Memory (index only - bodies are NOT loaded)
Call `memory_read` with the exact topic name when one becomes relevant.
- minecraft_server_setup: MYKYpack NeoForge 1.21.1 server - paths, JVM flags...
- mykyagent_search: search_helper.py architecture - engines, APIs, knobs...
```

Bodies are fetched with `memory_read` only when a topic becomes relevant. This keeps
the per-turn prompt cost roughly constant as knowledge accumulates (~140 tokens for
three topics holding ~7KB of notes), and keeps model-authored prose out of the
highest-trust region of the context.

| Tool | Purpose |
| --- | --- |
| `memory_read` | load one topic body by name |
| `memory_write` | create/update a topic (`name`, one-line `summary`, `body`) |
| `memory_forget` | delete a topic that is outdated or wrong |
| `memory_list` | all topics with size and last-updated date |

Topic names resolve loosely, so `"Proj Alpha"` finds `proj_alpha`. Summaries are
forced to a single line and a topic name can never escape the memory root.

An older flat `~/.config/mykyagent/memory.json` is imported once on startup and then
renamed to `memory.json.migrated`.

| Variable | Default | Effect |
| --- | --- | --- |
| `MYKYAGENT_MEMORY_DIR` | `~/.config/mykyagent/memory` | Store location |
| `MYKYAGENT_MEMORY_INDEX_CHARS` | `1800` | Cap on the always-injected index |
| `MYKYAGENT_MEMORY_BODY_CHARS` | `12000` | Cap on a single topic body |

### Why not embeddings / RAG for memory

Deliberately rejected. With only one-line summaries to match against, the failure mode
is **scoping**, not similarity ranking - a per-topic index scoped by name solves it
outright. Embeddings would add `onnxruntime` plus a 100-400MB model to replace a
directory listing. Do not re-litigate without new evidence.

## Background Tasks

The plain `bash` tool blocks the agent's whole turn, and a long build/download
would tie it up while progress spam floods the context. Background tasks invert
that: the command runs detached and outlives the tool call, output goes to a
log file, and the agent checks back with bounded reads.

| Tool | Purpose |
| --- | --- |
| `task_start` | spawn a command detached (own process group), return id + log path immediately |
| `task_status` | state of one task or all: `running` / `done` (exit 0) / `stopped` (non-zero) / `dead` |
| `task_output` | tail of the log - last N lines (default 50, max 250), 15KB byte cap, earlier lines summarised away |
| `task_stop` | SIGTERM the whole process group (`force: true` for SIGKILL); writes a recorded exit code so the state resolves |

Design notes:

- **Detached + unref'd**: the task survives the tool call, the turn, and even the
  agent process. `/tasks` lists what is out there after a restart.
- **Exit code via marker file**: the spawned wrapper writes `~/.config/mykyagent/tasks/<id>.exit`
  on normal completion, and `task_stop` writes the code for kills - so `done` vs
  `still running` vs `died hard` stays distinguishable even though nothing keeps
  a node process attached.
- **Zombie trap handled**: detached children are only reaped when the spawning
  agent exits, so `kill(pid, 0)` keeps succeeding on a finished task. `pidAlive`
  treats a `Z` state in `/proc/<pid>/stat` as dead.
- **Bounded output**: nothing from a task log reaches the context until the agent
  asks for a tail, and the tail is capped exactly like the `read` tool.

In-chat: `/tasks` lists all tasks, `/tasks clean` removes finished tasks older
than 24h (metadata + log + marker).

| Variable | Default | Effect |
| --- | --- | --- |
| `MYKYAGENT_TASKS_DIR` | `~/.config/mykyagent/tasks` | Task metadata/log/marker location |

## Tests

### Offline - `./run_tests.sh`

Everything here runs without a network:

| Suite | Assertions | Covers |
| --- | --- | --- |
| `memory.test.ts` | 34 | slug/path safety, caps, index, migration, injection guard |
| `background_tasks.test.ts` | 31 | real-process lifecycle: start returns before completion, exit markers, kill, bounded tails, clean |
| `search_hops.test.ts` | 22 | multi-hop control flow, `FOLLOWUP` parsing |
| `search_helper.py unit` | 51 | charset decoding, title extraction, block truncation, intent, nav, fields, conflicts |

```
ALL SUITES PASSED
```

### End-to-end - `./run_e2e.sh`

Drives the **real registered tools** through the real helper against a real model.
This is the layer unit tests cannot reach: that the handlers are wired correctly,
that the helper is invoked with the right arguments, and that a model can turn the
returned bundle into a usable answer.

```bash
MYKYAGENT_BASE_URL=http://127.0.0.1:8080/v1 MYKYAGENT_API_KEY=<your-key> \
    ./run_e2e.sh
```

The script skips cleanly if the endpoint is unreachable or esbuild is missing. It
starts a local fixture server (a page with a title, non-ASCII text, and no charset
in its HTTP header - the exact case that used to mojibake) and uses a unique URL
per run so the cold-cache assertion is genuinely cold.

It **preflights the credentials** and aborts if the endpoint rejects them. Without
that check the suite passes even when every distillation sub-call is rejected,
because the tools fall back to dumping raw text - so it would be testing the
fallback path while claiming to test the model path.

Assertions target the **tool's own strings** (the metadata lines it generates)
rather than model output, which is paraphrased and non-deterministic.

| Variable | Effect |
| --- | --- |
| `MYKYAGENT_BASE_URL` | OpenAI-compatible endpoint (required, else the suite skips) |
| `MYKYAGENT_API_KEY` | bearer token. Falls back to `API_KEY`, `OPENAI_API_KEY`, then `providers["llama-local"].apiKey` in `~/.pi/agent/models.json`. There is deliberately no hardcoded default: a missing key produces an explicit 401 message naming the ways to set it. |
| `MYKYAGENT_E2E_SEARCH=1` | also run the live `web_search` check (slow, network) |

`typebox_stub.ts` stands in for `@sinclair/typebox` when bundling the extension
standalone: pi resolves the real package through its own loader aliases. Only the
schema helpers are stubbed, so the code paths exercised are the real ones.

```
13 passed, 0 failed
```
