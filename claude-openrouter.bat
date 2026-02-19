@echo off
REM Claude Code with OpenRouter - routes through a local proxy to swap model names
REM Usage: claude-openrouter [openrouter-model] [other claude args]
REM Example: claude-openrouter openrouter/aurora-alpha
REM Example: claude-openrouter openai/gpt-4o

REM Default OpenRouter model
set OR_MODEL=openrouter/aurora-alpha

REM Claude-side model alias (must be a name Claude Code accepts)
set CLAUDE_MODEL=claude-sonnet-4-6

REM Proxy port
set PROXY_PORT=13337

REM Check if first argument looks like an OpenRouter model (contains / or :)
if not "%~1"=="" (
    echo %~1 | findstr /C:":" /C:"/" >nul 2>&1
    if not errorlevel 1 (
        set OR_MODEL=%~1
        shift
    )
)

echo Using OpenRouter model: %OR_MODEL%
echo Starting local proxy on port %PROXY_PORT%...

REM Start proxy in background
start /B node "%USERPROFILE%\openrouter-proxy.js" %OR_MODEL% %PROXY_PORT%

REM Give proxy a moment to start
timeout /t 1 /nobreak >nul

REM Allow running inside a Claude Code session
set CLAUDECODE=

REM Force API key mode (smaller requests that aurora-alpha can handle)
REM Proxy ignores this key and uses the real OpenRouter key itself
set ANTHROPIC_API_KEY=proxy-key

REM Point Claude at local proxy
set ANTHROPIC_BASE_URL=http://localhost:%PROXY_PORT%

echo Connecting via proxy to OpenRouter...
claude --model %CLAUDE_MODEL% %1 %2 %3 %4 %5 %6 %7 %8 %9

REM Kill the proxy after Claude exits
for /f "tokens=5" %%a in ('netstat -aon ^| find ":%PROXY_PORT%" ^| find "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
