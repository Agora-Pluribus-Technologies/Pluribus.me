import { isOwner, forbidden } from "../auth/_authorize.js";
import { loadOrBuildSiteBundle, BUNDLE_FORMAT_VERSION } from "../_export-helpers.js";

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
    "SELECT siteId, owner, repo, lastCommitShortSha FROM Sites WHERE siteId = ?"
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
  // BUNDLE_FORMAT_VERSION is folded into the key so a version bump
  // (e.g. when a builder bug is fixed) invalidates the edge cache for
  // every site without a manual purge — same SHA, new version → cold
  // cache → rebuild path runs.
  const cache = caches.default;
  const cacheKey = new Request(
    `https://internal-site-export/v${BUNDLE_FORMAT_VERSION}/${encodeURIComponent(siteId)}/${currentSha || "0"}`
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
    // loadOrBuildSiteBundle reads the persisted `_exports/<siteId>.json`
    // from R2 when its shortSha matches D1's current SHA, otherwise
    // rebuilds from per-file LIST + GET and persists for next time.
    // Same code path as /api/users/download.js, so per-site bundles
    // warm each other's caches.
    const { json, source, complete } = await loadOrBuildSiteBundle(env, siteConfig);
    console.log(`download: served ${siteId} from ${source}`);

    const response = new Response(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Browser shouldn't cache (auth-bound); the edge cache stores
        // its own copy via cache.put below using the SHA-keyed Request.
        "Cache-Control": "private, max-age=0",
      },
    });

    // Only seed the edge cache when the bundle is complete. A partial
    // build (any R2.get failures) cached here would be served for the
    // 24 h TTL — same sticky-failure mode the R2 persist path now
    // skips. Forces the next call to rebuild and self-heal.
    if (currentSha && complete !== false) {
      // Cache for the edge under the SHA-keyed URL. New publishes
      // advance the SHA → new key → cold cache → rebuild path runs.
      // Keep TTL short on the headers but rely on the cache-key
      // change for invalidation.
      const cacheable = new Response(json, {
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
