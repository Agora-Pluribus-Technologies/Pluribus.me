const GITLAB_CLIENT_ID =
  "12328ed7f6e7e0ffae8d10d8531df71aeffd7db927c966ffc763bf07e8800656";
const GITLAB_AUTH_URL = "https://gitlab.com/oauth/authorize";
const GITLAB_CLIENT_SCOPE = "api";
const GITLAB_REDIRECT_URI =
  "https://pluribus-me.pages.dev/gitlab/oauth/callback";

var GITLAB_USER_ID = null;

const STORAGE_KEY_GITLAB_OAUTH_TOKEN = "pluribus.me.gitlab.oauth_token";
const STORAGE_KEY_GITLAB_SITE_ID_LIST = "pluribus.me.gitlab.site_id_list";

// Check if we have a token in the URL hash (from OAuth callback redirect)
if (window.location.hash) {
  const params = new URLSearchParams(window.location.hash.substring(1));
  let accessToken;
  if (window.location.hash.startsWith("#gitlab")) {
    accessToken = params.get("gitlab_access_token");
    sessionStorage.setItem(STORAGE_KEY_GITLAB_OAUTH_TOKEN, accessToken);
  }

  if (accessToken) {
    // Clear the hash from URL
    window.history.replaceState(null, null, window.location.pathname);
  }
}

function getOauthTokenGitlab() {
  return sessionStorage.getItem(STORAGE_KEY_GITLAB_OAUTH_TOKEN);
}

function displayGitlabLoginButton() {
  var loginButton = document.createElement("button");
  loginButton.classList.add("btn");
  loginButton.innerText = "Sign into GitLab";
  loginButton.style.padding = "10px 18px";
  loginButton.style.cursor = "pointer";

  loginButton.addEventListener("click", () => {
    // Build the authorization URL
    const params = new URLSearchParams({
      client_id: GITLAB_CLIENT_ID,
      redirect_uri: GITLAB_REDIRECT_URI,
      scope: GITLAB_CLIENT_SCOPE,
      response_type: "code",
    });

    // Redirect user to login page
    window.location.href = `${GITLAB_AUTH_URL}?${params.toString()}`;
  });

  const sitesListPanel = document.getElementById("sites-list-panel");
  sitesListPanel.appendChild(loginButton);
}

async function getGitlabUserId() {
  if (GITLAB_USER_ID) {
    return GITLAB_USER_ID;
  }

  const oauthToken = sessionStorage.getItem(STORAGE_KEY_GITLAB_OAUTH_TOKEN);

  if (!oauthToken) return null;

  const response = await fetch("https://gitlab.com/api/v4/user", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
    },
  });

  if (!response.ok) return null;

  const data = await response.json();

  GITLAB_USER_ID = data.id;

  console.log("GitLab User ID:", data.id);

  return data.id;
}

async function getSitesGitLab() {
  const gitlabUserId = await getGitlabUserId();
  const gitlabSitesUrl = `https://gitlab.com/api/v4/users/${gitlabUserId}/projects`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  };

  const response = await fetch(gitlabSitesUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

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
      description: `${siteName}\n${siteDescription}\n\nA Pluribus OwO site created with the Pluribus.me site builder`,
      visibility: "private",
      pages_access_level: "public",
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

async function initialCommitGitlab(siteId) {
  const gitlabCreateFileUrl = `https://gitlab.com/api/v4/projects/${siteId}/repository/commits`;

  var owoTemplateResp = await fetch("owo-template.html", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const owoTemplate = await owoTemplateResp.text();

  const gitlabCiTemplateResp = await fetch(".gitlab-ci-template.yml", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const gitlabCiTemplate = await gitlabCiTemplateResp.text();

  console.log(owoTemplate);
  console.log(gitlabCiTemplate);

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
          file_path: ".gitlab-ci.yml",
          content: gitlabCiTemplate,
        },
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

async function apiRequest(url, body) {
  const response = await fetch(url, body);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
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

async function getSiteTreeGitLab(siteId) {
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

  return responseJson;
}

async function isPipelineRunningGitlab(siteId) {
  const gitlabPipelinesUrl = `https://gitlab.com/api/v4/projects/${siteId}/pipelines/latest`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  };

  const response = await fetch(gitlabPipelinesUrl, payload);

  if (!response.ok) {
    return true;
  }

  const responseJson = await response.json();

  return responseJson.finished_at == null;
}

async function getPagesUrlGitlab(siteId) {
  const gitlabPagesUrl = `https://gitlab.com/api/v4/projects/${siteId}/pages`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  };

  const response = await fetch(gitlabPagesUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  return responseJson.url;
}

async function getLatestPagesDeployTimeGitlab(siteId) {
  const gitlabPagesUrl = `https://gitlab.com/api/v4/projects/${siteId}/pages`;
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGitlab()}`,
    },
  };

  const response = await fetch(gitlabPagesUrl, payload);

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  const deployment = responseJson.deployments[0];

  return deployment ? new Date(deployment.created_at) : null;
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

  const gitlabCiTemplateResp = await fetch(".gitlab-ci-template.yml", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const gitlabCiTemplate = await gitlabCiTemplateResp.text();

  console.log(owoTemplate);
  console.log(gitlabCiTemplate);

  const siteTree = await getSiteTreeGitLab(siteId);
  console.log("Site Tree:", siteTree);

  var commitActions = [];

  // Get list of markdown files in GitLab
  const gitlabMarkdownFiles = siteTree
    .filter((item) => item.type === "blob" && item.path.endsWith(".md") && item.path.startsWith("public/"))
    .map((item) => item.path);

  // Get list of markdown files in cache
  const cacheMarkdownFiles = Object.keys(markdownCache).filter(path => path.endsWith(".md"));

  // Handle deletions: files in GitLab but not in cache
  for (const gitlabFile of gitlabMarkdownFiles) {
    if (!cacheMarkdownFiles.includes(gitlabFile)) {
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
  for (filePath in markdownCache) {
    console.log("Preparing to update file:", filePath);

    var crudAction = null;
    if (siteTree.map((f) => f.path).includes(filePath)) {
      crudAction = "update";
    } else {
      crudAction = "create";

      // Create the corresponding .html file
      commitActions.push({
        action: "create",
        file_path: filePath.replace(".md", ".html"),
        content: owoTemplate,
      });
    }

    // Create or update the .md file
    commitActions.push({
      action: crudAction,
      file_path: filePath,
      content: markdownCache[filePath],
    });
  }

  if (commitActions.length > 0) {
    // Update pages.json based on cache (final state)
    const pages = cacheMarkdownFiles
      .map((path) => path.replace("public/", "").replace(".md", ""));
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
