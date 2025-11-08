function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function getApiToken(): string | undefined {
  return Deno.env.get('EDGE_API_TOKEN') ?? Deno.env.get('SUPABASE_API_TOKEN') ?? undefined;
}

export function validateApiToken(req: Request): boolean {
  const apiToken = getApiToken();
  if (!apiToken) {
    // When the token is not configured we allow all requests (local dev convenience)
    return true;
  }

  const provided = req.headers.get('x-api-token') ?? req.headers.get('X-API-Token');
  return provided === apiToken;
}

export function unauthorizedResponse(): Response {
  return jsonResponse({ success: false, error: 'unauthorized' }, 401);
}

export function successResponse<T>(data: T, status = 200): Response {
  return jsonResponse({ success: true, ...((data as Record<string, unknown>) ?? {}) }, status);
}

export function errorResponse(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return jsonResponse({ success: false, error: message, ...(extra ?? {}) }, status);
}
