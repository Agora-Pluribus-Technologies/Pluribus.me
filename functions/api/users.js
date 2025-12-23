// GET /api/users - Check if username exists or get user by provider ID
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const username = url.searchParams.get("username");
  const providerId = url.searchParams.get("providerId");
  const provider = url.searchParams.get("provider");

  // Check if username is taken
  if (username) {
    const existing = await env.USERS.get(`username:${username.toLowerCase()}`);
    if (existing) {
      return new Response(JSON.stringify({ exists: true, user: JSON.parse(existing) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ exists: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get user by provider ID
  if (providerId && provider) {
    const existing = await env.USERS.get(`provider:${provider}:${providerId}`);
    if (existing) {
      return new Response(existing, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ exists: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Missing required parameters", { status: 400 });
}

// POST /api/users - Create a new user with username
export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { username, provider, providerId } = data;

  // Validate required fields
  if (!username || !provider || !providerId) {
    return new Response("Missing required fields: username, provider, providerId", { status: 400 });
  }

  // Validate username format (alphanumeric and hyphens, 3-30 chars)
  const usernameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,28}[a-zA-Z0-9]$/;
  if (!usernameRegex.test(username)) {
    return new Response("Invalid username format. Must be 3-30 characters, alphanumeric and hyphens only, cannot start or end with hyphen.", { status: 400 });
  }

  const usernameLower = username.toLowerCase();

  // Check if username is already taken
  const existingUsername = await env.USERS.get(`username:${usernameLower}`);
  if (existingUsername) {
    return new Response("Username already taken", { status: 409 });
  }

  // Check if this provider ID already has a username
  const existingProvider = await env.USERS.get(`provider:${provider}:${providerId}`);
  if (existingProvider) {
    return new Response("User already has a username", { status: 409 });
  }

  // Create user object
  const user = {
    username: usernameLower,
    provider: provider,
    providerId: providerId,
    createdAt: new Date().toISOString(),
  };

  // Store by username (for uniqueness check)
  await env.USERS.put(`username:${usernameLower}`, JSON.stringify(user));

  // Store by provider ID (for reverse lookup)
  await env.USERS.put(`provider:${provider}:${providerId}`, JSON.stringify(user));

  return new Response(JSON.stringify(user), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
