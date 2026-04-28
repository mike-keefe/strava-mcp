import type { Env } from "./types.js";

// ---------------------------------------------------------------------------
// KV key namespacing
// ---------------------------------------------------------------------------
const KV = {
  code: (c: string) => `oauth:code:${c}`,
  token: (t: string) => `oauth:token:${t}`,
  client: (id: string) => `oauth:client:${id}`,
  session: (s: string) => `oauth:session:${s}`,
};

const SESSION_TTL_SECONDS = 600; // 10 min to complete Strava auth
const CODE_TTL_SECONDS = 600; // 10 minutes
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_SCOPES = "read,activity:read_all,profile:read_all";

// Shared with StravaClient — per-user Strava access token cache key
export const stravaTokenCacheKey = (oauthToken: string) =>
  `strava:cached:${oauthToken}`;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function isOAuthPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname.startsWith("/oauth/")
  );
}

export async function handleOAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname, origin } = url;

  if (pathname === "/.well-known/oauth-authorization-server") {
    return authServerMetadata(origin);
  }
  if (pathname === "/.well-known/oauth-protected-resource") {
    return protectedResourceMetadata(origin);
  }
  if (pathname === "/oauth/register" && request.method === "POST") {
    return dynamicRegistration(request, env, origin);
  }
  if (pathname === "/oauth/authorize" && request.method === "GET") {
    return authorizeGet(request, env, origin);
  }
  if (pathname === "/oauth/strava-callback" && request.method === "GET") {
    return stravaCallback(request, env, origin);
  }
  if (pathname === "/oauth/token" && request.method === "POST") {
    return tokenEndpoint(request, env, origin);
  }
  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Validate an OAuth Bearer token (issued by this server)
// ---------------------------------------------------------------------------

