// Global cache for markdown files - Array of {displayName, fileName, content}
let markdownCache = [];
let currentSitePath = null;
let currentSiteId = null;
let currentSitePathFull = null;
let lastDeployTimeInterval = null;
let modified = false;

// Global cache for sites list
let sitesCache = [];

// Global cache for images - Array of filenames
let imageCache = [];

// Helper functions for markdownCache
function getCacheByFileName(fileName) {
  return markdownCache.find(item => item.fileName === fileName);
}

function getCacheByDisplayName(displayName) {
  return markdownCache.find(item => item.displayName === displayName);
}

function addOrUpdateCache(fileName, displayName, content) {
  const existing = getCacheByFileName(fileName);
  if (existing) {
    if (displayName) {
      existing.displayName = displayName;
    } else {
      displayName = existing.displayName
    }
    if (content) {
      existing.content = content;
    } else {
      content = existing.content;
    }
  } else {
    markdownCache.push({ displayName, fileName, content });
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

// Load sites for a specific user
async function loadSitesForUser(username) {
  console.log("Loading sites for user:", username);

  // Fetch sites filtered by owner (username)
  const sites = await getSites(username);

  // Cache the sites list
  sitesCache = sites || [];

  const sitesListHeader = document.getElementById("sites-list-header");
  sitesListHeader.style.display = "block";

  populateSitesList(sitesCache);
}

document.addEventListener("DOMContentLoaded", async function () {
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
      await loadSitesForUser(existingUser.username);
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

  let usernameCheckTimeout = null;

  usernameInput.addEventListener("input", function () {
    const username = usernameInput.value.trim();

    // Clear previous timeout
    if (usernameCheckTimeout) {
      clearTimeout(usernameCheckTimeout);
    }

    // Reset states
    usernameError.style.display = "none";
    usernameSuccess.style.display = "none";
    submitUsernameButton.disabled = true;

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
        submitUsernameButton.disabled = false;
      } else {
        usernameError.textContent = "Username is already taken.";
        usernameError.style.display = "block";
        usernameSuccess.style.display = "none";
        submitUsernameButton.disabled = true;
      }
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

      // Close modal and load sites
      $("#usernameModal").modal("hide");
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
        const siteName = document.getElementById("siteName").value;
        const siteDescription = document.getElementById("siteDescription").value;

        console.log("Creating new site:", siteName, siteDescription);

        // Get stored username (set during login)
        const owner = getStoredUsername();
        if (!owner) {
          alert("No username found. Please log in again.");
          return;
        }

        // Get provider info
        const providerInfo = await getCurrentProviderInfo();
        const provider = providerInfo ? providerInfo.provider : "unknown";

        // Sanitize site name for use as repo name
        const repo = siteName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

        const siteId = `${owner}/${repo}`;

        // Store site config in KV
        const createResponse = await fetch("/api/sites", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            siteId: siteId,
            provider: provider,
            owner: owner,
            repo: repo,
            branch: "main",
            basePath: "/public",
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
        await initialCommit(siteId);
        console.log("Initial commit completed for site:", siteId);

        // Initialize git repository
        await gitInit(siteId);
        await gitWriteFile(siteId, "public/pages.json", "[]");
        await gitWriteFile(siteId, "public/images.json", "[]");
        await gitCommit(siteId, "Initial commit");
        console.log("Git repo initialized for site:", siteId);

        // Add new site to cache
        const newSite = {
          siteId: siteId,
          provider: provider,
          owner: owner,
          repo: repo,
          branch: "main",
          basePath: "/public",
        };
        sitesCache.unshift(newSite);

        // Close the modal
        $("#createSiteModal").modal("hide");

        // Clear the form
        document.getElementById("createSiteForm").reset();

        // Repopulate sites list
        populateSitesList(sitesCache);
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
        goBackToSiteSelection();
      } else {
        document.getElementById("backButton").blur();
      }
    } else {
      goBackToSiteSelection();
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

      try {
        // Create git commit
        const commitSha = await gitCommit(currentSiteId, commitMessage);
        console.log("Commit created:", commitSha);

        // Deploy changes to R2 storage
        const deploySuccess = await deployChanges(currentSiteId);

        // Close modal
        $("#commitModal").modal("hide");

        // Reset modified flag after successful deployment
        modified = false;
        updateDeployButtonState();

        // Show success or failure message
        if (deploySuccess) {
          showAlertBar(`Deployed successfully! Commit: ${commitSha ? commitSha.substring(0, 7) : "done"}`, true);
        } else {
          showAlertBar("Deploy failed. Please check the console for errors.", false);
        }
      } catch (error) {
        console.error("Deploy error:", error);
        showAlertBar("Deploy failed: " + error.message, false);
      } finally {
        confirmButton.disabled = false;
        confirmButton.textContent = originalText;
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

        await triggerCreateNewSiteGitlab(displayName);
        await populateMenubar(currentSiteId);
      });
    });
});

