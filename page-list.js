document.addEventListener("DOMContentLoaded", async function () {
  const sites = await getSiteListNetlify();
  const sitesListPanel = document.getElementById("sitesListPanel");
  for (const site of sites) {
    const siteButton = document.createElement("button");
    siteButton.style.border = "1px solid #ccc";
    siteButton.style.padding = "10px";
    siteButton.style.marginBottom = "10px";
    siteButton.style.maxWidth = "100px";
    siteButton.innerHTML = site.name;
    siteButton.addEventListener("click", () => {
      console.log(`Selected site: ${site.name} (ID: ${site.id})`);
      sessionStorage.setItem("selectedSiteId", site.id);
      const markdown = fetchMarkdownFromSite(site.name);
      markdown.then((data) => {
        editor.setMarkdown(data);
      });
    });
    sitesListPanel.appendChild(siteButton);
  }
});

async function getSiteListNetlify() {
  const oauthToken = sessionStorage.getItem(STORAGE_KEY_NETLIFY_OAUTH_TOKEN);

  if (!oauthToken) return null;

  const response = await fetch("https://api.netlify.com/api/v1/sites", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
    },
  });

  const data = await response.json();

  const siteIds = data.map(site => site.id);
  sessionStorage.setItem(STORAGE_KEY_NETLIFY_SITE_ID_LIST, siteIds);

  return data;
}

async function fetchMarkdownFromSite(siteName) {
  // Use CORS proxy to bypass CORS restrictions
  const targetUrl = `https://${siteName}.netlify.app/index.md`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;

  const response = await fetch(proxyUrl, {
    method: "GET",
  });

  const data = await response.text();
  return data;
}
