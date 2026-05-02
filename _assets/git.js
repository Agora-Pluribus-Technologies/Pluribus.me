// Git operations using isomorphic-git with lightning-fs

// Initialize the filesystem
const fs = new LightningFS("pluribus-fs");
const pfs = fs.promises;

// Get the repo directory for a site
function getRepoDir(siteId) {
  return `/${siteId.replace(/\//g, "_")}`;
}

// Initialize a new git repository for a site
async function gitInit(siteId) {
  const dir = getRepoDir(siteId);

  try {
    // Create directory if it doesn't exist
    try {
      await pfs.mkdir(dir, { recursive: true });
    } catch (e) {
      // Directory might already exist
    }

    // Initialize git repo
    await git.init({ fs, dir });

    console.log(`Git repo initialized for site: ${siteId}`);
    return true;
  } catch (error) {
    console.error("Error initializing git repo:", error);
    return false;
  }
}

// Write a file to the git working directory.
//
// `options.skipStage` writes the file to lightning-fs but does NOT call
// git.add — the caller is then expected to stage in bulk via
// gitStagePaths once all writes are done. This is the hot path for
// large imports (initialCommitWithGitHistory, syncCacheToGit): per-file
// git.add reads + rewrites the .git/index on every call, so 1000 writes
// = 1000 index rewrites. Bulk-staging at the end collapses that to a
// single index rewrite and cuts the git phase of an Obsidian-vault
// import roughly in half.
async function gitWriteFile(siteId, filePath, content, options = {}) {
  const dir = getRepoDir(siteId);
  const fullPath = `${dir}/${filePath}`;

  try {
    // Ensure parent directory exists
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (parentDir && parentDir !== dir) {
      try {
        await pfs.mkdir(parentDir, { recursive: true });
      } catch (e) {
        // Directory might already exist
      }
    }

    // Write the file
    await pfs.writeFile(fullPath, content, "utf8");

    if (!options.skipStage) {
      await git.add({ fs, dir, filepath: filePath });
    }

    return true;
  } catch (error) {
    console.error("Error writing file:", error);
    return false;
  }
}

// Stage many files in a single git.add call. Isomorphic-git accepts a
// filepath array and amortizes the index load/save across all paths,
// which is the win that makes this worth using over a per-file loop.
async function gitStagePaths(siteId, filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return true;
  const dir = getRepoDir(siteId);
  try {
    await git.add({ fs, dir, filepath: filePaths });
    return true;
  } catch (error) {
    console.error("Error bulk-staging files:", error);
    return false;
  }
}

// Build the entire initial commit from in-memory file contents, skipping
// the working-tree round-trip + per-file git.add of the standard flow.
//
// Per file the standard path costs:
//   pfs.writeFile (working tree)         3-5 ms (IndexedDB put)
//   git.add re-reads the file we just wrote  2-3 ms
//   SHA-1 + deflate (required either way)    6-12 ms
//   write blob to .git/objects (IndexedDB)   3-5 ms
//   per-file index entry update              <1 ms
//
// Going through writeBlob from in-memory bytes drops both the worktree
// write AND the redundant re-read — about half the per-file overhead on
// large imports. The downside is the index is empty after this commit
// (the standard flow populates it via git.add); syncCacheToGit detects
// the empty-index-but-HEAD-has-files state and rebuilds the index from
// HEAD on the first publish so subsequent commits don't drop unchanged
// files from their tree.
//
// `files` is an array of { path, content }. `path` includes the
// `public/` prefix where applicable; `content` is a string (utf8) or a
// Uint8Array.
async function gitInitialCommitFromBlobs(siteId, files, { author, message }) {
  const dir = getRepoDir(siteId);
  const enc = new TextEncoder();

  // 1. Write every blob to .git/objects in parallel batches. Lightning-fs
  //    serializes through one IndexedDB transaction queue, but JS-level
  //    Promise scheduling overhead drops with chunked Promise.all.
  const BATCH = 50;
  const blobOidByPath = new Map();
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (f) => {
      const bytes = typeof f.content === "string" ? enc.encode(f.content) : f.content;
      const oid = await git.writeBlob({ fs, dir, blob: bytes });
      blobOidByPath.set(f.path, oid);
    }));
  }

  // 2. Group blobs into a nested directory tree.
  const root = { children: new Map(), blobs: new Map() };
  for (const [path, oid] of blobOidByPath) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, { children: new Map(), blobs: new Map() });
      }
      node = node.children.get(seg);
    }
    node.blobs.set(parts[parts.length - 1], oid);
  }

  // 3. Write tree objects bottom-up.
  async function writeNode(node) {
    const tree = [];
    for (const [name, oid] of node.blobs) {
      tree.push({ mode: "100644", path: name, oid, type: "blob" });
    }
    for (const [name, child] of node.children) {
      const childOid = await writeNode(child);
      tree.push({ mode: "040000", path: name, oid: childOid, type: "tree" });
    }
    return await git.writeTree({ fs, dir, tree });
  }
  const rootTreeOid = await writeNode(root);

  // 4. Build the commit object directly. timestamp/timezoneOffset are
  //    required by isomorphic-git's writeCommit (no auto-fill at this
  //    layer).
  const ts = Math.floor(Date.now() / 1000);
  const ident = {
    name: author?.name || "user",
    email: author?.email || "user@noreply.agorapages.com",
    timestamp: ts,
    timezoneOffset: 0,
  };
  const commitOid = await git.writeCommit({
    fs,
    dir,
    commit: {
      message: message + "\n",
      tree: rootTreeOid,
      parent: [],
      author: ident,
      committer: ident,
    },
  });

  // 5. Update the current branch ref AND HEAD to point at the new
  //    commit. We can't rely on git.init's default branch matching
  //    the value we use here — historically it's been "master" but
  //    newer isomorphic-git builds default to "main", and
  //    git.currentBranch can also throw on freshly-init'd repos in
  //    some versions. If our chosen branch and HEAD's symbolic
  //    target diverge, HEAD walks to a ref with no commit on it,
  //    git.log({ ref: "HEAD" }) throws, generateHistoryJson catches
  //    that and writes `history.json` as `"[]"` — exactly the
  //    "history.json is an empty list after a discard" symptom that
  //    persists across reloads (the broken HEAD pointer is in the
  //    persisted lightning-fs .git; clearAutoSave doesn't touch it).
  //    Writing HEAD explicitly after the branch ref makes the
  //    pairing deterministic regardless of init defaults.
  let branch = "main";
  try {
    const detected = await git.currentBranch({ fs, dir, fullname: false });
    if (detected) branch = detected;
  } catch { /* keep the "main" default */ }
  await git.writeRef({
    fs,
    dir,
    ref: `refs/heads/${branch}`,
    value: commitOid,
    force: true,
  });
  await git.writeRef({
    fs,
    dir,
    ref: "HEAD",
    value: `refs/heads/${branch}`,
    force: true,
    symbolic: true,
  });

  return commitOid;
}

