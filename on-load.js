// Global cache for markdown files - Array of {displayName, fileName, content, createdAt, modifiedAt}
let markdownCache = [];
let currentSitePath = null;
let currentSiteId = null;
let currentSitePathFull = null;
let lastDeployTimeInterval = null;
let modified = false;

// Global cache for sites list
let sitesCache = [];
let sharedSitesCache = [];

// Global cache for images - Array of filenames
let imageCache = [];

// Helper functions for markdownCache
function getCacheByFileName(fileName) {
  return markdownCache.find(item => item.fileName === fileName);
}

function getCacheByDisplayName(displayName) {
  return markdownCache.find(item => item.displayName === displayName);
}

function addOrUpdateCache(fileName, displayName, content, options = {}) {
  const existing = getCacheByFileName(fileName);
  const now = new Date().toISOString();

  if (existing) {
    if (displayName) {
      existing.displayName = displayName;
    } else {
      displayName = existing.displayName;
    }
    if (content) {
      existing.content = content;
    } else {
      content = existing.content;
    }
    // Update modifiedAt unless we're just loading from storage
    if (!options.preserveTimestamps) {
      existing.modifiedAt = now;
    }
  } else {
    // For new entries, use provided timestamps or current time
    markdownCache.push({
      displayName,
      fileName,
      content,
      createdAt: options.createdAt || now,
      modifiedAt: options.modifiedAt || now,
    });
  }
}

function removeCacheByFileName(fileName) {
  const index = markdownCache.findIndex(item => item.fileName === fileName);
  if (index !== -1) {
    markdownCache.splice(index, 1);
  }
}

// Helper functions for imageCache
function addImageToCache(filename) {
  if (!imageCache.includes(filename)) {
    imageCache.push(filename);
  }
}

function removeImageFromCache(filename) {
  const index = imageCache.indexOf(filename);
  if (index !== -1) {
    imageCache.splice(index, 1);
  }
}

function isImageInCache(filename) {
  return imageCache.includes(filename);
}

// Interval for checking site availability
let siteAvailabilityInterval = null;

// Helper function to refresh and display collaborators list
async function refreshCollaboratorsList(siteId, isOwner) {
  const collaboratorsList = document.getElementById("collaboratorsList");

  try {
    const collaborators = await getCollaborators(siteId);

    if (collaborators.length === 0) {
      collaboratorsList.innerHTML = "<p style='color: #888;'>No collaborators yet.</p>";
      return;
    }

    let html = '<ul class="list-group">';
    for (const collab of collaborators) {
      html += `<li class="list-group-item" style="display: flex; justify-content: space-between; align-items: center;">
        <span>${collab.username}</span>`;

      if (isOwner) {
        html += `<button class="btn btn-danger btn-xs remove-collaborator-btn" data-user-id="${collab.userId}" data-username="${collab.username}">Remove</button>`;
      }

      html += '</li>';
    }
    html += '</ul>';

    collaboratorsList.innerHTML = html;

    // Add event listeners for remove buttons
    if (isOwner) {
      const removeButtons = collaboratorsList.querySelectorAll(".remove-collaborator-btn");
      removeButtons.forEach(btn => {
        btn.addEventListener("click", async function () {
          const userId = this.dataset.userId;
          const username = this.dataset.username;

          if (!confirm(`Remove ${username} as a collaborator?`)) {
            return;
          }

          this.disabled = true;
          this.textContent = "...";

          try {
            await removeCollaborator(siteId, userId);
            await refreshCollaboratorsList(siteId, isOwner);
          } catch (error) {
            alert("Failed to remove collaborator: " + error.message);
            this.disabled = false;
            this.textContent = "Remove";
          }
        });
      });
    }
  } catch (error) {
    console.error("Error loading collaborators:", error);
    collaboratorsList.innerHTML = "<p style='color: #ff4444;'>Failed to load collaborators.</p>";
  }
}

// Open a site in the editor
async function openSiteInEditor(site, initialPage = "index") {
  console.log(`Loading site: ${site.displayName || site.repo} (ID: ${site.siteId})`);

  // Set current site ID
  currentSiteId = site.siteId;
  currentSitePathFull = site.siteId;
  console.log("Current site path full:", currentSitePathFull);

  // Update Visit Site button URL
  const visitSiteButton = document.getElementById("visitSiteButton");
  if (visitSiteButton && currentSitePathFull) {
    const pluribusSiteUrl = `/s/${currentSitePathFull}`;
    visitSiteButton.onclick = function () {
      window.open(pluribusSiteUrl, "_blank");
    };
    visitSiteButton.disabled = false;
    console.log("Visit Site button updated to:", pluribusSiteUrl);

    // Start site availability check
    // Clear any existing interval first
    if (siteAvailabilityInterval) {
      clearInterval(siteAvailabilityInterval);
      siteAvailabilityInterval = null;
    }

    // Check immediately
    checkSiteAvailability();

    // Then check every 5 seconds
    siteAvailabilityInterval = setInterval(checkSiteAvailability, 5000);
    console.log("Started site availability check interval");
  }

  modified = false;

  // Update deploy button state (should be disabled since not modified)
  updateDeployButtonState();

  // Hide sites list panel
  const sitesListPanel = document.getElementById("sites-list-panel");
  sitesListPanel.style.display = "none";

  // Show editor panel
  const editorContainer = document.getElementById("editorContainer");
  editorContainer.style.display = "flex";

  // Fetch site tree from R2
  const markdownFiles = await getPublicFiles(currentSiteId);

  console.log("Markdown files:", markdownFiles);
  if (markdownFiles.length === 0) {
    // No markdown files found - create a dummy index.md
    console.log("Site is empty - created dummy index.md");
    addOrUpdateCache(
      "public/index.md",
      "Home",
      "# Welcome to your Agora Site!\n\nThis is your site's homepage. Edit this file to customize your site."
    );
    // Initialize empty imageCache
    imageCache = [];
  } else {
    // Initialize markdownCache from pages.json
    markdownCache = JSON.parse(await getFileContent(currentSiteId, "public/pages.json"));
    for (let i=0; i < markdownCache.length; i++) {
      const fileName = markdownCache[i].fileName;
      markdownCache[i].fileName = `public/${fileName}.md`
    }

    // Load all markdown files into cache (preserve timestamps from pages.json)
    for (const file of markdownFiles) {
      console.log("Loading file into cache:", file);
      const content = await getFileContent(currentSiteId, file);
      addOrUpdateCache(file, null, content, { preserveTimestamps: true });
    }

    // Initialize imageCache from images.json
    try {
      const imagesJsonContent = await getFileContent(currentSiteId, "public/images.json");

      if (imagesJsonContent) {
        imageCache = JSON.parse(imagesJsonContent);
        console.log("Loaded imageCache:", imageCache);
      } else {
        imageCache = [];
        console.log("images.json not found, initialized empty imageCache");
      }
    } catch (error) {
      console.error("Error loading images.json:", error);
      imageCache = [];
    }
  }

  // Initialize git repo and load files from R2
  await loadR2ToGit(currentSiteId);

  // Populate menubar from cache
  await populateMenubar(site.siteId);

  // Load the editor
  loadToastEditor();

  // Find and click the appropriate page tab
  setTimeout(() => {
    const menubarItems = document.querySelectorAll(".menubar-item");
    const fileName = `public/${initialPage}.md`;
    let pageFound = false;

    for (const item of menubarItems) {
      const text = item.querySelector("span");
      if (text) {
        // Check if this menubar item matches the requested page
        const cacheItem = markdownCache.find(c =>
          c.fileName === fileName ||
          c.displayName.toLowerCase() === initialPage.toLowerCase() ||
          (initialPage === "index" && c.displayName === "Home")
        );

        if (cacheItem && text.textContent === cacheItem.displayName) {
          console.log("Opening page:", cacheItem.displayName);
          text.click();
          pageFound = true;

          // Set up editor change listener to update cache
          editor.off("change");
          editor.on("change", function () {
            if (currentSitePath) {
              const cacheItem = getCacheByFileName(currentSitePath);
              if (cacheItem) {
                let currentMarkdown = editor.getMarkdown();
                cacheItem.content = currentMarkdown;
                cacheItem.modifiedAt = new Date().toISOString();
                console.log(`Cached content for ${currentSitePath}`);
                modified = true;
                updateDeployButtonState();
              }
            }
          });

          // Ensure modified flag is false on initial load
          modified = false;
          break;
        }
      }
    }

    // Fallback to Home if requested page not found
    if (!pageFound) {
      console.log("Page not found:", initialPage, "- opening Home");
      for (const item of menubarItems) {
        const text = item.querySelector("span");
        if (text && text.textContent === "Home") {
          text.click();

          editor.off("change");
          editor.on("change", function () {
            if (currentSitePath) {
              const cacheItem = getCacheByFileName(currentSitePath);
              if (cacheItem) {
                let currentMarkdown = editor.getMarkdown();
                cacheItem.content = currentMarkdown;
                cacheItem.modifiedAt = new Date().toISOString();
                console.log(`Cached content for ${currentSitePath}`);
                modified = true;
                updateDeployButtonState();
              }
            }
          });

          modified = false;
          break;
        }
      }
    }
  }, 100);
}

