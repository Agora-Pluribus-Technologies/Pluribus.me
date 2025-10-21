export async function onRequestGet() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return alert("Missing OAuth code!");

  // Exchange the code for an access token using your Worker endpoint
  const response = await fetch("https://pluribus-me.pages.dev/oauth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      redirect_uri: "https://pluribus-me.pages.dev/oauth/callback",
    }),
  });

  const data = await response.json();
  if (data.access_token) {
    sessionStorage.setItem("gitlab_token", data.access_token);
    alert("✅ Logged in successfully!");
    window.location.replace("/editor.html");
  } else {
    console.error("Login failed", data);
    alert("⚠️ Login failed. See console for details.");
  }
}
