// functions/api/notify.js
// Sends email notification to all subscribers of a site when a new post is published

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { siteId, postTitle, postExcerpt, postUrl } = data;

  if (!siteId || !postTitle || !postUrl) {
    return new Response("Missing required fields: siteId, postTitle, postUrl", { status: 400 });
  }

  // Verify the site exists and get display name
  const site = await env.USERS_DB.prepare(
    "SELECT siteId, owner, displayName, repo FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!site) {
    return new Response("Site not found", { status: 404 });
  }

  const siteName = site.displayName || site.repo || siteId;

  // Get all subscribers
  let subscribers;
  try {
    const result = await env.USERS_DB.prepare(
      "SELECT email, unsubscribeToken FROM Subscribers WHERE siteId = ?"
    ).bind(siteId).all();
    subscribers = result.results || [];
  } catch (error) {
    if (error.message && error.message.includes("no such table")) {
      return new Response(JSON.stringify({ success: true, sent: 0, message: "No subscribers" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Error fetching subscribers:", error);
    return new Response("Failed to fetch subscribers", { status: 500 });
  }

  if (subscribers.length === 0) {
    return new Response(JSON.stringify({ success: true, sent: 0, message: "No subscribers" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check for Resend API key
  const resendApiKey = env.RESEND_API_KEY;
  if (!resendApiKey) {
    return new Response(JSON.stringify({ success: false, message: "Email service not configured. Set RESEND_API_KEY." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const siteSlug = siteId.replace("/", "-");
  const fromEmail = `${siteSlug}@agorapages.com`;
  const baseUrl = "https://agorapages.com";

  let sent = 0;
  let failed = 0;

  // Send emails in batches of 50
  const batchSize = 50;
  for (let i = 0; i < subscribers.length; i += batchSize) {
    const batch = subscribers.slice(i, i + batchSize);

    const sendPromises = batch.map(async (subscriber) => {
      const unsubscribeUrl = `${baseUrl}/unsubscribe.html?token=${subscriber.unsubscribeToken}`;

      const htmlBody = buildEmailHtml({
        siteName,
        postTitle,
        postExcerpt: postExcerpt || "",
        postUrl,
        unsubscribeUrl,
      });

      const textBody = buildEmailText({
        siteName,
        postTitle,
        postExcerpt: postExcerpt || "",
        postUrl,
        unsubscribeUrl,
      });

      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `${siteName} <${fromEmail}>`,
            to: [subscriber.email],
            subject: `New post: ${postTitle}`,
            html: htmlBody,
            text: textBody,
            headers: {
              "List-Unsubscribe": `<${unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }),
        });

        if (response.ok) {
          sent++;
        } else {
          const errText = await response.text();
          console.error(`Failed to send to ${subscriber.email}: ${errText}`);
          failed++;
        }
      } catch (err) {
        console.error(`Error sending to ${subscriber.email}:`, err);
        failed++;
      }
    });

    await Promise.all(sendPromises);
  }

  return new Response(JSON.stringify({
    success: true,
    sent,
    failed,
    total: subscribers.length,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function buildEmailHtml({ siteName, postTitle, postExcerpt, postUrl, unsubscribeUrl }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #1a1a1a; font-family: Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #1a1a1a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="background-color: #303030; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; border-bottom: 2px solid gold;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px;">${escapeHtml(siteName)}</h1>
              <p style="margin: 8px 0 0; color: #cccccc; font-size: 14px;">New post published</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color: #252525; padding: 30px;">
              <h2 style="margin: 0 0 15px; color: #ffffff; font-size: 22px;">${escapeHtml(postTitle)}</h2>
              ${postExcerpt ? `<p style="margin: 0 0 25px; color: #cccccc; font-size: 16px; line-height: 1.6;">${escapeHtml(postExcerpt)}</p>` : ""}
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color: gold; border-radius: 6px;">
                    <a href="${postUrl}" style="display: inline-block; padding: 12px 30px; color: #1a1a1a; text-decoration: none; font-weight: bold; font-size: 16px;">Read Post</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #303030; padding: 20px 30px; border-radius: 0 0 12px 12px; text-align: center;">
              <p style="margin: 0; color: #888888; font-size: 12px;">
                You received this because you subscribed to ${escapeHtml(siteName)}.
              </p>
              <p style="margin: 8px 0 0; color: #888888; font-size: 12px;">
                <a href="${unsubscribeUrl}" style="color: #cccccc; text-decoration: underline;">Unsubscribe</a>
                &nbsp;&bull;&nbsp;
                Powered by <a href="https://agorapages.com" style="color: gold; text-decoration: none;">AgoraPages</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildEmailText({ siteName, postTitle, postExcerpt, postUrl, unsubscribeUrl }) {
  let text = `${siteName} - New Post\n\n`;
  text += `${postTitle}\n\n`;
  if (postExcerpt) {
    text += `${postExcerpt}\n\n`;
  }
  text += `Read the full post: ${postUrl}\n\n`;
  text += `---\n`;
  text += `Unsubscribe: ${unsubscribeUrl}\n`;
  text += `Powered by AgoraPages (https://agorapages.com)\n`;
  return text;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