// Store pending site info for mode selection
let pendingSite = null;
let pendingPagePath = "index";

// Show mode selection panel
function showModeSelection(site, pagePath = "index") {
  pendingSite = site;
  pendingPagePath = pagePath;

  // Hide sites list panel
  const sitesListPanel = document.getElementById("sites-list-panel");
  sitesListPanel.style.display = "none";

  // Show mode selection panel
  const modeSelectionPanel = document.getElementById("modeSelectionPanel");
  modeSelectionPanel.style.display = "block";

  // Update site name
  const modeSelectionSiteName = document.getElementById("modeSelectionSiteName");
  modeSelectionSiteName.textContent = `${site.owner}/${site.displayName || site.repo}`;
}

// Open file manager for a site
async function openFileManager(site) {
  console.log("Opening file manager for site:", site.siteId);

  currentSiteId = site.siteId;
  currentSitePathFull = site.siteId;

  // Hide mode selection panel
  const modeSelectionPanel = document.getElementById("modeSelectionPanel");
  modeSelectionPanel.style.display = "none";

  // Show file manager
  const fileManagerContainer = document.getElementById("fileManagerContainer");
  fileManagerContainer.style.display = "block";

  // Update site name
  const fileManagerSiteName = document.getElementById("fileManagerSiteName");
  fileManagerSiteName.textContent = `${site.owner}/${site.displayName || site.repo}`;

  // Update Visit Site button
  const visitSiteButton = document.getElementById("fileManagerVisitSiteButton");
  const pluribusSiteUrl = `/s/${currentSitePathFull}`;
  visitSiteButton.onclick = function () {
    window.open(pluribusSiteUrl, "_blank");
  };

  // Load and display files
  await refreshFileList();
}

// Refresh file list in file manager
async function refreshFileList() {
  const fileList = document.getElementById("fileList");
  fileList.innerHTML = '<p class="file-list-loading">Loading files...</p>';

  try {
    const files = await listSiteFiles(currentSiteId);

    if (files.length === 0) {
      fileList.innerHTML = '<p class="file-list-empty">No files uploaded yet. Drag and drop files above to get started.</p>';
      return;
    }

    fileList.innerHTML = "";

    // Sort files by name
    files.sort((a, b) => a.key.localeCompare(b.key));

    for (const file of files) {
      const fileItem = document.createElement("div");
      fileItem.className = "file-item";

      // File icon based on extension
      const ext = file.key.split(".").pop().toLowerCase();
      let icon = "📄";
      if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) icon = "🖼️";
      else if (["html", "htm"].includes(ext)) icon = "🌐";
      else if (["css"].includes(ext)) icon = "🎨";
      else if (["js"].includes(ext)) icon = "⚡";
      else if (["json"].includes(ext)) icon = "📋";
      else if (["md"].includes(ext)) icon = "📝";

      // Format file size
      let sizeStr = "";
      if (file.size < 1024) {
        sizeStr = file.size + " B";
      } else if (file.size < 1024 * 1024) {
        sizeStr = (file.size / 1024).toFixed(1) + " KB";
      } else {
        sizeStr = (file.size / (1024 * 1024)).toFixed(1) + " MB";
      }

      fileItem.innerHTML = `
        <span class="file-item-icon">${icon}</span>
        <span class="file-item-name">${file.key}</span>
        <span class="file-item-size">${sizeStr}</span>
        <button class="file-item-delete" title="Delete file">×</button>
      `;

      // Delete button handler
      const deleteBtn = fileItem.querySelector(".file-item-delete");
      deleteBtn.addEventListener("click", async () => {
        if (confirm(`Delete "${file.key}"?`)) {
          const success = await deleteFileFromR2(currentSiteId, file.key);
          if (success) {
            await refreshFileList();
          } else {
            alert("Failed to delete file.");
          }
        }
      });

      fileList.appendChild(fileItem);
    }
  } catch (error) {
    console.error("Error loading files:", error);
    fileList.innerHTML = '<p class="file-list-empty">Error loading files.</p>';
  }
}

// Allowed file extensions for upload
const ALLOWED_EXTENSIONS = [
  // HTML
  "html", "htm",
  // CSS
  "css",
  // Data
  "json", "md", "txt",
  // Images
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif",
  // Fonts
  "woff", "woff2", "ttf", "eot", "otf",
  // Archives
  "zip"
];

// Handle file upload from dropzone
async function handleFileUpload(files) {
  if (!files || files.length === 0) return;

  const fileList = document.getElementById("fileList");

  // Filter files by allowed extensions
  const allowedFiles = [];
  const rejectedFiles = [];

  for (const file of files) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      allowedFiles.push(file);
    } else {
      rejectedFiles.push(file.name);
    }
  }

  // Warn about rejected files
  if (rejectedFiles.length > 0) {
    alert(`The following files were not uploaded (unsupported file type):\n${rejectedFiles.join("\n")}\n\nAllowed types: HTML, CSS, JS, JSON, Markdown, images, fonts, and ZIP files.`);
  }

  if (allowedFiles.length === 0) return;

  for (const file of allowedFiles) {
    // Show upload progress
    const uploadingItem = document.createElement("div");
    uploadingItem.className = "file-item";
    uploadingItem.innerHTML = `
      <span class="file-item-icon">⏳</span>
      <span class="file-item-name">Uploading ${file.name}...</span>
    `;
    fileList.insertBefore(uploadingItem, fileList.firstChild);

    try {
      // Upload to public/ folder
      const filePath = `public/${file.name}`;
      await uploadFileToR2(currentSiteId, filePath, file);
      console.log("Uploaded:", filePath);
    } catch (error) {
      console.error("Error uploading file:", error);
      alert(`Failed to upload ${file.name}`);
    }
  }

  // Refresh file list after all uploads
  await refreshFileList();
}

