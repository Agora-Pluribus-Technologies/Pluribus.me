import { parseSessionCookie, getSession, refreshSession } from "./auth/_session.js";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function validateTurnstileToken(token, secretKey, ip) {
  const formData = new FormData();
  formData.append("secret", secretKey);
  formData.append("response", token);
  if (ip) {
    formData.append("remoteip", ip);
  }

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body: formData,
  });

  return response.json();
}

export async function onRequest(context) {
  const { request, env, next } = context;

  const method = request.method.toUpperCase();
  const url = new URL(request.url);

  // CORS preflight
  if (method === "OPTIONS") {
    return next();
  }

  // Auth endpoints handle their own authentication
  if (url.pathname.startsWith("/api/auth/")) {
    return next();
  }

  // Public subscriber endpoints (no session required)
  if (url.pathname === "/api/subscribers") {
    // Email confirmation link
    if (method === "GET" && url.searchParams.get("confirm")) {
      return next();
    }
    // Unsubscribe link
    if (method === "DELETE" && url.searchParams.get("token")) {
      return next();
    }
    // Public subscribe form (protected by Turnstile, not session)
    if (method === "POST" && request.headers.get("X-Turnstile-Token")) {
      const secretKey = env.TURNSTILE_SECRET_KEY;
      if (secretKey) {
        const turnstileToken = request.headers.get("X-Turnstile-Token");
        const clientIP = request.headers.get("CF-Connecting-IP");
        const result = await validateTurnstileToken(turnstileToken, secretKey, clientIP);
        if (!result.success) {
          return new Response(JSON.stringify({ error: "Turnstile validation failed" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return next();
    }
  }

  // All other endpoints require a valid session
  const token = parseSessionCookie(request);
  if (!token) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const session = await getSession(env, token);
  if (!session) {
    return new Response(JSON.stringify({ error: "Session expired or invalid" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pending-username sessions can only access user registration
  if (session.status === "pending_username") {
    if (url.pathname !== "/api/users" || (method !== "GET" && method !== "POST")) {
      return new Response(JSON.stringify({ error: "Complete registration first" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Attach session to context for downstream handlers
  context.data = context.data || {};
  context.data.session = session;
  context.data.sessionToken = token;
  context.data.username = session.username;
  context.data.userId = session.userId;

  // Refresh session TTL in the background
  context.waitUntil(refreshSession(env, token, session));

  return next();
}
