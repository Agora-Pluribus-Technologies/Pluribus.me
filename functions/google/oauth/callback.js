import {
  createSession,
  makeSessionCookie,
  parseOAuthStateCookie,
  clearOAuthStateCookie,
} from "../../api/auth/_session.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return new Response("Missing OAuth code.", { status: 400 });
  }

  // CSRF defence: reject the callback unless the `state` query parameter
  // matches the value stored in the HttpOnly cookie that /api/auth/google/start
  // set on this browser.
  const state = url.searchParams.get("state");
  const cookieState = parseOAuthStateCookie(request, "google");
  if (!state || !cookieState || state !== cookieState) {
    return new Response("Invalid OAuth state.", {
      status: 400,
      headers: { "Set-Cookie": clearOAuthStateCookie("google") },
    });
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;

  // Exchange code for access token
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: `${url.origin}/google/oauth/callback`,
  });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
      Accept: "application/json",
    },
    body: tokenParams,
  });

  const tokenData = await tokenResponse.json();

  if (!tokenData.access_token) {
    return new Response(JSON.stringify(tokenData), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get Google user identity
  const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });

  if (!userResponse.ok) {
    return new Response("Failed to get Google user info", { status: 500 });
  }

  const googleUser = await userResponse.json();
  const providerId = googleUser.id;

  // Look up user in database
  const existingUser = await env.USERS_DB.prepare(
    "SELECT id, provider, providerId, username, createdAt FROM Users WHERE provider = ? AND providerId = ?"
  ).bind("google", providerId).first();

  let sessionData;
  if (existingUser) {
    sessionData = {
      userId: existingUser.id,
      username: existingUser.username.toLowerCase(),
      displayUsername: existingUser.username,
      provider: "google",
      providerId,
      status: "active",
    };
  } else {
    sessionData = {
      provider: "google",
      providerId,
      status: "pending_username",
    };
  }

  const sessionToken = await createSession(env, sessionData);
  const redirectUrl = new URL("/builder.html", url.origin);

  const headers = new Headers({ Location: redirectUrl.toString() });
  headers.append("Set-Cookie", makeSessionCookie(sessionToken));
  headers.append("Set-Cookie", clearOAuthStateCookie("google"));
  return new Response(null, { status: 302, headers });
}
