import { updateSession, deleteSession, clearSessionCookie } from "./auth/_session.js";

// GET /api/users - Check if username is available
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const username = url.searchParams.get("username");

  if (!username) {
    return new Response("Missing required parameter: username", { status: 400 });
  }

  const result = await env.USERS_DB.prepare(
    "SELECT id, provider, providerId, username, createdAt FROM Users WHERE LOWER(username) = LOWER(?)"
  ).bind(username).first();

  if (result) {
    return new Response(JSON.stringify({ exists: true, user: result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ exists: false }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /api/users - Create a new user with username (provider info from session)
export async function onRequestPost(context) {
  const { request, env } = context;
  const session = context.data.session;

  if (!session || session.status !== "pending_username") {
    return new Response("Invalid session state", { status: 400 });
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { username } = data;
  const { provider, providerId } = session;

  if (!username) {
    return new Response("Missing required field: username", { status: 400 });
  }

  // Validate username format (alphanumeric and hyphens, 3-30 chars)
  const usernameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,28}[a-zA-Z0-9]$/;
  if (!usernameRegex.test(username)) {
    return new Response("Invalid username format. Must be 3-30 characters, alphanumeric and hyphens only, cannot start or end with hyphen.", { status: 400 });
  }

  const usernameLower = username.toLowerCase();

  // Check if username is already taken
  const existingUsername = await env.USERS_DB.prepare(
    "SELECT id FROM Users WHERE LOWER(username) = LOWER(?)"
  ).bind(usernameLower).first();

  if (existingUsername) {
    return new Response("Username already taken", { status: 409 });
  }

  // Check if this provider ID already has a username
  const existingProvider = await env.USERS_DB.prepare(
    "SELECT id FROM Users WHERE provider = ? AND providerId = ?"
  ).bind(provider, providerId).first();

  if (existingProvider) {
    return new Response("User already has a username", { status: 409 });
  }

  // Generate UUID for the new user
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  // Insert new user into database
  await env.USERS_DB.prepare(
    "INSERT INTO Users (id, provider, providerId, username, createdAt) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, provider, providerId, username, createdAt).run();

  // Update the session to active with user info
  const sessionToken = context.data.sessionToken;
  await updateSession(env, sessionToken, {
    userId: id,
    username: usernameLower,
    displayUsername: username,
    status: "active",
  });

  const user = {
    id,
    provider,
    providerId,
    username,
    createdAt,
  };

  return new Response(JSON.stringify(user), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

// DELETE /api/users - Delete own account and all associated data
export async function onRequestDelete(context) {
  const { env } = context;
  const session = context.data.session;
  const usernameLower = session.username;

  // Get user info from database
  const user = await env.USERS_DB.prepare(
    "SELECT id, provider, providerId, username, createdAt FROM Users WHERE LOWER(username) = LOWER(?)"
  ).bind(usernameLower).first();

  if (!user) {
    return new Response("User not found", { status: 404 });
  }

  try {
    // 1. Delete all user's sites from D1 and R2
    const sitesResult = await env.USERS_DB.prepare(
      "SELECT siteId FROM Sites WHERE LOWER(owner) = LOWER(?)"
    ).bind(usernameLower).all();

    for (const site of sitesResult.results || []) {
      const siteId = site.siteId;

      // Delete all R2 files for this site
      try {
        const r2Prefix = `${siteId}/`;
        const r2List = await env.PLURIBUS_BUCKET.list({ prefix: r2Prefix });

        for (const obj of r2List.objects) {
          await env.PLURIBUS_BUCKET.delete(obj.key);
        }
        console.log(`Deleted ${r2List.objects.length} files from R2 for site: ${siteId}`);
      } catch (r2Error) {
        console.error(`Error deleting R2 files for site ${siteId}:`, r2Error);
      }

      // Delete collaborators for this site
      await env.USERS_DB.prepare(
        "DELETE FROM Collaborators WHERE siteId = ?"
      ).bind(siteId).run();

      // Delete site config from D1
      await env.USERS_DB.prepare(
        "DELETE FROM Sites WHERE siteId = ?"
      ).bind(siteId).run();
      console.log(`Deleted site config: ${siteId}`);
    }

    // 2. Delete user from database
    await env.USERS_DB.prepare(
      "DELETE FROM Users WHERE id = ?"
    ).bind(user.id).run();

    // 3. Delete session
    const sessionToken = context.data.sessionToken;
    await deleteSession(env, sessionToken);

    console.log(`User ${usernameLower} deleted successfully`);

    return new Response(JSON.stringify({ success: true, message: "Account deleted successfully" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": clearSessionCookie(),
      },
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    return new Response("Failed to delete account", { status: 500 });
  }
}