// Read a file from the git working directory
async function gitReadFile(siteId, filePath) {
  const dir = getRepoDir(siteId);
  const fullPath = `${dir}/${filePath}`;

  try {
    const content = await pfs.readFile(fullPath, "utf8");
    return content;
  } catch (error) {
    console.error("Error reading file:", error);
    return null;
  }
}

// Delete a file from the git working directory
async function gitDeleteFile(siteId, filePath) {
  const dir = getRepoDir(siteId);
  const fullPath = `${dir}/${filePath}`;

  try {
    // Remove from git index
    await git.remove({ fs, dir, filepath: filePath });

    // Delete the actual file
    try {
      await pfs.unlink(fullPath);
    } catch (e) {
      // File might not exist
    }

    console.log(`File deleted: ${filePath}`);
    return true;
  } catch (error) {
    console.error("Error deleting file:", error);
    return false;
  }
}

// Rename a file in the git working directory
async function gitRenameFile(siteId, oldPath, newPath) {
  const dir = getRepoDir(siteId);

  try {
    // Read old file content
    const content = await gitReadFile(siteId, oldPath);
    if (content === null) {
      console.error("Could not read old file for rename");
      return false;
    }

    // Write to new path
    await gitWriteFile(siteId, newPath, content);

    // Delete old file
    await gitDeleteFile(siteId, oldPath);

    console.log(`File renamed: ${oldPath} -> ${newPath}`);
    return true;
  } catch (error) {
    console.error("Error renaming file:", error);
    return false;
  }
}

// Get the status of all files in the working directory
async function gitStatus(siteId) {
  const dir = getRepoDir(siteId);

  try {
    const statusMatrix = await git.statusMatrix({ fs, dir });

    const changes = [];
    for (const [filepath, head, workdir, stage] of statusMatrix) {
      // Skip .git directory
      if (filepath.startsWith(".git")) continue;

      let status = null;

      // Determine status based on matrix values
      // [HEAD, WORKDIR, STAGE]
      // 0 = absent, 1 = present and same as HEAD, 2 = present and different
      if (head === 0 && workdir === 2 && stage === 2) {
        status = "added";
      } else if (head === 1 && workdir === 0 && stage === 0) {
        status = "deleted";
      } else if (head === 1 && workdir === 2 && stage === 2) {
        status = "modified";
      } else if (head === 1 && workdir === 2 && stage === 1) {
        status = "modified"; // Modified but not staged
      } else if (head === 0 && workdir === 2 && stage === 0) {
        status = "untracked";
      }

      if (status) {
        changes.push({ filepath, status });
      }
    }

    return changes;
  } catch (error) {
    console.error("Error getting git status:", error);
    return [];
  }
}

// Stage all changes
async function gitStageAll(siteId) {
  const dir = getRepoDir(siteId);

  // Only files the user explicitly deleted (tracked via
  // pendingDeletedFileNames in on-load.js) are eligible for git.remove.
  // The unconditional `head === 1 && workdir === 0 → git.remove` branch
  // this used to have was a severe data-loss vector: any time the
  // working tree was a subset of HEAD (writeBlob-imported sites with
  // an empty worktree, partial autosave restores, multi-tab sessions
  // with stale local state), every HEAD file missing from the worktree
  // got dropped from the index, the new commit's tree shed those
  // entries, and deployChanges propagated the "deletions" as R2.delete
  // calls. Now removals require the explicit-deletion signal that
  // removeCacheByFileName records — same guard we use in
  // syncCacheToGit's orphan loop.
  const explicitDeletes = (typeof pendingDeletedFileNames !== "undefined" && pendingDeletedFileNames instanceof Set)
    ? pendingDeletedFileNames
    : new Set();

  try {
    const statusMatrix = await git.statusMatrix({ fs, dir });

    for (const [filepath, head, workdir, stage] of statusMatrix) {
      if (filepath.startsWith(".git")) continue;

      // Add modified/new files
      if (workdir === 2) {
        await git.add({ fs, dir, filepath });
      }
      // Remove deleted files — only when the deletion was an explicit
      // user action. A workdir=0 row without that signal is treated as
      // a stale-state artifact and the index entry is preserved, so
      // the next commit's tree still references HEAD's blob.
      else if (head === 1 && workdir === 0 && explicitDeletes.has(filepath)) {
        await git.remove({ fs, dir, filepath });
      }
    }

    console.log("All changes staged");
    return true;
  } catch (error) {
    console.error("Error staging changes:", error);
    return false;
  }
}

