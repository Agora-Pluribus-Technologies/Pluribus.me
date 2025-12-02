export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  console.log("url:", url);
  console.log("search params:", url.searchParams);

  // If GitHub didn't send a code, show an error message
  if (!code) {
    return new Response("Missing OAuth code.", { status: 400 });
  }

  let clientId;
  let clientSecret;
  if (request.url.origin.includes("develop")) {
    clientId = env.GITHUB_DEV_CLIENT_ID;
    clientSecret = env.GITHUB_DEV_CLIENT_SECRET;
  } else {
    clientId = env.GITHUB_CLIENT_ID;
    clientSecret = env.GITHUB_CLIENT_SECRET;
  }

  // Prepare the token exchange request
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: `${url.origin}/github/oauth/callback`
  });

  // Exchange the code for an access token with GitHub
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
      "Accept": "application/json"
    },
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
  redirectUrl.hash = `github_access_token=${tokenData.access_token}`;

  return Response.redirect(redirectUrl.toString(), 302);
}

