// Turnstile validation middleware for PUT, POST, DELETE requests to /api/* routes

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function validateTurnstileToken(token, secretKey, ip) {
  const formData = new FormData();
  formData.append("secret", secretKey);
  formData.append("response", token);
  if (ip) {
    formData.append("remoteip", ip);
  }

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();
  return result;
}

// GET endpoints that require Turnstile validation (sensitive data downloads)
const PROTECTED_GET_ENDPOINTS = [
  "/api/sites/download",
  "/api/users/download",
];

export async function onRequest(context) {
  const { request, env, next } = context;

  const method = request.method.toUpperCase();
  const url = new URL(request.url);

  // Skip Turnstile validation for OPTIONS requests (CORS preflight)
  if (method === "OPTIONS") {
    return next();
  }

  // Check if this is a protected GET endpoint
  const isProtectedGetEndpoint = method === "GET" && PROTECTED_GET_ENDPOINTS.includes(url.pathname);

  // Only validate Turnstile for PUT, POST, DELETE requests OR protected GET endpoints
  if (method !== "PUT" && method !== "POST" && method !== "DELETE" && !isProtectedGetEndpoint) {
    return next();
  }

  // Skip Turnstile validation for collaborators endpoints
  if (url.pathname === "/api/collaborators") {
    return next();
  }

  // Get the Turnstile secret key from environment
  const secretKey = env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    console.error("TURNSTILE_SECRET_KEY not configured");
    // In development, allow requests without Turnstile if not configured
    return next();
  }

  // Get the Turnstile token from header
  const turnstileToken = request.headers.get("X-Turnstile-Token");

  if (!turnstileToken) {
    return new Response(JSON.stringify({ error: "Missing Turnstile token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get client IP for additional validation
  const clientIP = request.headers.get("CF-Connecting-IP");

  // Validate the token
  const validationResult = await validateTurnstileToken(turnstileToken, secretKey, clientIP);

  if (!validationResult.success) {
    console.error("Turnstile validation failed:", validationResult["error-codes"]);
    return new Response(JSON.stringify({ error: "Turnstile validation failed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Token is valid, proceed to the next handler
  return next();
}
