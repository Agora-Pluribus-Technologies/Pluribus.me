const NETLIFY_CLIENT_ID = "YrSXJx6H250qmnq5dgb4rlRdynecY16jGKhNcJJx60E";
const REDIRECT_URI = "https://pluribus-me.pages.dev/oauth/callback";
// const SCOPE = "api read_repository write_repository";
const AUTH_URL = "https://app.netlify.com/authorize";

// Check if we have a token in the URL hash (from OAuth callback redirect)
if (window.location.hash) {
  const params = new URLSearchParams(window.location.hash.substring(1));
  const accessToken = params.get("access_token");
  if (accessToken) {
    sessionStorage.setItem("token", accessToken);
    // Clear the hash from URL
    window.history.replaceState(null, null, window.location.pathname);
  }
}

document.addEventListener("DOMContentLoaded", async function () {
  const token = sessionStorage.getItem("token");
  const response = await fetch("https://api.netlify.com/api/v1/user", {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    console.log("Netlify access token missing or expired");
    displayLoginButton();
  } else {
    console.log("Netlify access token present and valid");
    
    const sitesList = await getNetlifySites();
    for (let i=0; i < sitesList.length; i++) {
      console.log("Site found: ", sitesList[i]);
    }
  }
});

async function netlifyApiRequest(url, body) {
  const accessToken = sessionStorage.getItem("token");
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

async function getNetlifySites() {
  const netlifySitesUrl = "https://api.netlify.com/api/v1/sites";
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${sessionStorage.getItem("token")}`,
    },
  };
  const data = await netlifyApiRequest(netlifySitesUrl, payload);
  return data;
}

async function createPluribusSiteNetlify() {
  const netlifySitesUrl = "https://api.netlify.com/api/v1/sites";
  const payload = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionStorage.getItem("token")}`,
    },
  };
  const data = await netlifyApiRequest(netlifySitesUrl, payload);
  for (let i = 0; i < data.length; i++) {
    var typeObj = data[i];
    if (typeObj.name.toLowerCase() == "free") {
      console.log("Free account type_id: " + typeObj.id);
      sessionStorage.setItem("ACCOUNT_TYPE_ID_FREE", typeObj.id);
      break;
    }
  }
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
