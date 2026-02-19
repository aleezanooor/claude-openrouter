// OpenRouter proxy for Claude Code
// Accepts any model name from Claude Code, routes to the configured OpenRouter model
// Usage: node openrouter-proxy.js [target-model] [port]
//   target-model defaults to openrouter/aurora-alpha
//   port defaults to 13337

const http = require("http");
const https = require("https");

const TARGET_MODEL = process.argv[2] || "openrouter/aurora-alpha";
const PORT = parseInt(process.argv[3] || "13337", 10);
const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ||
  "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";
const OPENROUTER_HOST = "openrouter.ai";
const OPENROUTER_PATH_PREFIX = "/api"; // Claude Code sends /v1/... but OpenRouter needs /api/v1/...

console.log(`[proxy] Listening on http://localhost:${PORT}`);
console.log(`[proxy] Routing all models -> ${TARGET_MODEL}`);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let outBody = body;
    if (body) {
      try {
        const json = JSON.parse(body);

        // Swap model name
        if (json.model) {
          json.model = TARGET_MODEL;
        }

        // Strip metadata/user — OpenRouter rejects user_id strings over 128 chars
        delete json.metadata;
        delete json.user;

        outBody = JSON.stringify(json);
      } catch (_) {
        // not JSON, pass through
      }
    }

    const options = {
      hostname: OPENROUTER_HOST,
      port: 443,
      path: OPENROUTER_PATH_PREFIX + req.url,
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(outBody),
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
        "HTTP-Referer": "https://github.com/anthropics/claude-code",
        "X-Title": "Claude Code via OpenRouter",
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        "Content-Type": proxyRes.headers["content-type"] || "application/json",
        "Access-Control-Allow-Origin": "*",
      });

      // Only log errors
      if (proxyRes.statusCode !== 200) {
        let respBody = "";
        proxyRes.on("data", (chunk) => { respBody += chunk; res.write(chunk); });
        proxyRes.on("end", () => {
          console.error(`[proxy] ERROR ${proxyRes.statusCode} ${req.url} -> ${respBody}`);
          res.end();
        });
      } else {
        proxyRes.pipe(res);
      }
    });

    proxyReq.on("error", (err) => {
      console.error("[proxy] Error:", err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.write(outBody);
    proxyReq.end();
  });
});

server.listen(PORT);
