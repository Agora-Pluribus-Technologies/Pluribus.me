// Global cache for markdown files
let markdownCache = {};
let currentFilePath = null;
let currentSiteId = null;
let lastDeployTimeInterval = null;
let modified = false;

document.addEventListener("DOMContentLoaded", async function () {
  const gitlabUserId = await getGitlabUserId();
  if (!gitlabUserId) {
    console.log("GitLab access token missing or expired");
    displayGitlabLoginButton();
  } else {
    console.log("GitLab access token present and valid");
    const createSiteButton = document.getElementById("createSiteButton");
    createSiteButton.style.display = "block";

    const sites = await getSitesGitLab();

    console.log("GitLab Sites:", sites);
    populateSitesList(sites);
  }

  // Handle create site form submission
  document
    .getElementById("createSiteForm")
    .addEventListener("submit", async function (event) {
      event.preventDefault();

      const siteName = document.getElementById("siteName").value;
      const siteDescription = document.getElementById("siteDescription").value;

      console.log("Creating new site:", siteName, siteDescription);

      const siteId = await createSiteGitlab(siteName, siteDescription);

      console.log("New site created with ID:", siteId);

      await initialCommitGitlab(siteId);

      console.log("Initial commit made for site ID:", siteId);

      // Close the modal
      $("#createSiteModal").modal("hide");

      // Clear the form
      document.getElementById("createSiteForm").reset();

      // Refresh the sites list
      const sites = await getSitesGitLab();
      document.getElementById("sitesListPanel").innerHTML =
        '<button id="createSiteButton" class="btn btn-primary" data-toggle="modal" data-target="#createSiteModal">Create New Site</button>';
      populateSitesList(sites);
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
        await deployChangesGitlab(currentSiteId);

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

      const sidebarContent = document.getElementById("sidebarContent");

      // Create input element for new page name
      const inputContainer = document.createElement("div");
      inputContainer.classList.add("sidebar-file-item");
      inputContainer.style.padding = "4px";

      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Page name...";
      input.style.width = "100%";
      input.style.border = "1px solid #1890ff";
      input.style.padding = "4px";
      input.style.fontSize = "14px";

      inputContainer.appendChild(input);
      sidebarContent.insertBefore(inputContainer, sidebarContent.firstChild);

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
        await populateSidebar(currentSiteId);
      });
    });
});

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

    // Refresh the sidebar
    await populateSidebar(currentSiteId);

    // Open the new page in the editor
    currentFilePath = newFilePath;
    editor.setMarkdown(markdownCache[newFilePath]);
  }
}

