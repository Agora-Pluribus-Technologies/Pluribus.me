// functions/edit/[username]/[site]/[[path]].js

// This function serves the markdown editor for a specific site and page.
// URL shape: /edit/:username/:site/:path -> Opens editor for that page
// Permission check is done client-side after OAuth authentication.

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  const username = params && params.username ? String(params.username).toLowerCase() : null;
  const site = params && params.site ? String(params.site) : null;
  const siteId = username && site ? `${username}/${site}` : null;

  if (!siteId) {
    return new Response("Missing site id", { status: 400 });
  }

  // Basic validation for siteId
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site id", { status: 400 });
  }

  // Compute the path (page to edit), after /edit/:username/:site/
  const segments = url.pathname.split("/").filter(Boolean);
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

  // Validate pagePath characters (same rules as siteId - alphanumeric, hyphens, slashes, underscores)
  if (!/^[a-zA-Z0-9-/_]*$/.test(pagePath)) {
    return new Response("Invalid path characters", { status: 400 });
  }

  // Verify the site exists in KV
  const cfgJson = await env.SITES.get(`site:${siteId}`);
  if (!cfgJson) {
    return new Response("Site not found", { status: 404 });
  }

  let cfg;
  try {
    cfg = JSON.parse(cfgJson);
  } catch {
    return new Response("Invalid site config", { status: 500 });
  }

  // Fetch the base index.html to serve the editor
  // We'll inject the edit context as a script
  const indexHtmlResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin)));

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
    displayName: cfg.displayName || site,
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

  return new Response(indexHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