// Create a commit
async function gitCommit(siteId, message) {
  const dir = getRepoDir(siteId);
  const username = getStoredUsername() || "user";

  try {
    // Stage all changes first
    await gitStageAll(siteId);

    const sha = await git.commit({
      fs,
      dir,
      message,
      author: {
        name: username,
        email: `${username}@noreply.agorapages.com`,
      },
    });

    console.log(`Commit created: ${sha}`);
    return sha;
  } catch (error) {
    console.error("Error creating commit:", error);
    return null;
  }
}

// Get commit history
async function gitLog(siteId, depth = 10) {
  const dir = getRepoDir(siteId);

  try {
    const commits = await git.log({ fs, dir, depth, ref: "HEAD" });
    return commits;
  } catch (error) {
    console.error("Error getting git log:", error);
    return [];
  }
}

// Format commit history for display
async function formatCommitHistory(siteId) {
  const commits = await gitLog(siteId, 50);

  if (commits.length === 0) {
    return "<p style='color: #888;'>No commits yet.</p>";
  }

  let html = "";

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const date = new Date(commit.commit.author.timestamp * 1000);
    const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();
    const shortSha = commit.oid.substring(0, 7);
    const messageFirstLine = commit.commit.message.split('\n')[0];
    const message = escapeHtml(commit.commit.message);
    const messageAttr = escapeHtml(messageFirstLine);
    const author = escapeHtml(commit.commit.author.name);

    html += `<div style="border-bottom: 1px solid #ddd; padding: 10px 0;">`;
    html += `<div style="display: flex; justify-content: space-between; align-items: center;">`;
    html += `<a href="#" class="commit-link" data-commit-oid="${commit.oid}" style="color: #337ab7; text-decoration: none; cursor: pointer;"><strong>${shortSha}</strong></a>`;
    html += `<span style="color: #888; font-size: 12px;">${dateStr}</span>`;
    html += `</div>`;
    html += `<div style="margin-top: 5px;">${message}</div>`;
    html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 5px;">`;
    html += `<span style="color: #888; font-size: 12px;">by ${author}</span>`;
    // Don't show revert button for the most recent commit (index 0)
    if (i > 0) {
      html += `<button class="btn btn-xs btn-warning revert-btn" data-commit-oid="${commit.oid}" data-commit-message="${messageAttr}">Revert to this</button>`;
    }
    html += `</div>`;
    html += `</div>`;
  }

  return html;
}

// Get changes for a specific commit (compared to its parent)
async function getCommitChanges(siteId, commitOid) {
  const dir = getRepoDir(siteId);

  try {
    // Get the commit
    const commitObj = await git.readCommit({ fs, dir, oid: commitOid });
    const commit = commitObj.commit;

    // Get parent commit oid (if any)
    const parentOid = commit.parent.length > 0 ? commit.parent[0] : null;

    // Get trees for both commits
    const commitTree = commitObj.commit.tree;
    let parentTree = null;

    if (parentOid) {
      const parentCommit = await git.readCommit({ fs, dir, oid: parentOid });
      parentTree = parentCommit.commit.tree;
    }

    // Walk both trees to find changes
    const changes = [];

    // Get files from current commit
    const currentFiles = await getTreeFiles(dir, commitTree, "");

    // Get files from parent commit
    const parentFiles = parentOid ? await getTreeFiles(dir, parentTree, "") : {};

    // Find added and modified files
    for (const [filepath, oid] of Object.entries(currentFiles)) {
      if (!parentFiles[filepath]) {
        // File was added
        changes.push({ filepath, status: "added", newOid: oid, oldOid: null });
      } else if (parentFiles[filepath] !== oid) {
        // File was modified
        changes.push({ filepath, status: "modified", newOid: oid, oldOid: parentFiles[filepath] });
      }
    }

    // Find deleted files
    for (const [filepath, oid] of Object.entries(parentFiles)) {
      if (!currentFiles[filepath]) {
        changes.push({ filepath, status: "deleted", newOid: null, oldOid: oid });
      }
    }

    return changes;
  } catch (error) {
    console.error("Error getting commit changes:", error);
    return [];
  }
}

// Helper to get all files from a tree recursively
async function getTreeFiles(dir, treeOid, basePath) {
  const files = {};

  try {
    const { tree } = await git.readTree({ fs, dir, oid: treeOid });

    for (const entry of tree) {
      const filepath = basePath ? `${basePath}/${entry.path}` : entry.path;

      if (entry.type === "blob") {
        files[filepath] = entry.oid;
      } else if (entry.type === "tree") {
        const subFiles = await getTreeFiles(dir, entry.oid, filepath);
        Object.assign(files, subFiles);
      }
    }
  } catch (error) {
    console.error("Error reading tree:", error);
  }

  return files;
}

// Get all markdown files at a specific commit with their content
async function getMarkdownFilesAtCommit(siteId, commitOid) {
  const dir = getRepoDir(siteId);
  const markdownFiles = [];

  try {
    const commitObj = await git.readCommit({ fs, dir, oid: commitOid });
    const treeOid = commitObj.commit.tree;
    const files = await getTreeFiles(dir, treeOid, "");

    // Read pages.json from the commit for display names and sort order
    let pagesLookup = {};
    if (files["public/pages.json"]) {
      try {
        const { blob } = await git.readBlob({ fs, dir, oid: files["public/pages.json"] });
        const pagesJson = JSON.parse(new TextDecoder().decode(blob));
        for (const page of pagesJson) {
          pagesLookup[page.fileName] = page;
        }
      } catch (e) {
        console.error("Error reading pages.json from commit:", e);
      }
    }

    const hasPagesJson = Object.keys(pagesLookup).length > 0;

    for (const [filepath, blobOid] of Object.entries(files)) {
      if (filepath.startsWith("public/") && filepath.endsWith(".md")) {
        const relPath = filepath.replace("public/", "").replace(".md", "");

        // Skip files not in pages.json — they are ghosts from a previous bug
        // where deletions weren't recorded in git
        if (hasPagesJson && !pagesLookup[relPath]) continue;

        try {
          const { blob } = await git.readBlob({ fs, dir, oid: blobOid });
          const content = new TextDecoder().decode(blob);

          const pageEntry = pagesLookup[relPath];
          const lastSegment = relPath.split("/").pop();
          const displayName = pageEntry ? pageEntry.displayName : lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1);
          const sortOrder = pageEntry && pageEntry.sortOrder != null ? pageEntry.sortOrder : null;

          markdownFiles.push({
            fileName: filepath,
            displayName: displayName,
            content: content,
            sortOrder: sortOrder,
          });
        } catch (blobError) {
          console.error("Error reading blob for", filepath, blobError);
        }
      }
    }
  } catch (error) {
    console.error("Error getting markdown files at commit:", error);
  }

  return markdownFiles;
}

