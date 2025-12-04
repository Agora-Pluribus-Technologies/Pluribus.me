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

const GITLAB_AUTH_URL = "https://gitlab.com/oauth/authorize";
const GITLAB_CLIENT_ID = "12328ed7f6e7e0ffae8d10d8531df71aeffd7db927c966ffc763bf07e8800656";
const GITLAB_REDIRECT_URI = "https://pluribus.me/gitlab/oauth/callback";
const GITLAB_DEV_CLIENT_ID = "31f7d88be4728aeffa2afa1ec6075b959aadf4e4015cd4afa725815a083ece66";
const GITLAB_DEV_REDIRECT_URI = "https://develop.pluribus-me.pages.dev/gitlab/oauth/callback";
const GITLAB_CLIENT_SCOPE = "api";

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_CLIENT_ID = "Ov23liqELtwrv29MS9Wc";
const GITHUB_REDIRECT_URI = "https://pluribus.me/github/oauth/callback";
const GITHUB_DEV_CLIENT_ID = "Ov23liwXpCsvFNlZJ0x8";
const GITHUB_DEV_REDIRECT_URI = "https://develop.pluribus-me.pages.dev/github/oauth/callback";
const GITHUB_CLIENT_SCOPE = "repo user delete_repo";

var GITLAB_USER_ID = null;
var GITHUB_USERNAME = null;

const STORAGE_KEY_GITLAB_OAUTH_TOKEN = "pluribus.me.gitlab.oauth_token";
const STORAGE_KEY_GITHUB_OAUTH_TOKEN = "pluribus.me.github.oauth_token";

// Check if we have a token in the URL hash (from OAuth callback redirect)
if (window.location.hash) {
  const params = new URLSearchParams(window.location.hash.substring(1));
  let accessToken;
  if (window.location.hash.startsWith("#gitlab")) {
    accessToken = params.get("gitlab_access_token");
    sessionStorage.setItem(STORAGE_KEY_GITLAB_OAUTH_TOKEN, accessToken);
  } else if (window.location.hash.startsWith("#github")) {
    accessToken = params.get("github_access_token");
    sessionStorage.setItem(STORAGE_KEY_GITHUB_OAUTH_TOKEN, accessToken);
  }

  if (accessToken) {
    // Clear the hash from URL
    window.history.replaceState(null, null, window.location.pathname);
  }
}

function getOauthTokenGitlab() {
  return sessionStorage.getItem(STORAGE_KEY_GITLAB_OAUTH_TOKEN);
}

function getOauthTokenGithub() {
  return sessionStorage.getItem(STORAGE_KEY_GITHUB_OAUTH_TOKEN);
}

function displayLoginButtons() {
  // Create container for both buttons
  const buttonContainer = document.createElement("div");
  buttonContainer.style.display = "flex";
  buttonContainer.style.gap = "10px";
  buttonContainer.style.justifyContent = "center";
  buttonContainer.style.flexWrap = "wrap";

  // GitHub login button
  var githubLoginButton = document.createElement("button");
  githubLoginButton.classList.add("btn");
  githubLoginButton.innerText = "Sign in with GitHub";
  githubLoginButton.style.padding = "10px 18px";
  githubLoginButton.style.cursor = "pointer";

  githubLoginButton.addEventListener("click", () => {
    // Build the authorization URL
    let clientId;
    let redirectUri;
    if (document.location.origin.includes("develop")) {
      clientId = GITHUB_DEV_CLIENT_ID;
      redirectUri = GITHUB_DEV_REDIRECT_URI;
    } else {
      clientId = GITHUB_CLIENT_ID;
      redirectUri = GITHUB_REDIRECT_URI;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: GITHUB_CLIENT_SCOPE,
    });

    // Redirect user to login page
    window.location.href = `${GITHUB_AUTH_URL}?${params.toString()}`;
  });

  // GitLab login button
  var gitlabLoginButton = document.createElement("button");
  gitlabLoginButton.classList.add("btn");
  gitlabLoginButton.innerText = "Sign in with GitLab";
  gitlabLoginButton.style.padding = "10px 18px";
  gitlabLoginButton.style.cursor = "pointer";

  gitlabLoginButton.addEventListener("click", () => {
    // Build the authorization URL
    
    // Build the authorization URL
    let clientId;
    let redirectUri;
    if (document.location.origin.includes("develop")) {
      clientId = GITLAB_DEV_CLIENT_ID;
      redirectUri = GITLAB_DEV_REDIRECT_URI;
    } else {
      clientId = GITLAB_CLIENT_ID;
      redirectUri = GITLAB_REDIRECT_URI;
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: GITLAB_CLIENT_SCOPE,
      response_type: "code",
    });

    // Redirect user to login page
    window.location.href = `${GITLAB_AUTH_URL}?${params.toString()}`;
  });

  buttonContainer.appendChild(githubLoginButton);
  buttonContainer.appendChild(gitlabLoginButton);

  const sitesListPanel = document.getElementById("sites-list-panel");
  sitesListPanel.appendChild(buttonContainer);
}

