// GET /api/users/download - Download all user data as JSON (ZIP created client-side)
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const username = url.searchParams.get("username");

  if (!username) {
    return new Response("Missing required parameter: username", { status: 400 });
  }

  const usernameLower = username.toLowerCase();

  // Get user info
  const userJson = await env.USERS.get(`username:${usernameLower}`);
  if (!userJson) {
    return new Response("User not found", { status: 404 });
  }

  const user = JSON.parse(userJson);

  try {
    const exportData = {
      user: {
        ...user,
        exportedAt: new Date().toISOString(),
      },
      sites: [],
    };

    // Get all user's sites from KV
    const sitePrefix = `site:${usernameLower}/`;
    const sitesList = await env.SITES.list({ prefix: sitePrefix });

    for (const key of sitesList.keys) {
      const siteConfigJson = await env.SITES.get(key.name);
      if (!siteConfigJson) continue;

      const siteConfig = JSON.parse(siteConfigJson);
      const siteId = key.name.replace("site:", "");

      const siteData = {
        config: siteConfig,
        files: [],
      };

      // Get all R2 files for this site
      try {
        const r2Prefix = `${siteId}/`;
        const r2List = await env.PLURIBUS_BUCKET.list({ prefix: r2Prefix });

        for (const obj of r2List.objects) {
          try {
            const fileObj = await env.PLURIBUS_BUCKET.get(obj.key);
            if (fileObj) {
              const contentType = fileObj.httpMetadata?.contentType || "application/octet-stream";
              const arrayBuffer = await fileObj.arrayBuffer();

              // Convert to base64 for transport
              const bytes = new Uint8Array(arrayBuffer);
              let binary = "";
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              const base64Content = btoa(binary);

              siteData.files.push({
                path: obj.key.replace(r2Prefix, ""),
                contentType: contentType,
                content: base64Content,
              });
            }
          } catch (fileError) {
            console.error(`Error reading file ${obj.key}:`, fileError);
          }
        }
      } catch (r2Error) {
        console.error(`Error listing R2 files for site ${siteId}:`, r2Error);
      }

      exportData.sites.push(siteData);
    }

    return new Response(JSON.stringify(exportData), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error exporting user data:", error);
    return new Response("Failed to export data: " + error.message, { status: 500 });
  }
}
