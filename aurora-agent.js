#!/usr/bin/env node
// aurora-agent.js
// Standalone OpenRouter sub-agent with full tool-use loop.
// Called by the /aurora Claude Code skill.
//
// Usage: node aurora-agent.js "<prompt>"
//
// Supports these tools (mirrors what Claude Code itself uses):
//   Bash   - execute shell commands
//   Read   - read file contents
//   Write  - write file contents
//   Glob   - list files by pattern
//   Grep   - search file contents

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const MODEL = process.env.AURORA_MODEL || "openrouter/aurora-alpha";
const API_KEY = process.env.OPENROUTER_API_KEY;
const MAX_TURNS = 10;

if (!API_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY is not set.");
  process.exit(1);
}

const PROMPT = process.argv.slice(2).join(" ");
if (!PROMPT) {
  console.error("Usage: node aurora-agent.js \"<your task>\"");
  process.exit(1);
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "Bash",
    description: "Execute a shell command and return its output.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run." }
      },
      required: ["command"]
    }
  },
  {
    name: "Read",
    description: "Read the contents of a file.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file." }
      },
      required: ["file_path"]
    }
  },
  {
    name: "Write",
    description: "Write content to a file, creating it if needed.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file." },
        content:   { type: "string", description: "Content to write." }
      },
      required: ["file_path", "content"]
    }
  },
  {
    name: "Glob",
    description: "List files matching a glob pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern e.g. **/*.js" },
        path:    { type: "string", description: "Directory to search in (optional)." }
      },
      required: ["pattern"]
    }
  },
  {
    name: "Grep",
    description: "Search file contents with a regex pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex to search for." },
        path:    { type: "string", description: "File or directory to search." },
        glob:    { type: "string", description: "File glob filter e.g. *.js (optional)." }
      },
      required: ["pattern"]
    }
  }
];

// ── Tool executor ───────────────────────────────────────────────────────────

function executeTool(name, input) {
  try {
    switch (name) {
      case "Bash": {
        const out = execSync(input.command, {
          encoding: "utf8",
          timeout: 30000,
          windowsHide: true
        });
        return out || "(no output)";
      }
      case "Read": {
        return fs.readFileSync(input.file_path, "utf8");
      }
      case "Write": {
        fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
        fs.writeFileSync(input.file_path, input.content, "utf8");
        return `Written to ${input.file_path}`;
      }
      case "Glob": {
        const dir = input.path || process.cwd();
        // Use PowerShell Get-ChildItem for reliable glob on Windows
        const pattern = input.pattern.replace(/\*\*/g, "*");
        const out = execSync(
          `powershell -Command "Get-ChildItem -Path '${dir}' -Filter '${pattern}' -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"`,
          { encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        return out || "(no matches)";
      }
      case "Grep": {
        const target = input.path || ".";
        const glob   = input.glob ? `--glob "${input.glob}"` : "";
        const out = execSync(
          `rg --no-heading -n ${glob} "${input.pattern.replace(/"/g, '\\"')}" "${target}" 2>&1 || true`,
          { encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        return out || "(no matches)";
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── OpenRouter API call ─────────────────────────────────────────────────────

function callAPI(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      tools: TOOLS,
      messages
    });

    const req = https.request({
      hostname: "openrouter.ai",
      port: 443,
      path: "/api/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${API_KEY}`,
        "anthropic-version": "2023-06-01",
        "HTTP-Referer": "https://github.com/aleezanooor/claude-openrouter",
        "X-Title": "Aurora Agent"
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Agent loop ──────────────────────────────────────────────────────────────

async function run() {
  const messages = [{ role: "user", content: PROMPT }];

  console.log(`\n[aurora-agent] Model: ${MODEL}`);
  console.log(`[aurora-agent] Task: ${PROMPT}\n`);
  console.log("─".repeat(60));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await callAPI(messages);
    } catch (err) {
      console.error(`[aurora-agent] API error: ${err.message}`);
      process.exit(1);
    }

    const { content, stop_reason } = response;

    // Collect text and tool calls from this response
    const toolCalls = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        process.stdout.write(block.text);
      }
      if (block.type === "tool_use") {
        toolCalls.push(block);
      }
    }

    // If no tool calls, we're done
    if (stop_reason === "end_turn" || toolCalls.length === 0) {
      console.log("\n" + "─".repeat(60));
      console.log("[aurora-agent] Done.");
      break;
    }

    // Execute tools and build tool_result blocks
    console.log();
    messages.push({ role: "assistant", content });

    const toolResults = [];
    for (const tc of toolCalls) {
      console.log(`[aurora-agent] → ${tc.name}(${JSON.stringify(tc.input)})`);
      const result = executeTool(tc.name, tc.input);
      const preview = result.slice(0, 200) + (result.length > 200 ? "…" : "");
      console.log(`[aurora-agent] ← ${preview}\n`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tc.id,
        content: result
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

run().catch(err => {
  console.error("[aurora-agent] Fatal:", err.message);
  process.exit(1);
});
