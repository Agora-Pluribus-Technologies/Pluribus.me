import { isOwner, forbidden } from "./auth/_authorize.js";

// Per-user cap on owned sites. Counts only sites the user OWNS — being a
// collaborator on someone else's site doesn't count toward the limit.
const MAX_SITES_PER_USER = 5;

// POST /api/sites - Create a new site
export async function onRequestPost(context) {
  const { request, env } = context;
  const sessionUsername = context.data.username;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { repo, siteType } = data;
  // Use session username as owner, ignore client-provided owner
  const owner = sessionUsername;
  const siteId = `${owner}/${repo}`;

  if (!repo) {
    return new Response("Missing required field: repo", { status: 400 });
  }

  // Validate siteId format
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  const validSiteType = siteType === "blog" ? "blog" : "pages";

  try {
    // Per-user site cap. COUNT(*) on the indexed LOWER(owner) column
    // (idx_sites_owner_lower) is a cheap index seek; no scan.
    const ownedCountRow = await env.USERS_DB.prepare(
      "SELECT COUNT(*) AS n FROM Sites WHERE LOWER(owner) = LOWER(?)"
    ).bind(owner).first();
    const ownedCount = (ownedCountRow && ownedCountRow.n) || 0;
    if (ownedCount >= MAX_SITES_PER_USER) {
      return new Response(
        JSON.stringify({
          error: `Site limit reached: each user may own at most ${MAX_SITES_PER_USER} sites. Delete an existing site to create a new one.`,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const existing = await env.USERS_DB.prepare(
      "SELECT siteId FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();

    if (existing) {
      return new Response("Site ID already exists", { status: 409 });
    }

    try {
      await env.USERS_DB.prepare(
        "INSERT INTO Sites (siteId, owner, repo, siteType) VALUES (?, ?, ?, ?)"
      ).bind(siteId, owner, repo, validSiteType).run();
    } catch (dbError) {
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

// GET /api/sites - Get a site or list user's sites (own + collaborations)
export async function onRequestGet(context) {
  const { request, env } = context;
  const sessionUsername = context.data.username;

  const url = new URL(request.url);
  const siteIdEncoded = url.searchParams.get("siteId");

  try {
    if (siteIdEncoded) {
      const siteId = decodeURIComponent(siteIdEncoded);
      const site = await env.USERS_DB.prepare(
        "SELECT siteId, owner, repo, siteType, displayName FROM Sites WHERE siteId = ?"
      ).bind(siteId).first();

      if (site) {
        site.displayName = site.displayName || site.repo;
        site.siteType = site.siteType || "pages";
        return new Response(JSON.stringify(site), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response("Not Found", { status: 404 });
      }
    }

    // List user's own sites
    const ownResult = await env.USERS_DB.prepare(
      "SELECT siteId, owner, repo, siteType, displayName FROM Sites WHERE LOWER(owner) = LOWER(?)"
    ).bind(sessionUsername).all();
    let sites = ownResult.results || [];

    // Also include sites where user is a collaborator
    const collabResult = await env.USERS_DB.prepare(
      "SELECT c.siteId FROM Collaborators c JOIN Users u ON c.userId = u.id WHERE LOWER(u.username) = LOWER(?)"
    ).bind(sessionUsername).all();
    const collabSiteIds = (collabResult.results || []).map(c => c.siteId);

    for (const collabSiteId of collabSiteIds) {
      if (!sites.some(s => s.siteId === collabSiteId)) {
        const collabSite = await env.USERS_DB.prepare(
          "SELECT siteId, owner, repo, siteType, displayName FROM Sites WHERE siteId = ?"
        ).bind(collabSiteId).first();
        if (collabSite) {
          sites.push(collabSite);
        }
      }
    }

    sites = sites.map(site => ({
      ...site,
      displayName: site.displayName || site.repo,
      siteType: site.siteType || "pages",
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
  const sessionUsername = context.data.username;

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

  if (!(await isOwner(env, siteId, sessionUsername))) {
    return forbidden();
  }

  try {
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
  const sessionUsername = context.data.username;

  const url = new URL(request.url);
  const siteIdEncoded = url.searchParams.get("siteId");

  if (!siteIdEncoded) {
    return new Response("Missing required fields", { status: 400 });
  }

  const siteId = decodeURIComponent(siteIdEncoded);

  if (!(await isOwner(env, siteId, sessionUsername))) {
    return forbidden();
  }

  try {
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
