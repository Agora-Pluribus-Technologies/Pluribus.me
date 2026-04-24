// functions/s/[username]/[site]/[[path]].js

// This function serves user sites from Cloudflare R2 storage.
// URL shape: /s/:username/:site/... -> fetch from R2 and return the file.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Cache-Control",
};

function corsResponse(body, status) {
  return new Response(body, { status, headers: corsHeaders });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);

  for (const k of url.searchParams.keys()) {
    url.searchParams.delete(k);
  }

  // Check cache first
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const username = params && params.username ? String(params.username).toLowerCase() : null;
  const site = params && params.site ? String(params.site) : null;
  const siteId = username && site ? `${username}/${site}` : null;
  if (!siteId) {
    return corsResponse("Missing site id", 400);
  }

  // Basic validation for siteId (avoid weird characters / traversal tricks)
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return corsResponse("Invalid site id", 400);
  }

  console.log("Site id:", siteId);

  // Look up site configuration in D1 to verify the site exists
  const cfg = await env.USERS_DB.prepare(
    "SELECT siteId, owner, repo FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!cfg) {
    // Fail closed: if we don't know this site, return 404
    return corsResponse("Unknown site", 404);
  }

  console.log("Site config:", cfg);

  // Compute the path inside the site, after /s/:username/:site/
  // e.g. /s/alice/myblog/about/team.html -> "about/team.html"
  const segments = url.pathname.split("/").filter(Boolean); // ["s","alice","myblog","about","team.html"]
  const restSegments = segments.slice(3); // skip "s", username, and site
  let filePath = restSegments.join("/");

  // Default to index.html if no specific file
  if (!filePath) {
    filePath = "index.html";
  }

  // Very simple path traversal guard
  if (filePath.includes("..")) {
    return corsResponse("Invalid path", 400);
  }

  // Default to HTML
  if (!filePath.includes(".")) {
    filePath += ".html";
  }

  console.log("File path:", filePath);

  // basePath is always "/public"
  let basePath = "/public";

  // Normalize basePath
  if (basePath.startsWith("/")) basePath = basePath.slice(1);
  if (basePath.endsWith("/")) basePath = basePath.slice(0, -1);

  // Build the R2 key: siteId/basePath/filePath
  const r2Key = basePath ? `${siteId}/${basePath}/${filePath}` : `${siteId}/${filePath}`;

  console.log("R2 key:", r2Key);

  try {
    let object = await env.PLURIBUS_BUCKET.get(r2Key);

    // Folder URL fallback: if path.html not found, try path/index.html
    if (!object && filePath.endsWith(".html") && !filePath.endsWith("/index.html")) {
      const folderIndexPath = filePath.replace(/\.html$/, "/index.html");
      const folderR2Key = `${siteId}/${basePath}/${folderIndexPath}`;
      object = await env.PLURIBUS_BUCKET.get(folderR2Key);
      if (object) {
        filePath = folderIndexPath;
      }
    }

    // Build response headers
    const headers = new Headers(corsHeaders);
    headers.set("Cache-Control", "public, max-age=0, s-maxage=31536000");

    let response;

    if (!object) {
      response = new Response("File not found", {
        status: 404,
        headers,
      });
    }
    else {
      headers.set("Content-Type", object.httpMetadata?.contentType || guessContentType(filePath));

      response = new Response(object.body, {
        status: 200,
        headers,
      });
    }

    // Store in cache (must clone since body can only be read once)
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (error) {
    console.error("R2 get error:", error);
    return corsResponse("Failed to retrieve file", 500);
  }
}

// Helper function to guess content type from file extension
function guessContentType(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeTypes = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    pdf: "application/pdf",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    eot: "application/vnd.ms-fontobject",
  };
  return mimeTypes[ext] || "application/octet-stream";
}
