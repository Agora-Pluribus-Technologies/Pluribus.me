// Shared export-bundle plumbing for /api/sites/download.js (single-site
// export) and /api/users/download.js (aggregate user export). Keeping the
// per-site bundle format identical between both endpoints means the user
// download can reuse whatever per-site bundles the single-site endpoint
// has already cached in R2 — and vice versa, so a user-download warms
// the cache for subsequent per-site downloads.
//
// Bundle layout invariants (do not break without coordinated frontend
// changes — see _assets/on-load.js bulk-download flow):
//
//   per-site bundle JSON  =  { site: {...siteConfig, exportedAt}, files: [...] }
//   user bundle JSON      =  { user: {...user, exportedAt}, sites: [{config, files}, ...] }
//   each file entry        =  { path, contentType, content (base64) }

import { SITE_TEMPLATE_HTML } from "../_site-templates.js";

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
export function exportBundleR2Key(siteId) {
  return `_exports/${siteId}.json`;
}

// Files we don't include in the export — they're regenerated from
// sources at publish time (the .html shells). Skipping them halves the
// per-file GET count with no functional loss on re-import.
export function isExportedFile(relativePath) {
  if (!relativePath) return false;
  if (relativePath.endsWith(".html")) return false;
  return true;
}

// Encode a string as a base64 of its UTF-8 bytes. The export protocol
// stores all file contents base64-encoded so the JSON envelope can carry
// arbitrary bytes; HTML shells we synthesize need the same treatment.
export function utf8ToBase64(str) {
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

// Convert an ArrayBuffer to a base64 string in chunks. Avoids the
// "maximum call stack" failure that String.fromCharCode(...bytes) hits
// on multi-MB files.
export function arrayBufferToBase64(buffer) {
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

// Synthesize the .html SPA shells the worker would normally serve at
// request time. We bake one shell per .md page (plus a root index.html)
// into the export so the unzipped site is deployable as-is on a static
// host (Netlify, GitHub Pages, Cloudflare Pages, etc.) without needing
// the AgoraPages worker to materialize shells. The shell is byte-
// identical per page so this only adds a few hundred bytes per page.
//
// Layout in the ZIP mirrors what the worker exposes at request time:
//   public/<slug>.md      <- already in the bundle
//   public/<slug>.html    <- added here, loads the sibling .md
//   public/index.html     <- site root
// The frontend ZIP-builder also drops the matching template .css/.js
// under public/_templates/, so a deploy with `public/` as the publish
// directory works out of the box.
export function synthesizeShellEntries(mdPaths) {
  const shellBase64 = utf8ToBase64(SITE_TEMPLATE_HTML);
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
    push(mdPath.slice(0, -3) + ".html");
  }
  return entries;
}

// Build the export bundle from R2 by listing the site prefix and
// fetching every (non-skipped) file in parallel. Returns the bundle
// object { site, files: [...] }, plus the JSON-stringified version
// for caching/PUT.
export async function buildExportBundle(env, siteId, siteConfig) {
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
  const mdPaths = files.map(f => f.path).filter(p => p.endsWith(".md"));
  const shellEntries = synthesizeShellEntries(mdPaths);

  const exportData = {
    site: {
      ...siteConfig,
      exportedAt: new Date().toISOString(),
    },
    files: [...files, ...shellEntries],
  };

  return { exportData, json: JSON.stringify(exportData) };
}

// Load this site's bundle, preferring the persisted R2 copy when its
// shortSha matches the current SHA from D1. On miss/stale, rebuilds via
// buildExportBundle and persists for next time. Returns the parsed
// `{ site, files }` object plus the source label for logging.
//
// `siteConfig` MUST include `siteId` and `lastCommitShortSha` (both come
// from the Sites D1 row). When `lastCommitShortSha` is null/empty we
// can't safely cache (no freshness key), so we always rebuild and skip
// the persist step — same behavior as a fresh-publish-with-no-SHA-yet.
export async function loadOrBuildSiteBundle(env, siteConfig) {
  const siteId = siteConfig.siteId;
  const currentSha = siteConfig.lastCommitShortSha || null;
  const bundleKey = exportBundleR2Key(siteId);

  if (currentSha) {
    try {
      const persisted = await env.PLURIBUS_BUCKET.get(bundleKey);
      if (persisted && persisted.customMetadata?.shortSha === currentSha) {
        const json = await persisted.text();
        return { bundle: JSON.parse(json), json, source: "r2-bundle" };
      }
    } catch (e) {
      console.warn(`download: failed to read persisted bundle for ${siteId}, will rebuild:`, e);
    }
  }

  const { exportData, json } = await buildExportBundle(env, siteId, siteConfig);

  if (currentSha) {
    try {
      await env.PLURIBUS_BUCKET.put(bundleKey, json, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { shortSha: currentSha },
      });
    } catch (e) {
      // Non-fatal — we still serve this download; next download just
      // rebuilds again.
      console.warn(`download: failed to persist bundle for ${siteId}:`, e);
    }
  }

  return { bundle: exportData, json, source: "rebuild" };
}
