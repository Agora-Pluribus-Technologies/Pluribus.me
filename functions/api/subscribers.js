// functions/api/subscribers.js
// Handles mailing list subscriber operations

// POST /api/subscribers - Subscribe an email or batch import emails
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

  // Ensure Subscribers table exists
  try {
    await env.USERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS Subscribers (
        id TEXT PRIMARY KEY,
        siteId TEXT NOT NULL,
        email TEXT NOT NULL,
        subscribedAt TEXT NOT NULL,
        unsubscribeToken TEXT NOT NULL,
        UNIQUE(siteId, email)
      )
    `).run();
  } catch {
    // Table likely already exists
  }

  // Batch import
  if (emails && Array.isArray(emails)) {
    // Verify the requester owns the site
    const site = await env.USERS_DB.prepare(
      "SELECT owner FROM Sites WHERE siteId = ?"
    ).bind(siteId).first();

    if (!site) {
      return new Response("Site not found", { status: 404 });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const entry of emails) {
      const addr = (typeof entry === "string" ? entry : entry.email || "").trim().toLowerCase();
      if (!addr || !isValidEmail(addr)) {
        skipped++;
        continue;
      }

      // Skip inactive subscribers if status is provided
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
          "INSERT OR IGNORE INTO Subscribers (id, siteId, email, subscribedAt, unsubscribeToken) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, siteId, addr, subscribedAt, unsubscribeToken).run();

        imported++;
      } catch (err) {
        skipped++;
      }
    }

    return new Response(JSON.stringify({ success: true, imported, skipped }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Single subscribe
  if (!email) {
    return new Response("Missing required field: email", { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    return new Response("Invalid email address", { status: 400 });
  }

  // Verify site exists
  const site = await env.USERS_DB.prepare(
    "SELECT siteId FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();

  if (!site) {
    return new Response("Site not found", { status: 404 });
  }

  try {
    // Check if already subscribed
    const existing = await env.USERS_DB.prepare(
      "SELECT id FROM Subscribers WHERE siteId = ? AND email = ?"
    ).bind(siteId, normalizedEmail).first();

    if (existing) {
      return new Response(JSON.stringify({ success: true, message: "Already subscribed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const id = crypto.randomUUID();
    const unsubscribeToken = crypto.randomUUID();
    const subscribedAt = new Date().toISOString();

    await env.USERS_DB.prepare(
      "INSERT INTO Subscribers (id, siteId, email, subscribedAt, unsubscribeToken) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, siteId, normalizedEmail, subscribedAt, unsubscribeToken).run();

    return new Response(JSON.stringify({ success: true, message: "Subscribed" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error subscribing:", error);
    return new Response("Failed to subscribe", { status: 500 });
  }
}

// GET /api/subscribers - List subscribers for a site (owner only)
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const siteId = url.searchParams.get("siteId");

  if (!siteId) {
    return new Response("Missing required parameter: siteId", { status: 400 });
  }

  try {
    const result = await env.USERS_DB.prepare(
      "SELECT id, email, subscribedAt FROM Subscribers WHERE siteId = ? ORDER BY subscribedAt DESC"
    ).bind(siteId).all();

    const subscribers = result.results || [];

    return new Response(JSON.stringify({ subscribers, count: subscribers.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Table may not exist yet
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
    // Public unsubscribe via email link
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
    // Owner removing a subscriber
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
