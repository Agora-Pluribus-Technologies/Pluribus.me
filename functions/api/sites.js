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

  if (!siteIdEncoded) {
    return new Response("Missing required fields", { status: 400 });
  }

  // Decode the URL-encoded siteId
  const siteId = decodeURIComponent(siteIdEncoded);

  // Check if site already exists
  const existing = await env.SITES.get(`site:${siteId}`);

  if (existing) {
    return new Response(existing, { status: 200 });
  } else {
    // Site not found
    return new Response("Not Found", { status: 404 });
  }

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
    await env.SITES.delete(`site:${siteId}`);
    return new Response(existing, { status: 200 });
  } else {
    // Site not found
    return new Response("Not Found", { status: 404 });
  }

};
