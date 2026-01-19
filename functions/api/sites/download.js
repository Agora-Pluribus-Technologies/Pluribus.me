// GET /api/sites/download - Download a single site as JSON (ZIP created client-side)
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const siteIdEncoded = url.searchParams.get("siteId");

  if (!siteIdEncoded) {
    return new Response("Missing required parameter: siteId", { status: 400 });
  }

  const siteId = decodeURIComponent(siteIdEncoded);

  // Get site info from D1 database
  const siteConfig = await env.USERS_DB.prepare(
    "SELECT siteId, owner, repo FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!siteConfig) {
    return new Response("Site not found", { status: 404 });
  }

  try {
    const exportData = {
      site: {
        ...siteConfig,
        exportedAt: new Date().toISOString(),
      },
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

            exportData.files.push({
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

    return new Response(JSON.stringify(exportData), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error exporting site data:", error);
    return new Response("Failed to export data: " + error.message, { status: 500 });
  }
}
