// Global cache for markdown files
let markdownCache = {};
let currentSitePath = null;
let currentSiteId = null;
let currentSitePathFull = null;
let lastDeployTimeInterval = null;
let modified = false;

// Global cache for sites list
let sitesCache = [];

// Interval for checking site availability
let siteAvailabilityInterval = null;

document.addEventListener("DOMContentLoaded", async function () {
  if (getOauthTokenGithub() === null && getOauthTokenGitlab() === null) {
    console.log("Access tokens missing or expired");
    displayLoginButtons();
  } else {
    let sites;
    if (getOauthTokenGitlab() !== null) {
      console.log("GitLab access token present and valid");
      sites = await getSitesGitLab();
      console.log("GitLab Sites:", sites);
    } else if (getOauthTokenGithub() !== null) {
      console.log("GitHub access token present and valid");
      sites = await getSitesGitHub();
      console.log("GitHub Sites:", sites);
    }

    // Cache the sites list
    sitesCache = sites || [];

    const sitesListHeader = document.getElementById("sites-list-header");
    sitesListHeader.style.display = "block";

    populateSitesList(sitesCache);
  }

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

        let siteId;
        if (getOauthTokenGitlab() !== null) {
          siteId = await createSiteGitlab(siteName, siteDescription);
          console.log("New GitLab site created with ID:", siteId);
          await initialCommitGitlab(siteId);
        } else if (getOauthTokenGithub() !== null) {
          siteId = await createSiteGithub(siteName, siteDescription);
          console.log("New GitHub site created with ID:", siteId);
          await initialCommitGithub(siteId);
        }

        console.log("Initial commit made for site ID:", siteId);

        // Close the modal
        $("#createSiteModal").modal("hide");

        // Clear the form
        document.getElementById("createSiteForm").reset();

        // Add new site directly to cache
        console.log("Adding new site to cache");

        // Create a site object with the minimal required fields
        const newSite = {
          name: siteName,
          description: `${siteName}: ${siteDescription} | A Pluribus OwO site created with the Pluribus.me site builder`
        };

        if (getOauthTokenGitlab() !== null) {
          newSite.id = siteId;
          newSite.path_with_namespace = `${siteName.toLowerCase().replace(/\s+/g, "-")}-pluribus-owo-site`;
        } else if (getOauthTokenGithub() !== null) {
          newSite.full_name = siteId;
        }

        // Add to the beginning of the cache
        sitesCache.unshift(newSite);

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

  // Handle deploy button click
  document
    .getElementById("deployButton")
    .addEventListener("click", async function () {
      console.log("Deploy button clicked");
      console.log("Current site ID:", currentSiteId);
      console.log("Markdown cache:", markdownCache);

      if (currentSiteId) {
        const deployButton = document.getElementById("deployButton");
        const originalButtonText = deployButton.textContent;

        // Show loading state
        deployButton.classList.add("loading");
        deployButton.textContent = "";
        deployButton.disabled = true;

        let deploySuccess = false;

        try {
          // Deploy changes
          if (getOauthTokenGitlab() !== null) {
            deploySuccess = await deployChangesGitlab(currentSiteId);
          } else if (getOauthTokenGithub() !== null) {
            deploySuccess = await deployChangesGithub(currentSiteId);
          }

          // Link pluribus site
          console.log("Current full site path:", currentSitePathFull);

          // Check if site exists in API, create if not
          if (currentSitePathFull) {
            try {
              // First, check if site exists
              const checkResponse = await fetch(`/api/sites?siteId=${encodeURIComponent(currentSitePathFull)}`, {
                method: "GET",
                headers: {
                  "Content-Type": "application/json",
                },
              });

              if (checkResponse.status === 404) {
                // Site doesn't exist, create it
                console.log("Site not found in API, creating...");

                // Determine provider and parse owner/repo
                const provider = getOauthTokenGitlab() !== null ? "gitlab" : "github";
                const [owner, repo] = currentSitePathFull.split("/");

                const createResponse = await fetch("/api/sites", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    siteId: currentSitePathFull,
                    provider: provider,
                    owner: owner,
                    repo: repo,
                    branch: "main",
                    basePath: "/public",
                  }),
                });

                if (createResponse.ok) {
                  console.log("Site created successfully in API");
                } else {
                  const errorText = await createResponse.text();
                  console.error("Failed to create site in API:", errorText);
                }
              } else if (checkResponse.ok) {
                console.log("Site already exists in API");
              } else {
                console.error("Error checking site existence:", checkResponse.status);
              }
            } catch (error) {
              console.error("Error linking pluribus site:", error);
            }
          }

          // Reset modified flag after successful deployment
          modified = false;
          updateDeployButtonState();

          // Show success or failure message
          if (deploySuccess) {
            showAlertBar("Deploy successful! Your changes will be live in about 5 minutes.", true);
          } else {
            showAlertBar("Deploy failed. Please check the console for errors.", false);
          }
        } catch (error) {
          console.error("Deploy error:", error);
          showAlertBar("Deploy failed. Please check the console for errors.", false);
        } finally {
          // Remove loading state
          deployButton.classList.remove("loading");
          deployButton.textContent = originalButtonText;
        }
      } else {
        console.error("No site selected");
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
        const pageName = input.value.trim();
        await triggerCreateNewSiteGitlab(pageName);
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
  markdownCache = {};
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

async function triggerCreateNewSiteGitlab(pageName) {
  if (pageName) {
    // Sanitize page name: lowercase and replace spaces with hyphens
    const sanitizedName = pageName.toLowerCase().replace(/\s+/g, "-");
    console.log("Creating new page:", sanitizedName);

    // Add to markdownCache with default content
    const newFilePath = `public/${sanitizedName}.md`;
    markdownCache[newFilePath] = `# ${sanitizedName}\n\nYour content here...`;
    console.log("New page added to cache:", sanitizedName);

    // Mark as modified
    modified = true;
    updateDeployButtonState();

    // Refresh the menubar
    await populateMenubar(currentSiteId);

    // Open the new page in the editor
    currentSitePath = newFilePath;
    editor.setMarkdown(markdownCache[newFilePath]);
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
      method: "HEAD",
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
    siteDiv.innerText = site.name;
    siteDiv.id = site.id;
    siteDiv.style.flex = "1";
    siteDiv.addEventListener("click", async function () {
      console.log(`Loading site: ${site.name} (ID: ${site.id})`);

      // Set current site ID and clear cache
      if (getOauthTokenGitlab() !== null) {
        currentSiteId = site.id;
        currentSitePathFull = site.path_with_namespace;
      } else if (getOauthTokenGithub() !== null) {
        currentSiteId = site.full_name;
        currentSitePathFull = site.full_name;
      }

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

      markdownCache = {};
      modified = false;

      // Update deploy button state (should be disabled since not modified)
      updateDeployButtonState();

      // Hide sites list panel
      const sitesListPanel = document.getElementById("sites-list-panel");
      sitesListPanel.style.display = "none";

      // Show editor panel
      const editorContainer = document.getElementById("editorContainer");
      editorContainer.style.display = "flex";

      // Fetch site tree
      let markdownFiles;
      if (getOauthTokenGitlab() !== null) {
        markdownFiles = await getPublicFilesGitLab(site.id);
      } else if (getOauthTokenGithub() !== null) {
        markdownFiles = await getPublicFilesGitHub(site.full_name);
      }

      console.log("Markdown files:", markdownFiles);
      if (markdownFiles.length === 0) {
        // No markdown files found - create a dummy index.md
        console.log("Site is empty - created dummy index.md");
        markdownCache["public/index.md"] =
          "# Welcome to your Pluribus OwO Site!\n\nThis is your site's homepage. Edit this file to customize your site.";
      } else {
        // Load all markdown files into cache
        for (const file of markdownFiles) {
          console.log("Loading file into cache:", file);
          let content;
          if (getOauthTokenGitlab() !== null) {
            content = await getFileContentGitlab(site.id, file);
          } else if (getOauthTokenGithub() !== null) {
            content = await getFileContentGithub(site.full_name, file);
          }
          markdownCache[file] = content;
        }
      }

      // Populate menubar from cache
      await populateMenubar(site.id);

      // Load the editor
      loadToastEditor();

      // Click the index menubar item to load it
      setTimeout(() => {
        const menubarItems = document.querySelectorAll(".menubar-item");
        for (const item of menubarItems) {
          const text = item.querySelector("span");
          if (text && text.textContent === "index") {
            text.click();

            // Set up editor change listener to update cache
            editor.off("change");
            editor.on("change", function () {
              if (currentSitePath) {
                markdownCache[currentSitePath] = editor.getMarkdown();
                console.log(`Cached content for ${currentSitePath}`);
                modified = true;
                updateDeployButtonState();
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

      const confirmMessage = `Are you sure you want to delete "${site.name}"? This action cannot be undone and will permanently delete the repository.`;
      if (confirm(confirmMessage)) {
        console.log("Deleting site:", site.name);

        // Disable button during deletion
        deleteButton.disabled = true;
        deleteButton.textContent = "...";
        deleteButton.style.opacity = "0.5";

        let success = false;
        let siteIdToDelete;

        if (getOauthTokenGitlab() !== null) {
          siteIdToDelete = site.id;
          success = await deleteSiteGitlab(siteIdToDelete);
        } else if (getOauthTokenGithub() !== null) {
          siteIdToDelete = site.full_name;
          success = await deleteSiteGithub(siteIdToDelete);
        }

        if (success) {
          console.log("Site deleted successfully");

          // Remove from cache
          sitesCache = sitesCache.filter(s => {
            if (getOauthTokenGitlab() !== null) {
              return s.id !== siteIdToDelete;
            } else {
              return s.full_name !== siteIdToDelete;
            }
          });

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
  // Use markdownCache as source of truth
  const markdownFiles = [];
  for (const cachePath in markdownCache) {
    if (cachePath.endsWith(".md") && cachePath.startsWith("public/")) {
      markdownFiles.push({
        path: cachePath,
        type: "blob",
        name: cachePath.split("/").pop(),
      });
    }
  }

  // Move index to the front, keep other files in original order
  const indexFile = markdownFiles.find(
    (f) => f.path.replace("public/", "").replace(".md", "") === "index"
  );
  const otherFiles = markdownFiles.filter(
    (f) => f.path.replace("public/", "").replace(".md", "") !== "index"
  );
  const sortedFiles = indexFile ? [indexFile, ...otherFiles] : otherFiles;
  markdownFiles.length = 0;
  markdownFiles.push(...sortedFiles);

  const menubarContent = document.getElementById("pageMenubarContent");
  const addButton = document.getElementById("addNewPageButton");

  // Clear existing content but preserve the add button
  menubarContent.innerHTML = "";

  for (const file of markdownFiles) {
    const fileItem = document.createElement("div");
    fileItem.classList.add("menubar-item");

    // Create text span for file path
    const fileText = document.createElement("span");
    // Display only the page name (remove "public/" and ".md")
    const displayName = file.path.replace("public/", "").replace(".md", "");
    fileText.textContent = displayName;
    fileText.classList.add("menubar-item-text");

    // Create button container
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "5px";

    // Only add rename and delete buttons if not index page
    if (displayName !== "index") {
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
            const sanitizedNewName = newPageName
              .toLowerCase()
              .replace(/\s+/g, "-");
            const oldPageName = file.path
              .replace("public/", "")
              .replace(".md", "");

            console.log(
              "Renaming page from:",
              oldPageName,
              "to:",
              sanitizedNewName
            );

            // Update cache - rename the file in cache
            const oldFilePath = file.path;
            const newFilePath = `public/${sanitizedNewName}.md`;
            if (markdownCache[oldFilePath]) {
              markdownCache[newFilePath] = markdownCache[oldFilePath];
              delete markdownCache[oldFilePath];
            } else {
              // If not in cache yet, fetch it first then rename
              let content;
              if (getOauthTokenGitlab() !== null) {
                content = await getFileContentGitlab(siteId, oldFilePath);
              } else if (getOauthTokenGithub() !== null) {
                content = await getFileContentGithub(siteId, oldFilePath);
              }
              markdownCache[newFilePath] = content;
            }

            // Update current file path if it was the renamed file
            if (currentSitePath === oldFilePath) {
              currentSitePath = newFilePath;
              editor.setMarkdown(markdownCache[newFilePath]);
            }

            // Mark as modified
            modified = true;
            updateDeployButtonState();

            // Refresh the menubar
            await populateMenubar(siteId);

            console.log("Page renamed in cache:", sanitizedNewName);

            // Click the renamed item in the menubar to load it
            setTimeout(() => {
              const menubarItems = document.querySelectorAll(".menubar-item");
              for (const item of menubarItems) {
                const text = item.querySelector("span");
                if (text && text.textContent === sanitizedNewName) {
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
          delete markdownCache[file.path];

          // Clear editor if the deleted file was open
          if (currentSitePath === file.path) {
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
    if (displayName !== "index") {
      fileItem.appendChild(buttonContainer);
    }

    fileText.addEventListener("click", async function () {
      console.log(`Loading file: ${file.path}`);

      // Remove active class from all items
      document.querySelectorAll(".menubar-item").forEach((item) => {
        item.classList.remove("active");
      });

      // Add active class to clicked item
      fileItem.classList.add("active");

      // Load file content
      let fileContent;
      if (markdownCache[file.path]) {
        // Use cached version
        console.log(`Using cached content for ${file.path}`);
        fileContent = markdownCache[file.path];
        modified = true;
      } else {
        // Fetch from remote
        console.log(`Fetching content for ${file.path}`);
        if (getOauthTokenGitlab() !== null) {
          fileContent = await getFileContentGitlab(siteId, file.path);
        } else if (getOauthTokenGithub() !== null) {
          fileContent = await getFileContentGithub(siteId, file.path);
        }
        markdownCache[file.path] = fileContent;
        modified = false;
      }
      // Update deploy button state since cache was updated
      updateDeployButtonState();

      // Update current file path
      currentSitePath = file.path;

      // Set editor content
      editor.setMarkdown(fileContent);
    });
    menubarContent.appendChild(fileItem);
  }

  // Add the "+" button back at the end
  menubarContent.appendChild(addButton);
}
