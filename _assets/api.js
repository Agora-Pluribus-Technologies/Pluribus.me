// ==================== Session Authentication ====================

var CURRENT_USERNAME = null;
var DISPLAY_USERNAME_CACHE = null;

async function getCurrentUser() {
  try {
    const response = await fetch("/api/auth/me");
    if (!response.ok) return { authenticated: false };
    return await response.json();
  } catch {
    return { authenticated: false };
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Best-effort
  }
  sessionStorage.clear();
  window.location.reload();
}

// ==================== Helper Functions ====================

// Helper functions for base64 encoding/decoding
function encodeBase64(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

// ==================== R2 Storage API Functions ====================

// Save a single file to R2
async function saveFileToR2(siteId, filePath, content, options = {}) {
  const { contentType, encoding } = options;

  const response = await fetch("/api/files", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteId,
      filePath,
      content,
      contentType,
      encoding,
    }),
  });

  if (!response.ok) {
    console.error("Failed to save file to R2:", await response.text());
    return false;
  }

  return true;
}

// Persist the latest published commit's short SHA to D1 so other open
// editor sessions can detect the divergence on their next conflict
// poll. Best-effort — failure is logged but never blocks the publish
// flow (the worst case is a 30 s slower conflict detection).
async function recordLastCommitShortSha(siteId, shortSha) {
  if (!shortSha) return;
  try {
    const resp = await fetch("/api/sites/last-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, shortSha }),
    });
    if (!resp.ok) {
      console.warn("recordLastCommitShortSha failed:", resp.status, await resp.text());
    }
  } catch (e) {
    console.warn("recordLastCommitShortSha error:", e);
  }
}

// Save multiple files to R2.
//
// Chunks the request into smaller POSTs so a single import (e.g. a
// 7000-page Obsidian vault) doesn't blow past three Cloudflare limits at
// once: the 100 MB Pages-Functions request-body cap, the ~1000
// simple-subrequest budget per Worker invocation (one R2.put each), and
// the per-request CPU-time budget. Each chunk is well under all three.
//
// Chunks run sequentially: parallel POSTs would multiply load on the
// /api/files endpoint without speeding up the underlying R2 writes
// (which are I/O-bound at the Cloudflare edge), and serial keeps the
// failure model simple — first chunk to fail aborts and surfaces the
// error to the caller, instead of mid-upload partials needing reconciliation.
//
// FILES_PER_CHUNK is empirical: 200 files at average ~5 KB ≈ 1 MB body
// per request, ~200 R2.put subrequests per invocation. Both leave wide
// headroom for outliers (large notes, .git-history.json) and keep the
// per-chunk wall time short enough that progress feels responsive.
const FILES_PER_CHUNK = 200;

async function saveFilesToR2(siteId, files) {
  if (!Array.isArray(files) || files.length === 0) return true;

  // Single chunk fast-path: most edits commit a handful of files. Avoids
  // an extra slice() + the chunked-loop bookkeeping.
  if (files.length <= FILES_PER_CHUNK) {
    return await sendFileChunk(siteId, files);
  }

  for (let i = 0; i < files.length; i += FILES_PER_CHUNK) {
    const chunk = files.slice(i, i + FILES_PER_CHUNK);
    const ok = await sendFileChunk(siteId, chunk);
    if (!ok) {
      console.error(
        `saveFilesToR2: chunk ${Math.floor(i / FILES_PER_CHUNK) + 1} of ` +
        `${Math.ceil(files.length / FILES_PER_CHUNK)} failed; aborting upload`
      );
      return false;
    }
  }
  return true;
}

async function sendFileChunk(siteId, files) {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, files }),
  });

  if (!response.ok) {
    console.error("Failed to save files to R2:", await response.text());
    return false;
  }

  const result = await response.json();
  return result.success;
}

// Get a file from R2
async function getFileFromR2(siteId, filePath) {
  const params = new URLSearchParams({
    siteId,
    filePath,
  });

  const response = await fetch(`/api/files?${params.toString()}`, {
    method: "GET",
  });

  if (!response.ok) {
    return null;
  }

  return await response.text();
}

// Delete a single file from R2
async function deleteFileFromR2(siteId, filePath) {
  const params = new URLSearchParams({
    siteId,
    filePath,
  });

  const response = await fetch(`/api/files?${params.toString()}`, {
    method: "DELETE",
  });

  return response.ok;
}

