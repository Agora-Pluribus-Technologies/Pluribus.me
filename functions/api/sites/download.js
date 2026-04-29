import { isOwner, forbidden } from "../auth/_authorize.js";
import { templateForSiteType } from "../../_site-templates.js";

// R2 key for each site's cached export bundle. Lives under a TOP-LEVEL
// `_exports/` prefix — NOT under the site's own prefix — so it is
// structurally unreachable via the public-serving worker, which only
// resolves keys of the form `<siteId>/public/<filePath>`. Putting the
// bundle alongside the published content (e.g. `<siteId>/_export.json`)
// would mean any future broadening of the public worker's scope, or a
// Cache Rule misconfiguration, could leak it. Keeping the security
// boundary structural rather than convention-based avoids that class
// of mistake entirely.
//
// Single fixed name per site (no SHA in the path) so every rebuild
// overwrites in place — no orphan accumulation. Freshness is tracked
// via R2 customMetadata.shortSha, compared against
// Sites.lastCommitShortSha from D1.
function exportBundleR2Key(siteId) {
  return `_exports/${siteId}.json`;
}

// Files we don't include in the export — they're either:
//   - regenerated from sources at publish time (the .html shells),
//   - or copies of files already in the export (latest.md duplicates
//     the newest blog post).
// Skipping these halves the per-file GET count on Pages sites and
// shaves ~10% off blog sites with no functional loss on re-import.
function isExportedFile(relativePath) {
  if (!relativePath) return false;
  if (relativePath.endsWith(".html")) return false;
  if (relativePath === "public/latest.md") return false;
  return true;
}

// Encode a string as a base64 of its UTF-8 bytes. The export protocol
// stores all file contents base64-encoded so the JSON envelope can carry
// arbitrary bytes; HTML shells we synthesize need the same treatment.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return btoa(binary);
}

// Synthesize the .html SPA shells the worker would normally serve at
// request time. We bake one shell per .md page (plus a root index.html)
// into the export so the unzipped site is deployable as-is on a static
// host (Netlify, GitHub Pages, Cloudflare Pages, etc.) without needing
// the AgoraPages worker to materialize shells. Shells are byte-identical
// per siteType, so this only adds a few hundred bytes per page.
//
// Layout in the ZIP mirrors what the worker exposes at request time:
//   public/<slug>.md      <- already in the bundle
//   public/<slug>.html    <- added here, loads the sibling .md
//   public/index.html     <- site root
// The frontend ZIP-builder also drops the matching template .css/.js
// under public/_templates/, so a deploy with `public/` as the publish
// directory works out of the box.
function synthesizeShellEntries(mdPaths, siteType) {
  const shellHtml = templateForSiteType(siteType);
  const shellBase64 = utf8ToBase64(shellHtml);
  const entries = [];
  const seen = new Set();

  const push = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    entries.push({
      path,
      contentType: "text/html; charset=utf-8",
      content: shellBase64,
    });
  };

  push("public/index.html");
  for (const mdPath of mdPaths) {
    if (!mdPath.startsWith("public/") || !mdPath.endsWith(".md")) continue;
    // public/latest.md is excluded from the export and isn't a real page
    if (mdPath === "public/latest.md") continue;
    push(mdPath.slice(0, -3) + ".html");
  }
  return entries;
}

// Convert an ArrayBuffer to a base64 string in chunks. Avoids the
// "maximum call stack" failure that String.fromCharCode(...bytes) hits
// on multi-MB files.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return btoa(binary);
}

// Build the export bundle from R2 by listing the site prefix and
// fetching every (non-skipped) file in parallel. Returns the bundle
// object { site, files: [...] }, plus the JSON-stringified version
// for caching/PUT.
async function buildExportBundle(env, siteId, siteConfig) {
  const r2Prefix = `${siteId}/`;
  const list = await env.PLURIBUS_BUCKET.list({ prefix: r2Prefix });

  const includedKeys = list.objects
    .map(obj => obj.key)
    .filter(key => isExportedFile(key.replace(r2Prefix, "")));

  // Parallel R2 GETs. Cloudflare Workers handle up to ~1000 concurrent
  // outbound subrequests; for typical sites we're well under that.
  const fileResults = await Promise.all(
    includedKeys.map(async (key) => {
      try {
        const obj = await env.PLURIBUS_BUCKET.get(key);
        if (!obj) return null;
        const arrayBuffer = await obj.arrayBuffer();
        return {
          path: key.replace(r2Prefix, ""),
          contentType: obj.httpMetadata?.contentType || "application/octet-stream",
          content: arrayBufferToBase64(arrayBuffer),
        };
      } catch (e) {
        console.error(`Error reading file ${key} for export:`, e);
        return null;
      }
    })
  );

  const files = fileResults.filter(Boolean);

  // Bake in one .html SPA shell per .md page (plus a root index.html).
  // See synthesizeShellEntries for layout rationale.
  const siteType = siteConfig.siteType || "pages";
  const mdPaths = files.map(f => f.path).filter(p => p.endsWith(".md"));
  const shellEntries = synthesizeShellEntries(mdPaths, siteType);

  const exportData = {
    site: {
      ...siteConfig,
      exportedAt: new Date().toISOString(),
    },
    files: [...files, ...shellEntries],
  };

  return { exportData, json: JSON.stringify(exportData) };
}

