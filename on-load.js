// Global cache for markdown files
let markdownCache = {};
let currentSitePath = null;
let currentSiteId = null;
let currentSitePathFull = null;
let lastDeployTimeInterval = null;
let modified = false;

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

    const sitesListHeader = document.getElementById("sites-list-header");
    sitesListHeader.style.display = "block";

    populateSitesList(sites);
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

      // Refresh the sites list
      let sites;
      if (getOauthTokenGitlab() !== null) {
        sites = await getSitesGitLab();
      } else if (getOauthTokenGithub() !== null) {
        sites = await getSitesGitHub();
      }
      populateSitesList(sites);
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
        // Deploy changes
        if (getOauthTokenGitlab() !== null) {
          await deployChangesGitlab(currentSiteId);
        } else if (getOauthTokenGithub() !== null) {
          await deployChangesGithub(currentSiteId);
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
      menubarContent.insertBefore(inputContainer, menubarContent.firstChild);

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

  // Clear existing interval if any
  if (lastDeployTimeInterval) {
    clearInterval(lastDeployTimeInterval);
    lastDeployTimeInterval = null;
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

function populateSitesList(sites) {
  document.getElementById("sites-list").innerHTML = ""; // Clear existing list
  for (const site of sites) {
    var siteDiv = document.createElement("div");
    siteDiv.classList.add("site-button", "site-item", "btn", "btn-default");
    siteDiv.innerText = site.name;
    siteDiv.id = site.id;
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
    document.getElementById("sites-list").appendChild(siteDiv);
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
  menubarContent.innerHTML = ""; // Clear existing content

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
}
