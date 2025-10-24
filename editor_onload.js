document.addEventListener("DOMContentLoaded", async function () {
  // Save token from callback
  const accessToken = saveToken();

  // Get account type "free"
  const url = "https://api.netlify.com/api/v1/accounts/types";
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
  const data = await apiRequest(url, payload);
  for (let i = 0; i < data.length; i++) {
    var typeObj = data[i];
    if (typeObj.name.toLowerCase() == "free") {
      console.log("Free account type_id: " + typeObj.id);
      sessionStorage.setItem("ACCOUNT_TYPE_ID_FREE", typeObj.id);
      break;
    }
  }
});

function saveToken() {
  // 1. Parse token from URL fragment (after the '#')
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const token = hashParams.get("access_token");

  // 2. If a token is present, store it in sessionStorage
  if (token) {
    sessionStorage.setItem("token", token);

    // 3. Clean the URL bar by removing the fragment
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return token;
}

async function apiRequest(url, body) {
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