async function getGitlabUserId() {
  if (GITLAB_USER_ID) {
    return GITLAB_USER_ID;
  }

  const response = await fetch("https://gitlab.com/api/v4/user", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  });

  if (!response.ok) return null;

  const data = await response.json();

  GITLAB_USER_ID = data.id;

  console.log("GitLab User ID:", data.id);

  return data.id;
}

async function getGithubUsername() {
  if (GITHUB_USERNAME) {
    return GITHUB_USERNAME;
  }

  const response = await fetch("https://api.github.com/user", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) return null;

  const data = await response.json();

  GITHUB_USERNAME = data.login;

  console.log("GitHub User ID:", data.login);

  return data.login;
}

async function getSitesGitLab() {
  const gitlabUserId = await getGitlabUserId();
  const gitlabSitesUrl = `https://gitlab.com/api/v4/users/${gitlabUserId}/projects`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
      "Cache-Control": "no-cache",
    },
  };

  const response = await fetch(gitlabSitesUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  var sites = [];
  for (const site of responseJson) {
    const name = site.name.toLowerCase();
    const description = site.description.toLowerCase();
    if (description.includes("pluribus owo") && !name.includes("deletion_scheduled")) {
      sites.push(site);
    }
  }

  return sites;
}

async function getSitesGitHub() {
  const githubUsername = await getGithubUsername();
  const githubSitesUrl = `https://api.github.com/users/${githubUsername}/repos`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`
    },
  };

  const response = await fetch(githubSitesUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  console.log("GitHub Repos:", responseJson);

  var sites = [];
  for (const site of responseJson) {
    const description = site.description.toLowerCase();
    if (description.includes("pluribus owo")) {
      sites.push(site);
    }
  }

  return sites;
}

async function createSiteGitlab(siteName, siteDescription) {
  const gitlabCreateSiteUrl = "https://gitlab.com/api/v4/projects";
  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
    body: JSON.stringify({
      name: `${siteName}`,
      path: `${siteName.toLowerCase().replace(/\s+/g, "-")}-pluribus-owo-site`,
      description: `${siteName}: ${siteDescription} | A Pluribus OwO site created with the Pluribus.me site builder`,
      visibility: "public",
      pages_access_level: "disabled",
    }),
  };

  const response = await fetch(gitlabCreateSiteUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  const siteId = responseJson.id;

  return siteId;
}

async function createSiteGithub(siteName, siteDescription) {
  const gitlabCreateSiteUrl = "https://api.github.com/user/repos";
  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
    },
    body: JSON.stringify({
      name: `${siteName}`,
      description: `${siteName}: ${siteDescription} | A Pluribus OwO site created with the Pluribus.me site builder`,
      private: false
    }),
  };

  const response = await fetch(gitlabCreateSiteUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  const siteId = responseJson.full_name;

  return siteId;
}

async function deleteSiteGitlab(siteId) {
  const gitlabDeleteSiteUrl = `https://gitlab.com/api/v4/projects/${siteId}`;
  const payload = {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  };

  const response = await fetch(gitlabDeleteSiteUrl, payload);

  if (!response.ok) {
    console.error("Failed to delete GitLab site:", response.status);
    return false;
  }

  console.log("GitLab site deleted successfully:", siteId);
  return true;
}

