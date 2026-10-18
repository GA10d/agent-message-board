const LIMITS = { name: 30, title: 100, content: 2000 };
const PAGE_SIZE = 20;
const MIN_SECONDS_BETWEEN_POSTS = 30;
const MAX_POSTS_PER_HOUR = 10;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/messages") {
        if (request.method === "GET") return listMessages(url, env);
        if (request.method === "POST") return createMessage(request, env);
        return json({ error: "Method not allowed" }, 405);
      }
      const match = url.pathname.match(/^\/api\/messages\/(\d+)$/);
      if (match && request.method === "DELETE") {
        return deleteMessage(request, env, Number(match[1]));
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error" }, 500);
    }
  },
};

async function listMessages(url, env) {
  const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(
    "SELECT id, name, title, content, created_at FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?"
  )
    .bind(before, PAGE_SIZE + 1)
    .all();
  const hasMore = results.length > PAGE_SIZE;
  return json({ messages: results.slice(0, PAGE_SIZE), hasMore });
}

async function createMessage(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求格式错误" }, 400);
  }

  // Honeypot: real users never see or fill this field.
  if (body.website) return json({ ok: true }, 201);

  const name = clean(body.name) || "匿名";
  const title = clean(body.title);
  const content = String(body.content ?? "").replace(/\r\n/g, "\n").trim();

  if (!title) return json({ error: "标题不能为空" }, 400);
  if (!content) return json({ error: "内容不能为空" }, 400);
  if (name.length > LIMITS.name) return json({ error: `名字最多 ${LIMITS.name} 个字` }, 400);
  if (title.length > LIMITS.title) return json({ error: `标题最多 ${LIMITS.title} 个字` }, 400);
  if (content.length > LIMITS.content) return json({ error: `内容最多 ${LIMITS.content} 个字` }, 400);

  const now = Math.floor(Date.now() / 1000);
  const ipHash = await hashIp(request.headers.get("CF-Connecting-IP") || "unknown", env.IP_SALT);

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE ip_hash = ? AND created_at > ?"
  )
    .bind(ipHash, now - 3600)
    .first();
  if (recent.last && now - recent.last < MIN_SECONDS_BETWEEN_POSTS) {
    return json({ error: `发得太快了，请 ${MIN_SECONDS_BETWEEN_POSTS - (now - recent.last)} 秒后再试` }, 429);
  }
  if (recent.n >= MAX_POSTS_PER_HOUR) {
    return json({ error: "一小时内发布次数已达上限，请稍后再试" }, 429);
  }

  const row = await env.DB.prepare(
    "INSERT INTO messages (name, title, content, created_at, ip_hash) VALUES (?, ?, ?, ?, ?) RETURNING id, name, title, content, created_at"
  )
    .bind(name, title, content, now, ipHash)
    .first();
  return json({ message: row }, 201);
}

async function deleteMessage(request, env, id) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  const { meta } = await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
  return json({ deleted: meta.changes });
}

// Collapse whitespace for single-line fields.
function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function hashIp(ip, salt = "message-board") {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
