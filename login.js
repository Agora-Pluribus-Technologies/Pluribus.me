// Replace with your actual Application ID and callback URL
const NETLIFY_CLIENT_ID =
  "YrSXJx6H250qmnq5dgb4rlRdynecY16jGKhNcJJx60E";
const REDIRECT_URI = "https://pluribus-me.pages.dev/oauth/callback";
// const SCOPE = "api read_repository write_repository";
const AUTH_URL = "https://app.netlify.com/oauth/authorize";

document.getElementById("login-button").addEventListener("click", () => {
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

console.log("Login button updated");
