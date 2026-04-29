import { loadOrBuildSiteBundle } from "../_export-helpers.js";

// GET /api/users/download - Download own user data as JSON (ZIP created client-side)
//
// Aggregates every site this user owns into one bundle. Each per-site
// bundle is loaded via the same loadOrBuildSiteBundle helper that
// /api/sites/download.js uses, so:
//
//   1. Per-site bundles persisted at `_exports/<siteId>.json` are reused
//      verbatim when their shortSha matches the current Sites row. A user
//      whose sites haven't changed since the last download (or whose
//      sites have been individually exported recently) gets ~one R2 GET
//      per site instead of N file-level GETs.
//   2. Cold-built bundles get persisted, so subsequent single-site
//      downloads of the same SHA hit the cached bundle for free.
//
// Edge-caches the assembled aggregate under a synthetic hostname so the
// entry can never leak as a public HTTP response — only this worker
// (which gates auth above) can reach it via cache.match. The cache key
// folds in every site's siteId+shortSha so any publish to any of the
// user's sites invalidates the aggregate without an explicit purge.
export async function onRequestGet(context) {
  const { env } = context;
  const usernameLower = context.data.username;

  const user = await env.USERS_DB.prepare(
    "SELECT username FROM Users WHERE LOWER(username) = LOWER(?)"
  ).bind(usernameLower).first();

  if (!user) {
    return new Response("User not found", { status: 404 });
  }

  // Pull the same fields per site that loadOrBuildSiteBundle expects —
  // siteId / lastCommitShortSha drive the per-site cache freshness.
  const sitesResult = await env.USERS_DB.prepare(
    "SELECT siteId, owner, repo, lastCommitShortSha FROM Sites WHERE LOWER(owner) = LOWER(?)"
  ).bind(usernameLower).all();
  const siteConfigs = sitesResult.results || [];

  // Aggregate edge-cache key. Synthetic hostname keeps the entry off the
  // public surface; the URL folds in every site's id+sha so any publish
  // (which advances some site's sha) yields a fresh key. Sort siteIds so
  // identical inputs always produce the same key — no order-dependence.
  const cache = caches.default;
  const cacheToken = siteConfigs
    .map(s => `${encodeURIComponent(s.siteId)}:${s.lastCommitShortSha || "0"}`)
    .sort()
    .join(",");
  const cacheKey = new Request(
    `https://internal-user-export/${encodeURIComponent(usernameLower)}/${cacheToken}`
  );
  // Skip the edge-cache lookup when the user has no sites with a sha —
  // there's nothing to invalidate against and we'd serve a "0,0,0" key
  // forever otherwise. Cheap path through anyway since there are no
  // bundles to assemble.
  const allShasKnown = siteConfigs.length > 0 && siteConfigs.every(s => s.lastCommitShortSha);
  if (allShasKnown) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      console.log("user-download: edge cache hit for", usernameLower);
      return new Response(cached.body, {
        status: cached.status,
        headers: cached.headers,
      });
    }
  }

  try {
    // Load every site's bundle in parallel. loadOrBuildSiteBundle reads
    // the persisted `_exports/<siteId>.json` from R2 when its shortSha
    // matches D1's current SHA, otherwise rebuilds + persists. Either
    // way returns the parsed `{ site, files }` object.
    const siteBundles = await Promise.all(
      siteConfigs.map(async (siteConfig) => {
        try {
          const { bundle, source } = await loadOrBuildSiteBundle(env, siteConfig);
          console.log(`user-download: site ${siteConfig.siteId} from ${source}`);
          return {
            // Match the legacy aggregate-bundle shape the frontend
            // bulk-download code reads (site.config / site.files —
            // see _assets/on-load.js bulk-download flow).
            config: bundle.site || siteConfig,
            files: bundle.files || [],
          };
        } catch (e) {
          console.error(`user-download: failed to load bundle for ${siteConfig.siteId}:`, e);
          // Return an empty entry so the aggregate still has a slot for
          // this site and the user gets a partial download instead of a
          // 500 — better UX for "one site is corrupt, the others work."
          return { config: siteConfig, files: [] };
        }
      })
    );

    const exportData = {
      user: {
        ...user,
        exportedAt: new Date().toISOString(),
      },
      sites: siteBundles,
    };
    const json = JSON.stringify(exportData);

    const response = new Response(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Browser shouldn't cache (auth-bound); the edge cache stores
        // its own copy via cache.put below using the sha-keyed Request.
        "Cache-Control": "private, max-age=0",
      },
    });

    if (allShasKnown) {
      // Cache for the edge under the per-sha aggregate URL. Any site
      // publish advances some sha → new key → cold cache → rebuild
      // path runs. Keep TTL short on the headers but rely on the
      // cache-key change for invalidation.
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
    console.error("Error exporting user data:", error);
    return new Response("Failed to export data: " + error.message, { status: 500 });
  }
}
