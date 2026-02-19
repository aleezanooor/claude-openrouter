@echo off
REM Claude Code powered by OpenRouter aurora-alpha (free, stealth-reasoning model)
REM Usage: claude-aurora [other claude args]
REM Example: claude-aurora -p "write a hello world" --print
REM Example: claude-aurora   (interactive session)

set OR_MODEL=openrouter/aurora-alpha
set CLAUDE_MODEL=claude-sonnet-4-6
set PROXY_PORT=13337

echo Using model: %OR_MODEL%
echo Starting proxy on port %PROXY_PORT%...

REM Start proxy in background
start /B node "%USERPROFILE%\openrouter-proxy.js" %OR_MODEL% %PROXY_PORT%
timeout /t 1 /nobreak >nul

REM Allow nested sessions, force API key mode, point at proxy
set CLAUDECODE=
set ANTHROPIC_API_KEY=proxy-key
set ANTHROPIC_BASE_URL=http://localhost:%PROXY_PORT%

REM Use clean config dir (no Pro credentials = no prompts, no Pro mode)
set CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-openrouter

echo Connecting to OpenRouter...
claude --model %CLAUDE_MODEL% %*

REM Kill proxy after Claude exits
for /f "tokens=5" %%a in ('netstat -aon ^| find ":%PROXY_PORT%" ^| find "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
