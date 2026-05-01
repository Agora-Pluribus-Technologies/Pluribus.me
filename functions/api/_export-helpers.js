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
//   v4 — same on-disk layout as v3; bumped to invalidate bundles built
//        before R2.list pagination + R2.get batching landed. Pre-v4
//        bundles for sites with >1000 R2 keys silently truncated to the
//        first 1000 (see buildExportBundle for the failure mode).
export const BUNDLE_FORMAT_VERSION = 4;

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

// Cap on concurrent outbound R2.get calls per fan-out batch. Workers
// allows ~1000 simple subrequests per request, but the bundle build
// also issues an R2.list and (on the persist path) an R2.put, so leaving
// substantial headroom keeps the build from clipping at the cap with no
// observable error. 200 was chosen empirically: the GET phase becomes
// pipelined-but-bounded and the wall-clock cost is dominated by the
// slowest batch's longest GET, not by the batch count.
const GET_BATCH_SIZE = 200;

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
//
// Returns `{ exportData, json, complete }`. `complete` is `false` when
// any expected R2 object failed to read (caller MUST NOT persist a
// partial bundle to the SHA-keyed cache — see loadOrBuildSiteBundle).
export async function buildExportBundle(env, siteId, siteConfig) {
  const r2Prefix = `${siteId}/`;

  // Paginate R2.list — a single call returns at most 1000 keys. Sites
  // with ~1000+ pages (one R2 key per .md, plus a handful of metadata
  // JSONs and the .git-history blob) silently truncated under the
  // single-call version: the alphabetically-later keys (e.g.
  // `public/projects/...`, `public/resources/...`) just never made it
  // into the bundle. Loop until R2 reports `truncated: false`.
  const includedKeys = [];
  let cursor;
  for (;;) {
    const list = await env.PLURIBUS_BUCKET.list({ prefix: r2Prefix, cursor });
    for (const obj of list.objects) {
      if (isExportedFile(obj.key.replace(r2Prefix, ""))) {
        includedKeys.push(obj.key);
      }
    }
    if (!list.truncated) break;
    cursor = list.cursor;
  }

  // Chunk the parallel R2.get fan-out so the bundle build never sits at
  // the 1000-subrequest cap. On the cap, R2.get rejects, the catch
  // returns null, and a silent drop lands in the bundle — same failure
  // mode as the LIST truncation above, just at a different layer.
  const files = [];
  let getFailures = 0;
  for (let i = 0; i < includedKeys.length; i += GET_BATCH_SIZE) {
    const batch = includedKeys.slice(i, i + GET_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (key) => {
        try {
          const obj = await env.PLURIBUS_BUCKET.get(key);
          if (!obj) return { key, ok: false };
          const arrayBuffer = await obj.arrayBuffer();
          return {
            key,
            ok: true,
            entry: {
              path: key.replace(r2Prefix, ""),
              contentType: obj.httpMetadata?.contentType || "application/octet-stream",
              content: arrayBufferToBase64(arrayBuffer),
            },
          };
        } catch (e) {
          console.error(`Error reading file ${key} for export:`, e);
          return { key, ok: false };
        }
      })
    );
    for (const r of batchResults) {
      if (r.ok) files.push(r.entry);
      else getFailures++;
    }
  }

  if (getFailures > 0) {
    console.warn(
      `download: ${getFailures}/${includedKeys.length} file(s) failed to fetch for ${siteId}; bundle marked incomplete`
    );
  }

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

  return {
    exportData,
    json: JSON.stringify(exportData),
    complete: getFailures === 0,
  };
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

  const { exportData, json, complete } = await buildExportBundle(env, siteId, siteConfig);

  // Only persist when the build is complete. A partial bundle (some
  // R2.get failed) keyed by the current shortSha would be served to
  // every subsequent download until the next publish bumped the SHA —
  // turning a transient fetch failure into a sticky one. Skipping the
  // persist forces the next download to rebuild and self-heal.
  if (currentSha && complete) {
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

  return {
    bundle: exportData,
    json,
    source: complete ? "rebuild" : "rebuild-partial",
    complete,
  };
}
