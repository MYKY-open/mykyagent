# MykyAgent 🦍

A lightweight, crash-proof agent overlay for small local reasoning models (like `ling-3.0-tiny` or `qwen2.5-coder-7b`) running on `llama-server`. Built on top of `@earendil-works/pi-coding-agent`.

## Features
- **Subagent Web Distillation**: Isolated subagent summaries (<80 words) for web search & fetch. Zero raw HTML dumped into context.
- **Link Prioritization**: Automatically extracts direct `.jar`, `.tar.gz`, `.zip`, and binary download links to the top.
- **Internal Planning System**: Built-in `plan` tool with live interactive terminal widget (`📋 2/5`) and step tracking.
- **Persistent Memory**: `memory_save` & `memory_list` tools saved to `~/.config/mykyagent/memory.json`.
- **Ultra Portable**: Entire agent is under 35 KB with no local `node_modules`.

## Installation on Any Computer

### Option A: Using the Installer Script
```bash
git clone https://github.com/MYKY-open/mykyagent.git ~/mykyagent
cd ~/mykyagent
./install.sh
```

### Option B: Quick Manual Setup
1. Install Node.js (v18+) and `pi`:
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
2. Install `uv`:
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
3. Add `llama-local` provider to `~/.pi/agent/models.json`:
   ```json
   {
     "providers": {
       "llama-local": {
         "baseUrl": "http://localhost:8080/v1",
         "api": "openai-completions",
         "apiKey": "cannotguess",
         "models": [
           {
             "id": "ling-3.0-tiny-Q4_K_M",
             "name": "Local: ling-3.0-tiny-Q4_K_M",
             "contextWindow": 131072,
             "maxTokens": 65536
           }
         ]
       }
     }
   }
   ```
4. Symlink launcher:
   ```bash
   ln -s "$(pwd)/bin/mykyagent" ~/.local/bin/mykyagent
   ```

## Usage
- Interactive mode:
  ```bash
  mykyagent
  ```
- Print/headless mode:
  ```bash
  mykyagent -p "find the latest version of minecraft server and download its server.jar into /tmp/mc_test"
  ```
- Connect to remote `llama-server`:
  ```bash
  MYKYAGENT_BASE_URL="http://192.168.1.50:8080/v1" mykyagent
  ```
