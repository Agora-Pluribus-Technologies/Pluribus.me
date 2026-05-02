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

const CONFLICT_POLL_INTERVAL_MS = 10000;
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
    // Fetch the prefixed URL so this request shares an edge-cache key with
    // the purge in functions/api/files.js (which targets
    // `/s/{siteId}/public/history.json`). The unprefixed form gets cached
    // under a separate key that publish never evicts, so polling it would
    // return a stale HEAD immediately after a self-publish.
    const resp = await fetch(`/s/${siteId}/public/history.json`, {
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

// Cheap "did upstream advance?" check that hits D1 (Sites.lastCommitShortSha)
// instead of the R2-served history.json. Polled every 30 s on every open
// editor session, so the savings vs. history.json (a full R2 GET + parse)
// add up. Returns the SHA string or null when no commit has been recorded
// yet for this site.
async function fetchUpstreamShortSha(siteId) {
  try {
    const resp = await fetch(
      `/api/sites/last-commit?siteId=${encodeURIComponent(siteId)}`,
      {
        method: "GET",
        headers: { "Cache-Control": "no-cache, must-revalidate" },
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data && typeof data.lastCommitShortSha === "string")
      ? data.lastCommitShortSha
      : null;
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

  // Cheap D1 lookup of Sites.lastCommitShortSha — replaces the prior
  // history.json poll. Only when this changes do we go to history.json
  // for the author info needed to route same-author vs different-author
  // divergence handling.
  const upstreamShortSha = await fetchUpstreamShortSha(siteId);
  if (!upstreamShortSha) return;
  if (!lastSeenShortSha) return;
  if (upstreamShortSha === lastSeenShortSha) return;

  // SHA differs — fetch the full head record (including author) from
  // history.json so we can route to the right divergence handler.
  const head = await fetchUpstreamHead(siteId);
  if (!head) return;

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

  // Route through the same trash-button code path the user gets when
  // they manually discard. The previous implementation reset the in-
  // memory caches and called openSiteInEditor for an in-place reload,
  // which mishandled lazy-loaded markdownCache stubs (and persisted-
  // last-seen state) in ways that left the editor in an inconsistent
  // state. A full window.location.reload tears every bit of that down
  // cleanly and rebuilds from R2/git on next page load.
  clearPersistedLastSeen(siteId);
  stopConflictPolling();
  showAlertBar(
    "Site was updated from another session. Reloading the latest version…",
    true
  );
  // Tiny delay so the alert bar paints before the reload tears down
  // the page; the user sees why they're being bounced.
  setTimeout(() => {
    if (typeof window.discardLocalAndReload === "function") {
      window.discardLocalAndReload(siteId);
    } else {
      // Defensive fallback: if the on-load.js helper hasn't attached
      // yet (it lives inside the DOMContentLoaded callback), do the
      // minimum equivalent so we still don't strand the user with a
      // stale local cache.
      try { clearAutoSave(siteId); } catch {}
      window.location.reload();
    }
  }, 250);
}

async function handleDifferentAuthorDivergence(siteId, upstream) {
  // Fast path: when the local user has nothing pending, there's nothing
  // to merge. Skip the three-way merge entirely and route through the
  // same discard-and-reload code the trash button uses, so the editor
  // bottoms out in a clean R2-rehydrated state. The merge code is
  // expensive and historically fragile (orphan-deletion, missing-index
  // handling, edge cases with parentless commits) — avoiding it
  // whenever possible is the simpler, safer behavior.
  if (typeof modified !== "undefined" && !modified) {
    console.log(
      "Different-author divergence with no local pending changes: " +
      "skipping three-way merge and reloading from upstream"
    );
    clearPersistedLastSeen(siteId);
    stopConflictPolling();
    showAlertBar(
      "Site was updated by another collaborator. Reloading the latest version…",
      true
    );
    setTimeout(() => {
      if (typeof window.discardLocalAndReload === "function") {
        window.discardLocalAndReload(siteId);
      } else {
        try { clearAutoSave(siteId); } catch {}
        window.location.reload();
      }
    }, 250);
    return;
  }

  console.log("Different-author divergence: attempting three-way merge");
  try {
    const result = await performThreeWayMerge(siteId);

    lastSeenShortSha = upstream.shortSha;
    lastSeenAuthor = upstream.author;
    persistLastSeen(siteId, upstream.shortSha, upstream.author);
    await recordLocalBaseCommit(siteId);

    hasUnresolvedConflicts = false;
    conflictedFiles.clear();
    hideConflictBanner();

    if (result.conflictsDiscarded) {
      modified = false;
      clearAutoSave(siteId);
      updateDeployButtonState();
      showAlertBar(
        "Merge conflicts detected — pending local changes were discarded and the upstream version was loaded.",
        false
      );
    } else {
      updateDeployButtonState();
      showAlertBar("Upstream changes merged into your edits.", true);
    }
  } catch (e) {
    // Log the full Error (with stack) rather than just the message so
    // we can pinpoint where minified isomorphic-git frames blow up.
    console.error("Three-way merge failed:", e, e && e.stack);
    // Best-effort cleanup so a half-checked-out merge branch doesn't
    // poison subsequent retries or normal publishes.
    try {
      const dir = getRepoDir(siteId);
      for (const branch of ["agora-merge-local", "agora-merge-upstream"]) {
        try { await git.deleteBranch({ fs, dir, ref: branch }); } catch {}
      }
    } catch {}

    // Offer the user a clean recovery path: discard local edits and
    // reload from upstream. Same code path the trash button and same-
    // author divergence use, so the failure mode bottoms out in a
    // known-good state instead of a stranded mid-merge repo.
    const ok = confirm(
      "Failed to merge upstream changes: " + (e && e.message ? e.message : e) +
      "\n\nDiscard your pending changes and reload to the latest upstream version?"
    );
    if (ok) {
      clearPersistedLastSeen(siteId);
      stopConflictPolling();
      if (typeof window.discardLocalAndReload === "function") {
        window.discardLocalAndReload(siteId);
      } else {
        try { clearAutoSave(siteId); } catch {}
        window.location.reload();
      }
    } else {
      showAlertBar(
        "Merge failed — your pending edits are still local. Resolve the divergence manually or discard to continue.",
        false
      );
    }
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

  // Resolve baseOid up-front and bail out cleanly if HEAD is unresolvable
  // — passing undefined to git.branch later would surface as the
  // confusing "null is not an object (evaluating 'n.length')" error
  // from inside isomorphic-git rather than something actionable.
  let baseOid = lastSeenBaseCommitOid;
  if (!baseOid) {
    try {
      baseOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
    } catch (e) {
      throw new Error(
        "Cannot merge: local repository has no resolvable HEAD. Reload the page and try again."
      );
    }
  }
  if (!baseOid) {
    throw new Error("Cannot merge: missing base commit OID for the local repository.");
  }

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

  let mergeConflicted = false;
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
    const looksLikeMerge = filepaths.length > 0 || (err && (err.code || "").includes("Merge"));
    if (looksLikeMerge) {
      mergeConflicted = true;
    } else {
      throw err;
    }
  }

  // Defensive: even if git.merge succeeded, scan the working tree for any
  // conflict markers it may have written. Treat marker presence as a conflict.
  if (!mergeConflicted) {
    const matrix = await git.statusMatrix({ fs, dir });
    for (const [filepath] of matrix) {
      if (!filepath.startsWith("public/") || !filepath.endsWith(".md")) continue;
      try {
        const content = await gitReadFile(siteId, filepath);
        if (content && CONFLICT_MARKER_REGEX.test(content)) {
          mergeConflicted = true;
          break;
        }
      } catch {}
    }
  }

  // Auto-resolve any conflict by taking upstream and discarding local edits.
  if (mergeConflicted) {
    console.log("Three-way merge produced conflicts — auto-resolving by taking upstream");
    await git.checkout({ fs, dir, ref: "agora-merge-upstream", force: true });
  }

  await reloadCacheFromWorkingTree(siteId, []);

  // Best-effort cleanup of the temporary merge branches so a subsequent
  // merge attempt isn't tripped up by leftover refs from this run.
  for (const branch of ["agora-merge-local", "agora-merge-upstream"]) {
    try { await git.deleteBranch({ fs, dir, ref: branch }); } catch {}
  }

  return { conflictsDiscarded: mergeConflicted };
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

  // Use the `public/`-prefixed URL so this request shares an edge-cache
  // key with the publish-time purge in functions/api/files.js. Stripping
  // the prefix routes through a separate cache entry that publish never
  // evicts, so divergence resolution would pull a stale pages.json.
  const pagesResp = await fetch(`/s/${siteId}/public/pages.json`, {
    headers: { "Cache-Control": "no-cache, must-revalidate" },
  });
  if (!pagesResp.ok) throw new Error("Failed to fetch upstream pages.json");
  const parsed = await pagesResp.json();
  // Defensive: pages.json should always be an array of {fileName,...},
  // but a malformed response would otherwise blow up at .map with a
  // confusing "n.length" / "map is not a function" error during the
  // merge flow. Drop entries missing a fileName so the downstream Set
  // never contains "public/undefined.md".
  const pages = Array.isArray(parsed) ? parsed : [];
  const upstreamMd = new Set(
    pages
      .map(p => p && p.fileName ? `public/${p.fileName}.md` : null)
      .filter(Boolean)
  );

  // Remove md files no longer in upstream
  const matrix = await git.statusMatrix({ fs, dir });
  for (const [filepath] of matrix) {
    if (filepath.startsWith("public/") && filepath.endsWith(".md") && !upstreamMd.has(filepath)) {
      try { await pfs.unlink(`${dir}/${filepath}`); } catch {}
    }
  }

  // Write upstream md content. Same `public/`-prefix rationale as
  // pages.json above — keep these requests aligned with the purge URL
  // shape so a fresh publish doesn't bleed stale page bodies into the
  // working tree.
  for (const file of upstreamMd) {
    const resp = await fetch(`/s/${siteId}/${file}`, {
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
