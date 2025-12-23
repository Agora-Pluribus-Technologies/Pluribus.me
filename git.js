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
        email: `${username}@noreply.pluribus.me`,
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
    const commits = await git.log({ fs, dir, depth });
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

  for (const commit of commits) {
    const date = new Date(commit.commit.author.timestamp * 1000);
    const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();
    const shortSha = commit.oid.substring(0, 7);
    const message = escapeHtml(commit.commit.message);
    const author = escapeHtml(commit.commit.author.name);

    html += `<div style="border-bottom: 1px solid #ddd; padding: 10px 0;">`;
    html += `<div style="display: flex; justify-content: space-between; align-items: center;">`;
    html += `<strong style="color: #337ab7;">${shortSha}</strong>`;
    html += `<span style="color: #888; font-size: 12px;">${dateStr}</span>`;
    html += `</div>`;
    html += `<div style="margin-top: 5px;">${message}</div>`;
    html += `<div style="color: #888; font-size: 12px; margin-top: 3px;">by ${author}</div>`;
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

// Format changes for display in the commit modal
async function formatChangesForDisplay(siteId) {
  const changes = await gitStatus(siteId);

  if (changes.length === 0) {
    return "<p style='color: #888;'>No changes to commit.</p>";
  }

  let html = "";

  for (const change of changes) {
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

    html += `<div style="margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 10px;">`;
    html += `<div style="color: ${statusColor}; margin-bottom: 5px;"><strong>[${statusSymbol}] ${change.filepath}</strong></div>`;

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
        displayName: fileName === "index" ? "Home" : item.displayName,
        fileName: fileName,
      };
    });
    await gitWriteFile(siteId, "public/pages.json", JSON.stringify(pages));

    // Write images.json
    await gitWriteFile(siteId, "public/images.json", JSON.stringify(imageCache));

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
    // Check if repo already exists
    try {
      await pfs.stat(`${dir}/.git`);
      console.log("Git repo already exists, skipping R2 sync");
      return true;
    } catch (e) {
      // Repo doesn't exist, need to init and load from R2
    }

    // Initialize the repo
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
