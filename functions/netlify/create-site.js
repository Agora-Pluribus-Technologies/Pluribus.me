export default {
  async fetch(request, env) {
    const authorization = request.headers.get("Authorization");
    const zipFile = await request.arrayBuffer();
    const netlifySitesUrl = `https://api.netlify.com/api/v1/sites`;
    const resp = await fetch(netlifySitesUrl, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/zip",
      },
      body: zipFile,
    });

    if (!resp.ok) {
      return new Response("Could not create Netlify site", { status: resp.status });
    }

    return resp;
  },
};