// Handle edit context from /edit route
async function handleEditContext(username) {
  const editContext = window.PLURIBUS_EDIT_CONTEXT;
  if (!editContext) return;

  console.log("Handling edit context:", editContext);

  // Clear the edit context from sessionStorage since we're handling it now
  sessionStorage.removeItem("agorapages.com.edit_context");
  window.PLURIBUS_EDIT_CONTEXT = null;

  // Check permission: user must be owner or collaborator
  const permission = await checkUserCanEditSite(editContext.siteId, username);
  if (!permission.canEdit) {
    console.error("Permission denied: user", username, "cannot edit site", editContext.siteId);
    showAlertBar("You don't have permission to edit this site.", false);
    return;
  }

  // Find the site in sitesCache or sharedSitesCache, or fetch it if not found
  let site = sitesCache.find(s => s.siteId === editContext.siteId);
  if (!site) {
    site = sharedSitesCache.find(s => s.siteId === editContext.siteId);
  }

  if (!site) {
    // Site not in cache - fetch the site config
    try {
      const response = await fetch(`/api/sites?siteId=${encodeURIComponent(editContext.siteId)}`);
      if (response.ok) {
        site = await response.json();
      }
    } catch (error) {
      console.error("Error fetching site config:", error);
    }
  }

  if (!site) {
    console.error("Site not found:", editContext.siteId);
    showAlertBar("Site not found.", false);
    return;
  }

  // Show mode selection instead of directly opening editor
  const pagePath = editContext.pagePath || "index";
  showModeSelection(site, pagePath);
}

// Load sites for a specific user
async function loadSitesForUser(username) {
  console.log("Loading sites for user:", username);

  // Fetch sites owned by user and sites shared with user in parallel
  const [ownedSites, sharedSites] = await Promise.all([
    getSites(username),
    getSharedSites(username)
  ]);

  // Cache the sites lists
  sitesCache = ownedSites || [];
  sharedSitesCache = sharedSites || [];

  console.log("Owned sites:", sitesCache.length, "Shared sites:", sharedSitesCache.length);

  const sitesListHeader = document.getElementById("sites-list-header");
  sitesListHeader.style.display = "block";

  populateSitesList(sitesCache, sharedSitesCache);
}

