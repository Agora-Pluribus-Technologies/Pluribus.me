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

  if (!oauthToken) return false;

  const response = await fetch("https://api.netlify.com/api/v1/sites", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
    },
  });

  const data = await response.json();

  return data;
}

async function fetchMarkdownFromSite(siteName) {
  const response = await fetch(`${siteName}.netlify.app/index.md`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
    },
  });

  const data = await response.json();

  return data;
}
