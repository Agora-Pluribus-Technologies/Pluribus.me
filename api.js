// ==================== Turnstile Configuration ====================

const TURNSTILE_SITE_KEY = "0x4AAAAAACJNWjSEPW9SeZxb";

let turnstileToken = null;
let turnstileWidgetId = null;

// Initialize Turnstile widget when the script loads
function initTurnstile() {
  if (typeof turnstile === "undefined") {
    setTimeout(initTurnstile, 100);
    return;
  }

  const container = document.getElementById("turnstile-container");
  if (!container) {
    console.error("Turnstile container not found");
    return;
  }

  turnstileWidgetId = turnstile.render(container, {
    sitekey: TURNSTILE_SITE_KEY,
    callback: function(token) {
      turnstileToken = token;
      console.log("Turnstile token obtained");
    },
    "error-callback": function() {
      console.error("Turnstile error");
      turnstileToken = null;
    },
    "expired-callback": function() {
      console.log("Turnstile token expired, refreshing...");
      turnstileToken = null;
      turnstile.reset(turnstileWidgetId);
    },
    size: "invisible",
  });
}

// Get current Turnstile token, refreshing if necessary
async function getTurnstileToken() {
  if (turnstileToken) {
    return turnstileToken;
  }

  if (typeof turnstile === "undefined") {
    console.warn("Turnstile not available");
    return null;
  }

  if (turnstileWidgetId !== null) {
    turnstile.reset(turnstileWidgetId);
  }

  return new Promise((resolve) => {
    let attempts = 0;

    const maxAttempts = 150;
    const checkToken = setInterval(() => {
      attempts++;
      if (turnstileToken) {
        console.log("Got turnstile token");
        clearInterval(checkToken);
        resolve(turnstileToken);
      } else if (attempts >= maxAttempts) {
        clearInterval(checkToken);
        console.warn("Turnstile token timeout");
        resolve(null);
      }
    }, 100);
  });
}

// Helper to add Turnstile token to headers (for PUT, POST, DELETE requests)
async function getHeadersWithTurnstile(additionalHeaders = {}) {
  const token = await getTurnstileToken();
  const headers = { ...additionalHeaders };
  if (token) {
    headers["X-Turnstile-Token"] = token;
  }
  // Reset token after use (tokens are single-use)
  turnstileToken = null;
  
  return headers;
}

