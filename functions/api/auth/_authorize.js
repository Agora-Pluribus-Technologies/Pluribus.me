// Checks if the session user is the owner of the given site
export async function isOwner(env, siteId, username) {
  const site = await env.USERS_DB.prepare(
    "SELECT owner FROM Sites WHERE siteId = ?"
  ).bind(siteId).first();
  if (!site) return false;
  return site.owner.toLowerCase() === username.toLowerCase();
}

// Checks if the session user is a collaborator on the given site
export async function isCollaborator(env, siteId, username) {
  const collab = await env.USERS_DB.prepare(
    "SELECT c.userId FROM Collaborators c JOIN Users u ON c.userId = u.id WHERE c.siteId = ? AND LOWER(u.username) = LOWER(?)"
  ).bind(siteId, username).first();
  return !!collab;
}

// Checks if the session user is the owner or a collaborator
export async function canAccess(env, siteId, username) {
  return await isOwner(env, siteId, username) || await isCollaborator(env, siteId, username);
}

// Returns 403 response for unauthorized access
export function forbidden(message = "You do not have permission to access this resource") {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
