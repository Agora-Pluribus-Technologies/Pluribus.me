// Global cache for markdown files - Array of {displayName, fileName, content, createdAt, modifiedAt}
let markdownCache = [];
let currentSitePath = null;
let currentSiteId = null;
let currentSitePathFull = null;
let currentSiteType = "pages"; // "pages" or "blog"
let lastDeployTimeInterval = null;
let modified = false;

// ==================== Auto-Save to localStorage ====================

let _autoSaveTimer = null;
const AUTO_SAVE_DELAY = 2000; // 2 seconds debounce

function getAutoSaveKey(siteId) {
  return `agorapages_autosave_${siteId}`;
}

function scheduleAutoSave() {
  if (!currentSiteId || !modified) return;
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => performAutoSave(), AUTO_SAVE_DELAY);
}

function performAutoSave() {
  if (!currentSiteId || !modified) return;
  try {
    const payload = {
      markdownCache: markdownCache,
      imageCache: imageCache,
      documentCache: documentCache,
      currentSitePath: currentSitePath,
      currentSiteType: currentSiteType,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(getAutoSaveKey(currentSiteId), JSON.stringify(payload));
    console.log("Auto-saved to localStorage for site:", currentSiteId);

    // Show auto-save indicator briefly
    const indicator = document.getElementById("autoSaveStatus");
    if (indicator) {
      indicator.textContent = "Draft saved";
      indicator.style.display = "inline";
      setTimeout(() => { indicator.style.display = "none"; }, 2000);
    }
  } catch (e) {
    console.warn("Auto-save failed:", e);
  }
}

function getAutoSaveData(siteId) {
  try {
    const raw = localStorage.getItem(getAutoSaveKey(siteId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearAutoSave(siteId) {
  localStorage.removeItem(getAutoSaveKey(siteId));
}

function restoreAutoSave(siteId) {
  const data = getAutoSaveData(siteId);
  if (!data) return false;

  markdownCache = data.markdownCache || [];
  imageCache = data.imageCache || [];
  documentCache = data.documentCache || [];
  if (data.currentSitePath) {
    currentSitePath = data.currentSitePath;
  }
  modified = true;
  updateDeployButtonState();
  console.log("Restored auto-save from", data.savedAt);
  return true;
}

// ==================== Onboarding Tour ====================

const TOUR_STEPS = [
  {
    target: '#pageMenubarContent .menubar-item',
    title: 'Your Pages',
    text: 'Each tab here is a page on your site. Click a tab to edit that page. You can drag tabs to reorder them.',
    position: 'bottom',
  },
  {
    target: '#addNewPageButton',
    title: 'Create New Pages',
    text: 'Click the + button to add a new page to your site. Give it a name and it will appear as a new tab.',
    position: 'bottom',
  },
  {
    target: '.add-block-btn',
    title: 'Add Content Blocks',
    text: 'Click any + button to add a content block — text panels, images, links, embeds, or documents. Blocks are the building pieces of your page.',
    position: 'bottom',
  },
  {
    target: '.block-item',
    title: 'Edit & Rearrange Blocks',
    text: 'Each block has an Edit button to change its content, an X to delete it, and a drag handle to reorder. Try editing the welcome text!',
    position: 'top',
  },
  {
    target: '#deployButton',
    title: 'Publish Your Site',
    text: 'When you\'re ready, click Publish Site to make your changes live. Your edits are auto-saved locally, so you won\'t lose work.',
    position: 'bottom',
  },
  {
    target: '#visitSiteButton',
    title: 'View Your Live Site',
    text: 'Click here to see your published site. Share the URL with anyone — your site is live on the web!',
    position: 'bottom',
  },
];

let _tourStep = 0;
let _tourOverlay = null;
let _tourPopup = null;

function shouldShowTour(siteId) {
  const key = `agorapages_tour_completed_${siteId}`;
  return !localStorage.getItem(key);
}

function markTourCompleted(siteId) {
  const key = `agorapages_tour_completed_${siteId}`;
  localStorage.setItem(key, '1');
}

function startOnboardingTour() {
  if (!currentSiteId || !shouldShowTour(currentSiteId)) return;
  // Only show tour for pages sites (blog has different UI)
  if (currentSiteType === 'blog') return;

  _tourStep = 0;
  showTourStep();
}

function showTourStep() {
  cleanupTour();

  if (_tourStep >= TOUR_STEPS.length) {
    markTourCompleted(currentSiteId);
    return;
  }

  const step = TOUR_STEPS[_tourStep];
  const targetEl = document.querySelector(step.target);

  // Skip step if target doesn't exist
  if (!targetEl) {
    _tourStep++;
    showTourStep();
    return;
  }

  // Create overlay
  _tourOverlay = document.createElement('div');
  _tourOverlay.className = 'tour-overlay';
  document.body.appendChild(_tourOverlay);

  // Highlight the target element
  targetEl.classList.add('tour-highlight');

  // Create popup
  _tourPopup = document.createElement('div');
  _tourPopup.className = 'tour-popup';

  const stepIndicator = `Step ${_tourStep + 1} of ${TOUR_STEPS.length}`;
  _tourPopup.innerHTML = `
    <div class="tour-popup-header">
      <span class="tour-step-indicator">${stepIndicator}</span>
      <button class="tour-close-btn" title="Skip tour">&times;</button>
    </div>
    <h4 class="tour-title">${step.title}</h4>
    <p class="tour-text">${step.text}</p>
    <div class="tour-buttons">
      ${_tourStep > 0 ? '<button class="tour-btn tour-btn-back">Back</button>' : ''}
      <button class="tour-btn tour-btn-next">${_tourStep === TOUR_STEPS.length - 1 ? 'Done' : 'Next'}</button>
    </div>
  `;

  document.body.appendChild(_tourPopup);

  // Position the popup relative to the target
  positionTourPopup(targetEl, step.position);

  // Event listeners
  _tourPopup.querySelector('.tour-close-btn').addEventListener('click', () => {
    cleanupTour();
    markTourCompleted(currentSiteId);
  });

  _tourPopup.querySelector('.tour-btn-next').addEventListener('click', () => {
    targetEl.classList.remove('tour-highlight');
    _tourStep++;
    showTourStep();
  });

  const backBtn = _tourPopup.querySelector('.tour-btn-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      targetEl.classList.remove('tour-highlight');
      _tourStep--;
      showTourStep();
    });
  }

  // Close on overlay click
  _tourOverlay.addEventListener('click', () => {
    cleanupTour();
    markTourCompleted(currentSiteId);
  });
}

function positionTourPopup(targetEl, position) {
  const rect = targetEl.getBoundingClientRect();
  const popupRect = _tourPopup.getBoundingClientRect();
  let top, left;

  if (position === 'bottom') {
    top = rect.bottom + 12;
    left = rect.left + rect.width / 2 - popupRect.width / 2;
  } else {
    top = rect.top - popupRect.height - 12;
    left = rect.left + rect.width / 2 - popupRect.width / 2;
  }

  // Keep within viewport
  left = Math.max(10, Math.min(left, window.innerWidth - popupRect.width - 10));
  top = Math.max(10, Math.min(top, window.innerHeight - popupRect.height - 10));

  _tourPopup.style.top = top + 'px';
  _tourPopup.style.left = left + 'px';
}

function cleanupTour() {
  if (_tourOverlay) {
    _tourOverlay.remove();
    _tourOverlay = null;
  }
  if (_tourPopup) {
    _tourPopup.remove();
    _tourPopup = null;
  }
  document.querySelectorAll('.tour-highlight').forEach(el => {
    el.classList.remove('tour-highlight');
  });
}

// Global cache for sites list
let sitesCache = [];
let sharedSitesCache = [];

// Global cache for images - Array of filenames
let imageCache = [];

// Global cache for documents (PDFs, DOCX) - Array of filenames
let documentCache = [];

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

// Helper functions for documentCache
function addDocumentToCache(filename) {
  if (!documentCache.includes(filename)) {
    documentCache.push(filename);
  }
}

function removeDocumentFromCache(filename) {
  const index = documentCache.indexOf(filename);
  if (index !== -1) {
    documentCache.splice(index, 1);
  }
}

function isDocumentInCache(filename) {
  return documentCache.includes(filename);
}

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
    const pluribusSiteUrl = `/s/${currentSitePathFull}/`;
    visitSiteButton.onclick = function () {
      window.open(pluribusSiteUrl, "_blank");
    };
    console.log("Visit Site button updated to:", pluribusSiteUrl);
  }

  modified = false;

  // Set initial button state directly — do NOT call updateDeployButtonState()
  // here because it would clear any pending auto-save before we offer recovery.
  const deployButton = document.getElementById("deployButton");
  deployButton.disabled = true;
  deployButton.style.opacity = "0.5";
  deployButton.style.cursor = "not-allowed";

  // Hide sites list panel
  const sitesListPanel = document.getElementById("sites-list-panel");
  sitesListPanel.style.display = "none";

  // Show editor panel
  const editorContainer = document.getElementById("editorContainer");
  editorContainer.style.display = "flex";

  // Hide user menu when in editor
  const userMenuContainer = document.getElementById("userMenuContainer");
  if (userMenuContainer) {
    userMenuContainer.style.display = "none";
  }

  // Fetch site tree from R2
  const markdownFiles = await getPublicFiles(currentSiteId);

  console.log("Markdown files:", markdownFiles);

  // Check for auto-saved data from a previous session
  const autoSaveData = getAutoSaveData(currentSiteId);
  let restoredFromAutoSave = false;

  if (autoSaveData && autoSaveData.markdownCache && autoSaveData.markdownCache.length > 0) {
    restoredFromAutoSave = restoreAutoSave(currentSiteId);
    setSiteAvailable(markdownFiles.length > 0);
    console.log("Auto-restored unpublished changes from", autoSaveData.savedAt);
  }

  if (!restoredFromAutoSave && markdownFiles.length === 0) {
    // Initialize empty imageCache
    imageCache = [];
    // Disable Visit Site button for unpublished sites
    setSiteAvailable(false);

    // For pages sites, create a default home page; blog sites start empty
    if (site.siteType !== "blog") {
      console.log("Site is empty - created dummy home.md");
      addOrUpdateCache(
        "public/home.md",
        "Home",
        "# Welcome to your Agora Site!\n\nThis is your homepage. Click the **Edit** button on this panel to change its content.\n\nUse the **+** buttons above or below this panel to add more panels, images, links, and embeds.\n\nTo add more pages, click the **+** button in the page menu bar above."
      );
      // Mark as modified for new sites (needs to be published)
      modified = true;
      updateDeployButtonState();
    }
  } else if (!restoredFromAutoSave) {
    // Site has been published before, enable Visit Site button
    setSiteAvailable(true);
    // Initialize markdownCache from pages.json (exclude latest.md)
    markdownCache = JSON.parse(await getFileContent(currentSiteId, "public/pages.json"));
    markdownCache = markdownCache.filter(item => item.fileName !== "latest");
    for (let i=0; i < markdownCache.length; i++) {
      let fileName = markdownCache[i].fileName;
      // Migrate old index.md files to use displayName-based filename
      if (fileName === "index") {
        const newFileName = markdownCache[i].displayName.toLowerCase().replace(/\s+/g, "-");
        console.log(`Migrating index.md to ${newFileName}.md`);
        fileName = newFileName;
      }
      markdownCache[i].fileName = `public/${fileName}.md`
    }

    // Load all markdown files, images.json, and documents.json in parallel
    const [mdResults, imagesJsonContent, documentsJsonContent] = await Promise.all([
      Promise.all(markdownFiles.map(async (file) => {
        console.log("Loading file into cache:", file);
        const content = await getFileContent(currentSiteId, file);
        return { file, content };
      })),
      getFileContent(currentSiteId, "public/images.json").catch(() => null),
      getFileContent(currentSiteId, "public/documents.json").catch(() => null),
    ]);

    // Process markdown results into cache
    for (const { file, content } of mdResults) {
      let cacheFileName = file;
      if (file === "public/index.md" && markdownCache.length > 0) {
        cacheFileName = markdownCache[0].fileName;
        console.log(`Mapping ${file} to ${cacheFileName}`);
      }
      addOrUpdateCache(cacheFileName, null, content, { preserveTimestamps: true });
    }

    // Initialize imageCache from images.json
    try {
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

    // Initialize documentCache from documents.json
    try {
      if (documentsJsonContent) {
        documentCache = JSON.parse(documentsJsonContent);
        console.log("Loaded documentCache:", documentCache);
      } else {
        documentCache = [];
        console.log("documents.json not found, initialized empty documentCache");
      }
    } catch (error) {
      console.error("Error loading documents.json:", error);
      documentCache = [];
    }
  }

  // Initialize git repo and load files from R2
  await loadR2ToGit(currentSiteId);

  // Load site type from site.json or site config
  try {
    const siteJsonContent = await getFileContent(currentSiteId, "public/site.json");
    if (siteJsonContent) {
      const siteJson = JSON.parse(siteJsonContent);
      currentSiteType = siteJson.siteType || "pages";
      console.log("Site type from site.json:", currentSiteType);
    } else if (site.siteType) {
      // Fallback to site config (for new sites before first deploy)
      currentSiteType = site.siteType;
      console.log("Site type from site config:", currentSiteType);
    } else {
      currentSiteType = "pages"; // default for older sites
      console.log("Site type defaulting to pages");
    }
  } catch (error) {
    console.error("Error loading site.json:", error);
    // Fallback to site config
    currentSiteType = site.siteType || "pages";
    console.log("Site type from fallback:", currentSiteType);
  }

  // Migration: Ensure index.html exists for existing sites
  try {
    const indexHtmlContent = await getFileContent(currentSiteId, "public/index.html");
    if (!indexHtmlContent) {
      console.log("index.html not found, creating it for existing site");
      const templateName = currentSiteType === "blog" ? "/templates/blog-template.html" : "/templates/owo-template.html";
      const templateResponse = await fetch(templateName);
      if (templateResponse.ok) {
        const indexHtml = await templateResponse.text();
        await gitWriteFile(currentSiteId, "public/index.html", indexHtml);
        modified = true;
        console.log("Created index.html for existing site");
      } else {
        console.error("Failed to fetch template");
      }
    }
  } catch (error) {
    console.error("Error checking/creating index.html:", error);
  }

  // For blog sites, hide the page menubar since posts are managed differently
  const pageMenubar = document.getElementById("pageMenubar");
  if (currentSiteType === "blog") {
    if (pageMenubar) {
      pageMenubar.style.display = "none";
    }
    // Load the blog editor
    initBlogEditor();
  } else {
    if (pageMenubar) {
      pageMenubar.style.display = "flex";
    }
    // Populate menubar from cache
    await populateMenubar(site.siteId);
    // Load the block editor
    initBlockEditor();
  }

  // Remember whether we restored from auto-save so we can preserve the modified flag
  const wasRestoredFromAutoSave = restoredFromAutoSave;

  // Find and click the appropriate page tab
  setTimeout(() => {
    // Position menubar after DOM is ready
    positionPageMenubar();
    const menubarItems = document.querySelectorAll(".menubar-item");
    const fileName = `public/${initialPage}.md`;
    let pageFound = false;

    for (const item of menubarItems) {
      const text = item.querySelector("span");
      if (text) {
        // Check if this menubar item matches the requested page
        const cacheItem = markdownCache.find(c =>
          c.fileName === fileName ||
          c.displayName.toLowerCase() === initialPage.toLowerCase()
        );

        if (cacheItem && text.textContent === cacheItem.displayName) {
          console.log("Opening page:", cacheItem.displayName);
          text.click();
          pageFound = true;

          // Keep modified=true if we restored auto-save (user has unpublished edits)
          if (!wasRestoredFromAutoSave) {
            modified = false;
          }
          break;
        }
      }
    }

    // Fallback to first page if requested page not found
    if (!pageFound) {
      console.log("Page not found:", initialPage, "- opening first page");
      const firstPageTab = document.querySelector(".menubar-item .menubar-item-text");
      if (firstPageTab) {
        firstPageTab.click();
        if (!wasRestoredFromAutoSave) {
          modified = false;
        }
      }
    }

    // After initial load, sync the deploy button state
    updateDeployButtonState();

    // Start onboarding tour after editor is fully rendered
    setTimeout(() => startOnboardingTour(), 500);
  }, 100);
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

  // Open the site in the editor
  const pagePath = editContext.pagePath || "index";
  await openSiteInEditor(site, pagePath);
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

// Position sites-list-panel below userMenuButton
function positionSitesListPanel() {
  const sitesListPanel = document.getElementById("sites-list-panel");
  const userMenuButton = document.getElementById("userMenuButton");
  if (sitesListPanel && userMenuButton) {
    const topbarRect = userMenuButton.getBoundingClientRect();
    sitesListPanel.style.marginTop = topbarRect.bottom + "px";
  }

  const footer = document.getElementById("footer");
  if (footer) {
    const footerRect = footer.getBoundingClientRect();
    sitesListPanel.style.marginBottom = footerRect.height + "px";
  }
  
}

// Position pageMenubar below editor-topbar
function positionPageMenubar() {
  const editorTopbar = document.getElementById("editor-topbar");
  const pageMenubar = document.getElementById("pageMenubar");
  if (editorTopbar && pageMenubar) {
    const topbarRect = editorTopbar.getBoundingClientRect();
    pageMenubar.style.marginTop = topbarRect.bottom + "px";
  }
}

// Call on load and resize
window.addEventListener("resize", positionPageMenubar);

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
    if (!providerInfo || !providerInfo.provider || !providerInfo.providerId) {
      console.error("Could not get provider info");
      displayLoginButtons();
      return;
    }

    document.body.style.height = "auto";

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

  // Set username prefix when create site modal is shown
  $("#createSiteModal").on("show.bs.modal", function () {
    const username = getStoredUsername();
    document.getElementById("siteNamePrefix").textContent = username + "/";
    document.getElementById("siteName").value = "";
    document.getElementById("siteType").value = "pages";
    document.querySelectorAll(".site-type-card").forEach(function(c) { c.classList.remove("selected"); });
    const defaultCard = document.querySelector('.site-type-card[data-value="pages"]');
    if (defaultCard) defaultCard.classList.add("selected");
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
        const siteType = document.getElementById("siteType").value;

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
            displayName: rawSiteName,
            siteType: siteType,
          }),
        });

        if (!createResponse.ok) {
          const errorText = await createResponse.text();
          console.error("Failed to create site:", errorText);
          alert("Failed to create site: " + errorText);
          return;
        }

        console.log("Site config stored successfully");

        // Create initial files and git history in R2 (single API call)
        await initialCommitWithGitHistory(siteId, { siteName, repo, owner, siteType });

        // Add new site to cache
        const newSite = {
          siteId: siteId,
          provider: provider,
          owner: owner,
          repo: repo,
          branch: "main",
          basePath: "/public",
          displayName: rawSiteName,
          siteType: siteType,
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
    window.location.href = document.location.origin + "/builder.html";
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
      let commitMessage = document.getElementById("commitMessage").value.trim();

      // Generate default commit message if blank
      if (!commitMessage) {
        const changes = await gitStatus(currentSiteId);
        const mdChanges = changes.filter(c => c.filepath.endsWith(".md"));
        if (mdChanges.length > 0) {
          const fileNames = mdChanges.map(c => {
            return c.filepath.replace("public/", "").replace(".md", "");
          });
          commitMessage = `Modified ${fileNames.join(", ")}`;
        } else {
          commitMessage = "Site update";
        }
      }

      const confirmButton = document.getElementById("confirmCommitButton");
      const originalText = confirmButton.textContent;
      confirmButton.disabled = true;
      confirmButton.textContent = "Publishing...";

      // Close modal and show deploy overlay
      $("#commitModal").modal("hide");
      showDeployOverlay("Publishing site...");

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
          // Enable Visit Site button after successful deploy
          setSiteAvailable(true);
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
      document.getElementById("siteSettingsNameInput").value = site ? (site.displayName || site.repo) : currentSiteId;
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
          document.getElementById("blogEmailUrl").value = siteJson.blogEmailUrl || "";
          if (siteJson.siteName) {
            document.getElementById("siteSettingsNameInput").value = siteJson.siteName;
          }
        } else {
          document.getElementById("showHistoryCheckbox").checked = false;
          document.getElementById("blogEmailUrl").value = "";
        }
      } catch (error) {
        console.error("Error loading site.json:", error);
        document.getElementById("showHistoryCheckbox").checked = false;
        document.getElementById("blogEmailUrl").value = "";
      }

      // Show/hide subscribers section for blog sites
      const subscribersSection = document.getElementById("subscribersSection");
      if (currentSiteType === "blog" && isOwner) {
        subscribersSection.style.display = "block";
        loadSubscribersPanel(currentSiteId);
      } else {
        subscribersSection.style.display = "none";
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

        // Update blog email URL
        const blogEmailUrl = document.getElementById("blogEmailUrl").value.trim();
        if (blogEmailUrl) {
          siteJson.blogEmailUrl = blogEmailUrl;
        } else {
          delete siteJson.blogEmailUrl;
        }

        // Update site display name
        const newDisplayName = document.getElementById("siteSettingsNameInput").value.trim();
        if (newDisplayName) {
          siteJson.siteName = newDisplayName;
          siteJson.displayName = newDisplayName;

          // Update the display name in the database
          await renameSite(currentSiteId, newDisplayName);

          // Update local cache
          const site = sitesCache.find(s => s.siteId === currentSiteId);
          if (site) {
            site.displayName = newDisplayName;
          }
        }

        // Save to git working directory
        await gitWriteFile(currentSiteId, "public/site.json", JSON.stringify(siteJson, null, 2));

        // Close modal
        $("#siteSettingsModal").modal("hide");

        // For blog sites, auto-deploy; for pages sites, mark as modified
        if (currentSiteType === "blog") {
          await autoPublishBlogSettings();
          showAlertBar("Settings saved and published.", true);
        } else {
          modified = true;
          updateDeployButtonState();
          showAlertBar("Settings saved. Deploy to apply changes.", true);
        }
      } catch (error) {
        console.error("Error saving site settings:", error);
        showAlertBar("Failed to save settings: " + error.message, false);
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = originalText;
      }
    });

  // Handle subscriber CSV import button
  document
    .getElementById("importSubscribersButton")
    .addEventListener("click", function () {
      document.getElementById("subscribersCsvInput").click();
    });

  // Handle CSV file selection
  document
    .getElementById("subscribersCsvInput")
    .addEventListener("change", async function (e) {
      const file = e.target.files[0];
      if (!file || !currentSiteId) return;

      const statusEl = document.getElementById("subscribersImportStatus");
      statusEl.style.display = "block";
      statusEl.className = "text-info";
      statusEl.textContent = "Parsing CSV...";

      try {
        const text = await file.text();
        const emails = parseCsvForEmails(text);

        if (emails.length === 0) {
          statusEl.className = "text-danger";
          statusEl.textContent = "No valid email addresses found in the CSV.";
          return;
        }

        statusEl.textContent = `Found ${emails.length} emails. Importing...`;

        const result = await importSubscribers(currentSiteId, emails);
        statusEl.className = "text-success";
        statusEl.textContent = `Imported ${result.imported} subscribers. ${result.skipped} skipped (duplicates or invalid).`;

        // Refresh the list
        await loadSubscribersPanel(currentSiteId);
      } catch (error) {
        statusEl.className = "text-danger";
        statusEl.textContent = "Failed to import: " + error.message;
      } finally {
        // Reset file input
        e.target.value = "";
      }
    });

  // Handle subscriber CSV export
  document
    .getElementById("exportSubscribersButton")
    .addEventListener("click", async function () {
      if (!currentSiteId) return;

      try {
        const data = await getSubscribers(currentSiteId);
        if (data.subscribers.length === 0) {
          alert("No subscribers to export.");
          return;
        }

        let csv = "Email,Subscribed Date\n";
        for (const sub of data.subscribers) {
          csv += `${sub.email},${sub.subscribedAt}\n`;
        }

        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `subscribers-${currentSiteId.replace("/", "-")}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (error) {
        alert("Failed to export subscribers: " + error.message);
      }
    });

  // Handle download site button click
  document
    .getElementById("downloadSiteButton")
    .addEventListener("click", async function () {
      if (!currentSiteId) {
        console.error("No site selected");
        return;
      }

      const downloadButton = document.getElementById("downloadSiteButton");
      const originalHtml = downloadButton.innerHTML;
      downloadButton.disabled = true;
      downloadButton.innerHTML = '<span class="glyphicon glyphicon-refresh"></span> Downloading...';

      try {
        const headers = await getHeadersWithTurnstile();
        const response = await fetch(`/api/sites/download?siteId=${encodeURIComponent(currentSiteId)}`, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          throw new Error("Failed to download site data");
        }

        const data = await response.json();

        // Create ZIP file using JSZip
        const zip = new JSZip();

        // Add site config
        zip.file("site-config.json", JSON.stringify(data.site, null, 2));

        // Add all files, converting .git-history.json to proper .git directory
        for (const file of data.files) {
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
                zip.file(`.git/${gitFilePath}`, bytes);
              }
              console.log("Converted .git-history.json to .git directory");
            } catch (e) {
              console.error("Error converting git history:", e);
              // Fall back to including the raw file
              const binaryString = atob(file.content);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              zip.file(file.path, bytes);
            }
          } else {
            // Regular file - decode base64 content
            const binaryString = atob(file.content);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            zip.file(file.path, bytes);
          }
        }

        // Fetch and include the correct template files based on site type
        try {
          const templateName = currentSiteType === "blog" ? "blog-template" : "owo-template";
          const [cssResponse, jsResponse] = await Promise.all([
            fetch(`/templates/${templateName}.css`),
            fetch(`/templates/${templateName}.js`),
          ]);

          if (cssResponse.ok) {
            const cssContent = await cssResponse.text();
            zip.file(`public/templates/${templateName}.css`, cssContent);
          }

          if (jsResponse.ok) {
            const jsContent = await jsResponse.text();
            zip.file(`public/templates/${templateName}.js`, jsContent);
          }

          console.log(`Added ${templateName} template files to ZIP`);
        } catch (templateError) {
          console.error("Error fetching template files:", templateError);
          // Continue without templates - not critical
        }

        // Generate ZIP and download
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = window.URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url;
        // Use site name for filename (replace / with _)
        const siteName = currentSiteId.replace("/", "_");
        a.download = `${siteName}-backup.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();

        console.log("Site download completed");
      } catch (error) {
        console.error("Download error:", error);
        alert("Failed to download site. Please try again.");
      } finally {
        downloadButton.disabled = false;
        downloadButton.innerHTML = originalHtml;
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
          // Enable Visit Site button after successful deploy
          setSiteAvailable(true);
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
    const content = `# ${displayName}\n\nClick **Edit** on this panel to start writing. Use the **+** buttons to add more panels.`;
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
    loadPageIntoBlockEditor(cacheItem.content);
  }
}

function updateDeployButtonState() {
  const deployButton = document.getElementById("deployButton");
  const publishStatus = document.getElementById("publishStatus");

  if (!modified) {
    deployButton.disabled = true;
    deployButton.style.opacity = "0.5";
    deployButton.style.cursor = "not-allowed";
    console.log("Deploy button disabled - no modifications");

    // Update publish status to "Published"
    if (publishStatus) {
      publishStatus.textContent = "Published";
      publishStatus.className = "publish-status published";
    }

    // Clear auto-save when changes are published
    if (currentSiteId) {
      clearAutoSave(currentSiteId);
    }
  } else {
    deployButton.disabled = false;
    deployButton.style.opacity = "1";
    deployButton.style.cursor = "pointer";
    console.log("Deploy button enabled - modifications present");

    // Update publish status to "Changes Not Yet Published"
    if (publishStatus) {
      publishStatus.textContent = "Changes Not Yet Published";
      publishStatus.className = "publish-status pending-changes";
    }

    // Schedule auto-save when there are unsaved changes
    scheduleAutoSave();
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

function showDeployOverlay(message = "Publishing site...") {
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

function setSiteAvailable(available) {
  const visitSiteButton = document.getElementById("visitSiteButton");
  if (!visitSiteButton) return;

  if (available) {
    visitSiteButton.disabled = false;
    visitSiteButton.style.opacity = "1";
    visitSiteButton.style.cursor = "pointer";
    console.log("Site is available, Visit Site button enabled");
  } else {
    visitSiteButton.disabled = true;
    visitSiteButton.style.opacity = "0.5";
    visitSiteButton.style.cursor = "not-allowed";
    console.log("Site not yet published, Visit Site button disabled");
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

          // Disable buttons during deletion
          deleteButton.disabled = true;
          deleteButton.textContent = "...";
          deleteButton.style.opacity = "0.5";
          siteDiv.style.pointerEvents = "none";
          siteDiv.style.opacity = "0.5";

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

            // Re-enable buttons on failure
            deleteButton.disabled = false;
            deleteButton.textContent = "×";
            deleteButton.style.opacity = "1";
            siteDiv.style.pointerEvents = "auto";
            siteDiv.style.opacity = "1";
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

  positionSitesListPanel();
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

    // Create rename button (available for all pages including Home)
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
          const oldFilePath = cacheItem.fileName;
          const existing = getCacheByFileName(oldFilePath);

          // Sanitize page name: lowercase and replace spaces with hyphens
          const sanitizedNewPageName = newPageName
            .toLowerCase()
            .replace(/\s+/g, "-");
          const oldPageName = oldFilePath
            .replace("public/", "")
            .replace(".md", "");

          console.log(
            "Renaming page from:",
            oldPageName,
            "to:",
            sanitizedNewPageName
          );

          // Update cache - rename the file in cache
          const newFilePath = `public/${sanitizedNewPageName}.md`;
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
            loadPageIntoBlockEditor(updatedItem.content);
          }

          // Mark as modified
          modified = true;
          updateDeployButtonState();

          // Refresh the menubar
          await populateMenubar(siteId);

          console.log("Page renamed in cache:", newPageName);

          // Click the renamed item in the menubar to load it
          setTimeout(() => {
            const menubarItems = document.querySelectorAll(".menubar-item");
            for (const item of menubarItems) {
              const text = item.querySelector("span");
              if (text && text.textContent === newPageName) {
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

    buttonContainer.appendChild(renameButton);

    // Only add delete button if there is more than one page
    if (markdownCache.length > 1) {
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

          // Check if deleted file was the currently selected one
          const wasSelected = currentSitePath === cacheItem.fileName;

          // Remove from cache
          removeCacheByFileName(cacheItem.fileName);

          // Mark as modified
          modified = true;
          updateDeployButtonState();

          // Refresh the menubar
          await populateMenubar(siteId);

          // If the deleted page was selected, click on the leftmost page tab
          if (wasSelected) {
            const firstPageTab = document.querySelector(".menubar-item .menubar-item-text");
            if (firstPageTab) {
              firstPageTab.click();
            }
          }

          console.log("Page deleted from cache:", displayName);
        }
      });

      buttonContainer.appendChild(deleteButton);
    }

    fileItem.appendChild(fileText);
    fileItem.appendChild(buttonContainer);

    // Add drag-and-drop functionality for reordering
    fileItem.draggable = true;
    fileItem.dataset.index = markdownCache.indexOf(cacheItem);

    fileItem.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", fileItem.dataset.index);
      fileItem.classList.add("dragging");
    });

    fileItem.addEventListener("dragend", function () {
      fileItem.classList.remove("dragging");
    });

    fileItem.addEventListener("dragover", function (e) {
      e.preventDefault();
      const draggingItem = document.querySelector(".menubar-item.dragging");
      if (draggingItem && draggingItem !== fileItem) {
        fileItem.classList.add("drag-over");
      }
    });

    fileItem.addEventListener("dragleave", function () {
      fileItem.classList.remove("drag-over");
    });

    fileItem.addEventListener("drop", async function (e) {
      e.preventDefault();
      fileItem.classList.remove("drag-over");

      const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const toIndex = parseInt(fileItem.dataset.index, 10);

      if (fromIndex !== toIndex) {
        // Reorder markdownCache
        const [movedItem] = markdownCache.splice(fromIndex, 1);
        markdownCache.splice(toIndex, 0, movedItem);

        console.log("Reordered pages:", markdownCache.map(c => c.displayName));

        // Mark as modified
        modified = true;
        updateDeployButtonState();

        // Refresh the menubar
        await populateMenubar(siteId);
      }
    });

    fileItem.addEventListener("click", async function (e) {
      // Don't trigger if clicking on buttons (rename/delete)
      if (e.target.tagName === "BUTTON") return;

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

      // Load content into block editor
      loadPageIntoBlockEditor(fileContent);
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
        const headers = await getHeadersWithTurnstile();
        const response = await fetch(`/api/users/download?username=${encodeURIComponent(username)}`, {
          method: "GET",
          headers,
        });

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

          // Fetch and include the correct template files for each site
          try {
            const templateName = site.config.siteType === "blog" ? "blog-template" : "owo-template";
            const [cssResponse, jsResponse] = await Promise.all([
              fetch(`/templates/${templateName}.css`),
              fetch(`/templates/${templateName}.js`),
            ]);

            if (cssResponse.ok) {
              const cssContent = await cssResponse.text();
              zip.file(`${siteFolderName}/public/templates/${templateName}.css`, cssContent);
            }

            if (jsResponse.ok) {
              const jsContent = await jsResponse.text();
              zip.file(`${siteFolderName}/public/templates/${templateName}.js`, jsContent);
            }
          } catch (templateError) {
            console.error(`Error fetching template files for ${siteFolderName}:`, templateError);
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

});

// ==================== Subscriber Management Functions ====================

async function loadSubscribersPanel(siteId) {
  const listEl = document.getElementById("subscribersList");
  const countEl = document.getElementById("subscriberCount");
  const postSelect = document.getElementById("notifyPostSelect");

  try {
    const data = await getSubscribers(siteId);
    const confirmedCount = data.subscribers.filter(s => s.confirmed).length;
    const pendingCount = data.count - confirmedCount;
    countEl.textContent = confirmedCount + (pendingCount > 0 ? ` (+${pendingCount} pending)` : "");

    if (data.subscribers.length === 0) {
      listEl.innerHTML = '<p style="color: #888; font-size: 12px;">No subscribers yet.</p>';
    } else {
      let html = '<table class="table table-condensed" style="margin-bottom: 0; font-size: 12px;"><tbody>';
      for (const sub of data.subscribers) {
        const date = new Date(sub.subscribedAt).toLocaleDateString();
        const statusBadge = sub.confirmed
          ? '<span class="label label-success" style="font-size: 10px;">confirmed</span>'
          : '<span class="label label-warning" style="font-size: 10px;">pending</span>';
        html += `<tr>
          <td>${escapeHtmlOnLoad(sub.email)} ${statusBadge}</td>
          <td style="color: #888;">${date}</td>
          <td style="width: 30px;">
            <button class="btn btn-xs btn-danger remove-subscriber-btn" data-id="${sub.id}" title="Remove">
              <span class="glyphicon glyphicon-remove"></span>
            </button>
          </td>
        </tr>`;
      }
      html += '</tbody></table>';
      listEl.innerHTML = html;

      // Attach remove handlers
      listEl.querySelectorAll(".remove-subscriber-btn").forEach(btn => {
        btn.addEventListener("click", async function () {
          const subId = this.dataset.id;
          if (!confirm("Remove this subscriber?")) return;
          this.disabled = true;
          try {
            await removeSubscriber(siteId, subId);
            await loadSubscribersPanel(siteId);
          } catch (e) {
            alert("Failed to remove subscriber.");
            this.disabled = false;
          }
        });
      });
    }
  } catch (error) {
    listEl.innerHTML = '<p style="color: #888; font-size: 12px;">Could not load subscribers.</p>';
    countEl.textContent = "0";
  }
}

function parseCsvForEmails(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return [];

  // Parse header to find email column
  const headerLine = lines[0];
  const separator = headerLine.includes("\t") ? "\t" : ",";
  const headers = headerLine.split(separator).map(h => h.trim().replace(/^["']|["']$/g, "").toLowerCase());

  // Find email column index
  let emailIndex = headers.findIndex(h =>
    h === "email" || h === "email address" || h === "email_address" || h === "e-mail"
  );

  // Find status column index (if any)
  const statusIndex = headers.findIndex(h =>
    h === "status" || h === "state" || h === "subscription_status"
  );

  // If no email header found, check if first column contains emails
  if (emailIndex === -1) {
    const firstDataLine = lines[1] ? lines[1].split(separator) : [];
    for (let i = 0; i < firstDataLine.length; i++) {
      const val = firstDataLine[i].trim().replace(/^["']|["']$/g, "");
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        emailIndex = i;
        break;
      }
    }
  }

  if (emailIndex === -1) return [];

  const results = [];
  // Start from line 1 (skip header), unless header row itself had no recognizable headers
  const startLine = headers.some(h => h.includes("@")) ? 0 : 1;

  for (let i = startLine; i < lines.length; i++) {
    const cols = lines[i].split(separator).map(c => c.trim().replace(/^["']|["']$/g, ""));
    const email = (cols[emailIndex] || "").trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;

    if (statusIndex !== -1) {
      const status = (cols[statusIndex] || "").trim();
      results.push({ email, status });
    } else {
      results.push(email);
    }
  }

  return results;
}

function escapeHtmlOnLoad(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
