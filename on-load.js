document.addEventListener("DOMContentLoaded", async function () {
  const isLoggedInNetlify = await checkLoginNetlify();
  const isLoggedInGitlab = await checkLoginGitlab();
  if (!isLoggedInNetlify) {
    console.log("Netlify access token missing or expired");
    displayNetlifyLoginButton();
  } else {
    console.log("Netlify access token present and valid");
    loadToastEditor();
    loadZipLogic();
  }

  if (!isLoggedInGitlab) {
    console.log("GitLab access token missing or expired");
    displayGitlabLoginButton();
  } else {
    console.log("GitLab access token present and valid");
  }
});

async function checkLoginGitlab() {
  const oauthToken = sessionStorage.getItem(
    STORAGE_KEY_GITLAB_OAUTH_TOKEN
  );

  if (!oauthToken) return false;

  const response = await fetch("https://gitlab.com/api/v4/projects", {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
    },
  });

  return response.ok;
}

async function checkLoginNetlify() {
  const oauthToken = sessionStorage.getItem(
    STORAGE_KEY_NETLIFY_OAUTH_TOKEN
  );

  if (!oauthToken) return false;

  const response = await fetch("https://api.netlify.com/api/v1/user", {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
    },
  });

  return response.ok;
}
