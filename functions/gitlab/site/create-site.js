export async function onRequestPost(context) {
  const request = context.request;
  const authorization = request.headers.get("Authorization");
  const netlifySitesUrl = `https://gitlab.com/api/v1/sites`;
  const resp = await fetch(netlifySitesUrl, {
    method: "POST",
    headers: {
      Authorization: authorization
    }
  });

  if (!resp.ok) {
    return new Response("Could not create Netlify site", {
      status: resp.status,
    });
  }

  return resp;
}
