document.addEventListener("DOMContentLoaded", async function () {
  const sites = await getSiteListNetlify();
  const sitesListPanel = document.getElementById("sitesListPanel");
  for (const site of sites) {
    const siteDiv = document.createElement("div");
    siteDiv.style.border = "1px solid #ccc";
    siteDiv.style.padding = "10px";
    siteDiv.style.marginBottom = "10px";
    siteDiv.innerHTML = site.name;
    sitesListPanel.appendChild(siteDiv);
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
