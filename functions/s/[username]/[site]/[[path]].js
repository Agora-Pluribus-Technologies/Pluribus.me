// functions/s/[username]/[site]/[[path]].js

// This function serves user sites from Cloudflare R2 storage.
// URL shape: /s/:username/:site/... -> fetch from R2 and return the file.

import { templateForSiteType } from "../../../_site-templates.js";

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

  // Look up site configuration in D1 to verify the site exists.
  // siteType decides which inlined SPA shell we serve for .html
  // requests (pages → owo-template, blog → blog-template). Defaults
  // to "pages" for legacy rows missing the column.
  const cfg = await env.USERS_DB.prepare(
    "SELECT siteId, owner, repo, siteType FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!cfg) {
    // Fail closed: if we don't know this site, return 404
    return corsResponse("Unknown site", 404);
  }

  const siteType = cfg.siteType || "pages";
  console.log("Site config:", cfg, "siteType:", siteType);

  console.log("Raw URL:", request.url);
  console.log("URL pathname:", url.pathname);

  // Compute the path inside the site, after /s/:username/:site/
  // e.g. /s/alice/myblog/about/team.html -> "about/team.html".
  // `URL.pathname` does NOT percent-decode, so a CJK page like
  // `中文笔记.html` arrives here as `%E4%B8%AD%E6%96%87%E7%AC%94%E8%AE%B0.html`.
  // Decode each segment so the downstream slug comparison and R2 key
  // see real UTF-8 chars; NFC-normalize while we're here so a URL
  // pasted from a macOS NFD source matches our NFC pages.json entries.
  const segments = url.pathname.split("/").filter(Boolean).map((seg) => {
    try { return decodeURIComponent(seg).normalize("NFC"); } catch { return seg; }
  });
  console.log("Path segments:", JSON.stringify(segments));
  const restSegments = segments.slice(3); // skip "s", username, and site
  let filePath = restSegments.join("/");
  console.log("filePath after join:", filePath);

  // Canonicalize the site-root URL to always have a trailing slash. The
  // SPA shell (owo-template.js / blog-template.js) detects the published
  // site via a regex that requires the trailing slash; without it the
  // shell mistakes the path for a root marketing page and fetches
  // `/s/<user>/<site>/s/<user>/<site>.md` (404). 302 redirect so the
  // browser's URL bar ends up on the canonical form before any JS runs.
  if (restSegments.length === 0 && !url.pathname.endsWith("/")) {
    const target = new URL(request.url);
    target.pathname = url.pathname + "/";
    console.log("Redirecting to canonical site root:", target.toString());
    return Response.redirect(target.toString(), 302);
  }

  // Default to index.html if no specific file
  if (!filePath) {
    filePath = "index.html";
    console.log("filePath defaulted to index.html");
  }

  // Very simple path traversal guard
  if (filePath.includes("..")) {
    return corsResponse("Invalid path", 400);
  }

  // Default to HTML
  if (!filePath.includes(".")) {
    filePath += ".html";
    console.log("filePath defaulted .html extension:", filePath);
  }

  console.log("File path:", filePath);
  console.log("Encoded codepoints (first 32):",
    Array.from(filePath).slice(0, 32).map(c => c.charCodeAt(0).toString(16)).join(" "));

  // Second gate: the requested file must either be one of the well-known
  // site-metadata files, an attachment, or an .html/.md whose slug exists
  // in the site's pages.json. Anything else is 404 — no random R2-key
  // probing for files that aren't pages of the site.
  const allowed = await isAllowedFilePath(filePath, env, siteId, url.origin);
  console.log("isAllowedFilePath result:", allowed);
  if (!allowed) {
    return corsResponse("Page not found", 404);
  }

  // .html requests (page shells + index.html for the SPA root) are
  // served from the baked-in template constants — never from R2. The
  // shell is identical for every page of a given site type; the actual
  // page content is fetched client-side as <slug>.md by the SPA logic
  // inside the template's bundled JS. This eliminates one R2 PUT per
  // page at publish time, halves R2 storage for Pages sites, and
  // means template updates only require a worker redeploy (not a
  // republish on every site).
  if (filePath.toLowerCase().endsWith(".html")) {
    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", "text/html; charset=utf-8");
    // Edge-cache the response so subsequent visitors of the same page
    // skip the worker invocation entirely. The body is constant per
    // siteType, so a long TTL is safe; cache is invalidated by the
    // existing publish-time purge of <slug>.html URLs (see
    // functions/api/files.js purgeCache).
    headers.set("Cache-Control", "public, max-age=300, must-revalidate");
    console.log("Serving inlined template for", filePath, "siteType:", siteType);
    return new Response(templateForSiteType(siteType), { status: 200, headers });
  }

  // Non-HTML requests (md, json, attachments, css, js, etc.) still
  // come from R2.
  let basePath = "/public";
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
// `requestOrigin` scopes the cache key to the deployment's hostname
// (e.g. agorapages.com vs develop.pluribus-me.pages.dev) so a dev
// preview can't reuse a stale prod entry and vice versa.
async function readPagesJsonForValidation(env, siteId, requestOrigin) {
  const cache = caches.default;
  // Cache key matches the public serving URL that purgeCache (in
  // functions/api/files.js) targets when pages.json is republished —
  // keeping the keys in sync means a publish-time purge actually evicts
  // this validation entry.
  const origin = requestOrigin || "https://agorapages.com";
  const cacheKey = new Request(
    `${origin}/s/${siteId}/pages.json`
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
//
// NFC-normalize so a URL pasted from a macOS NFD source matches the NFC
// form that the editor / importer now writes everywhere.
function canonicalSlug(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(/^\/+/, "")
    .replace(/^public\//, "")
    .replace(/\.md$/i, "");
}

// Verify that a non-metadata file path corresponds to a real page of the
// site. Goes through Cloudflare's edge cache first, then R2 — never
// HTTPS-back-into-itself, since recursive fetches get intercepted by
// Cloudflare Access on protected previews. Pages sites store pages.json
// as a flat array; blog sites use a batched object.
async function isPagePath(filePath, env, siteId, requestOrigin) {
  const m = filePath.match(/^(.+?)\.(html?|md)$/i);
  if (!m) {
    console.log("isPagePath: filePath did not match extension regex:", filePath);
    return false;
  }
  const rawCapture = m[1];
  const slug = canonicalSlug(rawCapture);
  console.log("isPagePath: lookup", JSON.stringify({
    filePath, rawCapture, slug,
    slugCodepoints: Array.from(slug).map(c => c.charCodeAt(0).toString(16)).join(" "),
  }));

  const parsed = await readPagesJsonForValidation(env, siteId, requestOrigin);
  if (!parsed) {
    console.log("isPagePath: pages.json was null for", siteId);
    return false;
  }

  let pages;
  let shape;
  if (Array.isArray(parsed)) {
    pages = parsed;
    shape = "flat-array";
  } else if (parsed && Array.isArray(parsed.batches)) {
    pages = [];
    for (const batch of parsed.batches) {
      if (Array.isArray(batch)) pages.push.apply(pages, batch);
    }
    shape = "batched-object";
  } else {
    pages = [];
    shape = "empty/unknown (" + (parsed && typeof parsed) + ")";
  }
  console.log("isPagePath: pages.json shape:", shape, "count:", pages.length);

  const stored = pages
    .map(p => (p && typeof p.fileName === "string") ? p.fileName : null)
    .filter(Boolean);
  const canonicals = stored.map(canonicalSlug);
  const matchIdx = canonicals.indexOf(slug);

  if (matchIdx >= 0) {
    console.log("isPagePath: hit at index", matchIdx, "fileName:", stored[matchIdx]);
    return true;
  }

  console.log(
    "isPagePath miss",
    JSON.stringify({
      slug,
      rawCapture,
      pageCount: pages.length,
      sampleStored: stored.slice(0, 15),
      sampleCanonical: canonicals.slice(0, 15),
    })
  );
  return false;
}

async function isAllowedFilePath(filePath, env, siteId, requestOrigin) {
  if (isAllowedMetadataPath(filePath)) {
    console.log("isAllowedFilePath: matched metadata path:", filePath);
    return true;
  }
  // Only .html/.md requests need to correspond to a real entry in
  // pages.json — those represent pages of the site. Everything else
  // (images, fonts, CSS, JS, JSON, PDFs, etc.) is a static asset; we
  // let the R2 lookup decide whether it actually exists. This keeps
  // legacy root-level images working on sites that pre-date the
  // attachments/ migration without weakening the page-probing gate.
  if (/\.(html?|md)$/i.test(filePath)) {
    console.log("isAllowedFilePath: routing to isPagePath:", filePath);
    return await isPagePath(filePath, env, siteId, requestOrigin);
  }
  console.log("isAllowedFilePath: non-page asset, allowed:", filePath);
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
