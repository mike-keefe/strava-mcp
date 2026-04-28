function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export function validateBearerToken(
  request: Request,
  expectedToken: string
): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7);
  if (token.length !== expectedToken.length) {
    return false;
  }
  return timingSafeEqual(token, expectedToken);
}

export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "UNAUTHORIZED", message: "Invalid or missing bearer token" },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}