export async function isValidOAuthToken(token: string, env: Env): Promise<boolean> {
  const record = await env.TOKEN_CACHE.get(KV.token(token));
  return record !== null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function authServerMetadata(origin: string): Response {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

function protectedResourceMetadata(origin: string): Response {
  return json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

interface ClientRecord {
  client_id: string;
  client_secret: string | null;
  redirect_uris: string[];
  client_name?: string;
}

async function dynamicRegistration(
  request: Request,
  env: Env,
  _origin: string
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_request", "Invalid JSON body");
  }

  const redirectUris = body["redirect_uris"];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError("invalid_request", "redirect_uris is required");
  }

  const clientId = generateToken();
  const record: ClientRecord = {
    client_id: clientId,
    client_secret: null,
    redirect_uris: redirectUris as string[],
    client_name: typeof body["client_name"] === "string" ? body["client_name"] : undefined,
  };

  await env.TOKEN_CACHE.put(KV.client(clientId), JSON.stringify(record));

  return json(
    {
      client_id: clientId,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201
  );
}

// ---------------------------------------------------------------------------
// Authorization endpoint — redirects to Strava
// ---------------------------------------------------------------------------

interface SessionRecord {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

async function authorizeGet(
  request: Request,
  env: Env,
  origin: string
): Promise<Response> {
  const url = new URL(request.url);
  const p = url.searchParams;

  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const state = p.get("state") ?? "";
  const codeChallenge = p.get("code_challenge") ?? "";
  const codeChallengeMethod = p.get("code_challenge_method") ?? "S256";
  const responseType = p.get("response_type");

  if (responseType !== "code") {
    return oauthError("unsupported_response_type", "Only 'code' is supported");
  }
  if (!clientId || !redirectUri || !codeChallenge) {
    return oauthError("invalid_request", "Missing required parameters");
  }

  const clientRaw = await env.TOKEN_CACHE.get(KV.client(clientId));
  if (!clientRaw) {
    return oauthError("invalid_client", "Unknown client_id");
  }
  const client = JSON.parse(clientRaw) as ClientRecord;
  if (!client.redirect_uris.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client");
  }

  // Save OAuth session so the Strava callback can complete the flow
  const sessionId = generateToken();
  const session: SessionRecord = { clientId, redirectUri, state, codeChallenge, codeChallengeMethod };
  await env.TOKEN_CACHE.put(KV.session(sessionId), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // Redirect user to Strava's consent screen
  const stravaUrl = new URL(STRAVA_AUTH_URL);
  stravaUrl.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
  stravaUrl.searchParams.set("redirect_uri", `${origin}/oauth/strava-callback`);
  stravaUrl.searchParams.set("response_type", "code");
  stravaUrl.searchParams.set("approval_prompt", "force");
  stravaUrl.searchParams.set("scope", STRAVA_SCOPES);
  stravaUrl.searchParams.set("state", sessionId);
  return Response.redirect(stravaUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Strava callback — completes the OAuth flow
// ---------------------------------------------------------------------------

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

async function stravaCallback(
  request: Request,
  env: Env,
  _origin: string
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const sessionId = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (!sessionId) {
    return new Response("Missing state parameter", { status: 400 });
  }

  const sessionRaw = await env.TOKEN_CACHE.get(KV.session(sessionId));
  if (!sessionRaw) {
    return new Response("Session expired or invalid. Please start the authorization flow again.", {
      status: 400,
    });
  }
  const session = JSON.parse(sessionRaw) as SessionRecord;
  await env.TOKEN_CACHE.delete(KV.session(sessionId));

  if (error) {
    const denied = new URL(session.redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (session.state) denied.searchParams.set("state", session.state);
    return Response.redirect(denied.toString(), 302);
  }

  if (!code) {
    return new Response("Missing code parameter", { status: 400 });
  }

  // Exchange Strava authorization code for tokens
  const tokenRes = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return new Response(
      `Failed to exchange Strava authorization code (${tokenRes.status})`,
      { status: 502 }
    );
  }

  const stravaTokens = (await tokenRes.json()) as StravaTokenResponse;

  // Issue our own authorization code, embedding the user's Strava refresh token
  const ourCode = generateToken();
  await env.TOKEN_CACHE.put(
    KV.code(ourCode),
    JSON.stringify({
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      state: session.state,
      codeChallenge: session.codeChallenge,
      codeChallengeMethod: session.codeChallengeMethod,
      stravaRefreshToken: stravaTokens.refresh_token,
      stravaAccessToken: stravaTokens.access_token,
      stravaTokenExpiresAt: stravaTokens.expires_at,
      used: false,
    }),
    { expirationTtl: CODE_TTL_SECONDS }
  );

  const redirectUrl = new URL(session.redirectUri);
  redirectUrl.searchParams.set("code", ourCode);
  if (session.state) redirectUrl.searchParams.set("state", session.state);
  return Response.redirect(redirectUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

async function tokenEndpoint(
  request: Request,
  env: Env,
  origin: string
): Promise<Response> {
  let body: URLSearchParams;
  try {
    body = new URLSearchParams(await request.text());
  } catch {
    return oauthError("invalid_request", "Invalid request body");
  }

  const grantType = body.get("grant_type");
  if (grantType === "authorization_code") {
    return handleAuthCodeGrant(body, env, origin);
  }
  return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  stravaRefreshToken: string;
  stravaAccessToken: string;
  stravaTokenExpiresAt: number;
  used: boolean;
}

async function handleAuthCodeGrant(
  body: URLSearchParams,
  env: Env,
  _origin: string
): Promise<Response> {
  const code = body.get("code") ?? "";
  const clientId = body.get("client_id") ?? "";
  const redirectUri = body.get("redirect_uri") ?? "";
  const codeVerifier = body.get("code_verifier") ?? "";

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthError("invalid_request", "Missing required parameters");
  }

  const codeRaw = await env.TOKEN_CACHE.get(KV.code(code));
  if (!codeRaw) {
    return oauthError("invalid_grant", "Authorization code not found or expired");
  }

  const codeRecord = JSON.parse(codeRaw) as CodeRecord;

  if (codeRecord.used) {
    return oauthError("invalid_grant", "Authorization code already used");
  }
  if (codeRecord.clientId !== clientId) {
    return oauthError("invalid_grant", "client_id mismatch");
  }
  if (codeRecord.redirectUri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }
  if (!(await verifyPKCE(codeVerifier, codeRecord.codeChallenge))) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  await env.TOKEN_CACHE.delete(KV.code(code));

  const accessToken = generateToken();

  // Store our token record with the user's Strava refresh token
  await env.TOKEN_CACHE.put(
    KV.token(accessToken),
    JSON.stringify({
      clientId,
      issuedAt: Date.now(),
      stravaRefreshToken: codeRecord.stravaRefreshToken,
    }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );

  // Pre-warm the Strava access token cache so the first MCP call is fast
  const stravaTokenTtl =
    codeRecord.stravaTokenExpiresAt - Math.floor(Date.now() / 1000) - 300;
  if (stravaTokenTtl > 0) {
    await env.TOKEN_CACHE.put(
      stravaTokenCacheKey(accessToken),
      JSON.stringify({
        access_token: codeRecord.stravaAccessToken,
        expires_at: codeRecord.stravaTokenExpiresAt,
      }),
      { expirationTtl: stravaTokenTtl }
    );
  }

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    scope: "mcp",
  });
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

async function verifyPKCE(verifier: string, challenge: string): Promise<boolean> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64url === challenge;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function oauthError(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
