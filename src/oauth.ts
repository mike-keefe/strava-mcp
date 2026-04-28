import type { Env } from "./types.js";

// ---------------------------------------------------------------------------
// KV key namespacing
// ---------------------------------------------------------------------------
const KV = {
  code: (c: string) => `oauth:code:${c}`,
  token: (t: string) => `oauth:token:${t}`,
  client: (id: string) => `oauth:client:${id}`,
};

const CODE_TTL_SECONDS = 600; // 10 minutes
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

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
  if (pathname === "/oauth/authorize") {
    if (request.method === "GET") return authorizeGet(request, env, origin);
    if (request.method === "POST") return authorizePost(request, env, origin);
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
    grant_types_supported: ["authorization_code", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
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
  // Public clients (PKCE) don't need a client_secret
  const isPublic = body["token_endpoint_auth_method"] === "none";
  const clientSecret = isPublic ? null : generateToken();

  const record: ClientRecord = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris as string[],
    client_name: typeof body["client_name"] === "string" ? body["client_name"] : undefined,
  };

  await env.TOKEN_CACHE.put(KV.client(clientId), JSON.stringify(record));

  return json(
    {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: isPublic ? "none" : "client_secret_post",
    },
    201
  );
}

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

interface AuthParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
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

  // Validate registered client
  const clientRaw = await env.TOKEN_CACHE.get(KV.client(clientId));
  if (!clientRaw) {
    return oauthError("invalid_client", "Unknown client_id");
  }
  const client = JSON.parse(clientRaw) as ClientRecord;
  if (!client.redirect_uris.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client");
  }

  const clientName = client.client_name ?? clientId;

  return new Response(authorizePage({ clientName, clientId, redirectUri, state, codeChallenge, codeChallengeMethod, origin }), {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

async function authorizePost(
  request: Request,
  env: Env,
  origin: string
): Promise<Response> {
  let body: URLSearchParams;
  try {
    body = new URLSearchParams(await request.text());
  } catch {
    return oauthError("invalid_request", "Invalid form body");
  }

  const approved = body.get("approved") === "true";
  const clientId = body.get("client_id") ?? "";
  const redirectUri = body.get("redirect_uri") ?? "";
  const state = body.get("state") ?? "";
  const codeChallenge = body.get("code_challenge") ?? "";
  const codeChallengeMethod = body.get("code_challenge_method") ?? "S256";

  if (!approved) {
    const denied = new URL(redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (state) denied.searchParams.set("state", state);
    return Response.redirect(denied.toString(), 302);
  }

  // Validate registered client again
  const clientRaw = await env.TOKEN_CACHE.get(KV.client(clientId));
  if (!clientRaw) {
    return oauthError("invalid_client", "Unknown client_id");
  }
  const client = JSON.parse(clientRaw) as ClientRecord;
  if (!client.redirect_uris.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri mismatch");
  }

  const code = generateToken();
  const codeRecord: AuthParams & { used: boolean } = {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    used: false,
  };
  await env.TOKEN_CACHE.put(KV.code(code), JSON.stringify(codeRecord), {
    expirationTtl: CODE_TTL_SECONDS,
  });

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  void origin;
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
    const text = await request.text();
    body = new URLSearchParams(text);
  } catch {
    return oauthError("invalid_request", "Invalid request body");
  }

  const grantType = body.get("grant_type");

  if (grantType === "authorization_code") {
    return handleAuthCodeGrant(body, env, origin);
  }
  if (grantType === "client_credentials") {
    return handleClientCredentialsGrant(body, env, origin);
  }
  return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
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

  const codeRecord = JSON.parse(codeRaw) as AuthParams & { used: boolean };

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

  // Mark code as used and delete it
  await env.TOKEN_CACHE.delete(KV.code(code));

  const accessToken = generateToken();
  await env.TOKEN_CACHE.put(
    KV.token(accessToken),
    JSON.stringify({ clientId, issuedAt: Date.now() }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    scope: "mcp",
  });
}

async function handleClientCredentialsGrant(
  body: URLSearchParams,
  env: Env,
  _origin: string
): Promise<Response> {
  const clientId = body.get("client_id") ?? "";
  const clientSecret = body.get("client_secret") ?? "";

  if (!clientId || !clientSecret) {
    return oauthError("invalid_client", "client_id and client_secret required");
  }

  // Look up the registered client
  const clientRaw = await env.TOKEN_CACHE.get(KV.client(clientId));
  if (!clientRaw) {
    return oauthError("invalid_client", "Unknown client");
  }
  const client = JSON.parse(clientRaw) as ClientRecord;

  if (!client.client_secret || client.client_secret !== clientSecret) {
    return oauthError("invalid_client", "Invalid client credentials");
  }

  const accessToken = generateToken();
  await env.TOKEN_CACHE.put(
    KV.token(accessToken),
    JSON.stringify({ clientId, issuedAt: Date.now() }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );

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

// ---------------------------------------------------------------------------
// Authorization HTML page
// ---------------------------------------------------------------------------

interface AuthPageParams {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  origin: string;
}

function authorizePage(p: AuthPageParams): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c)
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorise Strava MCP</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .card{background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.12);padding:2rem;max-width:420px;width:100%}
    .logo{font-size:2rem;text-align:center;margin-bottom:1rem}
    h1{font-size:1.25rem;font-weight:600;text-align:center;color:#111;margin-bottom:.5rem}
    .sub{font-size:.9rem;color:#555;text-align:center;margin-bottom:1.5rem;line-height:1.5}
    .client{background:#f8f8f8;border:1px solid #e0e0e0;border-radius:8px;padding:.75rem 1rem;font-size:.85rem;color:#333;margin-bottom:1.5rem;word-break:break-all}
    .scopes{font-size:.85rem;color:#444;margin-bottom:1.5rem}
    .scopes li{list-style:none;padding:.3rem 0;display:flex;align-items:center;gap:.5rem}
    .scopes li::before{content:"✓";color:#22c55e;font-weight:700}
    .btn-row{display:flex;gap:.75rem}
    .btn{flex:1;padding:.7rem 1rem;border:none;border-radius:8px;font-size:.95rem;font-weight:500;cursor:pointer;transition:opacity .15s}
    .btn-allow{background:#f97316;color:#fff}
    .btn-deny{background:#f3f4f6;color:#374151}
    .btn:hover{opacity:.9}
    .warning{font-size:.8rem;color:#888;text-align:center;margin-top:1rem}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🏃</div>
    <h1>Authorise Strava MCP</h1>
    <p class="sub"><strong>${esc(p.clientName)}</strong> is requesting access to your Strava running data.</p>
    <div class="client">${esc(p.redirectUri.split("?")[0])}</div>
    <ul class="scopes">
      <li>Read your activities and stream data</li>
      <li>Read your profile and zones</li>
      <li>Read your segments and routes</li>
    </ul>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="approved" value="true">
      <input type="hidden" name="client_id" value="${esc(p.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}">
      <input type="hidden" name="state" value="${esc(p.state)}">
      <input type="hidden" name="code_challenge" value="${esc(p.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${esc(p.codeChallengeMethod)}">
      <div class="btn-row">
        <button type="submit" class="btn btn-allow">Authorise</button>
        <button type="submit" class="btn btn-deny" formaction="/oauth/authorize"
          onclick="this.form.querySelector('[name=approved]').value='false'">Deny</button>
      </div>
    </form>
    <p class="warning">Only approve if you initiated this request.</p>
  </div>
</body>
</html>`;
}
