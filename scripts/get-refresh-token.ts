#!/usr/bin/env tsx
/**
 * One-shot script to perform the Strava OAuth flow and obtain a long-lived refresh token.
 *
 * Usage:
 *   STRAVA_CLIENT_ID=<id> STRAVA_CLIENT_SECRET=<secret> pnpm tsx scripts/get-refresh-token.ts
 *
 * Or add them to .dev.vars and run:
 *   pnpm tsx scripts/get-refresh-token.ts
 *
 * After running, paste the printed STRAVA_REFRESH_TOKEN into .dev.vars
 * and set it as a Worker secret with: npx wrangler secret put STRAVA_REFRESH_TOKEN
 */

import http from "node:http";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Load env from .dev.vars if the values aren't already in process.env
// ---------------------------------------------------------------------------
function loadDevVars(): void {
  try {
    const devVars = readFileSync(join(process.cwd(), ".dev.vars"), "utf-8");
    for (const line of devVars.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .dev.vars not found — rely on environment variables
  }
}

loadDevVars();

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\nError: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set.\n" +
      "Either add them to .dev.vars or export them in your shell before running this script.\n"
  );
  process.exit(1);
}

const PORT = 3000;
const CALLBACK_URL = `http://localhost:${PORT}/callback`;
const SCOPES = "read,activity:read_all,profile:read_all";

const authUrl =
  `https://www.strava.com/oauth/authorize` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(CALLBACK_URL)}` +
  `&response_type=code` +
  `&approval_prompt=force` +
  `&scope=${SCOPES}`;

// ---------------------------------------------------------------------------
// Start a local HTTP server to receive the OAuth callback
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error) {
    const message = `Strava returned an error: ${error}`;
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Error</h1><p>${message}</p><p>You can close this tab.</p>`);
    console.error(`\n${message}\n`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>Error</h1><p>No authorization code received.</p>");
    server.close();
    process.exit(1);
  }

  // Exchange authorization code for tokens
  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete: { firstname: string; lastname: string; id: number };
  };

  try {
    const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`);
    }

    tokenData = (await tokenResponse.json()) as typeof tokenData;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h1>Error</h1><p>${message}</p>`);
    console.error(`\nToken exchange error: ${message}\n`);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<h1>Success!</h1>` +
      `<p>Authenticated as ${tokenData.athlete.firstname} ${tokenData.athlete.lastname}.</p>` +
      `<p>Your refresh token has been printed to the terminal. You can close this tab.</p>`
  );

  server.close();

  const expiresAt = new Date(tokenData.expires_at * 1000).toISOString();

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SUCCESS — authenticated as ${tokenData.athlete.firstname} ${tokenData.athlete.lastname} (ID: ${tokenData.athlete.id})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  STRAVA_REFRESH_TOKEN=${tokenData.refresh_token}

  (Access token expires at ${expiresAt} — the refresh token does not expire)

Next steps:
  1. Copy STRAVA_REFRESH_TOKEN into your .dev.vars file
  2. Set it as a Worker secret after deploying:
       npx wrangler secret put STRAVA_REFRESH_TOKEN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

server.listen(PORT, () => {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Strava OAuth — get-refresh-token
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Listening on http://localhost:${PORT}/callback
  Scopes: ${SCOPES}

  Opening Strava authorization in your browser...
  If it doesn't open automatically, visit:

  ${authUrl}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  // Open browser
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execSync(`open "${authUrl}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${authUrl}"`);
    } else {
      execSync(`xdg-open "${authUrl}"`);
    }
  } catch {
    // Browser open failed — user can use the URL printed above
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nError: Port ${PORT} is already in use.\n` +
        `Stop whatever is running on that port and try again.\n`
    );
  } else {
    console.error(`\nServer error: ${err.message}\n`);
  }
  process.exit(1);
});
