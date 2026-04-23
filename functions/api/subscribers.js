import { isOwner, forbidden } from "./auth/_authorize.js";

// POST /api/subscribers - Subscribe an email (sends confirmation) or batch import emails
export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { siteId, email, emails } = data;

  if (!siteId) {
    return new Response("Missing required field: siteId", { status: 400 });
  }

  // Ensure Subscribers table exists with confirmed column
  try {
    await env.USERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS Subscribers (
        id TEXT PRIMARY KEY,
        siteId TEXT NOT NULL,
        email TEXT NOT NULL,
        subscribedAt TEXT NOT NULL,
        unsubscribeToken TEXT NOT NULL,
        confirmToken TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0,
        UNIQUE(siteId, email)
      )
    `).run();
  } catch {
    // Table likely already exists
  }

  // Ensure confirmed column exists (for existing tables)
  try {
    await env.USERS_DB.prepare(
      "ALTER TABLE Subscribers ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0"
    ).run();
  } catch {
    // Column already exists
  }
  try {
    await env.USERS_DB.prepare(
      "ALTER TABLE Subscribers ADD COLUMN confirmToken TEXT"
    ).run();
  } catch {
    // Column already exists
  }

  // Batch import (from dashboard — skips double opt-in, imports as confirmed)
  if (emails && Array.isArray(emails)) {
    if (!context.data.session || !(await isOwner(env, siteId, context.data.username))) {
      return forbidden();
    }

    const site = await env.USERS_DB.prepare(
      "SELECT owner FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();

    if (!site) {
      return new Response("Site not found", { status: 404 });
    }

    let imported = 0;
    let skipped = 0;

    for (const entry of emails) {
      const addr = (typeof entry === "string" ? entry : entry.email || "").trim().toLowerCase();
      if (!addr || !isValidEmail(addr)) {
        skipped++;
        continue;
      }

      if (typeof entry === "object" && entry.status) {
        const status = entry.status.toLowerCase();
        if (status !== "active" && status !== "subscribed" && status !== "confirmed") {
          skipped++;
          continue;
        }
      }

      try {
        const id = crypto.randomUUID();
        const unsubscribeToken = crypto.randomUUID();
        const subscribedAt = new Date().toISOString();

        await env.USERS_DB.prepare(
          "INSERT OR IGNORE INTO Subscribers (id, siteId, email, subscribedAt, unsubscribeToken, confirmed) VALUES (?, ?, ?, ?, ?, 1)"
        ).bind(id, siteId, addr, subscribedAt, unsubscribeToken).run();

        imported++;
      } catch {
        skipped++;
      }
    }

    return new Response(JSON.stringify({ success: true, imported, skipped }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Single subscribe (public — double opt-in)
  if (!email) {
    return new Response("Missing required field: email", { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    return new Response(JSON.stringify({ success: false, message: "Invalid email address" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify site exists and get display name
  const site = await env.USERS_DB.prepare(
    "SELECT siteId, displayName, repo FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!site) {
    return new Response("Site not found", { status: 404 });
  }

  try {
    // Check if already subscribed and confirmed
    const existing = await env.USERS_DB.prepare(
      "SELECT id, confirmed, confirmToken FROM Subscribers WHERE siteId = ? AND email = ?"
    ).bind(siteId, normalizedEmail).first();

    if (existing && existing.confirmed) {
      return new Response(JSON.stringify({ success: true, message: "Already subscribed!" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const confirmToken = crypto.randomUUID();
    const siteName = site.displayName || site.repo || siteId;

    if (existing && !existing.confirmed) {
      // Update the confirm token and resend
      await env.USERS_DB.prepare(
        "UPDATE Subscribers SET confirmToken = ? WHERE id = ?"
      ).bind(confirmToken, existing.id).run();
    } else {
      // Insert new pending subscriber
      const id = crypto.randomUUID();
      const unsubscribeToken = crypto.randomUUID();
      const subscribedAt = new Date().toISOString();

      await env.USERS_DB.prepare(
        "INSERT INTO Subscribers (id, siteId, email, subscribedAt, unsubscribeToken, confirmToken, confirmed) VALUES (?, ?, ?, ?, ?, ?, 0)"
      ).bind(id, siteId, normalizedEmail, subscribedAt, unsubscribeToken, confirmToken).run();
    }

    // Send confirmation email
    const resendApiKey = env.RESEND_API_KEY;
    if (resendApiKey) {
      const baseUrl = "https://agorapages.com";
      const confirmUrl = `${baseUrl}/confirm-subscribe.html?token=${confirmToken}`;
      const siteSlug = siteId.replace("/", "-");
      const fromEmail = `${siteSlug}@agorapages.com`;

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${siteName} <${fromEmail}>`,
          to: [normalizedEmail],
          subject: `Confirm your subscription to ${siteName}`,
          html: buildConfirmEmailHtml(siteName, confirmUrl),
          text: buildConfirmEmailText(siteName, confirmUrl),
        }),
      });
    }

    return new Response(JSON.stringify({ success: true, message: "Check your email to confirm!" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error subscribing:", error);
    return new Response("Failed to subscribe", { status: 500 });
  }
}

// GET /api/subscribers - List subscribers OR confirm a subscription
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("siteId");
  const confirmToken = url.searchParams.get("confirm");

  // Confirm subscription via email link
  if (confirmToken) {
    try {
      const subscriber = await env.USERS_DB.prepare(
        "SELECT id, siteId, email, confirmed FROM Subscribers WHERE confirmToken = ?"
      ).bind(confirmToken).first();

      if (!subscriber) {
        return new Response(JSON.stringify({ success: false, message: "Invalid or expired confirmation link." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (subscriber.confirmed) {
        return new Response(JSON.stringify({ success: true, message: "Already confirmed!" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      await env.USERS_DB.prepare(
        "UPDATE Subscribers SET confirmed = 1, confirmToken = NULL WHERE id = ?"
      ).bind(subscriber.id).run();

      return new Response(JSON.stringify({ success: true, message: "Subscription confirmed!" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error confirming subscription:", error);
      return new Response("Failed to confirm", { status: 500 });
    }
  }

  // List subscribers for a site (owner dashboard)
  if (!siteId) {
    return new Response("Missing required parameter: siteId", { status: 400 });
  }

  if (!(await isOwner(env, siteId, context.data.username))) {
    return forbidden();
  }

  try {
    const result = await env.USERS_DB.prepare(
      "SELECT id, email, subscribedAt, confirmed FROM Subscribers WHERE siteId = ? ORDER BY subscribedAt DESC"
    ).bind(siteId).all();

    const subscribers = result.results || [];

    return new Response(JSON.stringify({ subscribers, count: subscribers.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error.message && error.message.includes("no such table")) {
      return new Response(JSON.stringify({ subscribers: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Error listing subscribers:", error);
    return new Response("Failed to list subscribers", { status: 500 });
  }
}

// DELETE /api/subscribers - Unsubscribe via token (no auth needed) or by id (owner)
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const subscriberId = url.searchParams.get("id");
  const siteId = url.searchParams.get("siteId");

  if (token) {
    try {
      const subscriber = await env.USERS_DB.prepare(
        "SELECT id, email, siteId FROM Subscribers WHERE unsubscribeToken = ?"
      ).bind(token).first();

      if (!subscriber) {
        return new Response(JSON.stringify({ success: false, message: "Invalid or expired unsubscribe link" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      await env.USERS_DB.prepare(
        "DELETE FROM Subscribers WHERE unsubscribeToken = ?"
      ).bind(token).run();

      return new Response(JSON.stringify({ success: true, message: "Unsubscribed successfully" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error unsubscribing:", error);
      return new Response("Failed to unsubscribe", { status: 500 });
    }
  }

  if (subscriberId && siteId) {
    if (!(await isOwner(env, siteId, context.data.username))) {
      return forbidden();
    }

    try {
      await env.USERS_DB.prepare(
        "DELETE FROM Subscribers WHERE id = ? AND siteId = ?"
      ).bind(subscriberId, siteId).run();

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error removing subscriber:", error);
      return new Response("Failed to remove subscriber", { status: 500 });
    }
  }

  return new Response("Missing required parameters: token or (id + siteId)", { status: 400 });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildConfirmEmailHtml(siteName, confirmUrl) {
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
          <tr>
            <td style="background-color: #303030; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; border-bottom: 2px solid gold;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px;">${escapeHtmlEmail(siteName)}</h1>
              <p style="margin: 8px 0 0; color: #cccccc; font-size: 14px;">Confirm your subscription</p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #252525; padding: 30px; text-align: center;">
              <p style="margin: 0 0 25px; color: #cccccc; font-size: 16px; line-height: 1.6;">
                Click the button below to confirm your subscription to <strong style="color: #ffffff;">${escapeHtmlEmail(siteName)}</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                <tr>
                  <td style="background-color: gold; border-radius: 6px;">
                    <a href="${confirmUrl}" style="display: inline-block; padding: 12px 30px; color: #1a1a1a; text-decoration: none; font-weight: bold; font-size: 16px;">Confirm Subscription</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 25px 0 0; color: #888888; font-size: 13px;">If you didn't request this, you can ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #303030; padding: 20px 30px; border-radius: 0 0 12px 12px; text-align: center;">
              <p style="margin: 0; color: #888888; font-size: 12px;">
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

function buildConfirmEmailText(siteName, confirmUrl) {
  return `Confirm your subscription to ${siteName}\n\nClick the link below to confirm:\n${confirmUrl}\n\nIf you didn't request this, you can ignore this email.\n\nPowered by AgoraPages (https://agorapages.com)\n`;
}

function escapeHtmlEmail(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