async function updateLastDeployTime() {
  if (!currentSiteId) {
    return;
  }

  const lastDeployTime = await getLatestPagesDeployTimeGitlab(currentSiteId);
  const lastUpdatedLabel = document.getElementById("last-updated-time-label");
  if (lastDeployTime) {
    const oldText = lastUpdatedLabel.textContent;
    const newText = `Last deployed: ${lastDeployTime.toLocaleString()}`;
    if (oldText != newText) {
      lastUpdatedLabel.textContent = newText;
      console.log("Updated last deploy time:", lastDeployTime);
    }
  } else {
    lastUpdatedLabel.textContent = "";
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
  for (const site of sites) {
    var siteDiv = document.createElement("div");
    siteDiv.classList.add("site-item", "btn", "btn-default");
    siteDiv.innerHTML = `<h4 style="margin: 0 0 5px 0;">${
      site.name
    }</h4><p style="margin: 0;">${site.description || ""}</p>`;
    siteDiv.id = site.id;
    siteDiv.addEventListener("click", async function () {
      console.log(`Loading site: ${site.name} (ID: ${site.id})`);

      // Set current site ID and clear cache
      currentSiteId = site.id;
      markdownCache = {};
      modified = false;

      // Clear existing interval if any
      if (lastDeployTimeInterval) {
        clearInterval(lastDeployTimeInterval);
      }

      // Update deploy button state (should be disabled since not modified)
      updateDeployButtonState();

      // Hide sites list panel
      const sitesListPanel = document.getElementById("sitesListPanel");
      sitesListPanel.style.display = "none";

      // Show editor panel
      const editorContainer = document.getElementById("editorContainer");
      editorContainer.style.display = "flex";

      // Fetch site tree from GitLab
      const siteTree = await getSiteTreeGitLab(site.id);
      console.log("Site Tree:", siteTree);

      // Filter for markdown files and load them into cache
      const markdownFiles = siteTree.filter(
        (item) => item.type === "blob" && item.name.endsWith(".md")
      );
      console.log("Markdown files:", markdownFiles);

      // Load all markdown files into cache
      for (const file of markdownFiles) {
        const content = await getFileContentGitlab(site.id, file.path);
        markdownCache[file.path] = content;
      }

      // Populate sidebar from cache
      await populateSidebar(site.id);

      // Show sidebar with initial width
      const sidebar = document.getElementById("sidebar");
      const editorSection = document.getElementById("editorSection");
      sidebar.style.display = "flex";
      sidebar.style.width = "20%";
      editorSection.style.maxWidth = "80%";
      editorSection.style.minWidth = "40%";
      editorSection.style.flex = "none";

      // Set up Visit Site button
      const pagesUrl = await getPagesUrlGitlab(site.id);
      const visitSiteButton = document.getElementById("visitSiteButton");
      if (pagesUrl) {
        visitSiteButton.href = pagesUrl;
        console.log("Pages URL:", pagesUrl);
      } else {
        visitSiteButton.href = "#";
        console.log("Pages URL not available yet");
      }

      // Update last deployed time immediately
      await updateLastDeployTime();

      // Set up interval to update every 5 seconds
      lastDeployTimeInterval = setInterval(updateLastDeployTime, 5000);
      console.log("Started last deploy time update interval");

      // Load the editor
      loadToastEditor();

      // Click the index sidebar item to load it
      setTimeout(() => {
        const sidebarItems = document.querySelectorAll(".sidebar-file-item");
        for (const item of sidebarItems) {
          const text = item.querySelector("span");
          if (text && text.textContent === "index") {
            text.click();

            // Set up editor change listener to update cache
            editor.off("change");
            editor.on("change", function () {
              if (currentFilePath) {
                markdownCache[currentFilePath] = editor.getMarkdown();
                console.log(`Cached content for ${currentFilePath}`);
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
    document.getElementById("sitesListPanel").appendChild(siteDiv);
  }
}

async function populateSidebar(siteId) {
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
  const indexFile = markdownFiles.find(f => f.path.replace("public/", "").replace(".md", "") === "index");
  const otherFiles = markdownFiles.filter(f => f.path.replace("public/", "").replace(".md", "") !== "index");
  const sortedFiles = indexFile ? [indexFile, ...otherFiles] : otherFiles;
  markdownFiles.length = 0;
  markdownFiles.push(...sortedFiles);

  const sidebarContent = document.getElementById("sidebarContent");
  sidebarContent.innerHTML = ""; // Clear existing content

  for (const file of markdownFiles) {
    const fileItem = document.createElement("div");
    fileItem.classList.add("sidebar-file-item");
    fileItem.style.display = "flex";
    fileItem.style.justifyContent = "space-between";
    fileItem.style.alignItems = "center";

    // Create text span for file path
    const fileText = document.createElement("span");
    // Display only the page name (remove "public/" and ".md")
    const displayName = file.path.replace("public/", "").replace(".md", "");
    fileText.textContent = displayName;
    fileText.style.flex = "1";
    fileText.style.cursor = "pointer";

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
              const content = await getFileContentGitlab(siteId, oldFilePath);
              markdownCache[newFilePath] = content;
            }

            // Update current file path if it was the renamed file
            if (currentFilePath === oldFilePath) {
              currentFilePath = newFilePath;
              editor.setMarkdown(markdownCache[newFilePath]);
            }

            // Mark as modified
            modified = true;
            updateDeployButtonState();

            // Refresh the sidebar
            await populateSidebar(siteId);

            console.log("Page renamed in cache:", sanitizedNewName);

            // Click the renamed item in the sidebar to load it
            setTimeout(() => {
              const sidebarItems = document.querySelectorAll(".sidebar-file-item");
              for (const item of sidebarItems) {
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
          if (currentFilePath === file.path) {
            editor.setMarkdown("");
            currentFilePath = null;
          }

          // Mark as modified
          modified = true;
          updateDeployButtonState();

          // Refresh the sidebar
          await populateSidebar(siteId);

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
      document.querySelectorAll(".sidebar-file-item").forEach((item) => {
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
      } else {
        // Fetch from GitLab
        console.log(`Fetching content for ${file.path}`);
        fileContent = await getFileContentGitlab(siteId, file.path);
        markdownCache[file.path] = fileContent;

        // Update deploy button state since cache was updated
        updateDeployButtonState();
      }

      // Update current file path
      currentFilePath = file.path;

      // Set editor content
      editor.setMarkdown(fileContent);
    });
    sidebarContent.appendChild(fileItem);
  }
}
