import { parseSessionCookie, getSession, refreshSession } from "./auth/_session.js";

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