// Format commit changes for display
async function formatCommitChanges(siteId, commitOid) {
  const dir = getRepoDir(siteId);
  const changes = await getCommitChanges(siteId, commitOid);

  // Filter to only markdown files
  const mdChanges = changes.filter(c => c.filepath.endsWith(".md"));

  if (mdChanges.length === 0) {
    return "<p style='color: #888;'>No content changes in this commit.</p>";
  }

  let html = "";

  for (const change of mdChanges) {

    const statusColor =
      change.status === "added"
        ? "#4ec9b0"
        : change.status === "deleted"
        ? "#f14c4c"
        : "#dcdcaa";
    const statusSymbol =
      change.status === "added"
        ? "+"
        : change.status === "deleted"
        ? "-"
        : "M";

    // Display a cleaner file name (e.g., "public/about.md" -> "about")
    let displayPath = change.filepath;
    if (change.filepath.startsWith("public/") && change.filepath.endsWith(".md")) {
      displayPath = change.filepath.replace("public/", "").replace(".md", "");
    }

    html += `<div style="margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 10px;">`;
    // displayPath comes from a page filename, which is built from the
    // user-supplied page name. Always escape — even with the tightened
    // slug allowlist in on-load.js, a legacy site may have looser slugs
    // already committed, and "trust the slug sanitizer" is the wrong
    // last-line defence for an HTML sink.
    html += `<div style="color: ${statusColor}; margin-bottom: 5px;"><strong>[${statusSymbol}] ${escapeHtml(displayPath)}</strong></div>`;

    try {
      if (change.status === "added" && change.newOid) {
        // Show added content
        const { blob } = await git.readBlob({ fs, dir, oid: change.newOid });
        const content = new TextDecoder().decode(blob);
        const lines = content.split("\n");

        html += `<div style="padding-left: 10px;">`;
        for (const line of lines.slice(0, 20)) {
          const escapedLine = escapeHtml(line);
          html += `<div style="color: #4ec9b0;">+ ${escapedLine}</div>`;
        }
        if (lines.length > 20) {
          html += `<div style="color: #888;">... and ${lines.length - 20} more lines</div>`;
        }
        html += `</div>`;
      } else if (change.status === "deleted" && change.oldOid) {
        // Show deleted content
        const { blob } = await git.readBlob({ fs, dir, oid: change.oldOid });
        const content = new TextDecoder().decode(blob);
        const lines = content.split("\n");

        html += `<div style="padding-left: 10px;">`;
        for (const line of lines.slice(0, 20)) {
          const escapedLine = escapeHtml(line);
          html += `<div style="color: #f14c4c;">- ${escapedLine}</div>`;
        }
        if (lines.length > 20) {
          html += `<div style="color: #888;">... and ${lines.length - 20} more lines</div>`;
        }
        html += `</div>`;
      } else if (change.status === "modified" && change.oldOid && change.newOid) {
        // Show diff
        const { blob: oldBlob } = await git.readBlob({ fs, dir, oid: change.oldOid });
        const { blob: newBlob } = await git.readBlob({ fs, dir, oid: change.newOid });
        const oldContent = new TextDecoder().decode(oldBlob);
        const newContent = new TextDecoder().decode(newBlob);
        const diff = generateSimpleDiff(oldContent, newContent);

        if (diff.length > 0) {
          html += `<div style="padding-left: 10px;">`;
          for (const line of diff.slice(0, 20)) {
            const color = line.type === "add" ? "#4ec9b0" : "#f14c4c";
            const prefix = line.type === "add" ? "+" : "-";
            const escapedLine = escapeHtml(line.line);
            html += `<div style="color: ${color};">${prefix} ${escapedLine}</div>`;
          }
          if (diff.length > 20) {
            html += `<div style="color: #888;">... and ${diff.length - 20} more lines</div>`;
          }
          html += `</div>`;
        }
      }
    } catch (e) {
      console.error("Error reading blob for diff:", e);
    }

    html += `</div>`;
  }

  return html;
}

// Get diff for a file between working directory and HEAD
async function gitDiff(siteId, filepath) {
  const dir = getRepoDir(siteId);

  try {
    // Get current working directory content
    let workdirContent = "";
    try {
      workdirContent = await pfs.readFile(`${dir}/${filepath}`, "utf8");
    } catch (e) {
      // File might be deleted
    }

    // Get HEAD content
    let headContent = "";
    try {
      const commits = await git.log({ fs, dir, depth: 1 });
      if (commits.length > 0) {
        const { blob } = await git.readBlob({
          fs,
          dir,
          oid: commits[0].oid,
          filepath,
        });
        headContent = new TextDecoder().decode(blob);
      }
    } catch (e) {
      // File might be new
    }

    return {
      old: headContent,
      new: workdirContent,
    };
  } catch (error) {
    console.error("Error getting diff:", error);
    return { old: "", new: "" };
  }
}

