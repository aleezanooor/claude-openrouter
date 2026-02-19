# Claude Code + OpenRouter

## What We Accomplished

We got **Claude Code** — Anthropic's official AI coding assistant — running on top of **OpenRouter models** (including the free `openrouter/aurora-alpha`) instead of Anthropic's own paid Claude models. Both interactive and non-interactive (`-p`) modes work fully.

---

## Why It Matters

- **Free inference**: `openrouter/aurora-alpha` and other free OpenRouter models have zero cost per token, giving you Claude Code's full interface (file editing, bash execution, multi-step agents, tool use) without burning Anthropic API credits.
- **Any model, same UX**: The same technique works for any OpenRouter model — just swap the model name.
- **Tool use confirmed**: Aurora-alpha supports Anthropic-native tool use format that Claude Code relies on.

---

## How It Works

### The Architecture

```
Claude Code
    │  model: claude-sonnet-4-6  (a name Claude Code accepts)
    │  ANTHROPIC_BASE_URL=http://localhost:13337
    ▼
openrouter-proxy.js  (localhost:13337)
    │  swaps model → openrouter/aurora-alpha
    │  prepends /api to path  (/v1/messages → /api/v1/messages)
    │  strips metadata.user_id (too long for OpenRouter)
    │  injects real OpenRouter API key
    ▼
openrouter.ai/api/v1/messages
    ▼
aurora-alpha responds
```

---

## Problems We Solved (in order)

### 1. Claude Code rejects non-Claude model names
Claude Code validates model names client-side against known `claude-*` patterns. Passing `--model openrouter/aurora-alpha` gets rejected before any API call is made.

**Fix:** The proxy accepts `claude-sonnet-4-6` from Claude Code and swaps it to `openrouter/aurora-alpha` before forwarding.

### 2. Nested session block
Claude Code sets a `CLAUDECODE` env var to prevent nested sessions when launched from within another Claude Code session.

**Fix:** The bat file clears it with `set CLAUDECODE=`.

### 3. Auth conflict (Pro subscription vs API key)
When `ANTHROPIC_API_KEY` is set but the user is also logged in via claude.ai Pro, Claude Code warns about conflicting auth methods and may use Pro mode (which sends a larger system prompt that some models can't handle).

**Fix:** Setting `ANTHROPIC_API_KEY=proxy-key` forces Claude Code into API key mode (smaller, compatible requests). The proxy ignores this dummy key and uses the real OpenRouter key for all requests.

### 4. Wrong API path
Claude Code sends requests to `/v1/messages` but OpenRouter's API lives at `/api/v1/messages`.

**Fix:** The proxy prepends `/api` to every forwarded path.

### 5. `count_tokens` endpoint not found (404)
Claude Code calls `/v1/messages/count_tokens` for token counting. OpenRouter doesn't implement this endpoint.

**Fix:** Not needed — Claude Code handles 404 gracefully and falls back automatically.

### 6. `metadata.user_id` string too long (400 error)
When logged into an Anthropic Console account, Claude Code includes a `metadata.user_id` field in every request like:
```
user_83970b0b...account_5222dcaa...session_91c09dee...
```
This string is ~176 characters. OpenRouter rejects any string field over 128 characters with a `400 Too big` error. This caused ALL interactive mode requests to fail.

**Fix:** The proxy strips `metadata` and `user` from every request before forwarding.

### 7. Model identity confusion
When asked "what model are you?", aurora-alpha reads Claude Code's system prompt (which says `"You are powered by the model named Sonnet 4.6"`) and echoes it back. This is expected — the system prompt is injected by Claude Code and the underlying model reads it.

---

## Files

| File | Location | Purpose |
|------|----------|---------|
| `openrouter-proxy.js` | `~\openrouter-proxy.js` | Node.js proxy server |
| `claude-openrouter.bat` | `~\claude-openrouter.bat` | Full launcher — supports any OpenRouter model as first arg |
| `claude-aurora.bat` | This folder (in PATH) | Shortcut launcher for aurora-alpha |

---

## Usage

```bat
REM Interactive session
claude-aurora

REM Non-interactive
claude-aurora -p "write a fibonacci function in python" --print

REM Switch to a different OpenRouter model
claude-openrouter openai/gpt-4o
claude-openrouter stepfun/step-3.5-flash:free
claude-openrouter anthropic/claude-haiku-4-5
```

---

## Notes

- Aurora-alpha identifies itself as a **"stealth-reasoning large language model, not affiliated with any company"** — its real identity when asked directly (bypassing the Claude Code system prompt).
- The system prompt Claude Code sends is identical across models — only the model name and knowledge cutoff differ between Sonnet and Opus variants.
- The `~\.claude-openrouter\` directory is a clean config dir (no Pro credentials) used to avoid the auth conflict prompt.
