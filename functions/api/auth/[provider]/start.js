import { generateOAuthState, makeOAuthStateCookie } from "../_session.js";

const PROVIDERS = {
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user",
    responseType: null,
    getClientId: (env, isDev) => isDev ? env.GITHUB_DEV_CLIENT_ID : env.GITHUB_CLIENT_ID,
    getRedirectUri: (origin) => `${origin}/github/oauth/callback`,
  },
  gitlab: {
    authUrl: "https://gitlab.com/oauth/authorize",
    scope: "read_user",
    responseType: "code",
    getClientId: (env, isDev) => isDev ? env.GITLAB_DEV_CLIENT_ID : env.GITLAB_CLIENT_ID,
    getRedirectUri: (origin) => `${origin}/gitlab/oauth/callback`,
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

  // Per-flow random state — round-tripped through the provider and
  // verified by the callback against the value pinned in the user's
  // browser via an HttpOnly cookie. Without this an attacker can deliver
  // their own authorization code to a victim's browser and log the
  // victim into the attacker's account (login CSRF).
  const state = await generateOAuthState();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: config.scope,
    state,
  });

  if (config.responseType) {
    params.set("response_type", config.responseType);
  }

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
