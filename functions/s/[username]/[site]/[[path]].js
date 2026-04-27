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
  "search-index.json", // pages-site sidebar search (per-page title + headings)
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

// TTL for cached pages.json validation copies in seconds. pages.json only
// changes at publish time, so this trades a short delay for newly-added
// pages becoming visible against many fewer R2 reads. Tune as desired.
const PAGES_JSON_VALIDATION_CACHE_TTL = 300;

// Read + cache pages.json for the validation gate. Tries Cloudflare's
// edge cache first; on miss, falls through to R2 and stores the response
// for next time. Returns null if R2 has no file (or the read failed).
async function readPagesJsonForValidation(env, siteId) {
  const cache = caches.default;
  // Cache key matches the public serving URL that purgeCache (in
  // functions/api/files.js) targets when pages.json is republished —
  // `https://agorapages.com/s/<siteId>/pages.json`. Keeping the keys in
  // sync means a publish-time purge actually evicts this validation entry.
  const cacheKey = new Request(
    `https://agorapages.com/s/${siteId}/pages.json`
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      const parsed = await cached.json();
      console.log("pages.json validation source: cache");
      return parsed;
    } catch (_) { /* fall through to R2 */ }
  }

  let text;
  try {
    const obj = await env.PLURIBUS_BUCKET.get(`${siteId}/public/pages.json`);
    if (!obj) return null;
    text = await obj.text();
  } catch (e) {
    console.error("Failed to read pages.json from R2 for validation:", e);
    return null;
  }

  // Stash for next time. cache.put is fire-and-forget — don't block the
  // request on it. Errors are non-fatal (worst case: next request also misses).
  try {
    await cache.put(
      cacheKey,
      new Response(text, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${PAGES_JSON_VALIDATION_CACHE_TTL}`,
        },
      })
    );
  } catch (e) {
    console.warn("Cache put for pages.json validation failed:", e);
  }

  try {
    const parsed = JSON.parse(text);
    console.log("pages.json validation source: R2");
    return parsed;
  } catch (_) { return null; }
}

// Strip every shape pages.json's `fileName` field has historically taken
// (with/without `public/` prefix, with/without `.md` suffix, with a stray
// leading slash) so the comparison in isPagePath sees the same canonical
// slug regardless of which writer last touched the file. Without this,
// nested-folder pages 404 because the stored value and the URL-derived
// slug differ by one of these decorations.
function canonicalSlug(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/^\/+/, "")
    .replace(/^public\//, "")
    .replace(/\.md$/i, "");
}

// Verify that a non-metadata file path corresponds to a real page of the
// site. Goes through Cloudflare's edge cache first, then R2 — never
// HTTPS-back-into-itself, since recursive fetches get intercepted by
// Cloudflare Access on protected previews. Pages sites store pages.json
// as a flat array; blog sites use a batched object.
async function isPagePath(filePath, env, siteId) {
  const m = filePath.match(/^(.+?)\.(html?|md)$/i);
  if (!m) {
    console.log("isPagePath: filePath did not match extension regex:", filePath);
    return false;
  }
  const slug = canonicalSlug(m[1]);

  const parsed = await readPagesJsonForValidation(env, siteId);
  if (!parsed) {
    console.log("isPagePath: pages.json was null for", siteId);
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

  const found = pages.some(p => p && canonicalSlug(p.fileName) === slug);
  if (!found) {
    // Diagnostic: surface what we looked for and a sample of what was
    // available so the actual cause (stale cache, slug shape mismatch,
    // missing entry) is visible in worker logs without needing R2 access.
    const stored = pages
      .map(p => (p && typeof p.fileName === "string") ? p.fileName : null)
      .filter(Boolean);
    console.log(
      "isPagePath miss",
      JSON.stringify({
        slug,
        rawCapture: m[1],
        pageCount: pages.length,
        sampleFileNames: stored.slice(0, 10),
      })
    );
  }
  return found;
}

async function isAllowedFilePath(filePath, env, siteId) {
  if (isAllowedMetadataPath(filePath)) return true;
  // Only .html/.md requests need to correspond to a real entry in
  // pages.json — those represent pages of the site. Everything else
  // (images, fonts, CSS, JS, JSON, PDFs, etc.) is a static asset; we
  // let the R2 lookup decide whether it actually exists. This keeps
  // legacy root-level images working on sites that pre-date the
  // attachments/ migration without weakening the page-probing gate.
  if (/\.(html?|md)$/i.test(filePath)) {
    return await isPagePath(filePath, env, siteId);
  }
  return true;
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