// Delete all files for a site from R2
async function deleteAllFilesFromR2(siteId) {
  const params = new URLSearchParams({
    siteId,
    deleteAll: "true",
  });

  const response = await fetch(`/api/files?${params.toString()}`, {
    method: "DELETE",
  });

  return response.ok;
}

// List all files for a site from R2
async function listSiteFiles(siteId) {
  const params = new URLSearchParams({
    siteId,
    list: "true",
  });

  const response = await fetch(`/api/files?${params.toString()}`, {
    method: "GET",
  });

  if (!response.ok) {
    console.error("Failed to list files:", await response.text());
    return [];
  }

  const data = await response.json();
  return data.files || [];
}

// Upload a file to R2 (for file manager)
async function uploadFileToR2(siteId, filePath, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async function(e) {
      const base64Content = e.target.result.split(',')[1];
      const result = await saveFileToR2(siteId, filePath, base64Content, {
        encoding: "base64",
        contentType: file.type || guessContentType(filePath),
      });
      if (result) {
        resolve(true);
      } else {
        reject(new Error("Failed to upload file"));
      }
    };
    reader.onerror = function() {
      reject(new Error("Failed to read file"));
    };
    reader.readAsDataURL(file);
  });
}

// Upload multiple files to R2 in a single batch (for file manager)
async function uploadFilesToR2(siteId, fileItems) {
  // fileItems is an array of { file: File, filePath: string }

  // Read all files in parallel
  const fileDataPromises = fileItems.map(item => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        const base64Content = e.target.result.split(',')[1];
        resolve({
          filePath: item.filePath,
          content: base64Content,
          encoding: "base64",
          contentType: item.file.type || guessContentType(item.filePath),
        });
      };
      reader.onerror = function() {
        reject(new Error(`Failed to read file: ${item.filePath}`));
      };
      reader.readAsDataURL(item.file);
    });
  });

  try {
    const files = await Promise.all(fileDataPromises);
    return await saveFilesToR2(siteId, files);
  } catch (error) {
    console.error("Error reading files for batch upload:", error);
    return false;
  }
}

const STORAGE_KEY_USERNAME = "agorapages.com.username";

function displayLoginButtons() {
  const buttonContainer = document.createElement("div");
  buttonContainer.style.display = "flex";
  buttonContainer.style.gap = "10px";
  buttonContainer.style.justifyContent = "center";
  buttonContainer.style.flexWrap = "wrap";

  const providers = [
    { name: "Google", icon: "/_assets/Google_G_logo.svg", path: "/api/auth/google/start", style: "" },
    { name: "GitHub", icon: "/_assets/Octicons-mark-github.svg", path: "/api/auth/github/start", style: "filter: invert(1);" },
  ];

  for (const p of providers) {
    const btn = document.createElement("button");
    btn.classList.add("btn");
    btn.innerHTML = `<img src="${p.icon}" alt="" style="width: 18px; height: 18px; margin-right: 8px; ${p.style}"> Sign in with ${p.name}`;
    btn.style.padding = "10px 18px";
    btn.style.cursor = "pointer";
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.addEventListener("click", () => {
      window.location.href = p.path;
    });
    buttonContainer.appendChild(btn);
  }

  const sitesListPanel = document.getElementById("sites-list-panel");
  sitesListPanel.appendChild(buttonContainer);
}

// Check if username is available
async function checkUsernameAvailable(username) {
  const response = await fetch(`/api/users?username=${encodeURIComponent(username)}`);
  if (!response.ok) return false;
  const data = await response.json();
  return !data.exists;
}

// Create a new user with username (provider info comes from server session)
async function createUser(username) {
  const response = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  const user = await response.json();
  setStoredUsername(user.username);
  return user;
}

function getStoredUsername() {
  if (CURRENT_USERNAME) return CURRENT_USERNAME;
  const stored = sessionStorage.getItem(STORAGE_KEY_USERNAME);
  if (stored) {
    CURRENT_USERNAME = stored;
  }
  return stored;
}

function getDisplayUsername() {
  return DISPLAY_USERNAME_CACHE || sessionStorage.getItem('DISPLAY_USERNAME') || getStoredUsername();
}

