export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  // Exchange code for token
  const tokenRes = await fetch("https://gitlab.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITLAB_CLIENT_ID,
      client_secret: env.GITLAB_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: "https://pluribus-me.pages.dev/oauth/callback",
    }),
  });

  if (!tokenRes.ok) {
    return new Response("Failed to get access token", { status: 400 });
  }

  const token = await tokenRes.json();

  // Fetch basic user info (optional)
  const userRes = await fetch("https://gitlab.com/api/v4/user", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const user = await userRes.json();

  // Redirect back to home (or dashboard)
  const redirect = new URL("/", request.url);
  // you can append info as query params or handle it client-side
  redirect.searchParams.set("user", user.username);

  return Response.redirect(redirect.toString(), 302);
}
