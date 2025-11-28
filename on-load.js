// Global cache for markdown files
let markdownCache = {};
let currentFilePath = null;
let currentSiteId = null;

document.addEventListener("DOMContentLoaded", async function () {

  const gitlabUserId = await getGitlabUserId();
  if (!gitlabUserId) {
    console.log("GitLab access token missing or expired");
    displayGitlabLoginButton();
  } else {
    console.log("GitLab access token present and valid");
    const sites = await getSitesGitLab();

    console.log("GitLab Sites:", sites);
    populateSitesList(sites);
  }

  // Handle create site form submission
  document.getElementById("createSiteForm").addEventListener("submit", async function (event) {
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
    document.getElementById("sitesListPanel").innerHTML = '<button id="createSiteButton" class="btn btn-primary" data-toggle="modal" data-target="#createSiteModal">Create New Site</button>';
    populateSitesList(sites);
  });

  // Handle deploy button click
  document.getElementById("deployButton").addEventListener("click", async function () {
    console.log("Deploy button clicked");
    console.log("Current site ID:", currentSiteId);
    console.log("Markdown cache:", markdownCache);

    if (currentSiteId) {
      // Disable visit site button
      const visitSiteButton = document.getElementById("visitSiteButton");
      visitSiteButton.classList.add("disabled", "btn-deploying");
      visitSiteButton.style.pointerEvents = "none";
      console.log("Visit site button disabled");

      // Deploy changes
      await deployChanges(currentSiteId);
      console.log("Deploy completed for site ID:", currentSiteId);

      // Wait 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Wait for pipeline to finish
      console.log("Waiting for pipeline to complete...");
      let pipelineRunning = await isPipelineRunningGitlab(currentSiteId);
      while (pipelineRunning) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
        pipelineRunning = await isPipelineRunningGitlab(currentSiteId);
        console.log("Pipeline still running:", pipelineRunning);
      }
      console.log("Pipeline completed!");

      // Re-enable visit site button
      visitSiteButton.classList.remove("disabled", "btn-deploying");
      visitSiteButton.style.pointerEvents = "auto";
      console.log("Visit site button re-enabled");
    } else {
      console.error("No site selected");
    }
  });
});

function populateSitesList(sites) {
  for (const site of sites) {
    var siteDiv = document.createElement("div");
    siteDiv.classList.add("site-item", "btn", "btn-default");
    siteDiv.innerHTML = `<h4 style="margin: 0 0 5px 0;">${site.name}</h4><p style="margin: 0;">${site.description || ''}</p>`;
    siteDiv.id = site.id;
    siteDiv.addEventListener("click", async function () {
      console.log(`Loading site: ${site.name} (ID: ${site.id})`);

      // Set current site ID and clear cache
      currentSiteId = site.id;
      markdownCache = {};

      const siteTree = await getSiteTreeGitLab(site.id);
      console.log("Site Tree:", siteTree);

      // Filter for markdown files
      const markdownFiles = siteTree.filter(item => item.type === 'blob' && item.name.endsWith('.md'));
      console.log("Markdown files:", markdownFiles);

      // Hide sites list panel
      const sitesListPanel = document.getElementById("sitesListPanel");
      sitesListPanel.style.display = "none";

      // Show editor panel
      const editorContainer = document.getElementById("editorContainer");
      editorContainer.style.display = "block";

      // Populate sidebar
      populateSidebar(markdownFiles, site.id);

      // Show sidebar
      document.getElementById("sidebar").style.display = "block";

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

      // Load the editor
      loadToastEditor();

      // Populate with index.md
      const indexPath = "public/index.md";
      const mdContent = await getFileContentGitlab(site.id, indexPath);

      // Cache the content
      markdownCache[indexPath] = mdContent;
      currentFilePath = indexPath;

      editor.setMarkdown(mdContent);

      // Set up editor change listener to update cache
      editor.off('change');
      editor.on('change', function() {
        if (currentFilePath) {
          markdownCache[currentFilePath] = editor.getMarkdown();
          console.log(`Cached content for ${currentFilePath}`);
        }
      });

    });
    document.getElementById("sitesListPanel").appendChild(siteDiv);
  }
}

function populateSidebar(markdownFiles, siteId) {
  const sidebarContent = document.getElementById("sidebarContent");
  sidebarContent.innerHTML = ""; // Clear existing content

  for (const file of markdownFiles) {
    const fileItem = document.createElement("div");
    fileItem.classList.add("sidebar-file-item");
    fileItem.textContent = file.path;
    fileItem.addEventListener("click", async function () {
      console.log(`Loading file: ${file.path}`);

      // Remove active class from all items
      document.querySelectorAll(".sidebar-file-item").forEach(item => {
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
      }

      // Update current file path
      currentFilePath = file.path;

      // Set editor content
      editor.setMarkdown(fileContent);
    });
    sidebarContent.appendChild(fileItem);
  }
}

async function gitLabOnLoad() {
  const isLoggedInGitlab = await getGitlabUserId();
  if (!isLoggedInGitlab) {
    console.log("GitLab access token missing or expired");
    displayGitlabLoginButton();
  } else {
    console.log("GitLab access token present and valid");
    loadToastEditor();
  }
}
