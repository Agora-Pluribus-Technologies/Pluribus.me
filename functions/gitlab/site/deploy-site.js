export async function onRequestPost(context) {
  const request = context.request;
  const siteId = request.headers.get("X-Site-ID");
  const authorization = request.headers.get("Authorization");
  const zipFile = await request.arrayBuffer();
  const netlifySitesUrl = `https://api.netlify.com/api/v1/sites/${siteId}/deploys`;
  const resp = await fetch(netlifySitesUrl, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/zip",
    },
    body: zipFile,
  });

  if (!resp.ok) {
    return new Response("Could not deploy Netlify site", {
      status: resp.status,
    });
  }

  return resp;
}
