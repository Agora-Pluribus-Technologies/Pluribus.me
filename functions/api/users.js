// Password hashing utilities using Web Crypto API
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  // Combine salt and hash, then base64 encode
  const combined = new Uint8Array(salt.length + hash.byteLength);
  combined.set(salt);
  combined.set(new Uint8Array(hash), salt.length);
  return btoa(String.fromCharCode(...combined));
}

async function verifyPassword(password, storedHash) {
  const encoder = new TextEncoder();
  const combined = Uint8Array.from(atob(storedHash), c => c.charCodeAt(0));
  const salt = combined.slice(0, 16);
  const storedHashBytes = combined.slice(16);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const hashBytes = new Uint8Array(hash);
  if (hashBytes.length !== storedHashBytes.length) return false;
  for (let i = 0; i < hashBytes.length; i++) {
    if (hashBytes[i] !== storedHashBytes[i]) return false;
  }
  return true;
}

function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

// GET /api/users - Check if username exists or get user by provider ID
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const username = url.searchParams.get("username");
  const providerId = url.searchParams.get("providerId");
  const provider = url.searchParams.get("provider");

  // Check if username is taken
  if (username) {
    const result = await env.USERS_DB.prepare(
      "SELECT id, provider, providerId, username, createdAt FROM Users WHERE LOWER(username) = LOWER(?)"
    ).bind(username).first();

    if (result) {
      return new Response(JSON.stringify({ exists: true, user: result }), {
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
    const result = await env.USERS_DB.prepare(
      "SELECT id, provider, providerId, username, createdAt FROM Users WHERE provider = ? AND providerId = ?"
    ).bind(provider, providerId).first();

    if (result) {
      return new Response(JSON.stringify(result), {
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

  const { username, provider, providerId, password } = data;

  // Validate username
  if (!username) {
    return new Response("Missing required field: username", { status: 400 });
  }

  // Validate username format (alphanumeric and hyphens, 3-30 chars)
  const usernameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,28}[a-zA-Z0-9]$/;
  if (!usernameRegex.test(username)) {
    return new Response("Invalid username format. Must be 3-30 characters, alphanumeric and hyphens only, cannot start or end with hyphen.", { status: 400 });
  }

  const usernameLower = username.toLowerCase();

  // Check if username is already taken
  const existingUsername = await env.USERS_DB.prepare(
    "SELECT id FROM Users WHERE LOWER(username) = LOWER(?)"
  ).bind(usernameLower).first();

  if (existingUsername) {
    return new Response("Username already taken", { status: 409 });
  }

  // Handle agorapages provider (username/password auth)
  if (provider === "agorapages") {
    if (!password) {
      return new Response("Missing required field: password", { status: 400 });
    }

    if (password.length < 8) {
      return new Response("Password must be at least 8 characters", { status: 400 });
    }

    // Hash the password
    const passwordHash = await hashPassword(password);

    // Generate UUID and token for the new user
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const token = generateToken();

    // Insert new user into database with password hash
    // providerId is the same as username for agorapages provider
    await env.USERS_DB.prepare(
      "INSERT INTO Users (id, provider, providerId, username, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, "agorapages", usernameLower, usernameLower, passwordHash, createdAt).run();

    const user = {
      id,
      provider: "agorapages",
      providerId: usernameLower,
      username: usernameLower,
      createdAt,
      token,
    };

    return new Response(JSON.stringify(user), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Handle OAuth providers (existing flow)
  if (!provider || !providerId) {
    return new Response("Missing required fields: provider, providerId", { status: 400 });
  }

  // Check if this provider ID already has a username
  const existingProvider = await env.USERS_DB.prepare(
    "SELECT id FROM Users WHERE provider = ? AND providerId = ?"
  ).bind(provider, providerId).first();

  if (existingProvider) {
    return new Response("User already has a username", { status: 409 });
  }

  // Generate UUID for the new user
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  // Insert new user into database
  await env.USERS_DB.prepare(
    "INSERT INTO Users (id, provider, providerId, username, createdAt) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, provider, providerId, usernameLower, createdAt).run();

  const user = {
    id,
    provider,
    providerId,
    username: usernameLower,
    createdAt,
  };

  return new Response(JSON.stringify(user), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

// DELETE /api/users - Delete user account and all associated data
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const username = url.searchParams.get("username");

  if (!username) {
    return new Response("Missing required parameter: username", { status: 400 });
  }

  const usernameLower = username.toLowerCase();

  // Get user info from database
  const user = await env.USERS_DB.prepare(
    "SELECT id, provider, providerId, username, createdAt FROM Users WHERE LOWER(username) = LOWER(?)"
  ).bind(usernameLower).first();

  if (!user) {
    return new Response("User not found", { status: 404 });
  }

  try {
    // 1. Delete all user's sites from D1 and R2
    const sitesResult = await env.USERS_DB.prepare(
      "SELECT siteId FROM Sites WHERE owner = ?"
    ).bind(usernameLower).all();

    for (const site of sitesResult.results || []) {
      const siteId = site.siteId;

      // Delete all R2 files for this site
      try {
        const r2Prefix = `${siteId}/`;
        const r2List = await env.PLURIBUS_BUCKET.list({ prefix: r2Prefix });

        for (const obj of r2List.objects) {
          await env.PLURIBUS_BUCKET.delete(obj.key);
        }
        console.log(`Deleted ${r2List.objects.length} files from R2 for site: ${siteId}`);
      } catch (r2Error) {
        console.error(`Error deleting R2 files for site ${siteId}:`, r2Error);
      }

      // Delete collaborators for this site
      await env.USERS_DB.prepare(
        "DELETE FROM Collaborators WHERE siteId = ?"
      ).bind(siteId).run();

      // Delete site config from D1
      await env.USERS_DB.prepare(
        "DELETE FROM Sites WHERE siteId = ?"
      ).bind(siteId).run();
      console.log(`Deleted site config: ${siteId}`);
    }

    // 2. Delete user from database
    await env.USERS_DB.prepare(
      "DELETE FROM Users WHERE id = ?"
    ).bind(user.id).run();

    console.log(`User ${usernameLower} deleted successfully`);

    return new Response(JSON.stringify({ success: true, message: "Account deleted successfully" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    return new Response("Failed to delete account", { status: 500 });
  }
}
