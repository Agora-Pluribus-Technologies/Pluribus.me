import { generateOAuthState, makeOAuthStateCookie } from "../_session.js";

const PROVIDERS = {
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user",
    responseType: null,
    getClientId: (env, isDev) => isDev ? env.GITHUB_DEV_CLIENT_ID : env.GITHUB_CLIENT_ID,
    getRedirectUri: (origin) => `${origin}/github/oauth/callback`,
  },
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
    responseType: "code",
    getClientId: (env, _isDev) => env.GOOGLE_CLIENT_ID,
    getRedirectUri: (origin) => `${origin}/google/oauth/callback`,
  },
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const provider = context.params.provider;

  if (!PROVIDERS[provider]) {
    return new Response("Unknown provider", { status: 400 });
  }

  const config = PROVIDERS[provider];
  const isDev = url.origin.includes("develop");
  const clientId = config.getClientId(env, isDev);
  const redirectUri = config.getRedirectUri(url.origin);

  // Catch a missing OAuth credential early — otherwise URLSearchParams
  // will happily stringify `undefined` into the query (`client_id=undefined`)
  // and the provider returns a misleading error like "scope is invalid"
  // because it stops parsing once it sees the bad client_id.
  if (!clientId) {
    return new Response(
      `OAuth not configured for provider "${provider}" (missing client id).`,
      { status: 500 }
    );
  }

  // Per-flow random state — round-tripped through the provider and
  // verified by the callback against the value pinned in the user's
  // browser via an HttpOnly cookie. Without this an attacker can deliver
  // their own authorization code to a victim's browser and log the
  // victim into the attacker's account (login CSRF).
  const state = await generateOAuthState();

  // Build params with `.set()` in a deterministic order:
  // response_type, client_id, redirect_uri, state, scope.
  const params = new URLSearchParams();
  if (config.responseType) {
    params.set("response_type", config.responseType);
  }
  params.set("client_id", clientId);
  params.set("redirect_uri", redirectUri);
  params.set("state", state);
  params.set("scope", config.scope);

  if (provider === "google") {
    params.set("access_type", "offline");
  }

  const authorizationUrl = `${config.authUrl}?${params.toString()}`;

  // Response.redirect doesn't accept extra headers, so build the
  // response manually to attach the state cookie alongside the Location.
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizationUrl,
      "Set-Cookie": makeOAuthStateCookie(provider, state),
    },
  });
}
