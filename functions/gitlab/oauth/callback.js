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
    clientId = env.GITLAB_DEV_CLIENT_ID;
    clientSecret = env.GITLAB_DEV_CLIENT_SECRET;
  } else {
    clientId = env.GITLAB_CLIENT_ID;
    clientSecret = env.GITLAB_CLIENT_SECRET;
  }

  // Exchange code for access token
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: `${url.origin}/gitlab/oauth/callback`,
  });

  const tokenResponse = await fetch("https://gitlab.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
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

  // Get GitLab user identity
  const userResponse = await fetch("https://gitlab.com/api/v4/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });

  if (!userResponse.ok) {
    return new Response("Failed to get GitLab user info", { status: 500 });
  }

  const gitlabUser = await userResponse.json();
  const providerId = String(gitlabUser.id);

  // Look up user in database
  const existingUser = await env.USERS_DB.prepare(
    "SELECT id, provider, providerId, username, createdAt FROM Users WHERE provider = ? AND providerId = ?"
  ).bind("gitlab", providerId).first();

  let sessionData;
  if (existingUser) {
    sessionData = {
      userId: existingUser.id,
      username: existingUser.username.toLowerCase(),
      displayUsername: existingUser.username,
      provider: "gitlab",
      providerId,
      status: "active",
    };
  } else {
    sessionData = {
      provider: "gitlab",
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