function goBackToSiteSelection() {
  console.log("Returning to site selection");

  // Clear existing intervals if any
  if (lastDeployTimeInterval) {
    clearInterval(lastDeployTimeInterval);
    lastDeployTimeInterval = null;
  }

  if (siteAvailabilityInterval) {
    clearInterval(siteAvailabilityInterval);
    siteAvailabilityInterval = null;
    console.log("Cleared site availability check interval");
  }

  // Reset state
  currentSiteId = null;
  currentSitePathFull = null;
  currentSitePath = null;
  markdownCache = [];
  imageCache = [];
  modified = false;

  // Hide editor container
  const editorContainer = document.getElementById("editorContainer");
  editorContainer.style.display = "none";

  // Show sites list panel
  const sitesListPanel = document.getElementById("sites-list-panel");
  sitesListPanel.style.display = "block";

  // Repopulate sites list from cache
  populateSitesList(sitesCache);

  console.log("Back to site selection complete");
}

async function triggerCreateNewSiteGitlab(displayName) {
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

  // Auto-hide after 5 seconds
  setTimeout(() => {
    alertBar.className = "alert-bar";
  }, 5000);
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

function populateSitesList(sites) {
  document.getElementById("sites-list").innerHTML = ""; // Clear existing list
  for (const site of sites) {
    // Create container for site button and delete button
    var siteContainer = document.createElement("div");
    siteContainer.style.display = "flex";
    siteContainer.style.alignItems = "center";
    siteContainer.style.gap = "8px";
    siteContainer.style.marginBottom = "8px";

    // Create site button
    var siteDiv = document.createElement("div");
    siteDiv.classList.add("site-button", "site-item", "btn", "btn-default");
    siteDiv.innerText = site.repo;
    siteDiv.id = site.siteId;
    siteDiv.style.flex = "1";
    siteDiv.addEventListener("click", async function () {
      console.log(`Loading site: ${site.repo} (ID: ${site.siteId})`);

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
          "# Welcome to your Pluribus OwO Site!\n\nThis is your site's homepage. Edit this file to customize your site."
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

        // Load all markdown files into cache
        for (const file of markdownFiles) {
          console.log("Loading file into cache:", file);
          const content = await getFileContent(currentSiteId, file);
          addOrUpdateCache(file, null, content);
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

      // Click the Home menubar item to load it
      setTimeout(() => {
        const menubarItems = document.querySelectorAll(".menubar-item");
        for (const item of menubarItems) {
          const text = item.querySelector("span");
          if (text && text.textContent === "Home") {
            text.click();

            // Set up editor change listener to update cache
            editor.off("change");
            editor.on("change", function () {
              if (currentSitePath) {
                const cacheItem = getCacheByFileName(currentSitePath);
                if (cacheItem) {
                  let currentMarkdown = editor.getMarkdown();
                  cacheItem.content = currentMarkdown;
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
      }, 100);
    });

    // Create delete button
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

        const deleteResponse = await fetch(`/api/sites?siteId=${encodeURIComponent(site.siteId)}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (deleteResponse.ok) {
          console.log("Site deleted successfully");

          // Remove from cache
          sitesCache = sitesCache.filter(s => s.siteId !== site.siteId);

          // Repopulate the list
          populateSitesList(sitesCache);

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

    // Add both buttons to container
    siteContainer.appendChild(siteDiv);
    siteContainer.appendChild(deleteButton);

    // Add container to sites list
    document.getElementById("sites-list").appendChild(siteContainer);
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