document.addEventListener("DOMContentLoaded", async function () {
  // Check for edit context - either from injected script or from sessionStorage
  if (window.PLURIBUS_EDIT_CONTEXT) {
    // Save to sessionStorage so it persists through OAuth redirect
    sessionStorage.setItem("agorapages.com.edit_context", JSON.stringify(window.PLURIBUS_EDIT_CONTEXT));
    console.log("Saved edit context to sessionStorage");
  } else {
    // Try to restore from sessionStorage
    const savedContext = sessionStorage.getItem("agorapages.com.edit_context");
    if (savedContext) {
      try {
        window.PLURIBUS_EDIT_CONTEXT = JSON.parse(savedContext);
        console.log("Restored edit context from sessionStorage:", window.PLURIBUS_EDIT_CONTEXT);
      } catch (e) {
        console.error("Failed to parse saved edit context:", e);
        sessionStorage.removeItem("agorapages.com.edit_context");
      }
    }
  }

  if (getOauthTokenGithub() === null && getOauthTokenGitlab() === null && getOauthTokenGoogle() === null) {
    console.log("Access tokens missing or expired");
    displayLoginButtons();
  } else {
    console.log("Access token present and valid");

    // Check if user has a username
    const providerInfo = await getCurrentProviderInfo();
    if (!providerInfo) {
      console.error("Could not get provider info");
      displayLoginButtons();
      return;
    }

    console.log("Provider info:", providerInfo);

    // Check if user already has a username
    const existingUser = await getUserByProvider(providerInfo.provider, providerInfo.providerId);

    if (existingUser && existingUser.username) {
      // User has a username, proceed to load sites
      console.log("User found:", existingUser.username);
      setStoredUsername(existingUser.username);
      showUserMenu(existingUser.username);
      await loadSitesForUser(existingUser.username);

      // Check if we have an edit context (from /edit route)
      if (window.PLURIBUS_EDIT_CONTEXT) {
        await handleEditContext(existingUser.username);
      }
    } else {
      // User needs to select a username
      console.log("New user, showing username selection modal");
      $("#usernameModal").modal("show");
    }
  }

  // Handle username form input for live validation
  const usernameInput = document.getElementById("usernameInput");
  const usernameError = document.getElementById("usernameError");
  const usernameSuccess = document.getElementById("usernameSuccess");
  const submitUsernameButton = document.getElementById("submitUsernameButton");
  const acceptTermsCheckbox = document.getElementById("acceptTermsCheckbox");

  let usernameCheckTimeout = null;
  let usernameIsValid = false;

  // Function to update submit button state based on username and terms
  function updateSubmitButtonState() {
    submitUsernameButton.disabled = !(usernameIsValid && acceptTermsCheckbox.checked);
  }

  // Handle checkbox change
  acceptTermsCheckbox.addEventListener("change", updateSubmitButtonState);

  usernameInput.addEventListener("input", function () {
    const username = usernameInput.value.trim();

    // Clear previous timeout
    if (usernameCheckTimeout) {
      clearTimeout(usernameCheckTimeout);
    }

    // Reset states
    usernameError.style.display = "none";
    usernameSuccess.style.display = "none";
    usernameIsValid = false;
    updateSubmitButtonState();

    // Validate format
    const usernameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,28}[a-zA-Z0-9]$/;
    if (username.length < 3) {
      return;
    }

    if (!usernameRegex.test(username)) {
      usernameError.textContent = "Invalid format. Use letters, numbers, and hyphens only. Cannot start or end with hyphen.";
      usernameError.style.display = "block";
      return;
    }

    // Debounce the API check
    usernameCheckTimeout = setTimeout(async () => {
      const isAvailable = await checkUsernameAvailable(username);
      if (isAvailable) {
        usernameSuccess.textContent = "Username is available!";
        usernameSuccess.style.display = "block";
        usernameError.style.display = "none";
        usernameIsValid = true;
      } else {
        usernameError.textContent = "Username is already taken.";
        usernameError.style.display = "block";
        usernameSuccess.style.display = "none";
        usernameIsValid = false;
      }
      updateSubmitButtonState();
    }, 500);
  });

  // Handle username form submission
  document.getElementById("usernameForm").addEventListener("submit", async function (event) {
    event.preventDefault();

    const username = usernameInput.value.trim();
    const providerInfo = await getCurrentProviderInfo();

    if (!providerInfo) {
      usernameError.textContent = "Could not get provider info. Please try again.";
      usernameError.style.display = "block";
      return;
    }

    // Disable button during submission
    submitUsernameButton.disabled = true;
    submitUsernameButton.textContent = "Creating...";

    try {
      const user = await createUser(username, providerInfo.provider, providerInfo.providerId);
      console.log("User created:", user);

      // Close modal, show user menu, and load sites
      $("#usernameModal").modal("hide");
      showUserMenu(user.username);
      await loadSitesForUser(user.username);
    } catch (error) {
      console.error("Error creating user:", error);
      usernameError.textContent = error.message || "Failed to create username. Please try again.";
      usernameError.style.display = "block";
      submitUsernameButton.disabled = false;
      submitUsernameButton.textContent = "Confirm Username";
    }
  });

  // Warn user before leaving page with unsaved changes
  window.addEventListener("beforeunload", function (event) {
    if (modified) {
      event.preventDefault();
      event.returnValue = ""; // Required for Chrome
      return ""; // Required for some browsers
    }
  });

  // Set username prefix when create site modal is shown
  $("#createSiteModal").on("show.bs.modal", function () {
    const username = getStoredUsername();
    document.getElementById("siteNamePrefix").textContent = username + "/";
    document.getElementById("siteName").value = "";
  });

  // Handle create site form submission
  document
    .getElementById("createSiteForm")
    .addEventListener("submit", async function (event) {
      event.preventDefault();

      // Disable submit button to prevent double clicking
      const submitButton = document.getElementById("create-site-button");
      const originalButtonText = submitButton.innerText;
      submitButton.disabled = true;
      submitButton.innerText = "Creating...";
      submitButton.style.opacity = "0.6";
      submitButton.style.cursor = "not-allowed";

      try {
        const rawSiteName = document.getElementById("siteName").value.trim();

        // Sanitize site name: lowercase, only letters, numbers, and hyphens
        let siteName = rawSiteName
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')  // Replace invalid chars with hyphens
          .replace(/-+/g, '-')           // Collapse multiple hyphens into one
          .replace(/^-+|-+$/g, '');      // Trim hyphens from start and end

        // Truncate to 30 chars max, then trim any trailing hyphen from truncation
        if (siteName.length > 30) {
          siteName = siteName.substring(0, 30).replace(/-+$/, '');
        }

        // Validate that we have a usable site name after sanitization
        if (siteName.length < 2) {
          alert("Site name is too short. Please enter at least 2 valid characters (letters or numbers).");
          submitButton.disabled = false;
          submitButton.innerText = originalButtonText;
          submitButton.style.opacity = "";
          submitButton.style.cursor = "";
          return;
        }

        console.log("Creating new site:", siteName);

        // Get stored username (set during login)
        const owner = getStoredUsername();
        if (!owner) {
          alert("No username found. Please log in again.");
          return;
        }

        // Get provider info
        const providerInfo = await getCurrentProviderInfo();
        const provider = providerInfo ? providerInfo.provider : "unknown";

        // Site name is already validated and sanitized
        const repo = siteName;

        const siteId = `${owner}/${repo}`;

        // Store site config in KV
        const createSiteHeaders = await getHeadersWithTurnstile({
          "Content-Type": "application/json",
        });
        const createResponse = await fetch("/api/sites", {
          method: "POST",
          headers: createSiteHeaders,
          body: JSON.stringify({
            siteId: siteId,
            provider: provider,
            owner: owner,
            repo: repo,
            branch: "main",
            basePath: "/public",
            displayName: siteName,
          }),
        });

        if (!createResponse.ok) {
          const errorText = await createResponse.text();
          console.error("Failed to create site:", errorText);
          alert("Failed to create site: " + errorText);
          return;
        }

        console.log("Site config stored successfully");

        // Create initial files in R2
        await initialCommit(siteId, { siteName, repo, owner });
        console.log("Initial commit completed for site:", siteId);

        // Initialize git repository
        await gitInit(siteId);
        await gitWriteFile(siteId, "public/pages.json", "[]");
        await gitWriteFile(siteId, "public/images.json", "[]");
        await gitCommit(siteId, "Initial commit");
        console.log("Git repo initialized for site:", siteId);

        // Save git history to R2 for persistence
        await saveGitHistoryToR2(siteId);
        console.log("Git history saved to R2 for site:", siteId);

        // Add new site to cache
        const newSite = {
          siteId: siteId,
          provider: provider,
          owner: owner,
          repo: repo,
          branch: "main",
          basePath: "/public",
          displayName: siteName,
        };
        sitesCache.unshift(newSite);

        // Close the modal
        $("#createSiteModal").modal("hide");

        // Clear the form
        document.getElementById("createSiteForm").reset();

        // Repopulate sites list
        populateSitesList(sitesCache, sharedSitesCache);

        // Click into the newly created site to open the editor
        const newSiteButton = document.getElementById(siteId);
        if (newSiteButton) {
          newSiteButton.click();
        }
      } catch (error) {
        console.error("Error creating site:", error);
        alert("Failed to create site. Please try again.");
      } finally {
        // Re-enable submit button
        submitButton.disabled = false;
        submitButton.innerText = originalButtonText;
        submitButton.style.opacity = "1";
        submitButton.style.cursor = "pointer";
      }
    });

  // Handle back button click
  document.getElementById("backButton").addEventListener("click", function () {
    console.log("Back button clicked");

    if (modified) {
      if (
        confirm(
          "You have unsaved changes. Are you sure you want to go back? All unsaved changes will be lost."
        )
      ) {
        window.location.href = document.location.origin + "/builder.html";
      } else {
        document.getElementById("backButton").blur();
      }
    } else {
      window.location.href = document.location.origin + "/builder.html";
    }
  });

  // Handle deploy button click - show commit modal
  document
    .getElementById("deployButton")
    .addEventListener("click", async function () {
      console.log("Deploy button clicked");
      console.log("Current site ID:", currentSiteId);
      console.log("Markdown cache:", markdownCache);

      if (!currentSiteId) {
        console.error("No site selected");
        return;
      }

      // Sync current cache to git working directory
      await syncCacheToGit(currentSiteId, markdownCache, imageCache);

      // Get and display changes
      const changesPreview = document.getElementById("changesPreview");
      changesPreview.innerHTML = "<p style='color: #888;'>Loading changes...</p>";

      const changesHtml = await formatChangesForDisplay(currentSiteId);
      changesPreview.innerHTML = changesHtml;

      // Clear commit message
      document.getElementById("commitMessage").value = "";

      // Show commit modal
      $("#commitModal").modal("show");
    });

  // Handle commit confirmation
  document
    .getElementById("confirmCommitButton")
    .addEventListener("click", async function () {
      const commitMessage = document.getElementById("commitMessage").value.trim();

      if (!commitMessage) {
        alert("Please enter a commit message.");
        return;
      }

      const confirmButton = document.getElementById("confirmCommitButton");
      const originalText = confirmButton.textContent;
      confirmButton.disabled = true;
      confirmButton.textContent = "Deploying...";

      // Close modal and show deploy overlay
      $("#commitModal").modal("hide");
      showDeployOverlay("Deploying site...");

      try {
        // Create git commit
        const commitSha = await gitCommit(currentSiteId, commitMessage);
        console.log("Commit created:", commitSha);

        // Deploy changes to R2 storage
        const deploySuccess = await deployChanges(currentSiteId);

        // Save git history to R2 for persistence
        if (deploySuccess) {
          await saveGitHistoryToR2(currentSiteId);
          console.log("Git history saved to R2");
        }

        // Reset modified flag after successful deployment
        modified = false;
        updateDeployButtonState();

        // Show success or failure message
        if (deploySuccess) {
          showAlertBar("Deployed successfully!", true);
        } else {
          showAlertBar("Deploy failed. Please check the console for errors.", false);
        }
      } catch (error) {
        console.error("Deploy error:", error);
        showAlertBar("Deploy failed: " + error.message, false);
      } finally {
        hideDeployOverlay();
        confirmButton.disabled = false;
        confirmButton.textContent = originalText;
      }
    });

  // Handle history button click
  document
    .getElementById("historyButton")
    .addEventListener("click", async function () {
      if (!currentSiteId) {
        console.error("No site selected");
        return;
      }

      // Show modal with loading state
      const historyList = document.getElementById("historyList");
      historyList.innerHTML = "<p style='color: #888;'>Loading edit history...</p>";
      $("#historyModal").modal("show");

      // Fetch and display commit history
      const historyHtml = await formatCommitHistory(currentSiteId);
      historyList.innerHTML = historyHtml;
    });

  // Handle site settings button click
  document
    .getElementById("siteSettingsButton")
    .addEventListener("click", async function () {
      if (!currentSiteId) {
        console.error("No site selected");
        return;
      }

      // Get site info
      const site = sitesCache.find(s => s.siteId === currentSiteId);
      const username = getStoredUsername();
      const isOwner = site && site.owner.toLowerCase() === username.toLowerCase();

      // Update modal content
      document.getElementById("siteSettingsName").textContent = site ? (site.displayName || site.repo) : currentSiteId;
      document.getElementById("siteSettingsOwner").textContent = site ? site.owner : currentSiteId.split("/")[0];

      // Show/hide add collaborator section based on ownership
      const addCollaboratorSection = document.getElementById("addCollaboratorSection");
      addCollaboratorSection.style.display = isOwner ? "block" : "none";

      // Clear any previous error/success messages
      document.getElementById("collaboratorError").style.display = "none";
      document.getElementById("collaboratorSuccess").style.display = "none";
      document.getElementById("collaboratorUsernameInput").value = "";

      // Load site.json settings
      try {
        const siteJsonContent = await getFileContent(currentSiteId, "public/site.json");
        if (siteJsonContent) {
          const siteJson = JSON.parse(siteJsonContent);
          document.getElementById("showHistoryCheckbox").checked = siteJson.showHistory || false;
        } else {
          document.getElementById("showHistoryCheckbox").checked = false;
        }
      } catch (error) {
        console.error("Error loading site.json:", error);
        document.getElementById("showHistoryCheckbox").checked = false;
      }

      // Show modal with loading state
      const collaboratorsList = document.getElementById("collaboratorsList");
      collaboratorsList.innerHTML = "<p style='color: #888;'>Loading collaborators...</p>";
      $("#siteSettingsModal").modal("show");

      // Load and display collaborators
      await refreshCollaboratorsList(currentSiteId, isOwner);
    });

  // Handle add collaborator button click
  document
    .getElementById("addCollaboratorButton")
    .addEventListener("click", async function () {
      const usernameInput = document.getElementById("collaboratorUsernameInput");
      const errorElement = document.getElementById("collaboratorError");
      const successElement = document.getElementById("collaboratorSuccess");
      const username = usernameInput.value.trim();

      // Reset messages
      errorElement.style.display = "none";
      successElement.style.display = "none";

      if (!username) {
        errorElement.textContent = "Please enter a username.";
        errorElement.style.display = "block";
        return;
      }

      if (!currentSiteId) {
        errorElement.textContent = "No site selected.";
        errorElement.style.display = "block";
        return;
      }

      const addButton = document.getElementById("addCollaboratorButton");
      addButton.disabled = true;
      addButton.textContent = "Adding...";

      try {
        await addCollaborator(currentSiteId, username);
        successElement.textContent = `Added ${username} as a collaborator.`;
        successElement.style.display = "block";
        usernameInput.value = "";

        // Refresh the list
        await refreshCollaboratorsList(currentSiteId, true);
      } catch (error) {
        errorElement.textContent = error.message || "Failed to add collaborator.";
        errorElement.style.display = "block";
      } finally {
        addButton.disabled = false;
        addButton.textContent = "Add";
      }
    });

  // Handle Enter key in collaborator username input
  document
    .getElementById("collaboratorUsernameInput")
    .addEventListener("keypress", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("addCollaboratorButton").click();
      }
    });

  // Handle save site settings button click
  document
    .getElementById("saveSiteSettingsButton")
    .addEventListener("click", async function () {
      if (!currentSiteId) {
        console.error("No site selected");
        return;
      }

      const saveButton = document.getElementById("saveSiteSettingsButton");
      const originalText = saveButton.textContent;
      saveButton.disabled = true;
      saveButton.textContent = "Saving...";

      try {
        // Load existing site.json
        let siteJson = {};
        try {
          const siteJsonContent = await getFileContent(currentSiteId, "public/site.json");
          if (siteJsonContent) {
            siteJson = JSON.parse(siteJsonContent);
          }
        } catch (error) {
          console.error("Error loading site.json:", error);
        }

        // Update showHistory setting
        const showHistory = document.getElementById("showHistoryCheckbox").checked;
        siteJson.showHistory = showHistory;

        // Save to git working directory
        await gitWriteFile(currentSiteId, "public/site.json", JSON.stringify(siteJson, null, 2));

        // Mark as modified so user needs to deploy
        modified = true;
        updateDeployButtonState();

        // Close modal
        $("#siteSettingsModal").modal("hide");

        showAlertBar("Settings saved. Deploy to apply changes.", true);
      } catch (error) {
        console.error("Error saving site settings:", error);
        showAlertBar("Failed to save settings: " + error.message, false);
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = originalText;
      }
    });

  // Handle click on commit links in history (event delegation)
  document
    .getElementById("historyList")
    .addEventListener("click", async function (e) {
      const commitLink = e.target.closest(".commit-link");
      if (!commitLink) return;

      e.preventDefault();

      const commitOid = commitLink.dataset.commitOid;
      if (!commitOid || !currentSiteId) return;

      const historyList = document.getElementById("historyList");
      const shortSha = commitOid.substring(0, 7);

      // Show loading state with back button
      historyList.innerHTML = `
        <div style="margin-bottom: 15px;">
          <a href="#" id="backToHistoryList" style="color: #337ab7; text-decoration: none;">← Back to history</a>
        </div>
        <h5 style="margin-bottom: 15px;">Changes in commit ${shortSha}</h5>
        <p style='color: #888;'>Loading changes...</p>
      `;

      // Fetch and display commit changes
      const changesHtml = await formatCommitChanges(currentSiteId, commitOid);
      historyList.innerHTML = `
        <div style="margin-bottom: 15px;">
          <a href="#" id="backToHistoryList" style="color: #337ab7; text-decoration: none;">← Back to history</a>
        </div>
        <h5 style="margin-bottom: 15px;">Changes in commit ${shortSha}</h5>
        ${changesHtml}
      `;
    });

  // Handle back to history list click (event delegation)
  document
    .getElementById("historyList")
    .addEventListener("click", async function (e) {
      if (e.target.id === "backToHistoryList") {
        e.preventDefault();

        const historyList = document.getElementById("historyList");
        historyList.innerHTML = "<p style='color: #888;'>Loading edit history...</p>";

        const historyHtml = await formatCommitHistory(currentSiteId);
        historyList.innerHTML = historyHtml;
      }
    });

  // Handle revert button click (event delegation)
  document
    .getElementById("historyList")
    .addEventListener("click", async function (e) {
      const revertBtn = e.target.closest(".revert-btn");
      if (!revertBtn) return;

      e.preventDefault();

      const commitOid = revertBtn.dataset.commitOid;
      const commitMessage = revertBtn.dataset.commitMessage;
      const shortSha = commitOid.substring(0, 7);

      if (!commitOid || !currentSiteId) return;

      // Confirm with the user
      if (!confirm(`Are you sure you want to revert to commit ${shortSha}?\n\nThis will replace your current content with the content from that commit and deploy immediately.`)) {
        return;
      }

      // Disable the button and show loading state
      revertBtn.disabled = true;
      revertBtn.textContent = "Reverting...";

      try {
        // Get markdown files at the target commit
        const markdownFiles = await getMarkdownFilesAtCommit(currentSiteId, commitOid);

        if (markdownFiles.length === 0) {
          alert("No content found at this commit.");
          revertBtn.disabled = false;
          revertBtn.textContent = "Revert to this";
          return;
        }

        // Clear the current cache and repopulate with files from the commit
        markdownCache.length = 0;
        for (const file of markdownFiles) {
          addOrUpdateCache(file.fileName, file.displayName, file.content);
        }

        // Close the history modal and show deploy overlay
        $("#historyModal").modal("hide");
        showDeployOverlay("Reverting to previous version...");

        // Sync cache to git working directory before committing
        await syncCacheToGit(currentSiteId, markdownCache, imageCache);

        // Create revert commit message
        const revertMessage = `Revert to commit ${shortSha}: ${commitMessage}`;

        // Create git commit with the revert message
        const commitSha = await gitCommit(currentSiteId, revertMessage);
        console.log("Revert commit created:", commitSha);

        // Deploy changes to R2 storage
        const deploySuccess = await deployChanges(currentSiteId);

        // Save git history to R2 for persistence
        if (deploySuccess) {
          await saveGitHistoryToR2(currentSiteId);
          console.log("Git history saved to R2");
        }

        // Update the page menubar with the new pages
        await populateMenubar(currentSiteId);

        // Select the first page by clicking on it
        const firstMenuItem = document.querySelector(".menubar-item .menubar-item-text");
        if (firstMenuItem) {
          firstMenuItem.click();
        }

        // Reset modified flag after successful deployment
        modified = false;
        updateDeployButtonState();

        // Hide overlay before showing alert
        hideDeployOverlay();

        if (deploySuccess) {
          showAlertBar("Successfully reverted to commit " + shortSha, true);
        } else {
          showAlertBar("Revert commit created but deploy failed", false);
        }
      } catch (error) {
        console.error("Error reverting to commit:", error);
        hideDeployOverlay();
        alert("Failed to revert: " + error.message);
        revertBtn.disabled = false;
        revertBtn.textContent = "Revert to this";
      }
    });

  // Handle add new page button click
  document
    .getElementById("addNewPageButton")
    .addEventListener("click", function () {
      console.log("Add new page button clicked");

      if (!currentSiteId) {
        console.error("No site selected");
        return;
      }

      const menubarContent = document.getElementById("pageMenubarContent");
      const addButton = document.getElementById("addNewPageButton");

      // Create input element for new page name
      const inputContainer = document.createElement("div");
      inputContainer.classList.add("menubar-item");
      inputContainer.style.padding = "4px";

      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Page name...";
      input.style.border = "1px solid #1890ff";
      input.style.padding = "4px";
      input.style.fontSize = "14px";
      input.style.backgroundColor = "#1e1e1e";
      input.style.color = "#fff";

      inputContainer.appendChild(input);
      // Insert the input just before the add button (at the end of tabs)
      menubarContent.insertBefore(inputContainer, addButton);

      // Focus on the input
      input.focus();

      // Handle Enter key press
      input.addEventListener("keypress", async function (event) {
        if (event.key === "Enter") {
          input.blur();
        }
      });

      // Handle clicking outside or blur
      input.addEventListener("blur", async function () {
        inputContainer.remove();
        const displayName = input.value.trim();

        // Check if displayName already exists
        if (displayName) {
          const existingPage = getCacheByDisplayName(displayName);
          if (existingPage) {
            alert(`A page with the name "${displayName}" already exists. Please choose a different name.`);
            return;
          }
        }

        await triggerCreateNewSite(displayName);
        await populateMenubar(currentSiteId);
      });
    });
});

