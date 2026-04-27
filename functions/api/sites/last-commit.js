import { canAccess, forbidden } from "../auth/_authorize.js";

// GET /api/sites/last-commit?siteId=...
// Returns the latest published commit's short SHA for a site, read from
// the Sites.lastCommitShortSha column. Used by the editor's conflict-
// resolution polling to detect when another tab/device has published
// while the local editor session is open — replaces the previous
// fetch-history.json polling pattern (which read R2 on every poll).
export async function onRequestGet(context) {
  const { request, env } = context;
  const sessionUsername = context.data.username;

  const url = new URL(request.url);
  const siteIdEncoded = url.searchParams.get("siteId");
  if (!siteIdEncoded) {
    return new Response("Missing required query param: siteId", { status: 400 });
  }
  const siteId = decodeURIComponent(siteIdEncoded);

  if (!(await canAccess(env, siteId, sessionUsername))) {
    return forbidden();
  }

  try {
    const row = await env.USERS_DB.prepare(
      "SELECT lastCommitShortSha FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();
    return new Response(
      JSON.stringify({ lastCommitShortSha: (row && row.lastCommitShortSha) || null }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error reading lastCommitShortSha:", error);
    return new Response("Failed to read last commit", { status: 500 });
  }
}

// POST /api/sites/last-commit  body: { siteId, shortSha }
// Called by the editor right after a successful publish to record the
// new HEAD SHA. The editor's conflict-resolution poll then uses this
// value to detect divergence on other open sessions.
export async function onRequestPost(context) {
  const { request, env } = context;
  const sessionUsername = context.data.username;

  let data;
  try { data = await request.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { siteId, shortSha } = data || {};

  if (!siteId || typeof siteId !== "string") {
    return new Response("Missing required field: siteId", { status: 400 });
  }
  if (typeof shortSha !== "string" || !/^[a-zA-Z0-9]{1,40}$/.test(shortSha)) {
    return new Response("Invalid shortSha", { status: 400 });
  }

  if (!(await canAccess(env, siteId, sessionUsername))) {
    return forbidden();
  }

  try {
    await env.USERS_DB.prepare(
      "UPDATE Sites SET lastCommitShortSha = ? WHERE siteId = ?"
    ).bind(shortSha, siteId).run();
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error updating lastCommitShortSha:", error);
    return new Response("Failed to update last commit", { status: 500 });
  }
}
