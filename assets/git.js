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

// Write a file to the git working directory
async function gitWriteFile(siteId, filePath, content) {
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

    // Stage the file
    await git.add({ fs, dir, filepath: filePath });

    console.log(`File written and staged: ${filePath}`);
    return true;
  } catch (error) {
    console.error("Error writing file:", error);
    return false;
  }
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

  try {
    const statusMatrix = await git.statusMatrix({ fs, dir });

    for (const [filepath, head, workdir, stage] of statusMatrix) {
      if (filepath.startsWith(".git")) continue;

      // Add modified/new files
      if (workdir === 2) {
        await git.add({ fs, dir, filepath });
      }
      // Remove deleted files
      else if (head === 1 && workdir === 0) {
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
    // Get the commit
    const commitObj = await git.readCommit({ fs, dir, oid: commitOid });
    const treeOid = commitObj.commit.tree;

    // Get all files in the tree
    const files = await getTreeFiles(dir, treeOid, "");

    // Filter for markdown files in public/ directory and read their content
    for (const [filepath, blobOid] of Object.entries(files)) {
      if (filepath.startsWith("public/") && filepath.endsWith(".md")) {
        try {
          const { blob } = await git.readBlob({ fs, dir, oid: blobOid });
          const content = new TextDecoder().decode(blob);

          // Extract display name from filename
          const fileName = filepath.replace("public/", "").replace(".md", "");
          const displayName = fileName;

          markdownFiles.push({
            fileName: filepath,
            displayName: displayName,
            content: content
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
    html += `<div style="color: ${statusColor}; margin-bottom: 5px;"><strong>[${statusSymbol}] ${displayPath}</strong></div>`;

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
    html += `<div style="color: ${statusColor}; margin-bottom: 5px;"><strong>[${statusSymbol}] ${displayPath}</strong></div>`;

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
    // Write all markdown files
    for (const item of markdownCache) {
      await gitWriteFile(siteId, item.fileName, item.content);
    }

    // Write pages.json
    const pages = markdownCache.map((item) => {
      const fileName = item.fileName.replace("public/", "").replace(".md", "");
      return {
        displayName: item.displayName,
        fileName: fileName,
      };
    });
    await gitWriteFile(siteId, "public/pages.json", JSON.stringify(pages));

    // Write images.json
    await gitWriteFile(siteId, "public/images.json", JSON.stringify(imageCache));

    // Write documents.json
    await gitWriteFile(siteId, "public/documents.json", JSON.stringify(documentCache));

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
    // Check if repo already exists in local filesystem
    try {
      await pfs.stat(`${dir}/.git`);
      console.log("Git repo already exists, skipping R2 sync");
      return true;
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

          // Load each page into working directory
          const pages = JSON.parse(pagesJson);
          for (const page of pages) {
            const mdContent = await getFileFromR2(siteId, `public/${page.fileName}.md`);
            if (mdContent) {
              await pfs.writeFile(`${dir}/public/${page.fileName}.md`, mdContent, "utf8");
            }
            const htmlContent = await getFileFromR2(siteId, `public/${page.fileName}.html`);
            if (htmlContent) {
              await pfs.writeFile(`${dir}/public/${page.fileName}.html`, htmlContent, "utf8");
            }
          }
        }

        // Load images.json
        const imagesJson = await getFileFromR2(siteId, "public/images.json");
        if (imagesJson) {
          await pfs.writeFile(`${dir}/public/images.json`, imagesJson, "utf8");
        }

        // Load documents.json
        const documentsJson = await getFileFromR2(siteId, "public/documents.json");
        if (documentsJson) {
          await pfs.writeFile(`${dir}/public/documents.json`, documentsJson, "utf8");
        }

        console.log("Git history restored from R2 successfully");
        return true;
      }
    }

    // Fall back to creating new repo if no history exists
    console.log("No git history in R2, initializing new repo...");
    await gitInit(siteId);

    // Load pages.json from R2
    const pagesJson = await getFileFromR2(siteId, "public/pages.json");
    if (pagesJson) {
      await gitWriteFile(siteId, "public/pages.json", pagesJson);

      // Load each page
      const pages = JSON.parse(pagesJson);
      for (const page of pages) {
        const mdContent = await getFileFromR2(siteId, `public/${page.fileName}.md`);
        if (mdContent) {
          await gitWriteFile(siteId, `public/${page.fileName}.md`, mdContent);
        }
        const htmlContent = await getFileFromR2(siteId, `public/${page.fileName}.html`);
        if (htmlContent) {
          await gitWriteFile(siteId, `public/${page.fileName}.html`, htmlContent);
        }
      }
    }

    // Load images.json from R2
    const imagesJson = await getFileFromR2(siteId, "public/images.json");
    if (imagesJson) {
      await gitWriteFile(siteId, "public/images.json", imagesJson);
    }

    // Load documents.json from R2
    const documentsJson = await getFileFromR2(siteId, "public/documents.json");
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