// Generate a simple text diff
function generateSimpleDiff(oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const diff = [];

  // Simple line-by-line comparison
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === undefined) {
      diff.push({ type: "add", line: newLine, lineNum: i + 1 });
    } else if (newLine === undefined) {
      diff.push({ type: "del", line: oldLine, lineNum: i + 1 });
    } else if (oldLine !== newLine) {
      diff.push({ type: "del", line: oldLine, lineNum: i + 1 });
      diff.push({ type: "add", line: newLine, lineNum: i + 1 });
    }
  }

  return diff;
}

// Get file content at a specific commit
async function getFileContentAtCommit(siteId, commitOid, filepath) {
  const dir = getRepoDir(siteId);

  try {
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid: commitOid,
      filepath,
    });
    return new TextDecoder().decode(blob);
  } catch (error) {
    // File doesn't exist at this commit
    return null;
  }
}

// Generate diff between two commits for a specific file using LCS algorithm
function generateLCSDiff(oldContent, newContent) {
  if (oldContent === null) oldContent = "";
  if (newContent === null) newContent = "";

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // LCS-based diff algorithm
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find diff
  const diff = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      // Line unchanged - don't include in diff
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Line added
      diff.unshift({ type: "add", content: newLines[j - 1] });
      j--;
    } else if (i > 0) {
      // Line deleted
      diff.unshift({ type: "del", content: oldLines[i - 1] });
      i--;
    }
  }

  return diff;
}

// Get detailed changes for a commit including line-level diffs
async function getDetailedCommitChanges(siteId, commitOid) {
  const dir = getRepoDir(siteId);

  try {
    // Get the commit
    const commitObj = await git.readCommit({ fs, dir, oid: commitOid });
    const commit = commitObj.commit;

    // Get parent commit oid (if any)
    const parentOid = commit.parent.length > 0 ? commit.parent[0] : null;

    // Get basic changes first
    const changes = await getCommitChanges(siteId, commitOid);

    // Filter to only public/ files and add diffs
    const detailedChanges = [];

    for (const change of changes) {
      if (!change.filepath.startsWith("public/")) continue;

      // Get file content at both commits
      const newContent = change.newOid
        ? await getFileContentAtCommit(siteId, commitOid, change.filepath)
        : null;
      const oldContent = parentOid && change.oldOid
        ? await getFileContentAtCommit(siteId, parentOid, change.filepath)
        : null;

      // Generate diff
      const diff = generateLCSDiff(oldContent, newContent);

      // Limit diff size to avoid huge payloads
      const limitedDiff = diff.slice(0, 50);
      const truncated = diff.length > 50;

      detailedChanges.push({
        file: change.filepath.replace("public/", ""),
        status: change.status,
        diff: limitedDiff,
        truncated: truncated
      });
    }

    return detailedChanges;
  } catch (error) {
    console.error("Error getting detailed commit changes:", error);
    return [];
  }
}

// Format changes for display in the commit modal
async function formatChangesForDisplay(siteId) {
  const changes = await gitStatus(siteId);

  // Filter to only markdown files
  const mdChanges = changes.filter(c => c.filepath.endsWith(".md"));

  if (mdChanges.length === 0) {
    return "<p style='color: #888;'>No changes to commit.</p>";
  }

  let html = "";

  for (const change of mdChanges) {
    const statusColor =
      change.status === "added"
        ? "#4ec9b0"
        : change.status === "deleted"
        ? "#f14c4c"
        : "#dcdcaa";
    const statusSymbol =
      change.status === "added"
        ? "+"
        : change.status === "deleted"
        ? "-"
        : "M";

    // Display a cleaner file name (e.g., "public/about.md" -> "about")
    let displayPath = change.filepath;
    if (change.filepath.startsWith("public/") && change.filepath.endsWith(".md")) {
      displayPath = change.filepath.replace("public/", "").replace(".md", "");
    }

    html += `<div style="margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 10px;">`;
    // displayPath comes from a page filename, which is built from the
    // user-supplied page name. Always escape — even with the tightened
    // slug allowlist in on-load.js, a legacy site may have looser slugs
    // already committed, and "trust the slug sanitizer" is the wrong
    // last-line defence for an HTML sink.
    html += `<div style="color: ${statusColor}; margin-bottom: 5px;"><strong>[${statusSymbol}] ${escapeHtml(displayPath)}</strong></div>`;

    // Show diff for modified files
    if (change.status === "modified") {
      const { old: oldContent, new: newContent } = await gitDiff(
        siteId,
        change.filepath
      );
      const diff = generateSimpleDiff(oldContent, newContent);

      if (diff.length > 0) {
        html += `<div style="padding-left: 10px;">`;
        for (const line of diff.slice(0, 20)) {
          // Limit to first 20 diff lines
          const color = line.type === "add" ? "#4ec9b0" : "#f14c4c";
          const prefix = line.type === "add" ? "+" : "-";
          const escapedLine = escapeHtml(line.line);
          html += `<div style="color: ${color};">${prefix} ${escapedLine}</div>`;
        }
        if (diff.length > 20) {
          html += `<div style="color: #888;">... and ${diff.length - 20} more lines</div>`;
        }
        html += `</div>`;
      }
    }

    // Show content for added files
    if (change.status === "added") {
      const content = await gitReadFile(siteId, change.filepath);
      if (content) {
        const lines = content.split("\n");
        html += `<div style="padding-left: 10px;">`;
        for (const line of lines.slice(0, 20)) {
          const escapedLine = escapeHtml(line);
          html += `<div style="color: #4ec9b0;">+ ${escapedLine}</div>`;
        }
        if (lines.length > 20) {
          html += `<div style="color: #888;">... and ${lines.length - 20} more lines</div>`;
        }
        html += `</div>`;
      }
    }

    // Show content for deleted files
    if (change.status === "deleted") {
      const { old: oldContent } = await gitDiff(siteId, change.filepath);
      if (oldContent) {
        const lines = oldContent.split("\n");
        html += `<div style="padding-left: 10px;">`;
        for (const line of lines.slice(0, 20)) {
          const escapedLine = escapeHtml(line);
          html += `<div style="color: #f14c4c;">- ${escapedLine}</div>`;
        }
        if (lines.length > 20) {
          html += `<div style="color: #888;">... and ${lines.length - 20} more lines</div>`;
        }
        html += `</div>`;
      }
    }

    html += `</div>`;
  }

  return html;
}