function setStoredUsername(username) {
  DISPLAY_USERNAME_CACHE = username;
  sessionStorage.setItem('DISPLAY_USERNAME', username);
  const lower = username.toLowerCase();
  CURRENT_USERNAME = lower;
  sessionStorage.setItem(STORAGE_KEY_USERNAME, lower);
}

async function getSites() {
  const response = await fetch("/api/sites", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache",
    },
  });

  if (!response.ok) {
    console.error("Failed to fetch sites:", response.status);
    return [];
  }

  const sites = await response.json();
  console.log("Sites from R2:", sites);
  return sites;
}

// ==================== R2 Site Operations ====================

// Helper function to guess content type from filename
function guessContentType(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeTypes = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

// Build the JSON string written to public/pages.json. Pages sites use a
// flat array of `{ fileName, displayName, ... }` entries.
function buildPagesJsonContent(pages) {
  if (!Array.isArray(pages)) return JSON.stringify(pages || []);
  return JSON.stringify(pages);
}

// Strip common inline markdown so the stored heading text matches what
// the rendered DOM's textContent will end up showing. Critical for
// keeping search-result anchor slugs aligned with the auto-assigned
// heading ids on the published site — otherwise headings containing
// links/emphasis/code render with a different textContent than the raw
// markdown, and the slugs diverge.
function cleanHeadingText(text) {
  if (!text) return "";
  return text
    // image: ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // link: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // wikilink with alias: [[name|alias]] → alias
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    // wikilink: [[name]] → name
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    // emphasis: **bold**, __bold__, *italic*, _italic_
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    // strikethrough
    .replace(/~~(.+?)~~/g, "$1")
    // inline code
    .replace(/`+([^`]+?)`+/g, "$1")
    .trim();
}

// Pull the page title (first H1) and every ATX-style heading (`#` ... `######`)
// out of a markdown body. Used by the Pages-site search index so the published
// sidebar can search by page title and heading text. Returns
// { title, headings: [{l, t}, ...] }. Skips fenced code blocks so headings
// inside ``` fences aren't mistaken for real document headings. Each heading's
// inline markdown is stripped via cleanHeadingText so the stored text matches
// the DOM textContent the renderer will produce — slugs stay in sync.
function extractSearchEntries(markdown) {
  const out = { title: "", headings: [] };
  if (!markdown || typeof markdown !== "string") return out;

  // Strip frontmatter so its `---` and any `# ...` lines inside don't pollute.
  let text = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");

  let inFence = false;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trimStart();
    if (/^```/.test(line) || /^~~~/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const level = m[1].length;
    const txt = cleanHeadingText(m[2].trim());
    if (!txt) continue;
    if (level === 1 && !out.title) out.title = txt;
    out.headings.push({ l: level, t: txt });
  }
  return out;
}

// Parse an existing search-index.json string into the canonical shape.
// Tolerates missing/malformed input by returning an empty index. Used by
// the incremental update path so we don't re-parse pages that were already
// indexed on a previous publish.
function parseSearchIndexJson(text) {
  if (!text || typeof text !== "string") return { pages: {} };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { pages: {} }; }
  const pages = (parsed && parsed.pages && typeof parsed.pages === "object")
    ? parsed.pages
    : {};
  return { pages };
}

// Per-page search index for Pages sites. Schema:
//
//   {
//     "pages": {
//       "research/transformers": {
//         "displayName": "Transformers",
//         "title": "Transformers",
//         "headings": [{"l": 2, "t": "Architecture"}, ...]
//       },
//       ...
//     }
//   }
//
// INCREMENTAL generation: a slug
// already present in `previous.pages` is reused verbatim unless it appears
// in `dirty` (the set of slugs changed in this commit). This keeps publish
// fast even when most pages are lazy-loaded metadata-only stubs in the
// editor's cache. Slugs missing from `cacheItems` are GC'd.
//
// `cacheItems`  array of { fileName, displayName, content }; fileName is
//               the `public/<slug>.md` form used by markdownCache. Items
//               whose `content` is not a string are skipped on the
//               re-parse path (they stay on whatever `previous` had).
// `previous`    optional { pages } from the prior search-index.json
//               (parse it via parseSearchIndexJson). Defaults to empty.
// `dirty`       optional Set of bare slugs (no `public/`, no `.md`) that
//               must be re-parsed even if they were previously indexed.
function buildSearchIndexContent(cacheItems, previous, dirty) {
  const prev = previous || { pages: {} };
  const dirtySet = (dirty instanceof Set) ? dirty : new Set();

  const pages = {};
  for (const [slug, entry] of Object.entries(prev.pages || {})) {
    if (entry && typeof entry === "object") pages[slug] = entry;
  }

  if (!Array.isArray(cacheItems)) {
    return JSON.stringify({ pages });
  }

  const liveSlugs = new Set();
  for (const item of cacheItems) {
    const fn = (item && item.fileName) || "";
    if (!fn) continue;
    const slug = fn.replace(/^public\//, "").replace(/\.md$/, "");
    if (!slug || slug === "latest") continue;
    liveSlugs.add(slug);

    const wasKnown = Object.prototype.hasOwnProperty.call(pages, slug);
    const isDirty = dirtySet.has(slug);

    // Reuse previous classification when the page is unchanged.
    if (wasKnown && !isDirty) {
      // Keep displayName fresh in case the page was just renamed in
      // metadata (the body wouldn't change but the sidebar label might).
      if (item.displayName) pages[slug].displayName = item.displayName;
      continue;
    }

    // Body unavailable (lazy-load stub) and nothing in `previous` to fall
    // back on — skip; next publish that actually edits this page will fill
    // it in. Don't index a placeholder.
    if (typeof item.content !== "string") {
      if (wasKnown) {
        // Stale entry might be wrong but we can't re-parse — leave as-is
        // rather than dropping a real entry.
        if (item.displayName) pages[slug].displayName = item.displayName;
      }
      continue;
    }

    const extracted = extractSearchEntries(item.content);
    pages[slug] = {
      displayName: item.displayName || slug,
      title: extracted.title,
      headings: extracted.headings,
    };
  }

  // GC: drop slugs that no longer exist in cacheItems.
  for (const slug of Object.keys(pages)) {
    if (!liveSlugs.has(slug)) delete pages[slug];
  }

  return JSON.stringify({ pages });
}

// Combined initial commit with git history - single R2 call
async function initialCommitWithGitHistory(siteId, siteSettings = {}) {
  const { siteName, repo, owner, importedPages } = siteSettings;
  // images.json is the editor's per-site image manifest. New sites start
  // empty — folder import no longer produces image attachments (CSAM
  // policy: AgoraPages does not host user-uploaded image bytes).
  const imagesManifest = "[]";

  const siteJson = {
    siteName: siteName || repo || "Untitled Site",
    repo: repo || siteId.split("/")[1] || "",
    owner: owner || siteId.split("/")[0] || "",
    createdAt: new Date().toISOString(),
    showHistory: true,
  };

  // Imported-folder flow: caller passes already-parsed pages from a vault.
  // Skip the default Home page and seed pages.json from the import instead.
  const hasImport = Array.isArray(importedPages) && importedPages.length > 0;

  const defaultHomeContent = "# Welcome to your Agora Site!\n\nThis is your homepage. Click the **Edit** button on this panel to change its content.\n\nUse the **+** buttons above or below this panel to add more panels, images, links, and embeds.\n\nTo add more pages, click the **+** button in the page menu bar above.";
  const now = new Date().toISOString();

  // Imports without their own home/index page get one prepended so the
  // published-site router has a top-level entry to serve at "/". Imports
  // that DO carry one already had it surfaced to position 0 by the importer.
  let pagesToWrite = importedPages;
  if (hasImport) {
    const hasHome = importedPages.some(
      p => p.fileName === "home" || p.fileName === "index"
    );
    if (!hasHome) {
      pagesToWrite = [
        {
          displayName: "Home",
          fileName: "home",
          content: defaultHomeContent,
          createdAt: now,
          modifiedAt: now,
        },
        ...importedPages,
      ];
    }
  }

  let pagesJson;
  if (hasImport) {
    pagesJson = pagesToWrite.map(p => ({
      displayName: p.displayName,
      fileName: p.fileName,
      createdAt: p.createdAt || now,
      modifiedAt: p.modifiedAt || now,
    }));
  } else {
    pagesJson = [{
      displayName: "Home",
      fileName: "home",
      createdAt: now,
      modifiedAt: now,
    }];
  }

  // Initialize git repository and create initial commit with content
  await gitInit(siteId);
  const pagesJsonContent = buildPagesJsonContent(pagesJson);
  // Seed search-index.json (per-page title + headings) so the first
  // publish has a usable sidebar search.
  const searchIndexContent = buildSearchIndexContent(
    (Array.isArray(pagesToWrite) ? pagesToWrite : []).map(p => ({
      fileName: `public/${p.fileName}.md`,
      displayName: p.displayName,
      content: p.content,
    }))
  );
  // Build the initial commit directly from in-memory blobs — skipping
  // the working-tree round-trip + per-file git.add. For large imports
  // this is the dominant savings: see gitInitialCommitFromBlobs for the
  // breakdown. The index is left empty by this path; syncCacheToGit
  // rebuilds it from HEAD on the first publish.
  const filesForCommit = [
    { path: "public/pages.json", content: pagesJsonContent },
    { path: "public/images.json", content: imagesManifest },
  ];
  if (searchIndexContent != null) {
    filesForCommit.push({ path: "public/search-index.json", content: searchIndexContent });
  }
  if (hasImport) {
    for (const page of pagesToWrite) {
      filesForCommit.push({ path: `public/${page.fileName}.md`, content: page.content });
    }
  } else {
    filesForCommit.push({ path: "public/home.md", content: defaultHomeContent });
  }
  const commitAuthor = {
    name: owner || "user",
    email: `${owner || "user"}@noreply.agorapages.com`,
  };
  await gitInitialCommitFromBlobs(siteId, filesForCommit, {
    author: commitAuthor,
    message: hasImport ? "Initial import" : "Initial commit",
  });
  console.log("Git repo initialized for site:", siteId);

  // Serialize git history
  const gitData = await serializeGitDirectory(siteId);
  if (!gitData) {
    console.error("Failed to serialize git directory");
    return false;
  }
  const gitHistoryJson = JSON.stringify(gitData);

  // SPA shells (.html for every page + index.html) are no longer
  // written to R2 — the worker (functions/s/[username]/[site]/[[path]].js)
  // serves an inlined template constant for any .html request. Keeping
  // this comment so future readers don't wonder where the templateHtml
  // upload step went.

  // Build initial history.json
  const historyJson = [{
    shortSha: "initial",
    date: new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString(),
    message: hasImport ? "Initial import" : "Initial commit",
    author: owner || "Unknown",
    changes: hasImport
      ? pagesToWrite.map(p => ({ file: `public/${p.fileName}.md`, status: "added" }))
      : [],
  }];

  // Combine all files into a single batch — full deploy so site is immediately live
  const files = [
    {
      filePath: "public/pages.json",
      content: pagesJsonContent,
      contentType: "application/json",
    },
    {
      filePath: "public/images.json",
      content: imagesManifest,
      contentType: "application/json",
    },
    {
      filePath: "public/site.json",
      content: JSON.stringify(siteJson, null, 2),
      contentType: "application/json",
    },
    {
      filePath: "public/history.json",
      content: JSON.stringify(historyJson),
      contentType: "application/json",
    },
    {
      filePath: ".git-history.json",
      content: gitHistoryJson,
      contentType: "application/json",
    },
  ];

  if (searchIndexContent != null) {
    files.push({
      filePath: "public/search-index.json",
      content: searchIndexContent,
      contentType: "application/json",
    });
  }

  // .html shells are now served by the worker from inlined templates;
  // we only write .md sources + JSON metadata to R2.
  if (hasImport) {
    for (const page of pagesToWrite) {
      files.push({
        filePath: `public/${page.fileName}.md`,
        content: page.content,
        contentType: "text/markdown",
      });
    }
  } else {
    files.push({
      filePath: "public/home.md",
      content: defaultHomeContent,
      contentType: "text/markdown",
    });
  }

  // Build wikilinks.json (backlink index). At deploy-time this is
  // regenerated from markdownCache, but on initial import the editor
  // hasn't loaded the cache yet, so seed it from the pages we're about
  // to write. Without this the imported site's "Links to this page"
  // sections stay empty until the user re-publishes.
  if (hasImport && typeof AgoraWikilinks !== "undefined") {
    try {
      const indexablePages = pagesToWrite.map(p => ({
        fileName: p.fileName,
        displayName: p.displayName || p.fileName,
      }));
      const contentByFileName = new Map(
        pagesToWrite.map(p => [p.fileName, p.content])
      );
      const backlinks = AgoraWikilinks.buildBacklinkIndex(
        indexablePages,
        (fileName) => contentByFileName.get(fileName),
        null
      );
      files.push({
        filePath: "public/wikilinks.json",
        content: JSON.stringify(backlinks),
        contentType: "application/json",
      });
    } catch (e) {
      console.error("Failed to build initial wikilinks.json:", e);
    }
  }

  const result = await saveFilesToR2(siteId, files);
  if (result) {
    console.log("Initial commit with full deploy completed successfully");
    // Mirror the initial-commit marker into D1 so a freshly created
    // site has a non-null lastCommitShortSha — matches the literal
    // "initial" sha that history.json carries for the seed commit.
    await recordLastCommitShortSha(siteId, "initial");
  }
  return result;
}

async function getFileContent(siteId, filePath) {
  return await getFileFromR2(siteId, filePath);
}

async function getPublicFiles(siteId) {
  const pagesJson = await getFileFromR2(siteId, "public/pages.json");

  if (!pagesJson) {
    return [];
  }

  try {
    const pages = JSON.parse(pagesJson);
    if (!Array.isArray(pages)) return [];
    return pages.map(page => `public/${page.fileName}.md`);
  } catch {
    return [];
  }
}

async function generateHistoryJson(siteId) {
  try {
    const commits = await gitLog(siteId, 50);
    const historyItems = [];

    for (const commit of commits) {
      const date = new Date(commit.commit.author.timestamp * 1000);
      const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();

      // Get detailed changes with line-level diffs for this commit
      const detailedChanges = await getDetailedCommitChanges(siteId, commit.oid);

      // Filter to only show markdown files
      const mdChanges = detailedChanges.filter(c => c.file.endsWith(".md"));

      historyItems.push({
        shortSha: commit.oid.substring(0, 7),
        date: dateStr,
        message: commit.commit.message.split('\n')[0],
        author: commit.commit.author.name,
        changes: mdChanges
      });
    }

    return historyItems;
  } catch (error) {
    console.error("Error generating history JSON:", error);
    return [];
  }
}

async function deployChanges(siteId) {
  modified = false;
  updateDeployButtonState();

  // SPA shells (.html) are served by the worker from inlined templates;
  // the publish flow no longer fetches or writes them.

  const files = [];

  // Determine which markdown files actually changed in the latest commit
  const changedMd = new Set();
  const deletedMd = new Set();
  let latestCommitOid = null;
  try {
    const recent = await gitLog(siteId, 1);
    if (recent.length > 0) {
      latestCommitOid = recent[0].oid;
      const commitChanges = await getCommitChanges(siteId, recent[0].oid);
      for (const change of commitChanges) {
        if (!change.filepath.startsWith("public/") || !change.filepath.endsWith(".md")) continue;
        if (change.status === "deleted") {
          deletedMd.add(change.filepath);
        } else {
          changedMd.add(change.filepath);
        }
      }
    }
  } catch (error) {
    console.error("Error determining changed markdown files, falling back to full deploy:", error);
    // Fall back: treat every cache file as changed
    for (const cacheItem of markdownCache) changedMd.add(cacheItem.fileName);
  }

  // Lazy-load post bodies that the user hasn't opened yet but that could
  // affect wikilinks.json. Pages with no wikilinks last publish and no
  // edits this publish stay metadata-only. (The per-file write loop below
  // only writes pages in changedMd, which are loaded by this call too,
  // so the write step also has what it needs.)
  if (typeof ensurePagesWithWikilinksLoaded === "function") {
    await ensurePagesWithWikilinksLoaded(siteId, changedMd);
  }

  // Handle deletions: markdown files removed in this commit. Also
  // queue a delete for the legacy .html shell at the same slug — for
  // sites that were published before .html shells stopped being
  // written, the old shell is still in R2 and should go away with
  // the source.
  for (const deletedFile of deletedMd) {
    console.log("Preparing to delete file:", deletedFile);
    files.push({ filePath: deletedFile.replace(".md", ".html"), action: "delete" });
    files.push({ filePath: deletedFile, action: "delete" });
  }

  // Handle creates and updates: only files that actually changed.
  // .html shells are no longer written — the worker serves the
  // inlined template for any .html request. We also queue a delete
  // for any matching legacy .html that may still be in R2 from a
  // prior publish (idempotent: deleting a non-existent R2 key is
  // a no-op). This drains pre-migration shells gradually as pages
  // are touched, without a separate sweep.
  for (const cacheItem of markdownCache) {
    if (!changedMd.has(cacheItem.fileName)) continue;
    console.log("Preparing to update file:", cacheItem.fileName);
    files.push({
      filePath: cacheItem.fileName,
      content: cacheItem.content,
      contentType: "text/markdown",
    });
    files.push({
      filePath: cacheItem.fileName.replace(/\.md$/, ".html"),
      action: "delete",
    });
  }

  // Update pages.json (flat array of `{ fileName, displayName, ... }`).
  const pages = markdownCache.map(item => {
    const fileName = item.fileName.replace("public/", "").replace(".md", "");
    const entry = {
      displayName: item.displayName,
      fileName: fileName,
      createdAt: item.createdAt || new Date().toISOString(),
      modifiedAt: item.modifiedAt || new Date().toISOString(),
    };
    if (item.sortOrder != null) entry.sortOrder = item.sortOrder;
    return entry;
  });
  files.push({
    filePath: "public/pages.json",
    content: buildPagesJsonContent(pages),
    contentType: "application/json",
  });

  // Update images.json
  files.push({
    filePath: "public/images.json",
    content: JSON.stringify(imageCache),
    contentType: "application/json",
  });

  // Update folders.json (folder display names + sort orders)
  const safeFolderMeta = (typeof folderMeta === "object" && folderMeta) ? folderMeta : {};
  files.push({
    filePath: "public/folders.json",
    content: JSON.stringify(safeFolderMeta),
    contentType: "application/json",
  });

  // Generate history.json from git log
  const historyJson = await generateHistoryJson(siteId);
  files.push({
    filePath: "public/history.json",
    content: JSON.stringify(historyJson),
    contentType: "application/json",
  });

  // Slugs of every .md file changed in this commit. Shared by the
  // search-index and wikilinks incremental builders below.
  const dirtySlugs = new Set();
  for (const fp of changedMd) {
    dirtySlugs.add(fp.replace(/^public\//, "").replace(/\.md$/, ""));
  }

  // Republish search-index.json (per-page title + headings). Incremental
  // — slugs already classified in the previous index are reused verbatim
  // and only slugs in `dirtySlugs` (the ones that actually changed in
  // this commit) get re-parsed. Stays consistent with the lazy-load
  // strategy: pages still in metadata-only form keep their previous entry.
  {
    const prevSearchText = await getFileFromR2(siteId, "public/search-index.json");
    const prevSearch = parseSearchIndexJson(prevSearchText);
    files.push({
      filePath: "public/search-index.json",
      content: buildSearchIndexContent(markdownCache, prevSearch, dirtySlugs),
      contentType: "application/json",
    });
  }

  // Generate wikilinks.json (backlink index). Incremental — same strategy
  // as search-index.json above. Sources outside `dirtySlugs` keep whatever
  // entries they contributed last publish, so a metadata-only lazy-load
  // stub for an unchanged page contributes verbatim without needing its
  // body fetched.
  if (typeof AgoraWikilinks !== "undefined") {
    try {
      const indexablePages = markdownCache.map(c => ({
        fileName: c.fileName.replace(/^public\//, "").replace(/\.md$/, ""),
        displayName: c.displayName || c.fileName,
      }));
      const contentByFileName = new Map(
        markdownCache.map(c => [
          c.fileName.replace(/^public\//, "").replace(/\.md$/, ""),
          c.content,
        ])
      );
      const folders = typeof folderMeta !== "undefined" ? folderMeta : null;

      let prevBacklinks = {};
      try {
        const prevWikilinksText = await getFileFromR2(siteId, "public/wikilinks.json");
        if (prevWikilinksText) {
          const parsed = JSON.parse(prevWikilinksText);
          if (parsed && typeof parsed === "object") prevBacklinks = parsed;
        }
      } catch (_) { /* first publish or malformed — start fresh */ }

      const builder = typeof AgoraWikilinks.buildIncrementalBacklinkIndex === "function"
        ? AgoraWikilinks.buildIncrementalBacklinkIndex
        : null;
      const backlinks = builder
        ? builder(
            indexablePages,
            (fileName) => contentByFileName.get(fileName),
            folders,
            prevBacklinks,
            dirtySlugs
          )
        : AgoraWikilinks.buildBacklinkIndex(
            indexablePages,
            (fileName) => contentByFileName.get(fileName),
            folders
          );
      files.push({
        filePath: "public/wikilinks.json",
        content: JSON.stringify(backlinks),
        contentType: "application/json",
      });
    } catch (e) {
      console.error("Failed to build wikilinks.json:", e);
    }
  }

  // Update site.json from git working directory
  try {
    const siteJsonContent = await gitReadFile(siteId, "public/site.json");
    if (siteJsonContent) {
      files.push({
        filePath: "public/site.json",
        content: siteJsonContent,
        contentType: "application/json",
      });
    }
  } catch (error) {
    console.log("No site.json found in git, skipping");
  }

  // Drain any legacy `public/index.html` shell from R2. The worker
  // now serves the SPA shell for index.html requests from an inlined
  // template — the R2 file is dead weight from sites published before
  // the migration. Deleting a non-existent key is a no-op, so this
  // is safe to queue on every publish.
  files.push({ filePath: "public/index.html", action: "delete" });

  if (files.length > 0) {
    const result = await saveFilesToR2(siteId, files);
    if (result) {
      console.log("Deployed changes to R2");
      // Record the new HEAD SHA in D1 so the conflict-resolution poll
      // in other open editor sessions sees the divergence.
      if (latestCommitOid) {
        await recordLastCommitShortSha(siteId, latestCommitOid.substring(0, 7));
      }
    } else {
      modified = true;
      console.error("Failed to deploy changes to R2");
    }
    updateDeployButtonState();
    return result;
  }

  return true;
}

async function createPage(siteId, pageName) {
  // .html shells are served by the worker from inlined templates —
  // no per-page .html PUT needed.
  return await saveFilesToR2(siteId, [
    {
      filePath: `public/${pageName}.md`,
      content: `# ${pageName}\n\nThis is your new page.`,
      contentType: "text/markdown",
    },
  ]);
}