async function deleteSiteGithub(siteId) {
  const githubDeleteSiteUrl = `https://api.github.com/repos/${siteId}`;
  const payload = {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  };

  const response = await fetch(githubDeleteSiteUrl, payload);

  if (!response.ok) {
    console.error("Failed to delete GitHub site:", response.status);
    return false;
  }

  console.log("GitHub site deleted successfully:", siteId);
  return true;
}

async function initialCommitGitlab(siteId) {
  const gitlabCreateFileUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/commits`;

  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
    body: JSON.stringify({
      branch: "main",
      commit_message: "Initial GitLab Pages setup",
      actions: [
        {
          action: "create",
          file_path: "public/pages.json",
          content: '[]',
        },
      ],
    }),
  };

  const response = await fetch(gitlabCreateFileUrl, payload);

  return response.ok;
}

async function initialCommitGithub(siteId) {
  const githubCommitUrl = `https://api.github.com/repos/${siteId}/contents/public/pages.json`;

  const payload = {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: "Initial GitHub Pages setup",
      content: encodeBase64('[]'), // Base64 encode the content
    }),
  };

  const response = await fetch(githubCommitUrl, payload);

  return response.ok;
}

async function getFileContentGitlab(siteId, filePath) {
  const filePathEncoded = encodeURIComponent(filePath);
  const gitlabFileUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/files/${filePathEncoded}/raw`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  };

  const response = await fetch(gitlabFileUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseText = await response.text();

  return responseText;
}

async function getFileContentGithub(siteId, filePath) {
  const githubFileUrl = `https://api.github.com/repos/${siteId}/contents/${filePath}`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  };

  const response = await fetch(githubFileUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  // GitHub returns base64-encoded content, so we need to decode it
  const content = decodeBase64(responseJson.content);

  console.log("File content:", content);

  return content;
}

async function getPublicFilesGitLab(siteId) {
  const gitlabSiteTreeUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/tree?recursive=true`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  };

  const response = await fetch(gitlabSiteTreeUrl, payload);

  if (!response.ok) {
    return [];
  }

  const responseJson = await response.json();

  // Get list of markdown files in GitLab
  const gitlabMarkdownFiles = responseJson
    .filter((item) => item.type === "blob" && item.path.endsWith(".md") && item.path.startsWith("public/"))
    .map((item) => item.path);

  return gitlabMarkdownFiles;
}

async function getPublicFilesGitHub(siteName) {
  const githubSiteTreeUrl = `https://api.github.com/repos/${siteName}/git/trees/main?recursive=1`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  };

  const response = await fetch(githubSiteTreeUrl, payload);

  if (!response.ok) {
    return [];
  }

  const responseJson = await response.json();

  console.log("Site Tree:", responseJson.tree);

  // Get list of markdown files in GitHub
  const githubMarkdownFiles = responseJson.tree
    .filter((item) => item.type === "blob" && item.path.endsWith(".md") && item.path.startsWith("public/"))
    .map((item) => item.path);

  return githubMarkdownFiles;
}

async function deployChangesGitlab(siteId) {
  modified = false;
  updateDeployButtonState();

  const gitlabCreateFileUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/commits`;

  var owoTemplateResp = await fetch("owo-template.html", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const owoTemplate = await owoTemplateResp.text();

  console.log(owoTemplate);

  const gitlabMarkdownFiles = await getPublicFilesGitLab(siteId);

  var commitActions = [];

  // Get list of markdown files in cache
  const cacheFileNames = markdownCache.map(item => item.fileName);

  // Handle deletions: files in GitLab but not in cache
  for (const gitlabFile of gitlabMarkdownFiles) {
    if (!cacheFileNames.includes(gitlabFile)) {
      console.log("Preparing to delete file:", gitlabFile);

      // Delete both .md and .html files
      commitActions.push({
        action: "delete",
        file_path: gitlabFile.replace(".md", ".html"),
      });
      commitActions.push({
        action: "delete",
        file_path: gitlabFile,
      });
    }
  }

  // Handle creates and updates: files in cache
  for (const cacheItem of markdownCache) {
    console.log("Preparing to update file:", cacheItem.fileName);

    var crudAction = null;
    if (gitlabMarkdownFiles.includes(cacheItem.fileName)) {
      crudAction = "update";
    } else {
      crudAction = "create";
    }
    // Create/update the corresponding .html file
    commitActions.push({
      action: crudAction,
      file_path: cacheItem.fileName.replace(".md", ".html"),
      content: owoTemplate,
    });

    // Create or update the .md file
    commitActions.push({
      action: crudAction,
      file_path: cacheItem.fileName,
      content: cacheItem.content,
    });
  }

  if (commitActions.length > 0) {
    // Update pages.json based on cache (final state)
    const pages = markdownCache.map(item => {
      const fileName = item.fileName.replace("public/", "").replace(".md", "");
      return {
        displayName: fileName === "index" ? "Home" : item.displayName,
        fileName: fileName
      };
    });
    commitActions.push({
      action: "update",
      file_path: "public/pages.json",
      content: JSON.stringify(pages),
    });

    const payload = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOauthTokenGitlab()}`,
      },
      body: JSON.stringify({
        branch: "main",
        commit_message: "Update site content",
        actions: commitActions,
      }),
    };

    const response = await fetch(gitlabCreateFileUrl, payload);

    if (response.ok) {
      console.log("Deployed changes to GitLab");
    } else {
      modified = true;
      console.error("Failed to deploy changes to GitLab");
    }
    updateDeployButtonState();
    return response.ok;
  }

  return true;
}

