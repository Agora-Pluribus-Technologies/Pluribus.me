// functions/api/sites.ts

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;

  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Validate required fields
  const { siteId, provider, owner, repo, branch, basePath } = data;

  if (!siteId || !provider || !owner || !repo || !branch) {
    return new Response("Missing required fields", { status: 400 });
  }

  // You can add your own validation rules here if needed
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  // Build a clean config object
  const config = {
    siteId,
    provider,
    owner,
    repo,
    branch,
    basePath: basePath || "/public"
  };

  // Check if site already exists
  const existing = await env.SITES.get(`site:${siteId}`);

  if (existing) {
    return new Response("Site ID already exists", { status: 409 });
  } else {
    // Save to KV using a stable key
    await env.SITES.put(`site:${siteId}`, JSON.stringify(config));
  
    return new Response("Created", { status: 201 });
  }

};

// functions/api/sites.ts

export async function onRequestGet(context) {
  const { request, env } = context;

  // Parse URL to get search params
  const url = new URL(request.url);
  const siteIdEncoded = url.searchParams.get("siteId");
  const ownerParam = url.searchParams.get("owner");

  // If siteId is provided, return that specific site
  if (siteIdEncoded) {
    const siteId = decodeURIComponent(siteIdEncoded);
    const existing = await env.SITES.get(`site:${siteId}`);

    if (existing) {
      return new Response(existing, { status: 200 });
    } else {
      return new Response("Not Found", { status: 404 });
    }
  }

  // Otherwise, list all sites (optionally filtered by owner)
  const prefix = ownerParam ? `site:${ownerParam}/` : "site:";
  const listed = await env.SITES.list({ prefix });

  // Fetch all site configs
  const sites = [];
  for (const key of listed.keys) {
    const config = await env.SITES.get(key.name);
    if (config) {
      sites.push(JSON.parse(config));
    }
  }

  return new Response(JSON.stringify(sites), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// functions/api/sites.ts

export async function onRequestDelete(context) {
  const { request, env } = context;

  // Parse URL to get search params
  const url = new URL(request.url);
  const siteIdEncoded = url.searchParams.get("siteId");

  if (!siteIdEncoded) {
    return new Response("Missing required fields", { status: 400 });
  }

  // Decode the URL-encoded siteId
  const siteId = decodeURIComponent(siteIdEncoded);

  // Check if site already exists
  const existing = await env.SITES.get(`site:${siteId}`);

  if (existing) {
    // Delete all R2 files for this site
    try {
      const prefix = `${siteId}/`;
      const listed = await env.PLURIBUS_BUCKET.list({ prefix });

      if (listed.objects.length > 0) {
        // Delete all files with this prefix
        for (const obj of listed.objects) {
          await env.PLURIBUS_BUCKET.delete(obj.key);
        }
        console.log(`Deleted ${listed.objects.length} files from R2 for site: ${siteId}`);
      }
    } catch (error) {
      console.error("Error deleting R2 files:", error);
      // Continue with KV deletion even if R2 cleanup fails
    }

    // Delete the site config from KV
    await env.SITES.delete(`site:${siteId}`);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } else {
    // Site not found
    return new Response("Not Found", { status: 404 });
  }

};
