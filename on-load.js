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

    loadToastEditor();
    loadZipLogic();
  }
});