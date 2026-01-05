// GET /api/collaborators - Get collaborators for a site OR get sites shared with a user
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const siteId = url.searchParams.get("siteId");
  const username = url.searchParams.get("username");

  // If username is provided, get all sites shared with this user
  if (username) {
    try {
      // First get the user's ID
      const user = await env.USERS_DB.prepare(
        "SELECT id FROM Users WHERE LOWER(username) = LOWER(?)"
      ).bind(username).first();

      if (!user) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Get all sites where this user is a collaborator
      const result = await env.USERS_DB.prepare(`
        SELECT siteId FROM Collaborators WHERE userId = ?
      `).bind(user.id).all();

      // Fetch full site configs for each site
      const sharedSites = [];
      for (const row of result.results || []) {
        const siteConfig = await env.SITES.get(`site:${row.siteId}`);
        if (siteConfig) {
          sharedSites.push(JSON.parse(siteConfig));
        }
      }

      return new Response(JSON.stringify(sharedSites), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error fetching shared sites:", error);
      return new Response("Failed to fetch shared sites", { status: 500 });
    }
  }

  // If siteId is provided, get collaborators for that site
  if (!siteId) {
    return new Response("Missing required parameter: siteId or username", { status: 400 });
  }

  try {
    // Get all collaborators for this site with their usernames
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

  try {
    // Look up the user by username
    const user = await env.USERS_DB.prepare(
      "SELECT id, username FROM Users WHERE LOWER(username) = LOWER(?)"
    ).bind(username).first();

    if (!user) {
      return new Response("User not found", { status: 404 });
    }

    // Check if site exists
    const siteConfig = await env.SITES.get(`site:${siteId}`);
    if (!siteConfig) {
      return new Response("Site not found", { status: 404 });
    }

    // Check if already a collaborator
    const existing = await env.USERS_DB.prepare(
      "SELECT * FROM Collaborators WHERE siteId = ? AND userId = ?"
    ).bind(siteId, user.id).first();

    if (existing) {
      return new Response("User is already a collaborator", { status: 409 });
    }

    // Check if user is the site owner (can't add owner as collaborator)
    const site = JSON.parse(siteConfig);
    if (site.owner.toLowerCase() === username.toLowerCase()) {
      return new Response("Cannot add site owner as collaborator", { status: 400 });
    }

    // Add the collaborator
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
  const url = new URL(request.url);

  const siteId = url.searchParams.get("siteId");
  const userId = url.searchParams.get("userId");

  if (!siteId || !userId) {
    return new Response("Missing required parameters: siteId, userId", { status: 400 });
  }

  try {
    // Check if collaborator exists
    const existing = await env.USERS_DB.prepare(
      "SELECT * FROM Collaborators WHERE siteId = ? AND userId = ?"
    ).bind(siteId, userId).first();

    if (!existing) {
      return new Response("Collaborator not found", { status: 404 });
    }

    // Remove the collaborator
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
