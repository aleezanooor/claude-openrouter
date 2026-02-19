# Technical Design Document
## Claude Code + OpenRouter Proxy

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [System Architecture](#2-system-architecture)
3. [File Architecture](#3-file-architecture)
4. [Module Descriptions](#4-module-descriptions)
5. [Request Lifecycle](#5-request-lifecycle)
6. [Environment & Configuration](#6-environment--configuration)
7. [Known Constraints & Edge Cases](#7-known-constraints--edge-cases)
8. [Setup Guide (New Users)](#8-setup-guide-new-users)
9. [Extending the System](#9-extending-the-system)
10. [The /aurora Skill — Sub-Agent](#10-the-aurora-skill--sub-agent)

---

## 1. High-Level Overview

Claude Code is Anthropic's official CLI coding assistant. By default it routes all AI inference through Anthropic's own API, requiring either a Claude Pro subscription or paid API credits.

This project inserts a lightweight local HTTP proxy between Claude Code and the internet. The proxy intercepts every API call Claude Code makes, rewrites it to target any model available on OpenRouter (including free models), and forwards it. Claude Code never knows it's not talking to Anthropic.

```
┌─────────────────────────────────────┐
│            User Terminal            │
│                                     │
│   claude-aurora  (bat file)         │
│        │                            │
│        ├── starts proxy in bg       │
│        └── launches Claude Code     │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│     Claude Code (claude.exe)        │
│                                     │
│  Thinks it's talking to Anthropic   │
│  ANTHROPIC_BASE_URL=localhost:13337 │
└────────────────┬────────────────────┘
                 │  HTTP  (Anthropic API format)
                 ▼
┌─────────────────────────────────────┐
│   openrouter-proxy.js  :13337       │
│                                     │
│  1. Swap model name                 │
│  2. Fix API path (/api prefix)      │
│  3. Strip metadata.user_id          │
│  4. Inject OpenRouter API key       │
└────────────────┬────────────────────┘
                 │  HTTPS  (Anthropic API format)
                 ▼
┌─────────────────────────────────────┐
│   openrouter.ai/api/v1/messages     │
│                                     │
│   Routes to: aurora-alpha           │
│   (or any configured model)         │
└─────────────────────────────────────┘
```

---

## 2. System Architecture

### Why a Proxy?

Claude Code has two hard constraints that prevent direct OpenRouter use:

**Constraint 1 — Client-side model validation**
Claude Code validates the `--model` flag against an internal list of known `claude-*` model names before making any API call. Passing `openrouter/aurora-alpha` is rejected immediately with:
> "There's an issue with the selected model. It may not exist or you may not have access to it."

**Constraint 2 — Fixed base URL behavior**
Even with `ANTHROPIC_BASE_URL` pointing to OpenRouter, Claude Code constructs paths as `/v1/messages` while OpenRouter's API lives at `/api/v1/messages`. A direct redirect without path rewriting returns OpenRouter's web UI HTML.

The proxy solves both: Claude Code sends valid Claude model names to `localhost:13337`, the proxy fixes the model name and path, then forwards to OpenRouter.

### Transport Format

Claude Code uses **Anthropic's native messages API format** — not the OpenAI-compatible format. Requests go to `/v1/messages` (not `/v1/chat/completions`) with Anthropic-specific fields (`system` as an array of blocks, `anthropic-version` header, tool `input_schema` format).

OpenRouter supports the Anthropic-native format at `https://openrouter.ai/api/v1/messages`, which is why this approach works without any response format translation.

### Dual Request Pattern

In every conversation turn, Claude Code makes **two parallel requests**:

| Request | Model | Purpose |
|---------|-------|---------|
| `POST /v1/messages` | `claude-haiku-4-5-20251001` | Internal sub-agent tasks (planning, tool routing) |
| `POST /v1/messages` | `claude-sonnet-4-6` | Main response generation (streaming) |

Both are intercepted by the proxy and routed to the same OpenRouter target model. There is also a `POST /v1/messages/count_tokens` call which OpenRouter does not implement — Claude Code handles this 404 gracefully with a fallback.

---

## 3. File Architecture

```
Desktop\claude-aurora\               ← git repo root, added to PATH
│
├── claude-aurora.bat                ← primary launcher (aurora-alpha hardcoded)
├── claude-openrouter.bat            ← flexible launcher (any OR model as first arg)
├── openrouter-proxy.js              ← Node.js proxy server
├── .gitignore                       ← prevents committing secrets
├── README.md                        ← quick-start and troubleshooting summary
└── TECHNICAL_DESIGN.md              ← this document

~\.claude-openrouter\                ← clean Claude Code config dir (no Pro credentials)
│
└── settings.json                    ← copied from ~/.claude/settings.json (theme etc.)

~\                                   ← home directory
├── openrouter-proxy.js              ← copy used by claude-openrouter.bat (bat references this path)
└── claude-openrouter.bat            ← original location (also in repo)

Windows User Environment Variables:
└── OPENROUTER_API_KEY               ← your OpenRouter API key (never stored in files)
```

> **Note:** `openrouter-proxy.js` exists in two locations — the home directory (referenced by `claude-openrouter.bat` via `%USERPROFILE%`) and the repo folder. Keep them in sync when making changes.

---

## 4. Module Descriptions

### `openrouter-proxy.js`

A minimal Node.js HTTP server (~90 lines). No external dependencies — uses only Node's built-in `http` and `https` modules.

**Configuration (read at startup):**

| Variable | Source | Default | Purpose |
|----------|--------|---------|---------|
| `TARGET_MODEL` | `process.argv[2]` | `openrouter/aurora-alpha` | OpenRouter model to route to |
| `PORT` | `process.argv[3]` | `13337` | Port to listen on |
| `OPENROUTER_KEY` | `process.env.OPENROUTER_API_KEY` | — (required, exits if missing) | OpenRouter API key |

**Request pipeline (per incoming request):**

```
1. Collect request body chunks  (req.on "data")
2. On body complete             (req.on "end"):
   a. Parse JSON body
   b. Swap json.model → TARGET_MODEL
   c. Delete json.metadata        (contains user_id >128 chars)
   d. Delete json.user            (same issue)
   e. Re-serialize to outBody
3. Build HTTPS options:
   - hostname: openrouter.ai
   - path: /api + req.url         (fixes the missing /api prefix)
   - method: passthrough
   - headers:
       Authorization: Bearer OPENROUTER_KEY    (replaces Claude Code's dummy key)
       anthropic-version: passthrough or default 2023-06-01
       HTTP-Referer: github.com/anthropics/claude-code
       X-Title: "Claude Code via OpenRouter"
4. Forward request to OpenRouter via HTTPS
5. On response:
   - If 200: pipe response stream directly back to Claude Code
   - If non-200: buffer full body, log error, return to Claude Code
```

**Key design decisions:**
- Streaming is preserved for 200 responses (`proxyRes.pipe(res)`) — this is critical for Claude Code's real-time token streaming display
- Error responses are buffered so the full error message can be logged
- No body parsing for non-JSON requests (pass through unchanged)

---

### `claude-aurora.bat`

Fixed launcher for `openrouter/aurora-alpha`. Hardcodes the model so the user never has to specify it.

**Execution sequence:**

```
1. Set OR_MODEL=openrouter/aurora-alpha
2. Set CLAUDE_MODEL=claude-sonnet-4-6        (model name Claude Code accepts)
3. Set PROXY_PORT=13337
4. start /B node openrouter-proxy.js <model> <port>
                                              (starts proxy as background process)
5. timeout /t 1                               (1 second for proxy to bind port)
6. set CLAUDECODE=                            (clears nested session block)
7. set ANTHROPIC_API_KEY=proxy-key           (forces API key mode)
8. set ANTHROPIC_BASE_URL=http://localhost:13337
9. set CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-openrouter
                                              (clean config, no Pro credentials)
10. claude --model claude-sonnet-4-6 %*      (%* passes all args through)
11. [on Claude exit] taskkill proxy process
```

**Why `ANTHROPIC_API_KEY=proxy-key`?**
This dummy value forces Claude Code into "API key mode" which sends a smaller, simpler system prompt. Without it, Claude Code uses "Pro mode" which sends a very large system prompt containing detailed tool definitions — some models (like aurora-alpha) have string length limits that cause 400 errors on these.

**Why `CLAUDE_CONFIG_DIR`?**
Without this, Claude Code reads `~/.claude/.credentials.json` which contains the user's claude.ai Pro OAuth token. Having both an API key (`ANTHROPIC_API_KEY`) AND a Pro token causes an auth conflict prompt. Pointing to a clean config dir with no credentials file means Claude Code uses only the API key — no prompt, no conflict.

---

### `claude-openrouter.bat`

Flexible launcher that accepts any OpenRouter model as the first argument.

**Model detection logic:**
```batch
if first arg contains "/" or ":"
    → treat as OpenRouter model name, shift remaining args
else
    → use default OR_MODEL, pass all args to Claude
```

This allows both:
```bat
claude-openrouter openai/gpt-4o -p "say hi" --print
claude-openrouter -p "say hi" --print    (uses default aurora-alpha)
```

Uses `%1 %2 ... %9` (explicit args) instead of `%*` — a limitation that means it supports up to 9 additional arguments after a model name.

---

### `~\.claude-openrouter\settings.json`

A copy of `~\.claude\settings.json`. Provides Claude Code with enough config to skip the first-run onboarding wizard (theme selection screen) while having no `.credentials.json` — so the Pro OAuth token is never found and no auth conflict occurs.

---

## 5. Request Lifecycle

### Full trace for `claude-aurora -p "say hi" --print`

```
bat file
  │
  ├─ starts proxy on :13337
  └─ runs: claude --model claude-sonnet-4-6 -p "say hi" --print
               with ANTHROPIC_BASE_URL=http://localhost:13337

Claude Code startup
  │
  ├─ POST http://localhost:13337/v1/messages/count_tokens?beta=true
  │    └─ proxy → GET openrouter.ai/api/v1/messages/count_tokens
  │         └─ OpenRouter: 404 Not Found  (endpoint not supported)
  │    └─ Claude Code handles 404 gracefully, falls back
  │
  ├─ POST http://localhost:13337/v1/messages?beta=true
  │    body: { model: "claude-haiku-4-5-20251001", system: [...], messages: [...] }
  │    └─ proxy transforms:
  │         model → "openrouter/aurora-alpha"
  │         path  → /api/v1/messages?beta=true
  │         auth  → Bearer sk-or-v1-...
  │         strips metadata.user_id
  │    └─ OpenRouter: 200  (haiku sub-agent init call)
  │
  └─ POST http://localhost:13337/v1/messages?beta=true
       body: { model: "claude-sonnet-4-6", system: [...], messages: [{role:"user", content:"say hi"}] }
       └─ proxy transforms:
            model → "openrouter/aurora-alpha"
            path  → /api/v1/messages?beta=true
            auth  → Bearer sk-or-v1-...
       └─ OpenRouter: 200 (streaming SSE response)
            event: message_start
            event: content_block_delta  "Hello!"
            event: message_stop
       └─ proxy pipes stream back to Claude Code
       └─ Claude Code prints: Hello!
```

---

## 6. Environment & Configuration

### Required

| Name | Where set | Description |
|------|-----------|-------------|
| `OPENROUTER_API_KEY` | Windows User env var (`setx`) | Your OpenRouter API key (`sk-or-v1-...`) |
| Node.js | System PATH | Required to run the proxy (`node --version` to check) |

### Set by bat files at runtime (temporary, process-scoped)

| Name | Value | Purpose |
|------|-------|---------|
| `ANTHROPIC_BASE_URL` | `http://localhost:13337` | Redirects Claude Code to proxy |
| `ANTHROPIC_API_KEY` | `proxy-key` (dummy) | Forces API key mode |
| `CLAUDE_CONFIG_DIR` | `%USERPROFILE%\.claude-openrouter` | Clean config, no Pro credentials |
| `CLAUDECODE` | `` (empty) | Clears nested session block |

These are set with `set` (not `setx`) so they only affect the current cmd process and its children — they do not persist to other terminals.

---

## 7. Known Constraints & Edge Cases

### Aurora-alpha string length limit
`openrouter/aurora-alpha` rejects any JSON string field exceeding 128 characters. Claude Code's `metadata.user_id` (a compound session ID ~176 chars) triggers this. Fixed by stripping `metadata` and `user` in the proxy.

### count_tokens always 404
OpenRouter does not implement `/api/v1/messages/count_tokens`. Claude Code handles this gracefully — it falls back to an approximate token count. No action needed.

### Streaming response format
Claude Code expects Anthropic's SSE streaming format (`event: content_block_delta` etc.). OpenRouter forwards this format unchanged from compatible models. If you use a model that only supports non-streaming responses, Claude Code will hang waiting for the stream to begin.

### Model identity in responses
Claude Code injects `"You are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6."` into the system prompt. When you ask the underlying model "what model are you?", it reads this and reports Sonnet 4.6 rather than its true identity. This is expected and harmless.

### Proxy not killed on crash
If Claude Code crashes rather than exits cleanly, the proxy process may remain running on port 13337. Subsequent `claude-aurora` runs will fail to bind the port. Fix:
```bat
for /f "tokens=5" %a in ('netstat -aon ^| find ":13337" ^| find "LISTENING"') do taskkill /F /PID %a
```

### claude-openrouter.bat argument limit
Uses `%1`–`%9` explicit argument passing instead of `%*`. Maximum 9 arguments after the model name. `claude-aurora.bat` uses `%*` and has no limit.

---

## 8. Setup Guide (New Users)

### Prerequisites
- Windows 10/11
- [Node.js](https://nodejs.org) v18 or later
- [Claude Code](https://claude.ai/code) installed and on PATH
- An [OpenRouter](https://openrouter.ai) account

### Step 1 — Get an OpenRouter API key
1. Sign up at https://openrouter.ai
2. Go to **Settings → Keys** and create a new key
3. Copy the key (`sk-or-v1-...`)

### Step 2 — Set the environment variable
Open a terminal and run (replace with your actual key):
```bat
setx OPENROUTER_API_KEY "sk-or-v1-your-key-here"
```
Close and reopen the terminal for the variable to take effect.

### Step 3 — Clone the repo
```bat
git clone https://github.com/aleezanooor/claude-openrouter.git
cd claude-openrouter
```

### Step 4 — Add to PATH
```bat
powershell -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + (Get-Location).Path, 'User')"
```
Close and reopen the terminal.

### Step 5 — Create the clean config directory
```bat
mkdir %USERPROFILE%\.claude-openrouter
copy %USERPROFILE%\.claude\settings.json %USERPROFILE%\.claude-openrouter\settings.json
```
> If you don't have `~\.claude\settings.json` yet, run `claude` once to generate it first.

### Step 6 — Copy proxy to home directory
```bat
copy openrouter-proxy.js %USERPROFILE%\openrouter-proxy.js
```

### Step 7 — Run
Open a new terminal and run:
```bat
claude-aurora
```
Or non-interactively:
```bat
claude-aurora -p "write a hello world in Python" --print
```

---

## 9. Extending the System

### Using a different default model
Edit `claude-aurora.bat` and change:
```bat
set OR_MODEL=openrouter/aurora-alpha
```
to any model ID from https://openrouter.ai/models, e.g.:
```bat
set OR_MODEL=stepfun/step-3.5-flash:free
set OR_MODEL=openai/gpt-4o
set OR_MODEL=google/gemini-flash-1.5
```

### Using it ad-hoc with any model
```bat
claude-openrouter openai/gpt-4o
claude-openrouter anthropic/claude-haiku-4-5
claude-openrouter stepfun/step-3.5-flash:free -p "explain this code" --print
```

### Changing the proxy port
If port 13337 conflicts with another service, edit both files:
```bat
set PROXY_PORT=12345   (in the bat file)
```
The proxy reads the port from `process.argv[3]` so it picks it up automatically.

### Adding request logging (debug mode)
In `openrouter-proxy.js`, add inside the `if (body)` block:
```js
console.log(`[proxy] → ${req.method} ${req.url} body: ${outBody.slice(0, 200)}`);
```

---

## 10. The /aurora Skill — Sub-Agent

### Overview

The `/aurora` skill lets you delegate tasks to the aurora-alpha model as an autonomous sub-agent from inside any Claude Code session — without consuming your Claude Pro quota. It mirrors how GitHub Copilot opens a separate panel to run commands independently.

```
Claude Code session (Sonnet/Opus · Pro)
    │
    │  user types: /aurora get me the system specs
    │
    ▼
aurora.md skill expands → instructs Claude to run Bash:
    node ~/aurora-agent.js "get me the system specs"
    │
    ▼
aurora-agent.js (Node.js, standalone)
    │  calls OpenRouter API directly (no proxy needed)
    │  runs autonomous tool-use loop
    ├── Bash("systeminfo") → parses output
    ├── Bash("wmic cpu get ...") → CPU details
    └── returns formatted table
    │
    ▼
Claude Code presents result to user
```

### Files

| File | Location | Purpose |
|------|----------|---------|
| `aurora-agent.js` | `~\aurora-agent.js` | The agent runtime — calls OpenRouter, executes tools |
| `aurora.md` | `~\.claude\commands\aurora.md` | Skill definition — loaded by Claude Code at startup |

### `aurora-agent.js` — Module Breakdown

**Configuration:**
```
TARGET_MODEL  process.argv[2]           default: openrouter/aurora-alpha
OPENROUTER_KEY process.env.OPENROUTER_API_KEY   required, exits if missing
MAX_TURNS     10                        max autonomous tool-use iterations
```

**Tools available to the agent:**

| Tool | Implementation | Description |
|------|---------------|-------------|
| `Bash` | `child_process.execSync` | Run any shell command, 30s timeout |
| `Read` | `fs.readFileSync` | Read file contents |
| `Write` | `fs.writeFileSync` | Write/create files |
| `Glob` | PowerShell `Get-ChildItem` | Find files by pattern |
| `Grep` | `rg` (ripgrep) via shell | Search file contents by regex |

**Agent loop (up to `MAX_TURNS` iterations):**
```
1. Build messages array: [{ role: "user", content: PROMPT }]
2. POST to openrouter.ai/api/v1/messages with tool definitions
3. Parse response:
   a. Print any text blocks to stdout
   b. Collect tool_use blocks
4. If stop_reason == "end_turn" or no tool calls → done
5. Execute each tool call locally
6. Append { role: "assistant", content } and tool results to messages
7. Go to step 2
```

**Key difference from the proxy approach:** `aurora-agent.js` calls OpenRouter directly — it does NOT go through `openrouter-proxy.js`. It uses the non-streaming Anthropic messages format (no SSE), which simplifies response parsing and avoids the path-prefix and model-name issues that required the proxy.

### `aurora.md` — Skill Definition

Stored at `~/.claude/commands/aurora.md`. Claude Code reads all files in this directory at startup and registers them as `/command-name` skills (filename without `.md`).

When the user types `/aurora <task>`, Claude Code:
1. Reads `aurora.md` as the system instruction for this invocation
2. Extracts `<task>` as the argument
3. Follows the instructions in the file — which tells it to run `aurora-agent.js` via the Bash tool

The skill file instructs Claude to:
- Run `node ~/aurora-agent.js "<task>"` via Bash
- Wait for all output (agent may take multiple turns)
- Present the final result and summarize any file changes

### Path Resolution Note

The skill file uses `%USERPROFILE%\aurora-agent.js` (Windows syntax). When Claude Code runs this via its Bash tool (which uses Git Bash / MinGW), `%USERPROFILE%` is not expanded. Claude Code auto-corrects this on the fly by retrying with `$USERPROFILE/aurora-agent.js` (Unix syntax). This is standard Claude Code behavior — it recovers from command errors autonomously.

### Verified Behavior (Live Test)

```
/aurora get me the system specs
```

Agent execution trace:
```
→ Bash("systeminfo")          → OS, RAM, CPU details
→ Bash("wmic cpu get ...")    → core/thread count, cache
← Formatted markdown table with all specs
```

Result was presented correctly with no files modified. Total: 2 tool calls, 1 agent turn.

### Installing for a New User

1. Copy `aurora-agent.js` to your home directory:
   ```bat
   copy aurora-agent.js %USERPROFILE%\aurora-agent.js
   ```
2. Create the commands directory and install the skill:
   ```bat
   mkdir %USERPROFILE%\.claude\commands
   copy aurora.md %USERPROFILE%\.claude\commands\aurora.md
   ```
3. Start a **new** Claude Code session (skills are loaded at startup).
4. Use from any session:
   ```
   /aurora <your task>
   ```

### Using on macOS/Linux
Replace the `.bat` files with equivalent shell scripts (`.sh`). The proxy (`openrouter-proxy.js`) works unchanged on any platform with Node.js. Key differences in the shell script:
- Use `export` instead of `set`
- Use `$HOME` instead of `%USERPROFILE%`
- Start proxy with `node openrouter-proxy.js & PROXY_PID=$!`
- Kill proxy with `kill $PROXY_PID` after Claude exits
