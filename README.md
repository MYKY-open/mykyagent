# MykyAgent 🦍

A lightweight, crash-proof agent overlay for small local reasoning models (like `ling-3.0-tiny` or `qwen2.5-coder-7b`) running on `llama-server`. Built on top of `@earendil-works/pi-coding-agent`.

## Features
- **Seamless `llm` Integration**: Supported natively in the `llm` orchestrator (Mode 12) with automatic context probing and model configuration.
- **Subagent Web Distillation**: Autonomous multi-hop web crawling with clean technical summaries (<80 words) and priority code/link extraction. Zero raw DOM dumped into context (~90% context reduction).
- **Safe Local Code Inspection**: Guardrailed `read` tool enforcing 250-line chunks (max 15KB) to prevent 10,000-line files or logs from flooding local context. Automatic `grep`, `find`, and `ls` activation.
- **Customizable Personas**: In-chat `/persona` slash command with presets (`caveman`, `senior`, `cyberpunk`, `pirate`, `butler`, `academic`, or `custom`) saved to `~/.config/mykyagent/persona.json`.
- **Persistent Memory**: `memory_save` & `memory_list` tools saved to `~/.config/mykyagent/memory.json`.
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