// GET /api/sites/download - Download a single site as JSON (ZIP created client-side)
export async function onRequestGet(context) {
  const { request, env } = context;
  const sessionUsername = context.data.username;
  const url = new URL(request.url);

  const siteIdEncoded = url.searchParams.get("siteId");
  if (!siteIdEncoded) {
    return new Response("Missing required parameter: siteId", { status: 400 });
  }
  const siteId = decodeURIComponent(siteIdEncoded);

  if (!(await isOwner(env, siteId, sessionUsername))) {
    return forbidden();
  }

  const siteConfig = await env.USERS_DB.prepare(
    "SELECT siteId, owner, repo, siteType, lastCommitShortSha FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!siteConfig) {
    return new Response("Site not found", { status: 404 });
  }

  const currentSha = siteConfig.lastCommitShortSha || null;

  // Edge-cache key. Synthetic hostname (`internal-site-export`) so the
  // cache entry can NEVER be served as a public HTTP response — only
  // the worker, which gates auth above, can reach it via cache.match.
  // Including the SHA means a fresh publish (which advances the SHA)
  // automatically misses the cache without us having to purge anything.
  // Old SHAs become unreferenced and TTL out naturally.
  const cache = caches.default;
  const cacheKey = new Request(
    `https://internal-site-export/${encodeURIComponent(siteId)}/${currentSha || "0"}`
  );
  if (currentSha) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      console.log("download: edge cache hit for", siteId, "@", currentSha);
      return new Response(cached.body, {
        status: cached.status,
        headers: cached.headers,
      });
    }
  }

  try {
    let bundleJson = null;
    let bundleSource = null;
    const bundleKey = exportBundleR2Key(siteId);

    // Try the persisted bundle first. Stale (or missing) → rebuild.
    if (currentSha) {
      try {
        const persisted = await env.PLURIBUS_BUCKET.get(bundleKey);
        if (persisted && persisted.customMetadata?.shortSha === currentSha) {
          bundleJson = await persisted.text();
          bundleSource = "r2-bundle";
        }
      } catch (e) {
        console.warn("download: failed to read persisted bundle, will rebuild:", e);
      }
    }

    // Cold path — rebuild from the per-file LIST + GET pass and
    // persist for next time so subsequent downloads of this same
    // publish cost just one R2 GET (or zero, if edge-cached).
    if (!bundleJson) {
      const { json } = await buildExportBundle(env, siteId, siteConfig);
      bundleJson = json;
      bundleSource = "rebuild";

      if (currentSha) {
        try {
          await env.PLURIBUS_BUCKET.put(bundleKey, json, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { shortSha: currentSha },
          });
        } catch (e) {
          // Non-fatal — we still serve this download; next download
          // just rebuilds again.
          console.warn("download: failed to persist bundle:", e);
        }
      }
    }

    console.log(`download: served ${siteId} from ${bundleSource}`);

    const response = new Response(bundleJson, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Browser shouldn't cache (auth-bound); the edge cache stores
        // its own copy via cache.put below using the SHA-keyed Request.
        "Cache-Control": "private, max-age=0",
      },
    });

    if (currentSha) {
      // Cache for the edge under the SHA-keyed URL. New publishes
      // advance the SHA → new key → cold cache → rebuild path runs.
      // Keep TTL short on the headers but rely on the cache-key
      // change for invalidation.
      const cacheable = new Response(bundleJson, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400",
        },
      });
      context.waitUntil(cache.put(cacheKey, cacheable));
    }

    return response;
  } catch (error) {
    console.error("Error exporting site data:", error);
    return new Response("Failed to export data: " + error.message, { status: 500 });
  }
}
