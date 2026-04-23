import { isOwner, canAccess, forbidden } from "./auth/_authorize.js";

// GET /api/collaborators - Get collaborators for a site
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionUsername = context.data.username;

  const siteId = url.searchParams.get("siteId");

  if (!siteId) {
    return new Response("Missing required parameter: siteId", { status: 400 });
  }

  if (!(await canAccess(env, siteId, sessionUsername))) {
    return forbidden();
  }

  try {
    const result = await env.USERS_DB.prepare(`
      SELECT c.siteId, c.userId, u.username
      FROM Collaborators c
      JOIN Users u ON c.userId = u.id
      WHERE c.siteId = ?
    `).bind(siteId).all();

    return new Response(JSON.stringify(result.results || []), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching collaborators:", error);
    return new Response("Failed to fetch collaborators", { status: 500 });
  }
}

// POST /api/collaborators - Add a collaborator to a site
export async function onRequestPost(context) {
  const { request, env } = context;
  const sessionUsername = context.data.username;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { siteId, username } = data;

  if (!siteId || !username) {
    return new Response("Missing required fields: siteId, username", { status: 400 });
  }

  if (!(await isOwner(env, siteId, sessionUsername))) {
    return forbidden();
  }

  try {
    const user = await env.USERS_DB.prepare(
      "SELECT id, username FROM Users WHERE LOWER(username) = LOWER(?)"
    ).bind(username).first();

    if (!user) {
      return new Response("User not found", { status: 404 });
    }

    const site = await env.USERS_DB.prepare(
      "SELECT siteId, owner, repo FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();
    if (!site) {
      return new Response("Site not found", { status: 404 });
    }

    if (site.owner.toLowerCase() === username.toLowerCase()) {
      return new Response("Cannot add site owner as collaborator", { status: 400 });
    }

    const existing = await env.USERS_DB.prepare(
      "SELECT * FROM Collaborators WHERE siteId = ? AND userId = ?"
    ).bind(siteId, user.id).first();

    if (existing) {
      return new Response("User is already a collaborator", { status: 409 });
    }

    await env.USERS_DB.prepare(
      "INSERT INTO Collaborators (siteId, userId) VALUES (?, ?)"
    ).bind(siteId, user.id).run();

    return new Response(JSON.stringify({
      success: true,
      collaborator: { siteId, userId: user.id, username: user.username }
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error adding collaborator:", error);
    return new Response("Failed to add collaborator", { status: 500 });
  }
}

// DELETE /api/collaborators - Remove a collaborator from a site
export async function onRequestDelete(context) {
  const { request, env } = context;
  const sessionUsername = context.data.username;
  const url = new URL(request.url);

  const siteId = url.searchParams.get("siteId");
  const userId = url.searchParams.get("userId");

  if (!siteId || !userId) {
    return new Response("Missing required parameters: siteId, userId", { status: 400 });
  }

  if (!(await isOwner(env, siteId, sessionUsername))) {
    return forbidden();
  }

  try {
    const existing = await env.USERS_DB.prepare(
      "SELECT * FROM Collaborators WHERE siteId = ? AND userId = ?"
    ).bind(siteId, userId).first();

    if (!existing) {
      return new Response("Collaborator not found", { status: 404 });
    }

    await env.USERS_DB.prepare(
      "DELETE FROM Collaborators WHERE siteId = ? AND userId = ?"
    ).bind(siteId, userId).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error removing collaborator:", error);
    return new Response("Failed to remove collaborator", { status: 500 });
  }
}