async function deployChangesGithub(siteId) {
  modified = false;
  updateDeployButtonState();

  var owoTemplateResp = await fetch("owo-template.html", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const owoTemplate = await owoTemplateResp.text();

  console.log(owoTemplate);

  const githubMarkdownFiles = await getPublicFilesGitHub(siteId);

  // Get list of markdown files in cache
  const cacheFileNames = markdownCache.map(item => item.fileName);

  // Step 1: Get the current commit SHA
  const refResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!refResponse.ok) {
    modified = true;
    updateDeployButtonState();
    console.error("Failed to get current commit");
    return false;
  }

  const refData = await refResponse.json();
  const currentCommitSha = refData.object.sha;

  // Step 2: Get the current commit to get the tree SHA
  const commitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits/${currentCommitSha}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!commitResponse.ok) {
    modified = true;
    updateDeployButtonState();
    console.error("Failed to get commit data");
    return false;
  }

  const commitData = await commitResponse.json();
  const baseTreeSha = commitData.tree.sha;

  // Step 3: Create blobs and build tree items
  const treeItems = [];

  // Handle deletions: files in GitHub but not in cache
  for (const githubFile of githubMarkdownFiles) {
    if (!cacheFileNames.includes(githubFile)) {
      console.log("Preparing to delete file:", githubFile);

      // Mark files for deletion (sha: null)
      treeItems.push({
        path: githubFile.replace(".md", ".html"),
        mode: "100644",
        type: "blob",
        sha: null,
      });
      treeItems.push({
        path: githubFile,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }
  }

  // Handle creates and updates: files in cache
  for (const cacheItem of markdownCache) {
    console.log("Preparing to update file:", cacheItem.fileName);

    // Create blob for .html file (for both new and existing files)
    const htmlBlobResponse = await fetch(`https://api.github.com/repos/${siteId}/git/blobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOauthTokenGithub()}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        content: encodeBase64(owoTemplate),
        encoding: "base64",
      }),
    });

    if (!htmlBlobResponse.ok) {
      modified = true;
      updateDeployButtonState();
      console.error("Failed to create HTML blob");
      return false;
    }

    const htmlBlobData = await htmlBlobResponse.json();

    treeItems.push({
      path: cacheItem.fileName.replace(".md", ".html"),
      mode: "100644",
      type: "blob",
      sha: htmlBlobData.sha,
    });

    // Create blob for .md file
    const mdBlobResponse = await fetch(`https://api.github.com/repos/${siteId}/git/blobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOauthTokenGithub()}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        content: encodeBase64(cacheItem.content),
        encoding: "base64",
      }),
    });

    if (!mdBlobResponse.ok) {
      modified = true;
      updateDeployButtonState();
      console.error("Failed to create MD blob");
      return false;
    }

    const mdBlobData = await mdBlobResponse.json();

    treeItems.push({
      path: cacheItem.fileName,
      mode: "100644",
      type: "blob",
      sha: mdBlobData.sha,
    });
  }

  if (treeItems.length > 0) {
    // Update pages.json
    const pages = markdownCache.map(item => {
      const fileName = item.fileName.replace("public/", "").replace(".md", "");
      return {
        displayName: fileName === "index" ? "Home" : item.displayName,
        fileName: fileName
      };
    });

    const pagesBlobResponse = await fetch(`https://api.github.com/repos/${siteId}/git/blobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOauthTokenGithub()}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        content: encodeBase64(JSON.stringify(pages)),
        encoding: "base64",
      }),
    });

    if (!pagesBlobResponse.ok) {
      modified = true;
      updateDeployButtonState();
      console.error("Failed to create pages.json blob");
      return false;
    }

    const pagesBlobData = await pagesBlobResponse.json();

    treeItems.push({
      path: "public/pages.json",
      mode: "100644",
      type: "blob",
      sha: pagesBlobData.sha,
    });

    // Step 4: Create a new tree
    const treeResponse = await fetch(`https://api.github.com/repos/${siteId}/git/trees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOauthTokenGithub()}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeItems,
      }),
    });

    if (!treeResponse.ok) {
      modified = true;
      updateDeployButtonState();
      console.error("Failed to create tree");
      return false;
    }

    const treeData = await treeResponse.json();

    // Step 5: Create a new commit
    const newCommitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOauthTokenGithub()}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message: "Update site content",
        tree: treeData.sha,
        parents: [currentCommitSha],
      }),
    });

    if (!newCommitResponse.ok) {
      modified = true;
      updateDeployButtonState();
      console.error("Failed to create commit");
      return false;
    }

    const newCommitData = await newCommitResponse.json();

    // Step 6: Update the reference
    const updateRefResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOauthTokenGithub()}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        sha: newCommitData.sha,
      }),
    });

    if (updateRefResponse.ok) {
      console.log("Deployed changes to GitHub");
    } else {
      modified = true;
      console.error("Failed to deploy changes to GitHub");
    }
    updateDeployButtonState();
    return updateRefResponse.ok;
  }

  return true;
}

