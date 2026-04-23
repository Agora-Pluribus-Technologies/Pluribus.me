import { createSession, makeSessionCookie } from "../../api/auth/_session.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return new Response("Missing OAuth code.", { status: 400 });
  }

  let clientId;
  let clientSecret;
  if (url.origin.includes("develop")) {
    clientId = env.GITHUB_DEV_CLIENT_ID;
    clientSecret = env.GITHUB_DEV_CLIENT_SECRET;
  } else {
    clientId = env.GITHUB_CLIENT_ID;
    clientSecret = env.GITHUB_CLIENT_SECRET;
  }

  // Exchange code for access token
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: `${url.origin}/github/oauth/callback`,
  });

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
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

  // Get GitHub user identity
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "AgoraPages",
    },
  });

  if (!userResponse.ok) {
    return new Response("Failed to get GitHub user info", { status: 500 });
  }

  const githubUser = await userResponse.json();
  const providerId = githubUser.login;

  // Look up user in database
  const existingUser = await env.USERS_DB.prepare(
    "SELECT id, provider, providerId, username, createdAt FROM Users WHERE provider = ? AND providerId = ?"
  ).bind("github", providerId).first();

  let sessionData;
  if (existingUser) {
    sessionData = {
      userId: existingUser.id,
      username: existingUser.username.toLowerCase(),
      displayUsername: existingUser.username,
      provider: "github",
      providerId,
      status: "active",
    };
  } else {
    sessionData = {
      provider: "github",
      providerId,
      status: "pending_username",
    };
  }

  const sessionToken = await createSession(env, sessionData);
  const redirectUrl = new URL("/builder.html", url.origin);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      "Set-Cookie": makeSessionCookie(sessionToken),
    },
  });
}