async function triggerCreateNewSite(displayName) {
  if (displayName) {
    // Sanitize for file name: lowercase and replace spaces with hyphens
    const sanitizedFileName = displayName.toLowerCase().replace(/\s+/g, "-");
    console.log("Creating new page:", displayName, "->", sanitizedFileName);

    // Add to markdownCache with default content
    const fileName = `public/${sanitizedFileName}.md`;
    const content = `# ${displayName}\n\nYour content here...`;
    addOrUpdateCache(fileName, displayName, content);
    console.log("New page added to cache:", displayName);

    // Mark as modified
    modified = true;
    updateDeployButtonState();

    // Refresh the menubar
    await populateMenubar(currentSiteId);

    // Open the new page in the editor
    currentSitePath = fileName;
    const cacheItem = getCacheByFileName(fileName);
    editor.setMarkdown(cacheItem.content);
  }
}

function updateDeployButtonState() {
  const deployButton = document.getElementById("deployButton");

  if (!modified) {
    deployButton.disabled = true;
    deployButton.style.opacity = "0.5";
    deployButton.style.cursor = "not-allowed";
    console.log("Deploy button disabled - no modifications");
  } else {
    deployButton.disabled = false;
    deployButton.style.opacity = "1";
    deployButton.style.cursor = "pointer";
    console.log("Deploy button enabled - modifications present");
  }
}