async function createPageGitlab(siteId, pageName) {
  const gitlabCreateFileUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/commits`;

  var owoTemplateResp = await fetch("owo-template.html", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const owoTemplate = await owoTemplateResp.text();

  console.log(owoTemplate);

  commitActions = [
    {
      action: "create",
      file_path: `public/${pageName}.html`,
      content: owoTemplate,
    },
    {
      action: "create",
      file_path: `public/${pageName}.md`,
      content: `# ${pageName}\n\nThis is your new page.`,
    },
  ];

  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
    body: JSON.stringify({
      branch: "main",
      commit_message: `Create new page: ${pageName}`,
      actions: commitActions,
    }),
  };

  const response = await fetch(gitlabCreateFileUrl, payload);

  return response.ok;
}

async function createPageGithub(siteId, pageName) {
  var owoTemplateResp = await fetch("owo-template.html", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const owoTemplate = await owoTemplateResp.text();

  console.log(owoTemplate);

  // Step 1: Get the current commit SHA
  const refResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!refResponse.ok) return false;

  const refData = await refResponse.json();
  const currentCommitSha = refData.object.sha;

  // Step 2: Get the current commit to get the tree SHA
  const commitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits/${currentCommitSha}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!commitResponse.ok) return false;

  const commitData = await commitResponse.json();
  const baseTreeSha = commitData.tree.sha;

  // Step 3: Create blobs for HTML and MD files
  const htmlBlobResponse = await fetch(`https://api.github.com/repos/${siteId}/git/blobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      content: encodeBase64(owoTemplate),
      encoding: "base64",
    }),
  });

  if (!htmlBlobResponse.ok) return false;

  const htmlBlobData = await htmlBlobResponse.json();

  const mdBlobResponse = await fetch(`https://api.github.com/repos/${siteId}/git/blobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      content: encodeBase64(`# ${pageName}\n\nThis is your new page.`),
      encoding: "base64",
    }),
  });

  if (!mdBlobResponse.ok) return false;

  const mdBlobData = await mdBlobResponse.json();

  // Step 4: Create a new tree
  const treeResponse = await fetch(`https://api.github.com/repos/${siteId}/git/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [
        {
          path: `public/${pageName}.html`,
          mode: "100644",
          type: "blob",
          sha: htmlBlobData.sha,
        },
        {
          path: `public/${pageName}.md`,
          mode: "100644",
          type: "blob",
          sha: mdBlobData.sha,
        },
      ],
    }),
  });

  if (!treeResponse.ok) return false;

  const treeData = await treeResponse.json();

  // Step 5: Create a new commit
  const newCommitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: `Create new page: ${pageName}`,
      tree: treeData.sha,
      parents: [currentCommitSha],
    }),
  });

  if (!newCommitResponse.ok) return false;

  const newCommitData = await newCommitResponse.json();

  // Step 6: Update the reference
  const updateRefResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      sha: newCommitData.sha,
    }),
  });

  return updateRefResponse.ok;
}

async function deletePageGitlab(siteId, pageName) {
  const gitlabCreateFileUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/commits`;

  commitActions = [
    {
      action: "delete",
      file_path: `public/${pageName}.html`,
    },
    {
      action: "delete",
      file_path: `public/${pageName}.md`,
    },
  ];

  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
    body: JSON.stringify({
      branch: "main",
      commit_message: `Delete page: ${pageName}`,
      actions: commitActions,
    }),
  };

  const response = await fetch(gitlabCreateFileUrl, payload);

  return response.ok;
}

