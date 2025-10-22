// Replace with your actual Application ID and callback URL
const CLIENT_ID =
  "12328ed7f6e7e0ffae8d10d8531df71aeffd7db927c966ffc763bf07e8800656";
const REDIRECT_URI = "https://pluribus-me.pages.dev/oauth/callback";
// const SCOPE = "api read_repository write_repository";
const AUTH_URL = "https://app.netlify.com/oauth/authorize";

document.getElementById("login-button").addEventListener("click", () => {
  // Build the authorization URL
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    // scope: SCOPE,
  });

  // Redirect user to login page
  window.location.href = `${AUTH_URL}?${params.toString()}`;
});

console.log("Login button updated");
