const SESSION_TTL = 604800; // 7 days
const SESSION_REFRESH_THRESHOLD = 3600; // 1 hour
const COOKIE_NAME = "__session";

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generateSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64urlEncode(bytes.buffer);
}

export async function hashToken(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hash);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(env, sessionData) {
  const token = await generateSessionToken();
  const hash = await hashToken(token);

  const session = {
    ...sessionData,
    createdAt: new Date().toISOString(),
    lastAccess: new Date().toISOString(),
  };

  await env.SESSIONS.put(`session:${hash}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL,
  });

  return token;
}

export async function getSession(env, token) {
  const hash = await hashToken(token);
  const data = await env.SESSIONS.get(`session:${hash}`);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function updateSession(env, token, updates) {
  const hash = await hashToken(token);
  const data = await env.SESSIONS.get(`session:${hash}`);
  if (!data) return null;

  const session = JSON.parse(data);
  const updated = { ...session, ...updates, lastAccess: new Date().toISOString() };

  await env.SESSIONS.put(`session:${hash}`, JSON.stringify(updated), {
    expirationTtl: SESSION_TTL,
  });

  return updated;
}

export async function deleteSession(env, token) {
  const hash = await hashToken(token);
  await env.SESSIONS.delete(`session:${hash}`);
}

export async function refreshSession(env, token, session) {
  const lastAccess = new Date(session.lastAccess).getTime();
  const now = Date.now();
  if (now - lastAccess > SESSION_REFRESH_THRESHOLD * 1000) {
    await updateSession(env, token, {});
  }
}

export function makeSessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseSessionCookie(request) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === COOKIE_NAME) {
      return rest.join("=");
    }
  }
  return null;
}