async function deletePageGithub(siteId, pageName) {
  // Step 1: Get the current commit SHA
  const refResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!refResponse.ok) return false;

  const refData = await refResponse.json();
  const currentCommitSha = refData.object.sha;

  // Step 2: Get the current commit to get the tree SHA
  const commitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits/${currentCommitSha}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!commitResponse.ok) return false;

  const commitData = await commitResponse.json();
  const baseTreeSha = commitData.tree.sha;

  // Step 3: Create a new tree with deleted files (sha: null)
  const treeResponse = await fetch(`https://api.github.com/repos/${siteId}/git/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [
        {
          path: `public/${pageName}.html`,
          mode: "100644",
          type: "blob",
          sha: null,
        },
        {
          path: `public/${pageName}.md`,
          mode: "100644",
          type: "blob",
          sha: null,
        },
      ],
    }),
  });

  if (!treeResponse.ok) return false;

  const treeData = await treeResponse.json();

  // Step 4: Create a new commit
  const newCommitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: `Delete page: ${pageName}`,
      tree: treeData.sha,
      parents: [currentCommitSha],
    }),
  });

  if (!newCommitResponse.ok) return false;

  const newCommitData = await newCommitResponse.json();

  // Step 5: Update the reference
  const updateRefResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      sha: newCommitData.sha,
    }),
  });

  return updateRefResponse.ok;
}

async function renamePageGitlab(siteId, pageName, newPageName) {
  const gitlabCreateFileUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/commits`;

  commitActions = [
    {
      action: "move",
      previous_path: `public/${pageName}.html`,
      file_path: `public/${newPageName}.html`,
    },
    {
      action: "move",
      previous_path: `public/${pageName}.md`,
      file_path: `public/${newPageName}.md`,
    },
  ];

  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
    body: JSON.stringify({
      branch: "main",
      commit_message: `Rename page: ${pageName} --> ${newPageName}`,
      actions: commitActions,
    }),
  };

  const response = await fetch(gitlabCreateFileUrl, payload);

  return response.ok;
}