function showAlertBar(message, isSuccess) {
  const alertBar = document.getElementById("alertBar");
  alertBar.textContent = message;
  alertBar.className = "alert-bar show " + (isSuccess ? "success" : "error");

  // Auto-hide after 3 seconds
  setTimeout(() => {
    alertBar.className = "alert-bar";
  }, 3000);
}

function showDeployOverlay(message = "Deploying site...") {
  const overlay = document.getElementById("deployOverlay");
  const messageEl = overlay.querySelector(".deploy-message");
  if (messageEl) {
    messageEl.textContent = message;
  }
  overlay.style.display = "flex";
}

function hideDeployOverlay() {
  const overlay = document.getElementById("deployOverlay");
  overlay.style.display = "none";
}

async function checkSiteAvailability() {
  if (!currentSitePathFull) {
    return;
  }

  const visitSiteButton = document.getElementById("visitSiteButton");
  const pluribusSiteUrl = `/s/${currentSitePathFull}`;

  try {
    console.log("Checking site availability:", pluribusSiteUrl);
    const response = await fetch(pluribusSiteUrl, {
      method: "GET",
      cache: "no-cache"
    });

    if (response.status === 404) {
      // Site not available, disable button
      visitSiteButton.disabled = true;
      visitSiteButton.style.opacity = "0.5";
      visitSiteButton.style.cursor = "not-allowed";
      console.log("Site not available (404), button disabled");
    } else {
      // Site is available, enable button and stop checking
      visitSiteButton.disabled = false;
      visitSiteButton.style.opacity = "1";
      visitSiteButton.style.cursor = "pointer";
      console.log("Site is available, button enabled, stopping availability check");

      // Stop the interval
      if (siteAvailabilityInterval) {
        clearInterval(siteAvailabilityInterval);
        siteAvailabilityInterval = null;
      }
    }
  } catch (error) {
    console.error("Error checking site availability:", error);
    // On error, disable the button
    visitSiteButton.disabled = true;
    visitSiteButton.style.opacity = "0.5";
    visitSiteButton.style.cursor = "not-allowed";
  }
}

function populateSitesList(ownedSites, sharedSites = []) {
  const sitesList = document.getElementById("sites-list");
  sitesList.innerHTML = ""; // Clear existing list

  // Helper function to create a site item
  function createSiteItem(site, isOwned) {
    // Create container for site button and delete button
    var siteContainer = document.createElement("div");
    siteContainer.style.display = "flex";
    siteContainer.style.alignItems = "center";
    siteContainer.style.gap = "8px";
    siteContainer.style.marginBottom = "8px";

    // Create site button
    var siteDiv = document.createElement("div");
    siteDiv.classList.add("site-button", "site-item", "btn", "btn-default");
    siteDiv.innerText = `${site.owner}/${site.displayName || site.repo}`;
    siteDiv.id = site.siteId;
    siteDiv.style.flex = "1";
    siteDiv.addEventListener("click", function () {
      // Navigate to the edit endpoint
      window.location.href = `/edit/${site.siteId}`;
    });

    siteContainer.appendChild(siteDiv);

    // Only show delete button for owned sites
    if (isOwned) {
      var deleteButton = document.createElement("button");
      deleteButton.textContent = "×";
      deleteButton.classList.add("btn", "btn-danger");
      deleteButton.style.fontSize = "20px";
      deleteButton.style.padding = "6px 12px";
      deleteButton.style.fontWeight = "bold";
      deleteButton.title = "Delete site";
      deleteButton.addEventListener("click", async function (event) {
        event.stopPropagation(); // Prevent triggering site click

        const confirmMessage = `Are you sure you want to delete "${site.repo}"? This action cannot be undone.`;
        if (confirm(confirmMessage)) {
          console.log("Deleting site:", site.repo);

          // Disable button during deletion
          deleteButton.disabled = true;
          deleteButton.textContent = "...";
          deleteButton.style.opacity = "0.5";

          const deleteSiteHeaders = await getHeadersWithTurnstile({
            "Content-Type": "application/json",
          });
          const deleteResponse = await fetch(`/api/sites?siteId=${encodeURIComponent(site.siteId)}`, {
            method: "DELETE",
            headers: deleteSiteHeaders,
          });

          if (deleteResponse.ok) {
            console.log("Site deleted successfully");

            // Remove from cache
            sitesCache = sitesCache.filter(s => s.siteId !== site.siteId);

            // Repopulate the list
            populateSitesList(sitesCache, sharedSitesCache);

            alert("Site deleted successfully!");
          } else {
            console.error("Failed to delete site");
            alert("Failed to delete site. Please try again.");

            // Re-enable button on failure
            deleteButton.disabled = false;
            deleteButton.textContent = "×";
            deleteButton.style.opacity = "1";
          }
        }
      });

      siteContainer.appendChild(deleteButton);
    }

    return siteContainer;
  }

  // Add owned sites
  for (const site of ownedSites) {
    sitesList.appendChild(createSiteItem(site, true));
  }

  // Add shared sites section if there are any
  if (sharedSites.length > 0) {
    // Add section header
    var sharedHeader = document.createElement("h2");
    sharedHeader.textContent = "Shared with You";
    sharedHeader.style.marginTop = "20px";
    sharedHeader.style.marginBottom = "10px";
    sharedHeader.style.color = "white";
    sharedHeader.style.borderTop = "1px solid #555";
    sharedHeader.style.paddingTop = "15px";
    sitesList.appendChild(sharedHeader);

    // Add shared sites
    for (const site of sharedSites) {
      sitesList.appendChild(createSiteItem(site, false));
    }
  }
}

