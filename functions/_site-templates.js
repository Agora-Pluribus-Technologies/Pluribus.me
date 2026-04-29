// Inlined SPA shell HTML for each site type. Imported by:
//   - functions/s/[username]/[site]/[[path]].js   (serves the shell live)
//   - functions/api/sites/download.js              (bakes shells into the
//                                                   export ZIP so the
//                                                   downloaded site is
//                                                   deployable on Netlify
//                                                   / GitHub Pages / etc.
//                                                   without the AgoraPages
//                                                   worker)
//
// IMPORTANT: when you change /_templates/owo-template.html or
// /_templates/blog-template.html, mirror the change here and redeploy.
// The static template files in /_templates/ are the authoritative source;
// the constants below must stay in sync.

export const OWO_TEMPLATE_HTML = `<!DOCTYPE HTML>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agora Site</title>
  <link rel="icon" type="image/png" href="/_assets/AgoraPages-globe.svg" />
  <link rel="stylesheet" href="/_templates/owo-template.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/marked@latest/marked.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/dompurify@latest/dist/purify.min.js"></script>
  <script defer src="/_assets/wikilinks.js"></script>
  <script defer src="/_assets/math.js"></script>
  <script defer src="/_templates/owo-template.js"></script>
</head>
<body></body>
</html>`;

export const BLOG_TEMPLATE_HTML = `<!DOCTYPE HTML>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agora Blog</title>
  <link rel="icon" type="image/png" href="/_assets/AgoraPages-globe.svg" />
  <link rel="stylesheet" href="/_templates/blog-template.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/marked@latest/marked.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/dompurify@latest/dist/purify.min.js"></script>
  <script defer src="/_templates/blog-template.js"></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
</head>
<body></body>
</html>`;

export function templateForSiteType(siteType) {
  return siteType === "blog" ? BLOG_TEMPLATE_HTML : OWO_TEMPLATE_HTML;
}
