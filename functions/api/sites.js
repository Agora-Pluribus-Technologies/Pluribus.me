// POST /api/sites - Create a new site
export async function onRequestPost(context) {
  const { request, env } = context;

  let data;

  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Validate required fields
  const { siteId, owner, repo } = data;

  if (!siteId || !owner || !repo) {
    return new Response("Missing required fields", { status: 400 });
  }

  // Validate siteId format
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  try {
    // Check if site already exists
    const existing = await env.USERS_DB.prepare(
      "SELECT siteId FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();

    if (existing) {
      return new Response("Site ID already exists", { status: 409 });
    }

    // Insert the new site
    await env.USERS_DB.prepare(
      "INSERT INTO Sites (siteId, owner, repo) VALUES (?, ?, ?)"
    ).bind(siteId, owner, repo).run();

    return new Response("Created", { status: 201 });
  } catch (error) {
    console.error("Error creating site:", error);
    return new Response("Failed to create site", { status: 500 });
  }
}

// GET /api/sites - Get a site or list sites
export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const siteIdEncoded = url.searchParams.get("siteId");
  const ownerParam = url.searchParams.get("owner");

  try {
    // If siteId is provided, return that specific site
    if (siteIdEncoded) {
      const siteId = decodeURIComponent(siteIdEncoded);
      const site = await env.USERS_DB.prepare(
        "SELECT siteId, owner, repo FROM Sites WHERE siteId = ?"
      ).bind(siteId).first();

      if (site) {
        // Add displayName for compatibility (uses repo as fallback)
        site.displayName = site.repo;
        return new Response(JSON.stringify(site), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response("Not Found", { status: 404 });
      }
    }

    // Otherwise, list all sites (optionally filtered by owner)
    let sites;
    if (ownerParam) {
      const result = await env.USERS_DB.prepare(
        "SELECT siteId, owner, repo FROM Sites WHERE owner = ?"
      ).bind(ownerParam).all();
      sites = result.results || [];
    } else {
      const result = await env.USERS_DB.prepare(
        "SELECT siteId, owner, repo FROM Sites"
      ).all();
      sites = result.results || [];
    }

    // Add displayName for compatibility
    sites = sites.map(site => ({
      ...site,
      displayName: site.repo
    }));

    return new Response(JSON.stringify(sites), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching sites:", error);
    return new Response("Failed to fetch sites", { status: 500 });
  }
}

// DELETE /api/sites - Delete a site
export async function onRequestDelete(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const siteIdEncoded = url.searchParams.get("siteId");

  if (!siteIdEncoded) {
    return new Response("Missing required fields", { status: 400 });
  }

  const siteId = decodeURIComponent(siteIdEncoded);

  try {
    // Check if site exists
    const existing = await env.USERS_DB.prepare(
      "SELECT siteId FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();

    if (!existing) {
      return new Response("Not Found", { status: 404 });
    }

    // Delete all R2 files for this site
    try {
      const prefix = `${siteId}/`;
      const listed = await env.PLURIBUS_BUCKET.list({ prefix });

      if (listed.objects.length > 0) {
        for (const obj of listed.objects) {
          await env.PLURIBUS_BUCKET.delete(obj.key);
        }
        console.log(`Deleted ${listed.objects.length} files from R2 for site: ${siteId}`);
      }
    } catch (error) {
      console.error("Error deleting R2 files:", error);
      // Continue with D1 deletion even if R2 cleanup fails
    }

    // Delete collaborators for this site
    await env.USERS_DB.prepare(
      "DELETE FROM Collaborators WHERE siteId = ?"
    ).bind(siteId).run();

    // Delete the site from D1
    await env.USERS_DB.prepare(
      "DELETE FROM Sites WHERE siteId = ?"
    ).bind(siteId).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error deleting site:", error);
    return new Response("Failed to delete site", { status: 500 });
  }
}
