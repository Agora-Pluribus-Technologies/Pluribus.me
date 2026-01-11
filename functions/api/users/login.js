// Password verification using Web Crypto API
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

// POST /api/users/login - Login with username and password
export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { username, password } = data;

  if (!username || !password) {
    return new Response("Missing required fields: username, password", { status: 400 });
  }

  const usernameLower = username.toLowerCase();

  // Get user from database
  const user = await env.USERS_DB.prepare(
    "SELECT id, provider, providerId, username, passwordHash, createdAt FROM Users WHERE LOWER(username) = LOWER(?) AND provider = 'agorapages'"
  ).bind(usernameLower).first();

  if (!user) {
    return new Response("Invalid username or password", { status: 401 });
  }

  if (!user.passwordHash) {
    return new Response("Invalid username or password", { status: 401 });
  }

  // Verify password
  const isValid = await verifyPassword(password, user.passwordHash);

  if (!isValid) {
    return new Response("Invalid username or password", { status: 401 });
  }

  // Generate a session token
  const token = generateToken();

  const response = {
    id: user.id,
    provider: user.provider,
    providerId: user.providerId,
    username: user.username,
    createdAt: user.createdAt,
    token,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
