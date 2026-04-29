// functions/edit/[username]/[site]/[[path]].js

// This function serves the markdown editor for a specific site and page.
// URL shape: /edit/:username/:site/:path -> Opens editor for that page
// Permission check is done client-side after OAuth authentication.

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  // Decode + NFC normalize the route params before assembling siteId.
  // Cloudflare Pages Functions hand back route params with percent-
  // encoding intact, so a CJK site slug arrives as `%E4%B8%AD…` instead
  // of the actual code points — and the Unicode-aware validation gate
  // below then rejects those `%` characters as non-alphanumeric. NFC
  // normalize while we're here so a URL pasted from a macOS NFD source
  // matches the NFC form stored in D1 / R2.
  const decodeParam = (raw) => {
    if (!raw) return null;
    try { return decodeURIComponent(String(raw)).normalize("NFC"); }
    catch { return String(raw); }
  };
  const username = params && params.username ? decodeParam(params.username).toLowerCase() : null;
  const site = params && params.site ? decodeParam(params.site) : null;
  const siteId = username && site ? `${username}/${site}` : null;

  if (!siteId) {
    return new Response("Missing site id", { status: 400 });
  }

  // Basic validation for siteId. Unicode-aware allowlist (\p{L}\p{N})
  // matches sanitizeSiteName so CJK / accented-Latin / etc. slugs work
  // end to end. Structural separators (`/`, `_`, `-`) remain allowed.
  if (!/^[\p{L}\p{N}/_-]+$/u.test(siteId)) {
    return new Response("Invalid site id", { status: 400 });
  }

  // Compute the path (page to edit), after /edit/:username/:site/.
  // `URL.pathname` does NOT percent-decode, so a CJK page like
  // `中文笔记` arrives as `%E4%B8%AD%E6%96%87%E7%AC%94%E8%AE%B0`.
  // Decode each segment + NFC normalize so the downstream Unicode-aware
  // regex sees actual code points, not percent-encoded bytes (and so a
  // URL pasted from a macOS NFD source matches our NFC pages.json
  // entries). Mirrors the same boundary handling in the published-site
  // worker (functions/s/[username]/[site]/[[path]].js).
  const segments = url.pathname.split("/").filter(Boolean).map((seg) => {
    try { return decodeURIComponent(seg).normalize("NFC"); } catch { return seg; }
  });
  const restSegments = segments.slice(3); // skip "edit", username, and site
  let pagePath = restSegments.join("/");

  // Default to index if no specific page
  if (!pagePath) {
    pagePath = "index";
  }

  // Remove .md or .html extension if present
  pagePath = pagePath.replace(/\.(md|html)$/, "");

  // Path traversal guard
  if (pagePath.includes("..")) {
    return new Response("Invalid path", { status: 400 });
  }

  // Validate pagePath characters. Unicode-aware allowlist (\p{L}\p{N})
  // matches sanitizeSiteName / slugifySegment so CJK / Cyrillic / Greek /
  // accented-Latin page slugs validate; structural separators (`/`, `_`,
  // `-`) remain allowed as before. \p{L}/\p{N} are categories — they
  // don't include path separators or punctuation, so traversal protection
  // is preserved.
  if (!/^[\p{L}\p{N}/_-]*$/u.test(pagePath)) {
    return new Response("Invalid path characters", { status: 400 });
  }

  // Verify the site exists in D1
  const cfg = await env.USERS_DB.prepare(
    "SELECT siteId, owner, repo FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!cfg) {
    return new Response("Site not found", { status: 404 });
  }

  // Fetch the builder.html to serve the editor
  // We'll inject the edit context as a script
  const indexHtmlResponse = await env.ASSETS.fetch(new Request(new URL("/builder.html", url.origin)));

  if (!indexHtmlResponse.ok) {
    return new Response("Failed to load editor", { status: 500 });
  }

  let indexHtml = await indexHtmlResponse.text();

  // Inject the edit context before the closing </head> tag
  const editContext = {
    siteId,
    username,
    siteName: site,
    pagePath,
    displayName: cfg.repo || site,
  };

  // Escape < and > to prevent script tag breakout (defense-in-depth)
  const safeJson = JSON.stringify(editContext)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  const injectedScript = `
<script>
  // Edit context injected by /edit route
  window.PLURIBUS_EDIT_CONTEXT = ${safeJson};
</script>
`;

  // Insert the script before </head>
  indexHtml = indexHtml.replace("</head>", `${injectedScript}</head>`);

  // Versioning for cache busting of assets (append ?v=timestamp)
  const version = Date.now();
  indexHtml = indexHtml.replaceAll("QUERY_STRING_VERSION", version);

  return new Response(indexHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
