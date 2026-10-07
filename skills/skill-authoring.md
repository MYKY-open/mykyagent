# skill-authoring

How to write a skill pack for MykyAgent (skills-lite).

A skill is one markdown file: `skills/<name>.md`, or `skills/<name>/SKILL.md`
when it needs sidecar references. The skill index shows only the first
heading or first non-empty line, so put the one-line summary first.

Rules:
- One job per skill (commit flow, release checklist, repo-specific ritual).
- Commands first, prose last. The reader is a small local model.
- Keep it under ~200 lines. The full text loads only via skill_read.
- Never include secrets. Skills are plain files in the repo.
