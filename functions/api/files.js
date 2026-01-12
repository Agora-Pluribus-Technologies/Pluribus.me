// functions/api/files.js
// Handles file operations with Cloudflare R2 storage

// PUT /api/files - Save a file to R2
export async function onRequestPut(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { siteId, filePath, content, contentType, encoding } = data;

  if (!siteId || !filePath || content === undefined) {
    return new Response("Missing required fields: siteId, filePath, content", { status: 400 });
  }

  // Validate siteId format
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  // Validate filePath (no path traversal)
  if (filePath.includes("..")) {
    return new Response("Invalid file path", { status: 400 });
  }

  // Normalize filePath to not start with /
  const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

  // Build the R2 key: siteId/filePath
  const r2Key = `${siteId}/${normalizedPath}`;

  try {
    let body;
    if (encoding === "base64") {
      // Decode base64 content
      const binaryString = atob(content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      body = bytes;
    } else {
      // Plain text content
      body = content;
    }

    await env.PLURIBUS_BUCKET.put(r2Key, body, {
      httpMetadata: {
        contentType: contentType || guessContentType(normalizedPath),
      },
    });

    return new Response(JSON.stringify({ success: true, key: r2Key }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("R2 put error:", error);
    return new Response("Failed to save file", { status: 500 });
  }
}

// POST /api/files - Save multiple files to R2 in a batch
export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { siteId, files } = data;

  if (!siteId || !files || !Array.isArray(files)) {
    return new Response("Missing required fields: siteId, files (array)", { status: 400 });
  }

  // Validate siteId format
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  const results = [];
  const errors = [];

  for (const file of files) {
    const { filePath, content, contentType, encoding, action } = file;

    if (!filePath) {
      errors.push({ filePath, error: "Missing filePath" });
      continue;
    }

    // Validate filePath (no path traversal)
    if (filePath.includes("..")) {
      errors.push({ filePath, error: "Invalid file path" });
      continue;
    }

    // Normalize filePath
    const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    const r2Key = `${siteId}/${normalizedPath}`;

    try {
      if (action === "delete") {
        // Delete the file
        await env.PLURIBUS_BUCKET.delete(r2Key);
        results.push({ filePath: normalizedPath, action: "deleted" });
      } else {
        // Create or update the file
        if (content === undefined) {
          errors.push({ filePath, error: "Missing content for create/update" });
          continue;
        }

        let body;
        if (encoding === "base64") {
          const binaryString = atob(content);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          body = bytes;
        } else {
          body = content;
        }

        await env.PLURIBUS_BUCKET.put(r2Key, body, {
          httpMetadata: {
            contentType: contentType || guessContentType(normalizedPath),
          },
        });
        results.push({ filePath: normalizedPath, action: "saved" });
      }
    } catch (error) {
      console.error(`R2 operation error for ${r2Key}:`, error);
      errors.push({ filePath: normalizedPath, error: error.message });
    }
  }

  return new Response(JSON.stringify({ success: errors.length === 0, results, errors }), {
    status: errors.length === 0 ? 200 : 207,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /api/files - Get a file from R2 or list all files for a site
export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const siteId = url.searchParams.get("siteId");
  const filePath = url.searchParams.get("filePath");
  const listAll = url.searchParams.get("list") === "true";

  if (!siteId) {
    return new Response("Missing required query param: siteId", { status: 400 });
  }

  // Validate siteId format
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  // List all files for the site
  if (listAll) {
    try {
      const prefix = `${siteId}/`;
      const listed = await env.PLURIBUS_BUCKET.list({ prefix });

      const files = listed.objects.map(obj => ({
        key: obj.key.replace(prefix, ""),
        size: obj.size,
        uploaded: obj.uploaded,
      }));

      return new Response(JSON.stringify({ files }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("R2 list error:", error);
      return new Response("Failed to list files", { status: 500 });
    }
  }

  // Get a specific file
  if (!filePath) {
    return new Response("Missing required query param: filePath (or use list=true)", { status: 400 });
  }

  // Validate filePath (no path traversal)
  if (filePath.includes("..")) {
    return new Response("Invalid file path", { status: 400 });
  }

  // Normalize filePath
  const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const r2Key = `${siteId}/${normalizedPath}`;

  try {
    const object = await env.PLURIBUS_BUCKET.get(r2Key);

    if (!object) {
      return new Response("File not found", { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", object.httpMetadata?.contentType || guessContentType(normalizedPath));

    return new Response(object.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("R2 get error:", error);
    return new Response("Failed to retrieve file", { status: 500 });
  }
}

// DELETE /api/files - Delete a file or all files for a site from R2
export async function onRequestDelete(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const siteId = url.searchParams.get("siteId");
  const filePath = url.searchParams.get("filePath");
  const deleteAll = url.searchParams.get("deleteAll") === "true";

  if (!siteId) {
    return new Response("Missing required query param: siteId", { status: 400 });
  }

  // Validate siteId format
  if (!/^[a-zA-Z0-9-/_]+$/.test(siteId)) {
    return new Response("Invalid site ID", { status: 400 });
  }

  try {
    if (deleteAll) {
      // Delete all files for this site
      const prefix = `${siteId}/`;
      const listed = await env.PLURIBUS_BUCKET.list({ prefix });

      if (listed.objects.length > 0) {
        const keysToDelete = listed.objects.map(obj => obj.key);
        // R2 delete accepts an array of keys
        for (const key of keysToDelete) {
          await env.PLURIBUS_BUCKET.delete(key);
        }
      }

      return new Response(JSON.stringify({ success: true, deleted: listed.objects.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else if (filePath) {
      // Delete a single file
      if (filePath.includes("..")) {
        return new Response("Invalid file path", { status: 400 });
      }

      const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
      const r2Key = `${siteId}/${normalizedPath}`;

      await env.PLURIBUS_BUCKET.delete(r2Key);

      return new Response(JSON.stringify({ success: true, key: r2Key }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else {
      return new Response("Missing filePath or deleteAll=true", { status: 400 });
    }
  } catch (error) {
    console.error("R2 delete error:", error);
    return new Response("Failed to delete file(s)", { status: 500 });
  }
}

// Helper function to guess content type from file extension
function guessContentType(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeTypes = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    pdf: "application/pdf",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    eot: "application/vnd.ms-fontobject",
  };
  return mimeTypes[ext] || "application/octet-stream";
}
