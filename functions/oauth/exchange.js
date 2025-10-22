export async function onRequestPost(context) {
  const { NETLIFY_CLIENT_ID, NETLIFY_CLIENT_SECRET } = context.env;

  // Parse JSON body from frontend
  const body = await context.request.json();
  const { code, redirect_uri } = body;

  if (!code) {
    return new Response(JSON.stringify({ error: "Missing code" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Prepare form data for token exchange
  const form = new URLSearchParams({
    client_id: NETLIFY_CLIENT_ID,
    client_secret: NETLIFY_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri
  });

  // Exchange code for token
  const resp = await fetch("https://app.netlify.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });

  const data = await resp.json();

  // Return token payload to frontend
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
