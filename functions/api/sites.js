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
  const { siteId, owner, repo, siteType } = data;

  if (!siteId || !owner || !repo) {
    return new Response("Missing required fields", { status: 400 });
  }

  // Validate siteId format
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  // Validate siteType if provided
  const validSiteType = siteType === "blog" ? "blog" : "pages";

  try {
    // Check if site already exists
    const existing = await env.USERS_DB.prepare(
      "SELECT siteId FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();

    if (existing) {
      return new Response("Site ID already exists", { status: 409 });
    }

    // Insert the new site (siteType column may not exist in older schemas, so use try/catch)
    try {
      await env.USERS_DB.prepare(
        "INSERT INTO Sites (siteId, owner, repo, siteType) VALUES (?, ?, ?, ?)"
      ).bind(siteId, owner, repo, validSiteType).run();
    } catch (dbError) {
      // Fallback if siteType column doesn't exist
      console.log("siteType column may not exist, falling back to basic insert");
      await env.USERS_DB.prepare(
        "INSERT INTO Sites (siteId, owner, repo) VALUES (?, ?, ?)"
      ).bind(siteId, owner, repo).run();
    }

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
        "SELECT siteId, owner, repo, siteType, displayName FROM Sites WHERE siteId = ?"
      ).bind(siteId).first();

      if (site) {
        // Use stored displayName, fall back to repo
        site.displayName = site.displayName || site.repo;
        // Default siteType to "pages" if not set
        site.siteType = site.siteType || "pages";
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
        "SELECT siteId, owner, repo, siteType, displayName FROM Sites WHERE owner = ?"
      ).bind(ownerParam).all();
      sites = result.results || [];
    } else {
      const result = await env.USERS_DB.prepare(
        "SELECT siteId, owner, repo, siteType, displayName FROM Sites"
      ).all();
      sites = result.results || [];
    }

    // Use stored displayName with repo as fallback, and default siteType
    sites = sites.map(site => ({
      ...site,
      displayName: site.displayName || site.repo,
      siteType: site.siteType || "pages"
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

// PATCH /api/sites - Update site display name
export async function onRequestPatch(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { siteId, displayName } = data;

  if (!siteId || !displayName) {
    return new Response("Missing required fields", { status: 400 });
  }

  try {
    // Ensure displayName column exists
    try {
      await env.USERS_DB.prepare(
        "ALTER TABLE Sites ADD COLUMN displayName TEXT"
      ).run();
    } catch {
      // Column already exists
    }

    await env.USERS_DB.prepare(
      "UPDATE Sites SET displayName = ? WHERE siteId = ?"
    ).bind(displayName, siteId).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error updating site:", error);
    return new Response("Failed to update site", { status: 500 });
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

    // Delete subscribers for this site
    try {
      await env.USERS_DB.prepare(
        "DELETE FROM Subscribers WHERE siteId = ?"
      ).bind(siteId).run();
    } catch {
      // Subscribers table may not exist yet
    }

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
