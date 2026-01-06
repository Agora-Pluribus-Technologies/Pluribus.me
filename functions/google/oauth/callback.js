export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  console.log("url:", url);
  console.log("search params:", url.searchParams);

  // If Google didn't send a code, show an error message
  if (!code) {
    return new Response("Missing OAuth code.", { status: 400 });
  }

  // Same OAuth client is used for both dev and prod
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;

  // Prepare the token exchange request
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: `${url.origin}/google/oauth/callback`
  });

  // Exchange the code for an access token with Google
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
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

  // Try to save the user's IP address
  try {
    // Fetch user info from Google
    const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`
      }
    });

    if (userResponse.ok) {
      const userData = await userResponse.json();
      const providerId = userData.id;

      // Look up user in D1
      const user = await env.USERS_DB.prepare(
        "SELECT id FROM Users WHERE provider = ? AND providerId = ?"
      ).bind("google", providerId).first();

      if (user) {
        // Save IP address
        const ipAddress = request.headers.get("CF-Connecting-IP") || "unknown";
        await env.USERS_DB.prepare(
          "INSERT INTO IPs (userId, ipAddress, timestamp) VALUES (?, ?, datetime('now'))"
        ).bind(user.id, ipAddress).run();
        console.log("Saved IP for user:", user.id, ipAddress);
      }
    }
  } catch (error) {
    console.error("Error saving IP:", error);
    // Don't block login if IP save fails
  }

  // Pass token info via fragment (#token=...) so it doesn't get logged in server logs
  const redirectUrl = new URL(url.origin);
  redirectUrl.hash = `google_access_token=${tokenData.access_token}`;

  return Response.redirect(redirectUrl.toString(), 302);
}

