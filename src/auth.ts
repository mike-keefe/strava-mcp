function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

export function isStaticTokenValid(token: string, expectedToken: string): boolean {
  if (token.length !== expectedToken.length) return false;
  return timingSafeEqual(token, expectedToken);
}

// Kept for existing tests — composes the two functions above
export function validateBearerToken(
  request: Request,
  expectedToken: string
): boolean {
  const token = extractBearerToken(request);
  if (!token) return false;
  return isStaticTokenValid(token, expectedToken);
}

export function unauthorizedResponse(origin?: string): Response {
  const wwwAuth = origin
    ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    : "Bearer";
  return new Response(
    JSON.stringify({
      error: { code: "UNAUTHORIZED", message: "Invalid or missing bearer token" },
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuth,
      },
    }
  );
}
