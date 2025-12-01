// functions/s/[site]/[[path]].js

// This function serves user sites from GitHub or GitLab based on KV config.
// URL shape: /s/:siteId/... → fetch from that site's repo and return the file.

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  const username = params && params.username ? String(params.username) : null;
  const site = params && params.site ? String(params.site) : null;
  const siteId = username && site ? `${username}/${site}` : null;
  if (!siteId) {
    return new Response("Missing site id", { status: 400 });
  }

  // Basic validation for siteId (avoid weird characters / traversal tricks)
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site id", { status: 400 });
  }

  console.log("Site id:", siteId);

  // Compute the path inside the site, after /s/:siteId/
  // e.g. /s/alice/about/team.html -> "about/team.html"
  const segments = url.pathname.split("/").filter(Boolean); // ["s","alice","about","team.html"]
  const restSegments = segments.slice(3); // skip "s", username, and siteId
  let filePath = restSegments.join("/");

  // Default to index.html if no specific file
  if (!filePath) {
    filePath = "index.html";
  }

  // Normalize to always start with "/"
  if (!filePath.startsWith("/")) {
    filePath = "/" + filePath;
  }

  // Very simple path traversal guard
  if (filePath.includes("..")) {
    return new Response("Invalid path", { status: 400 });
  }

  console.log("File path:", filePath);

  // Look up site configuration in KV: site:<siteId>
  const cfgJson = await env.SITES.get(`site:${siteId}`);
  if (!cfgJson) {
    // Fail closed: if we don't know this site, return 404
    return new Response("Unknown site", { status: 404 });
  }

  let cfg;
  try {
    cfg = JSON.parse(cfgJson);
  } catch {
    return new Response("Invalid site config", { status: 500 });
  }

  console.log("Site config:", cfg);

  const provider = cfg.provider;
  const owner = cfg.owner;
  const repo = cfg.repo;
  const branch = cfg.branch || "main";
  let basePath = cfg.basePath || "/public";

  // Normalize basePath
  if (!basePath.startsWith("/")) basePath = "/" + basePath;
  if (basePath.endsWith("/")) basePath = basePath.slice(0, -1);

  const repoFilePath = basePath + filePath; // e.g. "/public/index.html"

  console.log("Repo file path:", repoFilePath);

  // Build raw URL
  let upstreamBaseUrl;
  if (provider === "github") {
    upstreamBaseUrl = githubRawUrl(owner, repo, branch, basePath);
  } else if (provider === "gitlab") {
    upstreamBaseUrl = gitlabRawUrl(owner, repo, branch, basePath);
  } else {
    return new Response("Unsupported provider", { status: 500 });
  }

  let upstreamUrl = upstreamBaseUrl + filePath;

  console.log("Upstream URL:", upstreamUrl);

  const upstreamRes = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, must-revalidate",
    },
  });

  if (!upstreamRes.ok) {
    // You could get fancy here (e.g. SPA routing), but 404 is fine for now.
    return new Response("File not found", { status: upstreamRes.status });
  }

  // Copy upstream headers (content-type, etc.) and add cache control
  const headers = new Headers();
  // Basic cache: adjust as you like
  headers.set("Cache-Control", "no-cache, must-revalidate");

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers
  });
};

// --- helpers ---

function githubRawUrl(owner, repo, branch, filePath) {
  // filePath already starts with "/"
  return (
    "https://raw.githubusercontent.com/" +
    encodeURIComponent(owner) +
    "/" +
    encodeURIComponent(repo) +
    "/" +
    encodeURIComponent(branch) +
    filePath
  );
}

function gitlabRawUrl(owner, repo, branch, filePath) {
  return (
    "https://gitlab.com/" +
    encodeURIComponent(owner) +
    "/" +
    encodeURIComponent(repo) +
    "/-/raw/" +
    encodeURIComponent(branch) +
    filePath
  );
}
