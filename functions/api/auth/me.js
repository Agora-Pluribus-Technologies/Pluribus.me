import { parseSessionCookie, getSession } from "./_session.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const token = parseSessionCookie(request);
  if (!token) {
    return Response.json({ authenticated: false });
  }

  const session = await getSession(env, token);
  if (!session) {
    return Response.json({ authenticated: false });
  }

  if (session.status === "pending_username") {
    return Response.json({
      authenticated: true,
      status: "pending_username",
      provider: session.provider,
      providerId: session.providerId,
    });
  }

  return Response.json({
    authenticated: true,
    status: "active",
    username: session.username,
    displayUsername: session.displayUsername,
    provider: session.provider,
  });
}
