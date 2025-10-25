const NETLIFY_CLIENT_ID = "YrSXJx6H250qmnq5dgb4rlRdynecY16jGKhNcJJx60E";
const REDIRECT_URI = "https://pluribus-me.pages.dev/oauth/callback";
// const SCOPE = "api read_repository write_repository";
const AUTH_URL = "https://app.netlify.com/authorize";

const STORAGE_KEY_OAUTH_TOKEN_NETLIFY = "pluribus.me.oauth_token.netlify";
const STORAGE_KEY_SITE_ID_LIST = "pluribus.me.siteIdList";

// Check if we have a token in the URL hash (from OAuth callback redirect)
if (window.location.hash) {
  const params = new URLSearchParams(window.location.hash.substring(1));
  const accessToken = params.get("access_token");
  if (accessToken) {
    sessionStorage.setItem(STORAGE_KEY_OAUTH_TOKEN_NETLIFY, accessToken);
    // Clear the hash from URL
    window.history.replaceState(null, null, window.location.pathname);
  }
}

document.addEventListener("DOMContentLoaded", async function () {
  const oauthTokenNetlify = sessionStorage.getItem(
    STORAGE_KEY_OAUTH_TOKEN_NETLIFY
  );
  const response = await fetch("https://api.netlify.com/api/v1/user", {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${oauthTokenNetlify}`,
    },
  });
  if (!response.ok) {
    console.log("Netlify access token missing or expired");
    displayLoginButton();
  } else {
    console.log("Netlify access token present and valid");

    await fetchNetlifySites(oauthTokenNetlify);
  }
});

async function fetchNetlifySites(oauthToken) {
  const netlifySitesUrl = "https://api.netlify.com/api/v1/sites";
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
    },
  };
  const sitesList = await netlifyApiRequest(netlifySitesUrl, payload);
  var siteIdList = [];
  for (let i = 0; i < sitesList.length; i++) {
    const idDomain = sitesList[i].id_domain;
    siteIdList.push(idDomain);
  }
  sessionStorage.setItem(STORAGE_KEY_SITE_ID_LIST, siteIdList);
}

async function netlifyApiRequest(url, body) {
  const accessToken = sessionStorage.getItem(STORAGE_KEY_OAUTH_TOKEN_NETLIFY);
  if (!accessToken) {
    console.warn("⚠️ No token found. Redirect user to log in.");
    return;
  }
  const response = await fetch(url, body);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  console.log(data);
  return data;
}

async function createPluribusSiteNetlify() {
  const netlifySitesUrl = "https://api.netlify.com/api/v1/sites";
  const payload = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionStorage.getItem(
        STORAGE_KEY_OAUTH_TOKEN_NETLIFY
      )}`,
    },
  };
  const data = await netlifyApiRequest(netlifySitesUrl, payload);
}

function displayLoginButton() {
  var loginButton = document.createElement("button");
  loginButton.id = "login-button";
  loginButton.innerText = "Sign into Netlify";
  loginButton.style.padding = "10px 18px";
  loginButton.style.cursor = "pointer";

  loginButton.addEventListener("click", () => {
    // Build the authorization URL
    const params = new URLSearchParams({
      client_id: NETLIFY_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      // scope: SCOPE,
    });

    // Redirect user to login page
    window.location.href = `${AUTH_URL}?${params.toString()}`;
  });

  const mainDiv = document.getElementById("main");
  mainDiv.appendChild(loginButton);
}
