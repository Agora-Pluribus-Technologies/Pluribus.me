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
//   per-site bundle JSON  =  { formatVersion, site: {...siteConfig, exportedAt}, files: [...] }
//   user bundle JSON      =  { user: {...user, exportedAt}, sites: [{config, files}, ...] }
//   each file entry        =  { path, contentType, content (base64) }
//
// `formatVersion` is bumped whenever the on-disk shape of `files[]`
// changes (paths, layout, encoding) — `loadOrBuildSiteBundle` treats a
// version mismatch as stale and rebuilds. Lets us flip layouts without
// manually purging the persisted bundles in `_exports/`.
//
// History:
//   v2 — markdown + metadata files HOISTED out of `public/` to the ZIP
//        root. (Caused git desync; replaced by v3.)
//   v3 — hybrid: shells at root, markdown stays under `public/` so the
//        bundled `.git/` history lines up with the working tree.
const BUNDLE_FORMAT_VERSION = 3;

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
// request time, plus a `.nojekyll` marker. We bake one shell per .md
// page (plus a root index.html) into the export so the unzipped site
// is deployable as-is on a static host (Netlify, GitHub Pages,
// Cloudflare Pages, etc.) without needing the AgoraPages worker to
// materialize shells. The shell is byte-identical per page so this
// only adds a few hundred bytes per page.
//
// Hybrid layout that solves three constraints simultaneously:
//   1. `index.html` (and per-page `<slug>.html`) at the deploy root,
//      so drag-and-drop deploy on Netlify / GitHub Pages / etc. works.
//   2. Markdown sources + JSON metadata stay under `public/`, matching
//      where they live in R2 AND matching the path entries in the
//      bundled `.git/` history. So `git status` after unzip is clean.
//   3. The SPA shell prefixes its data fetches with `public/` (e.g.
//      `<basePath>/public/about.md`), so on a static deploy where the
//      shell is at root it correctly resolves to the `public/about.md`
//      file in the same archive.
//
// Result:
//   index.html             <- site root, served by the static host
//   <slug>.html            <- per-page shell (loads the sibling .md)
//   _templates/, _assets/  <- shell-loaded static assets, at root
//                              because the shell uses absolute paths
//   .nojekyll              <- tells GitHub Pages to bypass Jekyll
//   public/<slug>.md       <- markdown source (matches git history)
//   public/pages.json      <- metadata (matches git history)
//   .git/                  <- history tracks `public/<file>` paths
//
// `mdPaths` arrives WITH the `public/` prefix (e.g. `public/about.md`).
// We strip it when computing the shell's deploy-root path.
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

  push("index.html");
  for (const mdPath of mdPaths) {
    if (!mdPath.endsWith(".md")) continue;
    // Strip `public/` so the shell lands at the deploy root, even
    // though the markdown it loads stays under `public/`.
    const rooted = mdPath.startsWith("public/")
      ? mdPath.slice("public/".length)
      : mdPath;
    push(rooted.slice(0, -3) + ".html");
  }
  // .nojekyll: empty marker file; GitHub Pages reads this and skips
  // its Jekyll build, which would otherwise filter out our
  // `_templates/` and `_assets/` directories. Other static hosts
  // ignore the file; harmless overhead (zero bytes of content).
  entries.push({
    path: ".nojekyll",
    contentType: "application/octet-stream",
    content: "",
  });
  return entries;
}

// Build the export bundle from R2 by listing the site prefix and
// fetching every (non-skipped) file in parallel. Returns the bundle
// object { site, files: [...] }, plus the JSON-stringified version
// for caching/PUT.
//
// File paths in the bundle preserve the storage layout — `public/<x>`
// stays as `public/<x>` (where the SPA's data-fetch URLs and the git
// history both reference it), and top-level keys like
// `.git-history.json` stay at the root. The hosted-elsewhere
// deployability of the export comes from synthesizeShellEntries
// emitting the `index.html` / `<slug>.html` shells AT the ZIP root,
// while the markdown they load remains nested under `public/`.
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

  // Bake in one .html SPA shell per .md page (plus a root index.html
  // and a `.nojekyll`). The shells go to the ZIP ROOT (no `public/`)
  // even though the matching .md files stay under `public/` — see
  // synthesizeShellEntries for the layout rationale.
  const mdPaths = files.map(f => f.path).filter(p => p.endsWith(".md"));
  const shellEntries = synthesizeShellEntries(mdPaths);

  const exportData = {
    formatVersion: BUNDLE_FORMAT_VERSION,
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
        const bundle = JSON.parse(json);
        // Format-version gate: bundles built before a layout change
        // (e.g. when the export root was hoisted out of `public/`) get
        // ignored and rebuilt instead of returned with the stale shape.
        // Newly-built bundles will then carry the current version.
        if (bundle && bundle.formatVersion === BUNDLE_FORMAT_VERSION) {
          return { bundle, json, source: "r2-bundle" };
        }
        console.log(
          `download: persisted bundle for ${siteId} has formatVersion`,
          bundle && bundle.formatVersion,
          "— current is", BUNDLE_FORMAT_VERSION + ", rebuilding"
        );
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
