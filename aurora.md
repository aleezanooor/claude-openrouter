Use the Bash tool to run the aurora sub-agent with the user's task:

```bash
node "%USERPROFILE%\aurora-agent.js" "$TASK"
```

Where `$TASK` is the full task or question the user provided after `/aurora`.

The aurora-agent is a separate AI agent powered by `openrouter/aurora-alpha` (a free stealth-reasoning model). It has access to the following tools and will use them autonomously to complete multi-step tasks:
- **Bash** — run shell commands
- **Read** — read file contents
- **Write** — write files
- **Glob** — find files by pattern
- **Grep** — search file contents

Instructions:
1. Take everything the user wrote after `/aurora` as the task.
2. Run the Bash tool with: `node "%USERPROFILE%\aurora-agent.js" "<task>"`
3. Wait for the output — the agent may take multiple turns using tools before finishing.
4. Present the agent's final output to the user clearly.
5. If the agent wrote or modified any files, summarize what changed.
