// Detects upstream commits that occurred while the editor is open and either
// rejects local edits (same author, e.g. another tab/device) or runs a
// three-way merge (different author). Pending merge conflicts block deploys.

let lastSeenShortSha = null;
let lastSeenAuthor = null;
let lastSeenBaseCommitOid = null;
let conflictPollInterval = null;
let hasUnresolvedConflicts = false;
let conflictedFiles = new Set();
let conflictResolutionInFlight = false;

const CONFLICT_POLL_INTERVAL_MS = 30000;
const CONFLICT_MARKER_REGEX = /^<{7} |^={7}\s*$|^>{7} /m;

function lastSeenStorageKey(siteId) {
  return `agorapages.lastSeenUpstream.${siteId}`;
}

function loadPersistedLastSeen(siteId) {
  try {
    const raw = localStorage.getItem(lastSeenStorageKey(siteId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.shortSha === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function persistLastSeen(siteId, shortSha, author) {
  try {
    if (!shortSha) {
      localStorage.removeItem(lastSeenStorageKey(siteId));
      return;
    }
    localStorage.setItem(
      lastSeenStorageKey(siteId),
      JSON.stringify({ shortSha, author: author || null })
    );
  } catch {}
}

function clearPersistedLastSeen(siteId) {
  try {
    localStorage.removeItem(lastSeenStorageKey(siteId));
  } catch {}
}

async function fetchUpstreamHead(siteId) {
  try {
    const resp = await fetch(`/s/${siteId}/history.json`, {
      method: "GET",
      headers: { "Cache-Control": "no-cache, must-revalidate" },
    });
    if (!resp.ok) return null;
    const history = await resp.json();
    if (!Array.isArray(history) || history.length === 0) return null;
    return { shortSha: history[0].shortSha, author: history[0].author };
  } catch (e) {
    return null;
  }
}

async function recordLocalBaseCommit(siteId) {
  try {
    const dir = getRepoDir(siteId);
    lastSeenBaseCommitOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    lastSeenBaseCommitOid = null;
  }
}

async function initConflictPolling(siteId) {
  stopConflictPolling();
  hasUnresolvedConflicts = false;
  conflictedFiles.clear();
  hideConflictBanner();

  // Prefer the persisted base from a prior session — that's the commit the
  // current pending changes were based on. Falling back to the upstream head
  // is only correct for a fresh session with no pending edits.
  const persisted = loadPersistedLastSeen(siteId);
  if (persisted) {
    lastSeenShortSha = persisted.shortSha;
    lastSeenAuthor = persisted.author;
  } else {
    const head = await fetchUpstreamHead(siteId);
    if (head) {
      lastSeenShortSha = head.shortSha;
      lastSeenAuthor = head.author;
      persistLastSeen(siteId, head.shortSha, head.author);
    } else {
      lastSeenShortSha = null;
      lastSeenAuthor = null;
    }
  }

  await recordLocalBaseCommit(siteId);

  conflictPollInterval = setInterval(() => {
    pollHistoryForConflicts(siteId).catch(err => console.error("Conflict poll failed:", err));
  }, CONFLICT_POLL_INTERVAL_MS);
}

function stopConflictPolling() {
  if (conflictPollInterval) {
    clearInterval(conflictPollInterval);
    conflictPollInterval = null;
  }
}

async function pollHistoryForConflicts(siteId) {
  if (siteId !== currentSiteId) return;
  if (conflictResolutionInFlight) return;
  
  console.log("current shortSha:", lastSeenShortSha, "author:", lastSeenAuthor);
  const head = await fetchUpstreamHead(siteId);
  console.log("Latest shortSha:", head ? head.shortSha : null, "author:", head ? head.author : null);
  if (!head || !lastSeenShortSha) return;
  if (head.shortSha === lastSeenShortSha) return;

  console.log(`Upstream commit changed: ${lastSeenShortSha} -> ${head.shortSha} (author: ${head.author})`);

  conflictResolutionInFlight = true;
  try {
    const me = (getStoredUsername() || "").toLowerCase();
    const upstreamAuthor = (head.author || "").toLowerCase();

    if (upstreamAuthor === me) {
      await handleSameAuthorDivergence(siteId);
    } else {
      await handleDifferentAuthorDivergence(siteId, head);
    }
  } finally {
    conflictResolutionInFlight = false;
  }
}

async function handleSameAuthorDivergence(siteId) {
  console.log("Same-author divergence: discarding pending changes and reloading");

  markdownCache = [];
  imageCache = [];
  documentCache = [];
  currentSitePath = null;
  modified = false;

  clearAutoSave(siteId);
  clearPersistedLastSeen(siteId);
  stopConflictPolling();

  const site = { siteId, displayName: siteId.split("/")[1] || siteId };
  await openSiteInEditor(site);

  showAlertBar("Site was updated from another session. Pending changes discarded and latest version loaded.", true);
}

async function handleDifferentAuthorDivergence(siteId, upstream) {
  console.log("Different-author divergence: attempting three-way merge");
  try {
    const result = await performThreeWayMerge(siteId);

    lastSeenShortSha = upstream.shortSha;
    lastSeenAuthor = upstream.author;
    persistLastSeen(siteId, upstream.shortSha, upstream.author);
    await recordLocalBaseCommit(siteId);

    if (result.conflicts.length > 0) {
      hasUnresolvedConflicts = true;
      conflictedFiles = new Set(result.conflicts);
      showConflictBanner(result.conflicts);
      updateDeployButtonState();
      showAlertBar(
        `Merge produced conflicts in ${result.conflicts.length} file(s). Resolve before deploying.`,
        false
      );
    } else {
      hasUnresolvedConflicts = false;
      conflictedFiles.clear();
      hideConflictBanner();
      updateDeployButtonState();
      showAlertBar("Upstream changes merged into your edits.", true);
    }
  } catch (e) {
    console.error("Three-way merge failed:", e);
    showAlertBar("Failed to merge upstream changes: " + (e.message || e), false);
  }
}

async function performThreeWayMerge(siteId) {
  const dir = getRepoDir(siteId);

  // Refresh the local .git directory from upstream's .git-history.json so the
  // merge sees the latest commit objects, refs, and ancestry. The merge base
  // (lastSeenBaseCommitOid) is preserved as an ancestor in the refreshed store.
  try {
    const gitData = await loadGitHistoryFromR2(siteId);
    if (gitData && Object.keys(gitData).length > 0) {
      await deserializeGitDirectory(siteId, gitData);
      console.log("Reloaded .git from upstream .git-history.json before merge");
    }
  } catch (e) {
    console.error("Failed to reload .git from upstream, proceeding with local state:", e);
  }

  const baseOid = lastSeenBaseCommitOid || (await git.resolveRef({ fs, dir, ref: "HEAD" }));
  const username = getStoredUsername() || "user";
  const authorObj = { name: username, email: `${username}@noreply.agorapages.com` };

  for (const branch of ["agora-merge-local", "agora-merge-upstream"]) {
    try { await git.deleteBranch({ fs, dir, ref: branch }); } catch {}
  }

  // Local branch: snapshot of current cache state on top of base
  await git.branch({ fs, dir, ref: "agora-merge-local", object: baseOid, force: true });
  await git.checkout({ fs, dir, ref: "agora-merge-local", force: true });
  await syncCacheToGit(siteId, markdownCache, imageCache);
  await stageAllChanges(siteId);
  try {
    await git.commit({ fs, dir, message: "Local pending edits", author: authorObj });
  } catch (e) {
    // No local changes to commit; continue
  }

  // Upstream branch: snapshot of upstream content on top of base
  await git.branch({ fs, dir, ref: "agora-merge-upstream", object: baseOid, force: true });
  await git.checkout({ fs, dir, ref: "agora-merge-upstream", force: true });
  await replaceWorkingTreeWithUpstream(siteId);
  await stageAllChanges(siteId);
  try {
    await git.commit({
      fs, dir,
      message: "Upstream snapshot",
      author: { name: "upstream", email: "upstream@noreply.agorapages.com" },
    });
  } catch (e) {
    // No upstream-only changes to commit; continue
  }

  // Merge upstream into local
  await git.checkout({ fs, dir, ref: "agora-merge-local", force: true });

  const conflicts = [];
  try {
    await git.merge({
      fs, dir,
      ours: "agora-merge-local",
      theirs: "agora-merge-upstream",
      author: authorObj,
      abortOnConflict: false,
    });
  } catch (err) {
    const filepaths = (err && err.data && err.data.filepaths) || [];
    if (filepaths.length > 0 || (err.code || "").includes("Merge")) {
      conflicts.push(...filepaths);
    } else {
      throw err;
    }
  }

  await reloadCacheFromWorkingTree(siteId, conflicts);

  return { conflicts: [...new Set(conflicts)] };
}

async function stageAllChanges(siteId) {
  const dir = getRepoDir(siteId);
  const matrix = await git.statusMatrix({ fs, dir });
  for (const row of matrix) {
    const [filepath, head, workdir] = row;
    if (workdir === 0 && head !== 0) {
      try { await git.remove({ fs, dir, filepath }); } catch {}
    } else if (head !== workdir) {
      try { await git.add({ fs, dir, filepath }); } catch {}
    }
  }
}

async function replaceWorkingTreeWithUpstream(siteId) {
  const dir = getRepoDir(siteId);

  const pagesResp = await fetch(`/s/${siteId}/pages.json`, {
    headers: { "Cache-Control": "no-cache, must-revalidate" },
  });
  if (!pagesResp.ok) throw new Error("Failed to fetch upstream pages.json");
  const pages = await pagesResp.json();
  const upstreamMd = new Set(pages.map(p => `public/${p.fileName}.md`));

  // Remove md files no longer in upstream
  const matrix = await git.statusMatrix({ fs, dir });
  for (const [filepath] of matrix) {
    if (filepath.startsWith("public/") && filepath.endsWith(".md") && !upstreamMd.has(filepath)) {
      try { await pfs.unlink(`${dir}/${filepath}`); } catch {}
    }
  }

  // Write upstream md content
  for (const file of upstreamMd) {
    const servingPath = file.replace(/^public\//, "");
    const resp = await fetch(`/s/${siteId}/${servingPath}`, {
      headers: { "Cache-Control": "no-cache, must-revalidate" },
    });
    if (!resp.ok) continue;
    const content = await resp.text();
    await gitWriteFile(siteId, file, content);
  }
}

async function reloadCacheFromWorkingTree(siteId, conflictsOut) {
  const dir = getRepoDir(siteId);
  const matrix = await git.statusMatrix({ fs, dir });

  const newCache = [];
  for (const [filepath] of matrix) {
    if (!filepath.startsWith("public/") || !filepath.endsWith(".md")) continue;
    let content;
    try {
      content = await gitReadFile(siteId, filepath);
    } catch {
      continue;
    }
    if (content == null) continue;
    if (CONFLICT_MARKER_REGEX.test(content)) conflictsOut.push(filepath);

    const existing = markdownCache.find(c => c.fileName === filepath);
    newCache.push({
      fileName: filepath,
      displayName: existing
        ? existing.displayName
        : filepath.replace(/^public\//, "").replace(/\.md$/, ""),
      content,
      sortOrder: existing ? existing.sortOrder : undefined,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    });
  }

  markdownCache = newCache;
  modified = true;

  await populateSidebar(siteId);
  if (currentSitePath && markdownCache.find(c => c.fileName === currentSitePath)) {
    selectSidebarPage(currentSitePath);
  } else if (markdownCache.length > 0) {
    selectSidebarPage(markdownCache[0].fileName);
  }
}

function showConflictBanner(files) {
  let banner = document.getElementById("conflictBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "conflictBanner";
    banner.className = "conflict-banner";
    document.body.appendChild(banner);
  }
  const list = files
    .map(f => `<code>${f.replace(/^public\//, "").replace(/\.md$/, "")}</code>`)
    .join(", ");
  banner.innerHTML =
    `<strong>Merge conflicts detected</strong> in: ${list}. ` +
    `Resolve the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>=======</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers in the affected pages before publishing.`;
  banner.style.display = "block";
}

function hideConflictBanner() {
  const banner = document.getElementById("conflictBanner");
  if (banner) banner.style.display = "none";
}

function rescanForConflictMarkers() {
  const stillConflicted = new Set();
  for (const item of markdownCache) {
    if (CONFLICT_MARKER_REGEX.test(item.content || "")) {
      stillConflicted.add(item.fileName);
    }
  }
  conflictedFiles = stillConflicted;
  hasUnresolvedConflicts = stillConflicted.size > 0;
  if (hasUnresolvedConflicts) {
    showConflictBanner([...stillConflicted]);
  } else {
    hideConflictBanner();
  }
}

// Run before the publish flow opens the commit modal. If upstream has moved
// or there are unresolved conflicts, run the merge resolution flow and tell
// the caller to suppress the modal. Returns:
//   { canProceed: true } - safe to open the commit modal
//   { canProceed: false, reason: "conflicts" | "upstream-changed" | "merge-conflicts" }
async function checkUpstreamBeforeDeploy(siteId) {
  // Existing unresolved conflicts always block.
  if (hasUnresolvedConflicts) {
    showAlertBar(
      "Cannot publish — resolve the merge conflicts in your pending pages first.",
      false
    );
    if (conflictedFiles.size > 0) showConflictBanner([...conflictedFiles]);
    return { canProceed: false, reason: "conflicts" };
  }

  const head = await fetchUpstreamHead(siteId);
  if (!head || !lastSeenShortSha || head.shortSha === lastSeenShortSha) {
    return { canProceed: true };
  }

  // Upstream has advanced since the local edits' base commit. Run the same
  // resolution path as the background poll instead of opening the modal.
  if (conflictResolutionInFlight) {
    showAlertBar("Upstream changes are being merged — please wait.", false);
    return { canProceed: false, reason: "upstream-changed" };
  }

  conflictResolutionInFlight = true;
  try {
    const me = (getStoredUsername() || "").toLowerCase();
    const upstreamAuthor = (head.author || "").toLowerCase();

    if (upstreamAuthor === me) {
      await handleSameAuthorDivergence(siteId);
      return { canProceed: false, reason: "upstream-changed" };
    }

    await handleDifferentAuthorDivergence(siteId, head);
    return {
      canProceed: false,
      reason: hasUnresolvedConflicts ? "merge-conflicts" : "upstream-changed",
    };
  } finally {
    conflictResolutionInFlight = false;
  }
}

// Called after a successful self-publish so the next poll doesn't treat our
// own commit as upstream divergence.
async function recordSelfDeploy(siteId) {
  await recordLocalBaseCommit(siteId);
  const head = await fetchUpstreamHead(siteId);
  if (head) {
    lastSeenShortSha = head.shortSha;
    lastSeenAuthor = head.author;
    persistLastSeen(siteId, head.shortSha, head.author);
  }
}
