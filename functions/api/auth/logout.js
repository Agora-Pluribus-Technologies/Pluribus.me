import { parseSessionCookie, deleteSession, clearSessionCookie } from "./_session.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const token = parseSessionCookie(request);
  if (token) {
    await deleteSession(env, token);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}
