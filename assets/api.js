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

// Save multiple files to R2 in a batch
async function saveFilesToR2(siteId, files) {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteId,
      files,
    }),
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
    { name: "Google", icon: "/assets/Google_G_logo.svg", path: "/api/auth/google/start", style: "" },
    { name: "GitHub", icon: "/assets/Octicons-mark-github.svg", path: "/api/auth/github/start", style: "filter: invert(1);" },
    { name: "GitLab", icon: "/assets/GitLab_icon.svg", path: "/api/auth/gitlab/start", style: "" },
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

// Combined initial commit with git history - single R2 call
async function initialCommitWithGitHistory(siteId, siteSettings = {}) {
  const { siteName, repo, owner, siteType, importedPages } = siteSettings;
  const isBlog = siteType === "blog";

  const siteJson = {
    siteName: siteName || repo || "Untitled Site",
    repo: repo || siteId.split("/")[1] || "",
    owner: owner || siteId.split("/")[0] || "",
    siteType: siteType || "pages",
    createdAt: new Date().toISOString(),
    ...(isBlog ? {} : { showHistory: true }),
  };

  // Imported-folder flow: caller passes already-parsed pages from a vault.
  // Skip the default Home page and seed pages.json from the import instead.
  const hasImport = !isBlog && Array.isArray(importedPages) && importedPages.length > 0;

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
  if (isBlog) {
    pagesJson = [];
  } else if (hasImport) {
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
  await gitWriteFile(siteId, "public/pages.json", JSON.stringify(pagesJson));
  await gitWriteFile(siteId, "public/images.json", "[]");
  if (hasImport) {
    for (const page of pagesToWrite) {
      await gitWriteFile(siteId, `public/${page.fileName}.md`, page.content);
    }
  } else if (!isBlog) {
    await gitWriteFile(siteId, "public/home.md", defaultHomeContent);
  }
  await gitCommit(siteId, hasImport ? "Initial import" : "Initial commit");
  console.log("Git repo initialized for site:", siteId);

  // Serialize git history
  const gitData = await serializeGitDirectory(siteId);
  if (!gitData) {
    console.error("Failed to serialize git directory");
    return false;
  }
  const gitHistoryJson = JSON.stringify(gitData);

  // Fetch the appropriate template for the initial deploy
  const templatePath = isBlog ? "/templates/blog-template.html" : "/templates/owo-template.html";
  let templateHtml = "";
  try {
    const templateResp = await fetch(templatePath, {
      method: "GET",
      headers: { "Cache-Control": "no-cache, must-revalidate" },
    });
    if (templateResp.ok) {
      templateHtml = await templateResp.text();
    }
  } catch (e) {
    console.warn("Failed to fetch template for initial deploy:", e);
  }

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
      content: JSON.stringify(pagesJson),
      contentType: "application/json",
    },
    {
      filePath: "public/images.json",
      content: "[]",
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

  // Add template and home page content for pages sites
  if (templateHtml) {
    files.push({
      filePath: "public/index.html",
      content: templateHtml,
      contentType: "text/html",
    });
  }

  if (hasImport) {
    for (const page of pagesToWrite) {
      files.push({
        filePath: `public/${page.fileName}.md`,
        content: page.content,
        contentType: "text/markdown",
      });
      if (templateHtml) {
        files.push({
          filePath: `public/${page.fileName}.html`,
          content: templateHtml,
          contentType: "text/html",
        });
      }
    }
  } else if (!isBlog) {
    files.push({
      filePath: "public/home.md",
      content: defaultHomeContent,
      contentType: "text/markdown",
    });
    if (templateHtml) {
      files.push({
        filePath: "public/home.html",
        content: templateHtml,
        contentType: "text/html",
      });
    }
  }

  const result = await saveFilesToR2(siteId, files);
  if (result) {
    console.log("Initial commit with full deploy completed successfully");
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

  // Determine which template to use based on site type
  const isBlogSite = currentSiteType === "blog";
  const templatePath = isBlogSite ? "/templates/blog-template.html" : "/templates/owo-template.html";

  var templateResp = await fetch(templatePath, {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const template = await templateResp.text();

  const files = [];

  // Determine which markdown files actually changed in the latest commit
  const changedMd = new Set();
  const deletedMd = new Set();
  try {
    const recent = await gitLog(siteId, 1);
    if (recent.length > 0) {
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

  // Handle deletions: markdown files removed in this commit
  for (const deletedFile of deletedMd) {
    console.log("Preparing to delete file:", deletedFile);
    if (!isBlogSite) {
      files.push({ filePath: deletedFile.replace(".md", ".html"), action: "delete" });
    }
    files.push({ filePath: deletedFile, action: "delete" });
  }

  // Handle creates and updates: only files that actually changed
  for (const cacheItem of markdownCache) {
    if (!changedMd.has(cacheItem.fileName)) continue;
    console.log("Preparing to update file:", cacheItem.fileName);
    if (!isBlogSite) {
      files.push({
        filePath: cacheItem.fileName.replace(".md", ".html"),
        content: template,
        contentType: "text/html",
      });
    }
    files.push({
      filePath: cacheItem.fileName,
      content: cacheItem.content,
      contentType: "text/markdown",
    });
  }

  // Update pages.json (exclude latest.md)
  const pages = markdownCache
    .filter(item => item.fileName !== "public/latest.md")
    .map(item => {
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
    content: JSON.stringify(pages),
    contentType: "application/json",
  });

  // Generate latest.md for blog sites (the most recent post by date)
  if (isBlogSite && markdownCache.length > 0) {
    let latestItem = null;
    let latestDate = null;

    for (const item of markdownCache) {
      let postDate = null;
      // Try to extract date from frontmatter
      const frontmatterMatch = item.content.match(/^---\n([\s\S]*?)\n---\n/);
      if (frontmatterMatch) {
        const dateMatch = frontmatterMatch[1].match(/^date:\s*(.+)$/m);
        if (dateMatch) {
          postDate = new Date(dateMatch[1].trim());
        }
      }
      // Fall back to modifiedAt
      if (!postDate || isNaN(postDate.getTime())) {
        postDate = new Date(item.modifiedAt || item.createdAt || 0);
      }

      if (!latestDate || postDate > latestDate) {
        latestDate = postDate;
        latestItem = item;
      }
    }

    if (latestItem) {
      files.push({
        filePath: "public/latest.md",
        content: latestItem.content,
        contentType: "text/markdown",
      });
    }
  }

  // Update images.json
  files.push({
    filePath: "public/images.json",
    content: JSON.stringify(imageCache),
    contentType: "application/json",
  });

  // Update folders.json (folder display names + sort orders) for pages sites
  if (!isBlogSite) {
    const safeFolderMeta = (typeof folderMeta === "object" && folderMeta) ? folderMeta : {};
    files.push({
      filePath: "public/folders.json",
      content: JSON.stringify(safeFolderMeta),
      contentType: "application/json",
    });
  }

  // Generate history.json from git log
  const historyJson = await generateHistoryJson(siteId);
  files.push({
    filePath: "public/history.json",
    content: JSON.stringify(historyJson),
    contentType: "application/json",
  });

  // Generate wikilinks.json (backlink index) for pages sites
  if (!isBlogSite && typeof AgoraWikilinks !== "undefined") {
    try {
      const indexablePages = markdownCache
        .filter(c => c.fileName !== "public/latest.md")
        .map(c => ({
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
      const backlinks = AgoraWikilinks.buildBacklinkIndex(
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

  // Update index.html (use the appropriate template)
  files.push({
    filePath: "public/index.html",
    content: template,
    contentType: "text/html",
  });

  if (files.length > 0) {
    const result = await saveFilesToR2(siteId, files);
    if (result) {
      console.log("Deployed changes to R2");
    } else {
      modified = true;
      console.error("Failed to deploy changes to R2");
    }
    updateDeployButtonState();
    return result;
  }

  return true;
}

// Deploy only a single changed blog post plus essential metadata
// changedPost: { fileName, content?, oldFileName?, action? }
async function deployBlogPost(siteId, changedPost) {
  modified = false;
  updateDeployButtonState();

  const files = [];

  // Handle the changed post
  if (changedPost.action === 'delete') {
    files.push({ filePath: changedPost.fileName, action: "delete" });
  } else {
    // Add or update the post
    files.push({
      filePath: changedPost.fileName,
      content: changedPost.content,
      contentType: "text/markdown",
    });
    // If renamed, delete the old file
    if (changedPost.oldFileName) {
      files.push({ filePath: changedPost.oldFileName, action: "delete" });
    }
  }

  // Always update pages.json (exclude latest.md)
  const pages = markdownCache
    .filter(item => item.fileName !== "public/latest.md")
    .map(item => {
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
    content: JSON.stringify(pages),
    contentType: "application/json",
  });

  // Generate latest.md (most recent post by date)
  if (markdownCache.length > 0) {
    let latestItem = null;
    let latestDate = null;

    for (const item of markdownCache) {
      let postDate = null;
      const frontmatterMatch = item.content.match(/^---\n([\s\S]*?)\n---\n/);
      if (frontmatterMatch) {
        const dateMatch = frontmatterMatch[1].match(/^date:\s*(.+)$/m);
        if (dateMatch) {
          postDate = new Date(dateMatch[1].trim());
        }
      }
      if (!postDate || isNaN(postDate.getTime())) {
        postDate = new Date(item.modifiedAt || item.createdAt || 0);
      }

      if (!latestDate || postDate > latestDate) {
        latestDate = postDate;
        latestItem = item;
      }
    }

    if (latestItem) {
      files.push({
        filePath: "public/latest.md",
        content: latestItem.content,
        contentType: "text/markdown",
      });
    }
  }

  // Generate history.json from git log
  const historyJson = await generateHistoryJson(siteId);
  files.push({
    filePath: "public/history.json",
    content: JSON.stringify(historyJson),
    contentType: "application/json",
  });

  // Update site.json
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

  // Update index.html with blog template
  const templateResp = await fetch("/templates/blog-template.html", {
    method: "GET",
    headers: { "Cache-Control": "no-cache, must-revalidate" },
  });
  const template = await templateResp.text();
  files.push({
    filePath: "public/index.html",
    content: template,
    contentType: "text/html",
  });

  const result = await saveFilesToR2(siteId, files);
  if (result) {
    console.log("Blog post deployed to R2");
  } else {
    modified = true;
    console.error("Failed to deploy blog post to R2");
  }
  updateDeployButtonState();
  return result;
}

async function createPage(siteId, pageName) {
  var owoTemplateResp = await fetch("/templates/owo-template.html", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const owoTemplate = await owoTemplateResp.text();

  const files = [
    {
      filePath: `public/${pageName}.html`,
      content: owoTemplate,
      contentType: "text/html",
    },
    {
      filePath: `public/${pageName}.md`,
      content: `# ${pageName}\n\nThis is your new page.`,
      contentType: "text/markdown",
    },
  ];

  return await saveFilesToR2(siteId, files);
}

async function deletePage(siteId, pageName) {
  const files = [
    { filePath: `public/${pageName}.html`, action: "delete" },
    { filePath: `public/${pageName}.md`, action: "delete" },
  ];

  return await saveFilesToR2(siteId, files);
}

async function renamePage(siteId, pageName, newPageName) {
  const htmlContent = await getFileFromR2(siteId, `public/${pageName}.html`);
  const mdContent = await getFileFromR2(siteId, `public/${pageName}.md`);

  if (!htmlContent || !mdContent) {
    console.error("Failed to read existing page files for rename");
    return false;
  }

  const files = [
    { filePath: `public/${newPageName}.html`, content: htmlContent, contentType: "text/html" },
    { filePath: `public/${newPageName}.md`, content: mdContent, contentType: "text/markdown" },
    { filePath: `public/${pageName}.html`, action: "delete" },
    { filePath: `public/${pageName}.md`, action: "delete" },
  ];

  return await saveFilesToR2(siteId, files);
}

async function uploadImage(siteId, filename, base64Content) {
  const result = await saveFileToR2(siteId, `public/${filename}`, base64Content, {
    encoding: "base64",
    contentType: guessContentType(filename),
  });

  if (result) {
    console.log("Image uploaded to R2 successfully:", filename);
  } else {
    console.error("Failed to upload image to R2");
  }

  return result;
}

async function deleteImage(siteId, filename) {
  const result = await deleteFileFromR2(siteId, `public/${filename}`);

  if (result) {
    console.log("Image deleted from R2 successfully:", filename);
  } else {
    console.error("Failed to delete image from R2");
  }

  return result;
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


// ==================== Subscriber / Mailing List Functions ====================

async function getSubscribers(siteId) {
  const params = new URLSearchParams({ siteId });
  const response = await fetch(`/api/subscribers?${params.toString()}`);

  if (!response.ok) {
    console.error("Failed to fetch subscribers:", response.status);
    return { subscribers: [], count: 0 };
  }

  return await response.json();
}

async function removeSubscriber(siteId, subscriberId) {
  const params = new URLSearchParams({ siteId, id: subscriberId });

  const response = await fetch(`/api/subscribers?${params.toString()}`, {
    method: "DELETE",
  });

  return response.ok;
}

async function importSubscribers(siteId, emails) {
  const response = await fetch("/api/subscribers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, emails }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return await response.json();
}

async function notifySubscribers(siteId, postTitle, postExcerpt, postUrl) {
  const response = await fetch("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, postTitle, postExcerpt, postUrl }),
  });

  if (!response.ok) {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      throw new Error(json.message || "Failed to send notifications");
    } catch (e) {
      if (e.message !== "Failed to send notifications") throw e;
      throw new Error(text);
    }
  }

  return await response.json();
}