async function populateMenubar(siteId) {
  const menubarContent = document.getElementById("pageMenubarContent");
  const addButton = document.getElementById("addNewPageButton");

  // Clear existing content but preserve the add button
  menubarContent.innerHTML = "";

  for (const cacheItem of markdownCache) {
    const fileItem = document.createElement("div");
    fileItem.classList.add("menubar-item");

    // Create text span for file path
    const fileText = document.createElement("span");
    const displayName = cacheItem.displayName;
    fileText.textContent = displayName;
    fileText.classList.add("menubar-item-text");

    // Create button container
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "5px";

    // Only add rename and delete buttons if not Home page
    if (displayName !== "Home") {
      // Create rename button
      const renameButton = document.createElement("button");
      renameButton.textContent = "✎";
      renameButton.style.background = "transparent";
      renameButton.style.border = "none";
      renameButton.style.color = "white";
      renameButton.style.fontSize = "16px";
      renameButton.style.cursor = "pointer";
      renameButton.style.padding = "0 5px";
      renameButton.title = "Rename page";

      renameButton.addEventListener("click", async function (event) {
        event.stopPropagation(); // Prevent triggering file click

        // Hide the text and buttons
        fileText.style.display = "none";
        buttonContainer.style.display = "none";

        // Create input element for new page name
        const input = document.createElement("input");
        input.type = "text";
        input.value = displayName;
        input.style.flex = "1";
        input.style.border = "1px solid #1890ff";
        input.style.padding = "4px";
        input.style.fontSize = "14px";
        input.style.backgroundColor = "#1e1e1e";
        input.style.color = "#fff";

        fileItem.insertBefore(input, fileItem.firstChild);
        input.focus();
        input.select();

        // Handle Enter key press
        input.addEventListener("keypress", async function (event) {
          if (event.key === "Enter") {
            input.blur();
          }
        });

        // Handle blur
        input.addEventListener("blur", async function () {
          const newPageName = input.value.trim();

          if (newPageName && newPageName !== displayName) {
            // Sanitize page name: lowercase and replace spaces with hyphens
            const sanitizedNewPageName = newPageName
              .toLowerCase()
              .replace(/\s+/g, "-");
            const oldPageName = currentSitePath
              .replace("public/", "")
              .replace(".md", "");

            console.log(
              "Renaming page from:",
              oldPageName,
              "to:",
              sanitizedNewPageName
            );

            // Update cache - rename the file in cache
            const oldFilePath = cacheItem.fileName;
            const newFilePath = `public/${sanitizedNewPageName}.md`;
            const existing = getCacheByFileName(oldFilePath);
            if (existing) {
              existing.displayName = newPageName;
              existing.fileName = newFilePath;
              existing.modifiedAt = new Date().toISOString();
            } else {
              // If not in cache yet, fetch it first then rename
              const content = await getFileContent(siteId, oldFilePath);
              addOrUpdateCache(newFilePath, newPageName, content);
            }

            // Update current file path if it was the renamed file
            if (currentSitePath === oldFilePath) {
              currentSitePath = newFilePath;
              const updatedItem = getCacheByFileName(newFilePath);
              editor.setMarkdown(updatedItem.content);
            }

            // Mark as modified
            modified = true;
            updateDeployButtonState();

            // Refresh the menubar
            await populateMenubar(siteId);

            console.log("Page renamed in cache:", sanitizedNewPageName);

            // Click the renamed item in the menubar to load it
            setTimeout(() => {
              const menubarItems = document.querySelectorAll(".menubar-item");
              for (const item of menubarItems) {
                const text = item.querySelector("span");
                if (text && text.textContent === sanitizedNewPageName) {
                  text.click();
                  break;
                }
              }
            }, 100);
          } else {
            // Restore display
            input.remove();
            fileText.style.display = "block";
            buttonContainer.style.display = "flex";
          }
        });
      });

      // Create delete button
      const deleteButton = document.createElement("button");
      deleteButton.textContent = "×";
      deleteButton.style.background = "transparent";
      deleteButton.style.border = "none";
      deleteButton.style.color = "#ff4444";
      deleteButton.style.fontSize = "20px";
      deleteButton.style.cursor = "pointer";
      deleteButton.style.padding = "0 5px";
      deleteButton.style.fontWeight = "bold";
      deleteButton.title = "Delete page";

      deleteButton.addEventListener("click", async function (event) {
        event.stopPropagation(); // Prevent triggering file click

        if (confirm(`Are you sure you want to delete "${displayName}"?`)) {
          console.log("Deleting page:", displayName);

          // Remove from cache
          removeCacheByFileName(cacheItem.fileName);

          // Clear editor if the deleted file was open
          if (currentSitePath === cacheItem.fileName) {
            editor.setMarkdown("");
            currentSitePath = null;
          }

          // Mark as modified
          modified = true;
          updateDeployButtonState();

          // Refresh the menubar
          await populateMenubar(siteId);

          console.log("Page deleted from cache:", displayName);
        }
      });

      buttonContainer.appendChild(renameButton);
      buttonContainer.appendChild(deleteButton);
    }

    fileItem.appendChild(fileText);
    if (displayName !== "Home") {
      fileItem.appendChild(buttonContainer);
    }

    fileText.addEventListener("click", async function () {
      console.log(`Loading file: ${cacheItem.fileName}`);

      // Remove active class from all items
      document.querySelectorAll(".menubar-item").forEach((item) => {
        item.classList.remove("active");
      });

      // Add active class to clicked item
      fileItem.classList.add("active");

      // Load file content - always from cache since we use cache as source of truth
      let fileContent = cacheItem.content;
      console.log(`Using cached content for ${cacheItem.fileName}`);

      // Update deploy button state
      updateDeployButtonState();

      // Update current file path
      currentSitePath = cacheItem.fileName;

      // Set editor content
      editor.setMarkdown(fileContent);
    });
    menubarContent.appendChild(fileItem);
  }

  // Add the "+" button back at the end
  menubarContent.appendChild(addButton);
}

// ==================== User Menu Functions ====================

function showUserMenu(username) {
  const userMenuContainer = document.getElementById("userMenuContainer");
  const userMenuUsername = document.getElementById("userMenuUsername");
  const settingsUsername = document.getElementById("settingsUsername");
  const deleteConfirmUsername = document.getElementById("deleteConfirmUsername");

  if (userMenuContainer && userMenuUsername) {
    userMenuUsername.textContent = username;
    userMenuContainer.style.display = "block";
  }

  if (settingsUsername) {
    settingsUsername.textContent = username;
  }

  if (deleteConfirmUsername) {
    deleteConfirmUsername.textContent = username;
  }
}