// Helper to escape HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Sync files from markdownCache to git working directory
async function syncCacheToGit(siteId, markdownCache, imageCache) {
  const dir = getRepoDir(siteId);

  try {
    // Index-rebuild bridge for sites whose initial commit was built via
    // gitInitialCommitFromBlobs (writeBlob + writeTree + writeCommit).
    // That path leaves the index empty even though HEAD has every file,
    // so the next commit's tree would otherwise be assembled solely from
    // the staged paths and silently drop every file the user hasn't
    // touched this session. checkout({ noUpdate: true }) populates the
    // index from HEAD without writing the working tree — exactly the
    // shape we need for the publish flow's stage-and-commit logic to
    // work normally from here on.
    try {
      const [headFiles, indexFiles] = await Promise.all([
        git.listFiles({ fs, dir, ref: "HEAD" }).catch(() => []),
        git.listFiles({ fs, dir }).catch(() => []),
      ]);
      if (headFiles.length > 0 && indexFiles.length === 0) {
        console.log("Rebuilding index from HEAD (post-import first publish)");
        await git.checkout({ fs, dir, ref: "HEAD", noUpdate: true });
      }
    } catch (e) {
      console.warn("Index rebuild check failed; proceeding anyway:", e);
    }

    // Find every tracked file (in HEAD AND in the current index) and
    // delete the ones no longer backed by a cache entry. Handles .md
    // sources only — .html shells are no longer written (the worker
    // serves them from inlined templates). Any legacy .html still in
    // the working tree is also evicted so the next commit drops it
    // cleanly, regardless of whether the source .md still exists.
    // Unlink the file first, then remove it from the index, so a
    // stale index entry can't outlive the working tree.
    let tracked;
    try {
      const [headFiles, indexFiles] = await Promise.all([
        git.listFiles({ fs, dir, ref: "HEAD" }).catch(() => []),
        git.listFiles({ fs, dir }).catch(() => []),
      ]);
      tracked = new Set([...headFiles, ...indexFiles]);
    } catch (e) {
      tracked = new Set();
    }
    const cacheFileNames = new Set(markdownCache.map(item => item.fileName));
    // Only consider a tracked .md file an orphan if the user has
    // explicitly deleted it this session (recorded via
    // removeCacheByFileName → pendingDeletedFileNames). Cache absences
    // without that signal are treated as stale state and left alone —
    // otherwise a stale-autosave restoration that pre-dates a page
    // added by a collaborator would silently unlink that page from
    // both the local branch and (via the three-way merge) the upstream
    // tree. .html shells stay always-orphan: the worker serves them
    // from inlined templates and any leftover R2 copy is dead weight.
    const explicitDeletes = (typeof pendingDeletedFileNames !== "undefined" && pendingDeletedFileNames instanceof Set)
      ? pendingDeletedFileNames
      : new Set();
    for (const filepath of tracked) {
      if (!filepath.startsWith("public/")) continue;

      let isOrphan = false;
      if (filepath.endsWith(".md")) {
        isOrphan = !cacheFileNames.has(filepath) && explicitDeletes.has(filepath);
      } else if (filepath.endsWith(".html")) {
        // Always orphan — we no longer produce .html shells.
        isOrphan = true;
      }
      if (!isOrphan) continue;

      const fullPath = `${dir}/${filepath}`;
      try { await pfs.unlink(fullPath); } catch (_) { /* may already be gone */ }
      try { await git.remove({ fs, dir, filepath }); } catch (_) { /* may not be staged */ }
    }

    // Write all markdown files. Pages-site cache entries are metadata-only
    // until the user opens them (lazy load), so skip any item whose body
    // hasn't been fetched — the loadR2ToGit pass already wrote the
    // current R2 copy into the working tree, which is the right state for
    // an unedited page.
    //
    // skipStage: defer the per-file git.add to a single bulk gitStagePaths
    // call below. On a 1000-page sync this turns 1000 index rewrites into
    // one and roughly halves the git portion of a publish.
    const stagedPaths = [];
    for (const item of markdownCache) {
      if (typeof item.content !== "string") continue;
      await gitWriteFile(siteId, item.fileName, item.content, { skipStage: true });
      stagedPaths.push(item.fileName);
    }

    // Write pages.json (flat array of `{ fileName, displayName, ... }`).
    const pages = markdownCache.map((item) => {
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
    const pagesJsonContent = (typeof buildPagesJsonContent === "function")
      ? buildPagesJsonContent(pages)
      : JSON.stringify(pages);
    await gitWriteFile(siteId, "public/pages.json", pagesJsonContent, { skipStage: true });
    stagedPaths.push("public/pages.json");

    // Keep search-index.json in sync with the cache. Incremental: reuse
    // the previous index from the git working tree so we don't reparse
    // pages whose body hasn't changed (and don't penalise lazy-loaded
    // metadata-only stubs).
    if (typeof buildSearchIndexContent === "function") {
      let prevSearch = { pages: {} };
      if (typeof parseSearchIndexJson === "function") {
        try {
          const prevText = await gitReadFile(siteId, "public/search-index.json");
          prevSearch = parseSearchIndexJson(prevText);
        } catch (_) { /* file not in tree yet */ }
      }
      await gitWriteFile(
        siteId,
        "public/search-index.json",
        buildSearchIndexContent(markdownCache, prevSearch),
        { skipStage: true }
      );
      stagedPaths.push("public/search-index.json");
    }

    // Write images.json
    await gitWriteFile(siteId, "public/images.json", JSON.stringify(imageCache), { skipStage: true });
    stagedPaths.push("public/images.json");

    // Write documents.json
    await gitWriteFile(siteId, "public/documents.json", JSON.stringify(documentCache), { skipStage: true });
    stagedPaths.push("public/documents.json");

    // One bulk stage for everything we just wrote.
    await gitStagePaths(siteId, stagedPaths);

    console.log("Cache synced to git");
    return true;
  } catch (error) {
    console.error("Error syncing cache to git:", error);
    return false;
  }
}

// Load files from R2 into the git working directory (for initial load)
async function loadR2ToGit(siteId) {
  const dir = getRepoDir(siteId);

  try {
    // Treat the local repo as healthy only when (a) the .git directory
    // exists AND (b) HEAD actually resolves to a commit. The directory-
    // exists-only check from before would silently keep using a repo
    // whose HEAD pointed at a non-existent ref (e.g. an early
    // gitInitialCommitFromBlobs that wrote refs/heads/main while
    // git.init had set HEAD to refs/heads/master), which made
    // generateHistoryJson silently emit `[]` on every publish.
    // Re-deriving from R2 when HEAD is broken self-heals those sites
    // without requiring the user to clear IndexedDB by hand.
    try {
      await pfs.stat(`${dir}/.git`);
      try {
        await git.resolveRef({ fs, dir, ref: "HEAD" });
        console.log("Git repo already exists, skipping R2 sync");
        return true;
      } catch (headErr) {
        console.warn(
          `Local .git for ${siteId} exists but HEAD does not resolve — rebuilding from R2.`,
          headErr
        );
        // Drop the broken .git so deserializeGitDirectory below starts
        // from a clean slate. Best-effort; if delete fails we still
        // proceed and let writes overlay.
        try { await rmdirRecursive(`${dir}/.git`); } catch (_) {}
      }
    } catch (e) {
      // Repo doesn't exist locally, need to load from R2
    }

    // Try to restore git history from R2 first
    const gitData = await loadGitHistoryFromR2(siteId);
    if (gitData && Object.keys(gitData).length > 0) {
      console.log("Restoring git history from R2...");
      const restored = await deserializeGitDirectory(siteId, gitData);
      if (restored) {
        // Also restore working directory files from R2
        const pagesJson = await getFileFromR2(siteId, "public/pages.json");
        if (pagesJson) {
          // Create public directory if needed
          try {
            await pfs.mkdir(`${dir}/public`, { recursive: true });
          } catch (e) {}

          await pfs.writeFile(`${dir}/public/pages.json`, pagesJson, "utf8");

          // Load all page files and metadata in parallel
          const pages = JSON.parse(pagesJson);
          const pagePromises = pages.flatMap(page => [
            getFileFromR2(siteId, `public/${page.fileName}.md`).then(content =>
              content ? pfs.writeFile(`${dir}/public/${page.fileName}.md`, content, "utf8") : null
            ),
            getFileFromR2(siteId, `public/${page.fileName}.html`).then(content =>
              content ? pfs.writeFile(`${dir}/public/${page.fileName}.html`, content, "utf8") : null
            ),
          ]);
          const metaPromises = [
            getFileFromR2(siteId, "public/images.json").then(content =>
              content ? pfs.writeFile(`${dir}/public/images.json`, content, "utf8") : null
            ),
            getFileFromR2(siteId, "public/documents.json").then(content =>
              content ? pfs.writeFile(`${dir}/public/documents.json`, content, "utf8") : null
            ),
          ];
          await Promise.all([...pagePromises, ...metaPromises]);
        }

        console.log("Git history restored from R2 successfully");
        return true;
      }
    }

    // Fall back to creating new repo if no history exists
    console.log("No git history in R2, initializing new repo...");
    await gitInit(siteId);

    // Load pages.json and metadata from R2 in parallel
    const [pagesJson, imagesJson, documentsJson] = await Promise.all([
      getFileFromR2(siteId, "public/pages.json"),
      getFileFromR2(siteId, "public/images.json"),
      getFileFromR2(siteId, "public/documents.json"),
    ]);

    if (pagesJson) {
      await gitWriteFile(siteId, "public/pages.json", pagesJson);

      // Load all page files in parallel, then write to git sequentially.
      const parsedPages = JSON.parse(pagesJson);
      const pages = Array.isArray(parsedPages) ? parsedPages : [];
      const pageContents = await Promise.all(
        pages.map(async (page) => ({
          fileName: page.fileName,
          md: await getFileFromR2(siteId, `public/${page.fileName}.md`),
          html: await getFileFromR2(siteId, `public/${page.fileName}.html`),
        }))
      );
      for (const { fileName, md, html } of pageContents) {
        if (md) await gitWriteFile(siteId, `public/${fileName}.md`, md);
        if (html) await gitWriteFile(siteId, `public/${fileName}.html`, html);
      }
    }

    if (imagesJson) {
      await gitWriteFile(siteId, "public/images.json", imagesJson);
    }
    if (documentsJson) {
      await gitWriteFile(siteId, "public/documents.json", documentsJson);
    }

    // Create initial commit if there are files
    const changes = await gitStatus(siteId);
    if (changes.length > 0) {
      await gitCommit(siteId, "Initial commit from R2 storage");
    }

    console.log("R2 files loaded into git");
    return true;
  } catch (error) {
    console.error("Error loading R2 to git:", error);
    return false;
  }
}

// Check if there are uncommitted changes
async function hasUncommittedChanges(siteId) {
  const changes = await gitStatus(siteId);
  return changes.length > 0;
}

// Helper function to recursively list all files in a directory
async function listAllFiles(dirPath, basePath = "") {
  const files = [];
  try {
    const entries = await pfs.readdir(dirPath);
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry}`;
      const relativePath = basePath ? `${basePath}/${entry}` : entry;
      try {
        const stat = await pfs.stat(fullPath);
        if (stat.isDirectory()) {
          const subFiles = await listAllFiles(fullPath, relativePath);
          files.push(...subFiles);
        } else {
          files.push(relativePath);
        }
      } catch (e) {
        // Skip files that can't be stat'd
      }
    }
  } catch (e) {
    // Directory might not exist
  }
  return files;
}

// Helper function to convert ArrayBuffer/Uint8Array to base64
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper function to convert base64 to Uint8Array
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Recursively delete a directory and everything under it. Used by
// loadR2ToGit when it detects a corrupted local .git (HEAD doesn't
// resolve) and needs to wipe the on-disk repo before rehydrating from
// R2's .git-history.json. LightningFS lacks native recursive removal,
// so walk the tree and unlink leaves first.
async function rmdirRecursive(path) {
  let entries;
  try {
    entries = await pfs.readdir(path);
  } catch (e) {
    // Path doesn't exist or isn't a directory; nothing to do.
    return;
  }
  for (const name of entries) {
    const child = `${path}/${name}`;
    let stat;
    try { stat = await pfs.stat(child); } catch (_) { continue; }
    if (stat && stat.isDirectory && stat.isDirectory()) {
      await rmdirRecursive(child);
    } else {
      try { await pfs.unlink(child); } catch (_) {}
    }
  }
  try { await pfs.rmdir(path); } catch (_) {}
}

// Helper function to create directories recursively (LightningFS doesn't support recursive well)
async function mkdirRecursive(path) {
  const parts = path.split("/").filter((p) => p);
  let currentPath = "";

  for (const part of parts) {
    currentPath += "/" + part;
    try {
      await pfs.mkdir(currentPath);
    } catch (e) {
      // Directory might already exist, that's fine
      if (e.code !== "EEXIST") {
        // Check if it exists as a directory
        try {
          const stat = await pfs.stat(currentPath);
          if (!stat.isDirectory()) {
            throw e;
          }
        } catch (statErr) {
          // If stat also fails with something other than "it exists", ignore
        }
      }
    }
  }
}

// Serialize the .git directory to a JSON object for R2 storage
async function serializeGitDirectory(siteId) {
  const dir = getRepoDir(siteId);
  const gitDir = `${dir}/.git`;

  try {
    const files = await listAllFiles(gitDir);
    const gitData = {};

    for (const file of files) {
      const fullPath = `${gitDir}/${file}`;
      try {
        // Read file as binary (Uint8Array)
        const content = await pfs.readFile(fullPath);
        // Convert to base64 for JSON storage
        if (content instanceof Uint8Array) {
          gitData[file] = arrayBufferToBase64(content);
        } else if (typeof content === "string") {
          // Text content - encode as base64 for consistency
          gitData[file] = btoa(unescape(encodeURIComponent(content)));
        } else {
          gitData[file] = arrayBufferToBase64(new Uint8Array(content));
        }
      } catch (e) {
        console.error(`Error reading git file ${file}:`, e);
      }
    }

    console.log(`Serialized ${Object.keys(gitData).length} git files`);
    return gitData;
  } catch (error) {
    console.error("Error serializing git directory:", error);
    return null;
  }
}

// Deserialize and restore the .git directory from R2 data
async function deserializeGitDirectory(siteId, gitData) {
  const dir = getRepoDir(siteId);
  const gitDir = `${dir}/.git`;

  try {
    // Create base directories
    await mkdirRecursive(dir);
    await mkdirRecursive(gitDir);

    // Restore each file
    for (const [filePath, base64Content] of Object.entries(gitData)) {
      const fullPath = `${gitDir}/${filePath}`;

      // Ensure parent directory exists
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (parentDir && parentDir !== gitDir) {
        await mkdirRecursive(parentDir);
      }

      // Write file as binary
      const content = base64ToArrayBuffer(base64Content);
      await pfs.writeFile(fullPath, content);
    }

    console.log(`Deserialized ${Object.keys(gitData).length} git files`);
    return true;
  } catch (error) {
    console.error("Error deserializing git directory:", error);
    return false;
  }
}

// Save git history to R2 storage
async function saveGitHistoryToR2(siteId) {
  try {
    const gitData = await serializeGitDirectory(siteId);
    if (!gitData) {
      console.error("Failed to serialize git directory");
      return false;
    }

    const jsonContent = JSON.stringify(gitData);
    const result = await saveFileToR2(siteId, ".git-history.json", jsonContent, {
      contentType: "application/json",
    });

    if (result) {
      console.log("Git history saved to R2");
    }
    return result;
  } catch (error) {
    console.error("Error saving git history to R2:", error);
    return false;
  }
}

// Load git history from R2 storage
async function loadGitHistoryFromR2(siteId) {
  try {
    const jsonContent = await getFileFromR2(siteId, ".git-history.json");
    if (!jsonContent) {
      console.log("No git history found in R2");
      return null;
    }

    const gitData = JSON.parse(jsonContent);
    console.log("Git history loaded from R2");
    return gitData;
  } catch (error) {
    console.error("Error loading git history from R2:", error);
    return null;
  }
}
