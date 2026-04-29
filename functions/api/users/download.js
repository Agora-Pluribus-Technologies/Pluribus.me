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
// No aggregate edge cache: the assembled user bundle is rebuilt on every
// request from the per-site bundles. The per-site cache is the
// load-bearing optimization — assembling is just a few R2 GETs +
// concatenation, dwarfed by the network transfer of the response itself
// — and dropping the aggregate layer removes a second cache-invalidation
// surface (no need to fold every site's sha into a synthetic cache key).
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

    return new Response(JSON.stringify(exportData), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Auth-bound — don't let the browser (or any intermediary) cache
        // the assembled bundle. Per-site bundles in `_exports/` are the
        // only caching layer; they live in R2 and are gated behind this
        // worker's auth check on every request.
        "Cache-Control": "private, max-age=0",
      },
    });
  } catch (error) {
    console.error("Error exporting user data:", error);
    return new Response("Failed to export data: " + error.message, { status: 500 });
  }
}
