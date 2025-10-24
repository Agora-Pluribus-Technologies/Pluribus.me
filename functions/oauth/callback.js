export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  // If Netlify didn't send a code, show an error message
  if (!code) {
    return new Response("Missing OAuth code.", { status: 400 });
  }

  // Prepare the token exchange request
  const tokenParams = new URLSearchParams({
    client_id: env.NETLIFY_CLIENT_ID,
    client_secret: env.NETLIFY_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: `${url.origin}/oauth/callback`
  });

  // Exchange the code for an access token
  const tokenResponse = await fetch("https://api.netlify.com/oauth/token", {
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

  // Build a redirect URL to your front-end (e.g. /editor.html)
  // Pass token info via fragment (#token=...) so it doesn't get logged in server logs
  const redirectUrl = new URL(`${url.origin}`);
  redirectUrl.hash = `access_token=${tokenData.access_token}`;
  sessionStorage.setItem("token", tokenData.access_token);

  // Get account type "free"
  const netlifyAccountTypeUrl = "https://api.netlify.com/api/v1/accounts/types";
  const payload = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
  const data = await netlifyApiRequest(netlifyAccountTypeUrl, payload);
  for (let i = 0; i < data.length; i++) {
    var typeObj = data[i];
    if (typeObj.name.toLowerCase() == "free") {
      console.log("Free account type_id: " + typeObj.id);
      sessionStorage.setItem("ACCOUNT_TYPE_ID_FREE", typeObj.id);
      break;
    }
  }

  return Response.redirect(redirectUrl.toString(), 302);
}

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

