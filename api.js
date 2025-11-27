const NETLIFY_CLIENT_ID = "YrSXJx6H250qmnq5dgb4rlRdynecY16jGKhNcJJx60E";
const NETLIFY_AUTH_URL = "https://app.netlify.com/authorize";
const NETLIFY_REDIRECT_URI = "https://pluribus-me-dev.pages.dev/netlify/oauth/callback";

const GITLAB_CLIENT_ID = "12328ed7f6e7e0ffae8d10d8531df71aeffd7db927c966ffc763bf07e8800656";
const GITLAB_AUTH_URL = "https://gitlab.com/oauth/authorize";
const GITLAB_CLIENT_SCOPE = "api";
const GITLAB_REDIRECT_URI = "https://pluribus-me-dev.pages.dev/gitlab/oauth/callback";

const STORAGE_KEY_NETLIFY_OAUTH_TOKEN = "pluribus.me.netlify.oauth_token";
const STORAGE_KEY_NETLIFY_SITE_ID_LIST = "pluribus.me.netlify.site_id_list";
const STORAGE_KEY_GITLAB_OAUTH_TOKEN = "pluribus.me.gitlab.oauth_token";
const STORAGE_KEY_GITLAB_SITE_ID_LIST = "pluribus.me.gitlab.site_id_list";

// Check if we have a token in the URL hash (from OAuth callback redirect)
if (window.location.hash) {
  const params = new URLSearchParams(window.location.hash.substring(1));
  let accessToken;
  if (window.location.hash.startsWith("#netlify")) {
    accessToken = params.get("netlify_access_token");
    sessionStorage.setItem(STORAGE_KEY_NETLIFY_OAUTH_TOKEN, accessToken);
  } else if (window.location.hash.startsWith("#gitlab")) {
    accessToken = params.get("gitlab_access_token");
    sessionStorage.setItem(STORAGE_KEY_GITLAB_OAUTH_TOKEN, accessToken);
  }

  if (accessToken) {
    // Clear the hash from URL
    window.history.replaceState(null, null, window.location.pathname);
  }
}

async function fetchNetlifySites(oauthToken) {
  const netlifySitesUrl = "https://api.netlify.com/api/v1/sites";
  const payload = {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${oauthToken}`,
    },
  };
  const sitesList = await netlifyApiRequest(netlifySitesUrl, payload);
  var siteIdList = [];
  for (let i = 0; i < sitesList.length; i++) {
    const idDomain = sitesList[i].id_domain;
    siteIdList.push(idDomain);
  }
  sessionStorage.setItem(STORAGE_KEY_NETLIFY_SITE_ID_LIST, siteIdList);
}

async function netlifyApiRequest(url, body) {
  const accessToken = sessionStorage.getItem(STORAGE_KEY_NETLIFY_OAUTH_TOKEN);
  if (!accessToken) {
    console.warn("⚠️ No token found. Redirect user to log in.");
    return;
  }
  const response = await fetch(url, body);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

async function createSiteNetlify() {
  const netlifySitesUrl = `${location.origin}/netlify/site/create`;
  console.log("Creating site on Netlify");
  const payload = {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${getOauthTokenNetlify()}`,
    },
  };
  const data = await netlifyApiRequest(netlifySitesUrl, payload);
  
  return data;
}

async function createSiteGitLab() {
  const gitlabSitesUrl = `${location.origin}/gitlab/site/create`;
  const payload = {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${getOauthTokenGitlab()}`,
    },
  };
  const data = await netlifyApiRequest(gitlabSitesUrl, payload);
  
  return data;
}

async function deploySite(siteId, zipBlob) {
  const netlifySitesUrl = `${location.origin}/netlify/site/deploy`;
  const payload = {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "Authorization": `Bearer ${getOauthTokenNetlify()}`,
      "X-Site-ID": siteId,
    },
    body: zipBlob,
  };
  const data = await netlifyApiRequest(netlifySitesUrl, payload);
  
  return data;
}

function displayGitlabLoginButton() {
  var loginButton = document.createElement("button");
  loginButton.classList.add("login-button");
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

  const mainDiv = document.getElementById("main");
  mainDiv.appendChild(loginButton);
}

function displayNetlifyLoginButton() {
  var loginButton = document.createElement("button");
  loginButton.classList.add("login-button");
  loginButton.innerText = "Sign into Netlify";
  loginButton.style.padding = "10px 18px";
  loginButton.style.cursor = "pointer";

  loginButton.addEventListener("click", () => {
    // Build the authorization URL
    const params = new URLSearchParams({
      client_id: NETLIFY_CLIENT_ID,
      redirect_uri: NETLIFY_REDIRECT_URI,
      response_type: "code",
    });

    // Redirect user to login page
    window.location.href = `${NETLIFY_AUTH_URL}?${params.toString()}`;
  });

  const mainDiv = document.getElementById("main");
  mainDiv.appendChild(loginButton);
}

function getOauthTokenNetlify() {
  return sessionStorage.getItem(STORAGE_KEY_NETLIFY_OAUTH_TOKEN);
}

function getOauthTokenGitlab() {
  return sessionStorage.getItem(STORAGE_KEY_GITLAB_OAUTH_TOKEN);
}