// Sign Out handler
document.addEventListener("DOMContentLoaded", function() {
  const signOutLink = document.getElementById("signOutLink");
  if (signOutLink) {
    signOutLink.addEventListener("click", function(event) {
      event.preventDefault();

      // Clear all OAuth tokens from session storage
      sessionStorage.removeItem("agorapages.com.gitlab.oauth_token");
      sessionStorage.removeItem("agorapages.com.github.oauth_token");
      sessionStorage.removeItem("agorapages.com.google.oauth_token");
      sessionStorage.removeItem("agorapages.com.username");

      console.log("Signed out - tokens cleared");

      // Reload the page
      window.location.reload();
    });
  }

  // Download Data handler
  const downloadDataButton = document.getElementById("downloadDataButton");
  if (downloadDataButton) {
    downloadDataButton.addEventListener("click", async function() {
      const username = getStoredUsername();
      if (!username) {
        alert("No user logged in.");
        return;
      }

      downloadDataButton.disabled = true;
      downloadDataButton.textContent = "Downloading...";

      try {
        const response = await fetch(`/api/users/download?username=${encodeURIComponent(username)}`);

        if (!response.ok) {
          throw new Error("Failed to download data");
        }

        const data = await response.json();

        // Create ZIP file using JSZip
        const zip = new JSZip();

        // Add user info
        zip.file("user-info.json", JSON.stringify(data.user, null, 2));

        // Add each site's files
        for (const site of data.sites) {
          const siteFolderName = site.config.siteId.replace("/", "_");

          // Add site config
          zip.file(`${siteFolderName}/site-config.json`, JSON.stringify(site.config, null, 2));

          // Add all files, converting .git-history.json to proper .git directory
          for (const file of site.files) {
            // Check if this is the git history file
            if (file.path === ".git-history.json") {
              // Parse the git history JSON and create proper .git directory structure
              try {
                const gitHistoryJson = atob(file.content);
                const gitData = JSON.parse(gitHistoryJson);

                // Add each git file to the .git directory
                for (const [gitFilePath, gitFileBase64] of Object.entries(gitData)) {
                  const binaryString = atob(gitFileBase64);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  zip.file(`${siteFolderName}/.git/${gitFilePath}`, bytes);
                }
                console.log(`Converted .git-history.json to .git directory for ${siteFolderName}`);
              } catch (e) {
                console.error("Error converting git history:", e);
                // Fall back to including the raw file
                const binaryString = atob(file.content);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i);
                }
                zip.file(`${siteFolderName}/${file.path}`, bytes);
              }
            } else {
              // Regular file - decode base64 content
              const binaryString = atob(file.content);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              zip.file(`${siteFolderName}/${file.path}`, bytes);
            }
          }
        }

        // Generate ZIP and download
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = window.URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${username}-data.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();

        console.log("Data download completed");
      } catch (error) {
        console.error("Download error:", error);
        alert("Failed to download data. Please try again.");
      } finally {
        downloadDataButton.disabled = false;
        downloadDataButton.textContent = "Download All Data";
      }
    });
  }

  // Delete Account - show confirmation modal
  const deleteAccountButton = document.getElementById("deleteAccountButton");
  if (deleteAccountButton) {
    deleteAccountButton.addEventListener("click", function() {
      $("#userSettingsModal").modal("hide");
      $("#deleteAccountModal").modal("show");
    });
  }

  // Delete Account - enable/disable confirm button based on username input
  const deleteConfirmInput = document.getElementById("deleteConfirmInput");
  const confirmDeleteAccountButton = document.getElementById("confirmDeleteAccountButton");

  if (deleteConfirmInput && confirmDeleteAccountButton) {
    deleteConfirmInput.addEventListener("input", function() {
      const username = getStoredUsername();
      if (deleteConfirmInput.value === username) {
        confirmDeleteAccountButton.disabled = false;
      } else {
        confirmDeleteAccountButton.disabled = true;
      }
    });
  }

  // Delete Account - confirm deletion
  if (confirmDeleteAccountButton) {
    confirmDeleteAccountButton.addEventListener("click", async function() {
      const username = getStoredUsername();
      if (!username) {
        alert("No user logged in.");
        return;
      }

      // Double-check username matches
      if (deleteConfirmInput.value !== username) {
        alert("Username does not match.");
        return;
      }

      confirmDeleteAccountButton.disabled = true;
      confirmDeleteAccountButton.textContent = "Deleting...";

      try {
        const headers = await getHeadersWithTurnstile();
        const response = await fetch(`/api/users?username=${encodeURIComponent(username)}`, {
          method: "DELETE",
          headers,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "Failed to delete account");
        }

        console.log("Account deleted successfully");

        // Clear all session data
        sessionStorage.removeItem("agorapages.com.gitlab.oauth_token");
        sessionStorage.removeItem("agorapages.com.github.oauth_token");
        sessionStorage.removeItem("agorapages.com.google.oauth_token");
        sessionStorage.removeItem("agorapages.com.username");

        alert("Your account has been deleted.");

        // Reload the page
        window.location.reload();
      } catch (error) {
        console.error("Delete account error:", error);
        alert("Failed to delete account: " + error.message);
        confirmDeleteAccountButton.disabled = false;
        confirmDeleteAccountButton.textContent = "Delete My Account";
      }
    });
  }

  // ==================== Mode Selection and File Manager Event Handlers ====================

  // Mode selection back button - return to sites list
  const modeBackButton = document.getElementById("modeBackButton");
  if (modeBackButton) {
    modeBackButton.addEventListener("click", function() {
      // Hide mode selection panel
      document.getElementById("modeSelectionPanel").style.display = "none";
      // Show sites list panel
      document.getElementById("sites-list-panel").style.display = "block";
      // Clear pending site
      pendingSite = null;
      pendingPagePath = "index";
    });
  }

  // Mode editor button - open page editor
  const modeEditorButton = document.getElementById("modeEditorButton");
  if (modeEditorButton) {
    modeEditorButton.addEventListener("click", async function() {
      if (!pendingSite) return;
      // Hide mode selection panel
      document.getElementById("modeSelectionPanel").style.display = "none";
      // Open the site in the editor
      await openSiteInEditor(pendingSite, pendingPagePath);
    });
  }

  // Mode files button - open file manager
  const modeFilesButton = document.getElementById("modeFilesButton");
  if (modeFilesButton) {
    modeFilesButton.addEventListener("click", async function() {
      if (!pendingSite) return;
      await openFileManager(pendingSite);
    });
  }

  // File manager back button - return to mode selection
  const fileManagerBackButton = document.getElementById("fileManagerBackButton");
  if (fileManagerBackButton) {
    fileManagerBackButton.addEventListener("click", function() {
      // Hide file manager
      document.getElementById("fileManagerContainer").style.display = "none";
      // Show mode selection panel
      document.getElementById("modeSelectionPanel").style.display = "block";
    });
  }

  // File dropzone - drag and drop handlers
  const fileDropzone = document.getElementById("fileDropzone");
  const fileInput = document.getElementById("fileInput");
  const fileSelectButton = document.getElementById("fileSelectButton");

  if (fileDropzone) {
    // Prevent default drag behaviors
    ["dragenter", "dragover", "dragleave", "drop"].forEach(eventName => {
      fileDropzone.addEventListener(eventName, function(e) {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Highlight dropzone on drag over
    ["dragenter", "dragover"].forEach(eventName => {
      fileDropzone.addEventListener(eventName, function() {
        fileDropzone.classList.add("dragover");
      });
    });

    // Remove highlight on drag leave or drop
    ["dragleave", "drop"].forEach(eventName => {
      fileDropzone.addEventListener(eventName, function() {
        fileDropzone.classList.remove("dragover");
      });
    });

    // Handle dropped files
    fileDropzone.addEventListener("drop", async function(e) {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        await handleFileUpload(files);
      }
    });
  }

  // File select button - trigger file input
  if (fileSelectButton && fileInput) {
    fileSelectButton.addEventListener("click", function() {
      fileInput.click();
    });

    fileInput.addEventListener("change", async function() {
      if (fileInput.files.length > 0) {
        await handleFileUpload(fileInput.files);
        // Clear input so the same file can be uploaded again
        fileInput.value = "";
      }
    });
  }
});
