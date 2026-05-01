const SESSION_TTL = 604800; // 7 days
const SESSION_REFRESH_THRESHOLD = 518400; // 6 days (refresh in last 24h of 7-day TTL)
const COOKIE_NAME = "__session";
// Cap on concurrent active sessions per user. Each fresh login adds a row;
// when the count exceeds this, the oldest (by lastAccess) sessions are
// evicted so a single user can be signed in on at most this many devices.
const MAX_SESSIONS_PER_USER = 3;

// OAuth `state` defends against login CSRF: an attacker can't trick a
// victim's browser into completing OAuth with the attacker's authorization
// code unless they also know the victim's per-flow state (which lives in
// an HttpOnly cookie scoped to the victim's browser). Per-provider cookie
// names so a stale GitHub state can't be replayed against a Google flow.
const OAUTH_STATE_COOKIE_PREFIX = "__oauth_state_";
const OAUTH_STATE_TTL = 600; // 10 minutes — covers a slow login but expires

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

// Stable identity across pending_username AND active phases, since both
// carry provider + providerId from the OAuth callback unchanged. Used
// as the UNIQUE column so re-issuing for the same user replaces in place.
function userKeyFromSession(sessionData) {
  return `${sessionData.provider}:${sessionData.providerId}`;
}

export async function createSession(env, sessionData) {
  const token = await generateSessionToken();
  const hash = await hashToken(token);
  const userKey = userKeyFromSession(sessionData);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowSec * 1000).toISOString();

  const session = {
    ...sessionData,
    createdAt: nowIso,
    lastAccess: nowIso,
  };

  // Insert the new session, then evict the oldest rows for this userKey
  // beyond the per-user concurrent-session cap. Each row's tokenHash is
  // distinct, so multiple sessions coexist for the same user — up to
  // MAX_SESSIONS_PER_USER. The Sessions.userKey column must NOT carry a
  // UNIQUE constraint for this to work (drop it via a recreate-and-copy
  // migration if it still does — D1/SQLite can't ALTER it in place).
  await env.USERS_DB.prepare(
    "INSERT INTO Sessions (tokenHash, userKey, data, createdAt, lastAccess) VALUES (?, ?, ?, ?, ?)"
  ).bind(hash, userKey, JSON.stringify(session), nowSec, nowSec).run();

  await env.USERS_DB.prepare(
    `DELETE FROM Sessions
     WHERE userKey = ?
       AND tokenHash NOT IN (
         SELECT tokenHash FROM Sessions
         WHERE userKey = ?
         ORDER BY lastAccess DESC, createdAt DESC
         LIMIT ?
       )`
  ).bind(userKey, userKey, MAX_SESSIONS_PER_USER).run();

  return token;
}

export async function getSession(env, token) {
  const hash = await hashToken(token);
  const row = await env.USERS_DB.prepare(
    "SELECT data, lastAccess FROM Sessions WHERE tokenHash = ?"
  ).bind(hash).first();
  if (!row) return null;

  // Lazy expiry: D1 has no TTL, so any read that hits an expired row
  // also evicts it. Combined with the UNIQUE userKey replacing rows on
  // re-login, the table never accumulates dead state.
  const nowSec = Math.floor(Date.now() / 1000);
  if (row.lastAccess + SESSION_TTL < nowSec) {
    try {
      await env.USERS_DB.prepare("DELETE FROM Sessions WHERE tokenHash = ?")
        .bind(hash).run();
    } catch (_) { /* best-effort */ }
    return null;
  }

  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export async function updateSession(env, token, updates) {
  const hash = await hashToken(token);
  const row = await env.USERS_DB.prepare(
    "SELECT data, lastAccess FROM Sessions WHERE tokenHash = ?"
  ).bind(hash).first();
  if (!row) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (row.lastAccess + SESSION_TTL < nowSec) return null;

  let session;
  try { session = JSON.parse(row.data); } catch { return null; }

  const nowIso = new Date(nowSec * 1000).toISOString();
  const updated = { ...session, ...updates, lastAccess: nowIso };

  await env.USERS_DB.prepare(
    "UPDATE Sessions SET data = ?, lastAccess = ? WHERE tokenHash = ?"
  ).bind(JSON.stringify(updated), nowSec, hash).run();

  return updated;
}

export async function deleteSession(env, token) {
  const hash = await hashToken(token);
  await env.USERS_DB.prepare("DELETE FROM Sessions WHERE tokenHash = ?")
    .bind(hash).run();
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

// 256 bits of entropy, base64url-encoded. Same generation strategy as the
// session token — high enough that an attacker can't guess a victim's
// state value within the 10-minute TTL.
export async function generateOAuthState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64urlEncode(bytes.buffer);
}

export function makeOAuthStateCookie(provider, state) {
  // SameSite=Lax is required: the OAuth provider redirects the browser
  // back to /<provider>/oauth/callback as a top-level GET navigation, and
  // SameSite=Strict would strip the cookie on that navigation.
  return `${OAUTH_STATE_COOKIE_PREFIX}${provider}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OAUTH_STATE_TTL}`;
}

export function clearOAuthStateCookie(provider) {
  return `${OAUTH_STATE_COOKIE_PREFIX}${provider}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseOAuthStateCookie(request, provider) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  const want = `${OAUTH_STATE_COOKIE_PREFIX}${provider}`;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === want) return rest.join("=");
  }
  return null;
}
