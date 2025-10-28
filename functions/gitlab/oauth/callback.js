export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  // If GitLab didn't send a code, show an error message
  if (!code) {
    return new Response("Missing OAuth code.", { status: 400 });
  }

  // Prepare the token exchange request
  const tokenParams = new URLSearchParams({
    client_id: env.GITLAB_CLIENT_ID,
    client_secret: env.GITLAB_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: `${url.origin}/gitlab/oauth/callback`
  });

  // Exchange the code for an access token
  const tokenResponse = await fetch("https://gitlab.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams
  });

  const tokenData = await tokenResponse.json();

  // If something went wrong, return the error JSON
  if (!tokenData.access_token) {
    return new Response(JSON.stringify(tokenData), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Pass token info via fragment (#token=...) so it doesn't get logged in server logs
  const redirectUrl = new URL(url.origin);
  redirectUrl.hash = `gitlab_access_token=${tokenData.access_token}`;

  return Response.redirect(redirectUrl.toString(), 302);
}

