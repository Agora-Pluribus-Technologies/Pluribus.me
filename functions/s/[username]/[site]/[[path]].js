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

  // Second gate: the requested file must either be one of the well-known
  // site-metadata files, an attachment, or an .html/.md whose slug exists
  // in the site's pages.json. Anything else is 404 — no random R2-key
  // probing for files that aren't pages of the site.
  const allowed = await isAllowedFilePath(filePath, env, siteId);
  if (!allowed) {
    return corsResponse("Page not found", 404);
  }

  // basePath is always "/public"
  let basePath = "/public";

  // Normalize basePath
  if (basePath.startsWith("/")) basePath = basePath.slice(1);
  if (basePath.endsWith("/")) basePath = basePath.slice(0, -1);

  // Build the R2 key: siteId/basePath/filePath
  const r2Key = basePath ? `${siteId}/${basePath}/${filePath}` : `${siteId}/${filePath}`;

  console.log("R2 key:", r2Key);

  try {
    const object = await env.PLURIBUS_BUCKET.get(r2Key);

    const headers = new Headers(corsHeaders);

    if (!object) {
      return new Response("File not found", { status: 404, headers });
    }

    headers.set("Content-Type", object.httpMetadata?.contentType || guessContentType(filePath));

    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    console.error("R2 get error:", error);
    return corsResponse("Failed to retrieve file", 500);
  }
}

// Site-wide metadata files that the published-page template fetches by
// name. They aren't pages of the site, so they wouldn't appear in
// pages.json — but they're legitimate requests that need to be allowed
// through the page-validation gate.
const ALLOWED_METADATA_FILES = new Set([
  "index.html",       // SPA shell at the site root
  "pages.json",
  "site.json",
  "folders.json",
  "wikilinks.json",
  "images.json",
  "tags.json",
  "history.json",
  "latest.md",        // blog: most-recent-post snapshot
]);

function isAllowedMetadataPath(filePath) {
  if (ALLOWED_METADATA_FILES.has(filePath)) return true;
  // Image attachments live under public/attachments/ — the file inside
  // the folder isn't a "page" but it's a legitimate site asset.
  if (filePath.startsWith("attachments/")) return true;
  return false;
}

// Verify that a non-metadata file path corresponds to a real page of the
// site. Reads pages.json directly from R2 (NOT via HTTPS) — a recursive
// fetch back into this same Pages Function gets intercepted by Cloudflare
// Access on protected previews and returns an HTML challenge page instead
// of JSON. Pages sites store pages.json as a flat array; blog sites use a
// batched object.
async function isPagePath(filePath, env, siteId) {
  const m = filePath.match(/^(.+?)\.(html?|md)$/i);
  if (!m) return false;
  const slug = m[1];

  let parsed;
  try {
    const obj = await env.PLURIBUS_BUCKET.get(`${siteId}/public/pages.json`);
    if (!obj) return false;
    parsed = JSON.parse(await obj.text());
  } catch (e) {
    console.error("Failed to read pages.json from R2 for validation:", e);
    return false;
  }

  let pages;
  if (Array.isArray(parsed)) {
    pages = parsed;
  } else if (parsed && Array.isArray(parsed.batches)) {
    pages = [];
    for (const batch of parsed.batches) {
      if (Array.isArray(batch)) pages.push.apply(pages, batch);
    }
  } else {
    pages = [];
  }

  return pages.some(p => p && p.fileName === slug);
}

async function isAllowedFilePath(filePath, env, siteId) {
  if (isAllowedMetadataPath(filePath)) return true;
  return await isPagePath(filePath, env, siteId);
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