// Initialize Turnstile when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTurnstile);
} else {
  initTurnstile();
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

  const headers = await getHeadersWithTurnstile({
    "Content-Type": "application/json",
  });

  const response = await fetch("/api/files", {
    method: "PUT",
    headers,
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
  const headers = await getHeadersWithTurnstile({
    "Content-Type": "application/json",
  });
  
  const response = await fetch("/api/files", {
    method: "POST",
    headers,
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

  const headers = await getHeadersWithTurnstile();

  const response = await fetch(`/api/files?${params.toString()}`, {
    method: "DELETE",
    headers,
  });

  return response.ok;
}

// Delete all files for a site from R2
async function deleteAllFilesFromR2(siteId) {
  const params = new URLSearchParams({
    siteId,
    deleteAll: "true",
  });

  const headers = await getHeadersWithTurnstile();

  const response = await fetch(`/api/files?${params.toString()}`, {
    method: "DELETE",
    headers,
  });

  return response.ok;
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

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_CLIENT_ID = "8624161102-4guo9djint6glfkl2e6detjhlgoe3iv2.apps.googleusercontent.com";
const GOOGLE_REDIRECT_URI = "https://pluribus.me/google/oauth/callback";
const GOOGLE_DEV_REDIRECT_URI = "https://develop.pluribus-me.pages.dev/google/oauth/callback";
const GOOGLE_CLIENT_SCOPE = "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";

var GITLAB_USER_ID = null;
var GITHUB_USERNAME = null;
var GOOGLE_USER_ID = null;
var CURRENT_USERNAME = null;

const STORAGE_KEY_GITLAB_OAUTH_TOKEN = "pluribus.me.gitlab.oauth_token";
const STORAGE_KEY_GITHUB_OAUTH_TOKEN = "pluribus.me.github.oauth_token";
const STORAGE_KEY_GOOGLE_OAUTH_TOKEN = "pluribus.me.google.oauth_token";
const STORAGE_KEY_USERNAME = "pluribus.me.username";

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
  } else if (window.location.hash.startsWith("#google")) {
    accessToken = params.get("google_access_token");
    sessionStorage.setItem(STORAGE_KEY_GOOGLE_OAUTH_TOKEN, accessToken);
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

function getOauthTokenGoogle() {
  return sessionStorage.getItem(STORAGE_KEY_GOOGLE_OAUTH_TOKEN);
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

  // Google login button
  var googleLoginButton = document.createElement("button");
  googleLoginButton.classList.add("btn");
  googleLoginButton.innerText = "Sign in with Google";
  googleLoginButton.style.padding = "10px 18px";
  googleLoginButton.style.cursor = "pointer";

  googleLoginButton.addEventListener("click", () => {
    // Build the authorization URL
    // Same client ID for dev and prod, only redirect URI differs
    let redirectUri;
    if (document.location.origin.includes("develop")) {
      redirectUri = GOOGLE_DEV_REDIRECT_URI;
    } else {
      redirectUri = GOOGLE_REDIRECT_URI;
    }

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: GOOGLE_CLIENT_SCOPE,
      response_type: "code",
      access_type: "offline",
    });

    // Redirect user to login page
    window.location.href = `${GOOGLE_AUTH_URL}?${params.toString()}`;
  });

  buttonContainer.appendChild(githubLoginButton);
  buttonContainer.appendChild(gitlabLoginButton);
  buttonContainer.appendChild(googleLoginButton);

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

async function getGoogleUserId() {
  if (GOOGLE_USER_ID) {
    return GOOGLE_USER_ID;
  }

  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getOauthTokenGoogle()}`,
    },
  });

  if (!response.ok) return null;

  const data = await response.json();

  GOOGLE_USER_ID = data.id;

  console.log("Google User ID:", data.id);

  return data.id;
}

// Get current provider and provider ID
async function getCurrentProviderInfo() {
  if (getOauthTokenGitlab() !== null) {
    const providerId = await getGitlabUserId();
    return { provider: "gitlab", providerId: String(providerId) };
  } else if (getOauthTokenGithub() !== null) {
    const providerId = await getGithubUsername();
    return { provider: "github", providerId: providerId };
  } else if (getOauthTokenGoogle() !== null) {
    const providerId = await getGoogleUserId();
    return { provider: "google", providerId: providerId };
  }
  return null;
}

// Check if username is available
async function checkUsernameAvailable(username) {
  const response = await fetch(`/api/users?username=${encodeURIComponent(username)}`);
  if (!response.ok) return false;
  const data = await response.json();
  return !data.exists;
}

// Get user by provider ID (check if user already has a username)
async function getUserByProvider(provider, providerId) {
  const response = await fetch(`/api/users?provider=${provider}&providerId=${encodeURIComponent(providerId)}`);
  if (!response.ok) return null;
  const data = await response.json();
  if (data.exists === false) return null;
  return data;
}

// Create a new user with username
async function createUser(username, provider, providerId) {
  const headers = await getHeadersWithTurnstile({
    "Content-Type": "application/json",
  });

  const response = await fetch("/api/users", {
    method: "POST",
    headers,
    body: JSON.stringify({ username, provider, providerId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  const user = await response.json();
  CURRENT_USERNAME = user.username;
  sessionStorage.setItem(STORAGE_KEY_USERNAME, user.username);
  return user;
}

// Get stored username from session
function getStoredUsername() {
  if (CURRENT_USERNAME) return CURRENT_USERNAME;
  const stored = sessionStorage.getItem(STORAGE_KEY_USERNAME);
  if (stored) {
    CURRENT_USERNAME = stored;
  }
  return stored;
}

// Set stored username
function setStoredUsername(username) {
  CURRENT_USERNAME = username;
  sessionStorage.setItem(STORAGE_KEY_USERNAME, username);
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

async function getSites(owner) {
  const params = new URLSearchParams();
  if (owner) {
    params.set("owner", owner);
  }

  const response = await fetch(`/api/sites?${params.toString()}`, {
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

// ==================== Unified R2 Site Operations ====================
// These functions work the same regardless of provider (GitHub/GitLab)

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

async function initialCommit(siteId, siteSettings = {}) {
  const { siteName, repo, owner } = siteSettings;

  const siteJson = {
    siteName: siteName || repo || "Untitled Site",
    repo: repo || siteId.split("/")[1] || "",
    owner: owner || siteId.split("/")[0] || "",
    createdAt: new Date().toISOString(),
  };

  const files = [
    {
      filePath: "public/pages.json",
      content: "[]",
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
  ];

  const result = await saveFilesToR2(siteId, files);
  if (result) {
    console.log("Initial commit completed successfully (via R2)");
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

async function deployChanges(siteId) {
  modified = false;
  updateDeployButtonState();

  var owoTemplateResp = await fetch("/owo-template.html", {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  const owoTemplate = await owoTemplateResp.text();

  const existingMarkdownFiles = await getPublicFiles(siteId);
  const files = [];
  const cacheFileNames = markdownCache.map(item => item.fileName);

  // Handle deletions: files that exist but not in cache
  for (const existingFile of existingMarkdownFiles) {
    if (!cacheFileNames.includes(existingFile)) {
      console.log("Preparing to delete file:", existingFile);
      files.push({ filePath: existingFile.replace(".md", ".html"), action: "delete" });
      files.push({ filePath: existingFile, action: "delete" });
      files.push({ filePath: existingFile + ".meta", action: "delete" });
    }
  }

  // Handle creates and updates: files in cache
  const now = new Date().toISOString();
  for (const cacheItem of markdownCache) {
    console.log("Preparing to update file:", cacheItem.fileName);
    files.push({
      filePath: cacheItem.fileName.replace(".md", ".html"),
      content: owoTemplate,
      contentType: "text/html",
    });
    files.push({
      filePath: cacheItem.fileName,
      content: cacheItem.content,
      contentType: "text/markdown",
    });

    // Update modifiedAt and save metadata file
    if (cacheItem.metadata) {
      cacheItem.metadata.modifiedAt = now;
    } else {
      cacheItem.metadata = {
        author: getStoredUsername() || "unknown",
        createdAt: now,
        modifiedAt: now,
      };
    }
    files.push({
      filePath: cacheItem.fileName + ".meta",
      content: JSON.stringify(cacheItem.metadata, null, 2),
      contentType: "application/json",
    });
  }

  // Update pages.json
  const pages = markdownCache.map(item => {
    const fileName = item.fileName.replace("public/", "").replace(".md", "");
    return {
      displayName: fileName === "index" ? "Home" : item.displayName,
      fileName: fileName
    };
  });
  files.push({
    filePath: "public/pages.json",
    content: JSON.stringify(pages),
    contentType: "application/json",
  });

  // Update images.json
  files.push({
    filePath: "public/images.json",
    content: JSON.stringify(imageCache),
    contentType: "application/json",
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

async function createPage(siteId, pageName) {
  var owoTemplateResp = await fetch("/owo-template.html", {
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

async function addCollaborator(siteId, username) {
  const headers = await getHeadersWithTurnstile({
    "Content-Type": "application/json",
  });

  const response = await fetch("/api/collaborators", {
    method: "POST",
    headers,
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
  const headers = await getHeadersWithTurnstile();

  const response = await fetch(`/api/collaborators?${params.toString()}`, {
    method: "DELETE",
    headers,
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

async function getSharedSites(username) {
  const params = new URLSearchParams({ username });
  const response = await fetch(`/api/collaborators?${params.toString()}`);

  if (!response.ok) {
    console.error("Failed to fetch shared sites:", response.status);
    return [];
  }

  return await response.json();
}