async function renamePageGithub(siteId, pageName, newPageName) {
  // Step 1: Get the current commit SHA
  const refResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!refResponse.ok) return false;

  const refData = await refResponse.json();
  const currentCommitSha = refData.object.sha;

  // Step 2: Get the current commit to get the tree SHA
  const commitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits/${currentCommitSha}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!commitResponse.ok) return false;

  const commitData = await commitResponse.json();
  const baseTreeSha = commitData.tree.sha;

  // Step 3: Get the content of existing files
  const htmlFileResponse = await fetch(`https://api.github.com/repos/${siteId}/contents/public/${pageName}.html`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!htmlFileResponse.ok) return false;

  const htmlFileData = await htmlFileResponse.json();

  const mdFileResponse = await fetch(`https://api.github.com/repos/${siteId}/contents/public/${pageName}.md`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!mdFileResponse.ok) return false;

  const mdFileData = await mdFileResponse.json();

  // Step 4: Create blobs with the existing content
  const htmlBlobResponse = await fetch(`https://api.github.com/repos/${siteId}/git/blobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      content: htmlFileData.content,
      encoding: "base64",
    }),
  });

  if (!htmlBlobResponse.ok) return false;

  const htmlBlobData = await htmlBlobResponse.json();

  const mdBlobResponse = await fetch(`https://api.github.com/repos/${siteId}/git/blobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      content: mdFileData.content,
      encoding: "base64",
    }),
  });

  if (!mdBlobResponse.ok) return false;

  const mdBlobData = await mdBlobResponse.json();

  // Step 5: Create a new tree with renamed files
  const treeResponse = await fetch(`https://api.github.com/repos/${siteId}/git/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [
        // Add new files with new names
        {
          path: `public/${newPageName}.html`,
          mode: "100644",
          type: "blob",
          sha: htmlBlobData.sha,
        },
        {
          path: `public/${newPageName}.md`,
          mode: "100644",
          type: "blob",
          sha: mdBlobData.sha,
        },
        // Delete old files
        {
          path: `public/${pageName}.html`,
          mode: "100644",
          type: "blob",
          sha: null,
        },
        {
          path: `public/${pageName}.md`,
          mode: "100644",
          type: "blob",
          sha: null,
        },
      ],
    }),
  });

  if (!treeResponse.ok) return false;

  const treeData = await treeResponse.json();

  // Step 6: Create a new commit
  const newCommitResponse = await fetch(`https://api.github.com/repos/${siteId}/git/commits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: `Rename page: ${pageName} --> ${newPageName}`,
      tree: treeData.sha,
      parents: [currentCommitSha],
    }),
  });

  if (!newCommitResponse.ok) return false;

  const newCommitData = await newCommitResponse.json();

  // Step 7: Update the reference
  const updateRefResponse = await fetch(`https://api.github.com/repos/${siteId}/git/refs/heads/main`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOauthTokenGithub()}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      sha: newCommitData.sha,
    }),
  });

  return updateRefResponse.ok;
}