async function deletePage(siteId, pageName) {
  // Queue a delete for the legacy .html shell too — for sites
  // published before .html shells stopped being written, the old
  // shell is still in R2 and should go away with the source.
  return await saveFilesToR2(siteId, [
    { filePath: `public/${pageName}.html`, action: "delete" },
    { filePath: `public/${pageName}.md`, action: "delete" },
  ]);
}

async function renamePage(siteId, pageName, newPageName) {
  const mdContent = await getFileFromR2(siteId, `public/${pageName}.md`);

  if (!mdContent) {
    console.error("Failed to read existing page .md for rename");
    return false;
  }

  // Same legacy-cleanup pattern: also delete the old .html shell if
  // it's there; we don't write a new one because the worker serves it.
  return await saveFilesToR2(siteId, [
    { filePath: `public/${newPageName}.md`, content: mdContent, contentType: "text/markdown" },
    { filePath: `public/${pageName}.html`, action: "delete" },
    { filePath: `public/${pageName}.md`, action: "delete" },
  ]);
}

// ==================== Collaborator API Functions ====================

async function getCollaborators(siteId) {
  const params = new URLSearchParams({ siteId });
  const response = await fetch(`/api/collaborators?${params.toString()}`);

  if (!response.ok) {
    console.error("Failed to fetch collaborators:", response.status);
    return [];
  }

  return await response.json();
}

async function renameSite(siteId, displayName) {
  const response = await fetch("/api/sites", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, displayName }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return await response.json();
}

async function addCollaborator(siteId, username) {
  const response = await fetch("/api/collaborators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, username }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  return await response.json();
}

async function removeCollaborator(siteId, userId) {
  const params = new URLSearchParams({ siteId, userId });

  const response = await fetch(`/api/collaborators?${params.toString()}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  return await response.json();
}

async function checkUserCanEditSite(siteId, username) {
  // Check if user is owner
  const siteOwner = siteId.split("/")[0];
  if (siteOwner.toLowerCase() === username.toLowerCase()) {
    return { canEdit: true, isOwner: true };
  }

  // Check if user is a collaborator
  const collaborators = await getCollaborators(siteId);
  const isCollaborator = collaborators.some(
    c => c.username.toLowerCase() === username.toLowerCase()
  );

  return { canEdit: isCollaborator, isOwner: false };
}


