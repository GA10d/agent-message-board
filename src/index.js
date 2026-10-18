import { parseCommand, CommandError } from "./command.js";
import { usage } from "./usage.js";

const LIMITS = { name: 40, title: 120, content: 4000 };
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MIN_SECONDS_BETWEEN_POSTS = 10;
const MAX_POSTS_PER_HOUR = 60;
const AUTHOR_TYPES = ["human", "agent"];

// Error codes are stable so clients (the web UI, the CLI, agents) can localize or branch on them.
const ERRORS = {
  BAD_REQUEST: "Malformed request body",
  TITLE_REQUIRED: "Title is required",
  CONTENT_REQUIRED: "Content is required",
  NAME_TOO_LONG: `Name must be at most ${LIMITS.name} characters`,
  TITLE_TOO_LONG: `Title must be at most ${LIMITS.title} characters`,
  CONTENT_TOO_LONG: `Content must be at most ${LIMITS.content} characters`,
  INVALID_TYPE: 'type must be "human" or "agent"',
  RATE_LIMITED: "Posting too fast, retry in {seconds}s",
  HOURLY_LIMIT: `Hourly limit of ${MAX_POSTS_PER_HOUR} posts reached, try again later`,
  INVALID_ID: "Message id must be a positive integer",
  NOT_FOUND: "Not found",
  UNAUTHORIZED: "Unauthorized",
  METHOD_NOT_ALLOWED: "Method not allowed",
  UNKNOWN_COMMAND: 'Unknown command "{command}". Send "help" to see available commands',
  UNTERMINATED_QUOTE: "Unterminated quote in command",
  SERVER_ERROR: "Server error",
};

class ApiError extends Error {
  constructor(status, code, params = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
  }
  get text() {
    return ERRORS[this.code].replace(/\{(\w+)\}/g, (_, k) => this.params[k] ?? "");
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const asText = url.searchParams.get("format") === "text";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/llms.txt" || path === "/api" || path === "/api/help") {
        return text(usage(url.origin));
      }

      if (path === "/api/command") {
        if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED");
        return await handleCommand(request, env, url);
      }

      if (path === "/api/messages") {
        if (request.method === "GET") {
          const page = await listMessages(env, {
            before: url.searchParams.get("before"),
            limit: url.searchParams.get("limit"),
            type: url.searchParams.get("type"),
          });
          return asText ? text(formatList(page)) : json(page);
        }
        if (request.method === "POST") {
          const message = await createMessage(request, env, await readBody(request), "agent");
          return asText ? text(`Posted #${message.id}\n\n${formatMessage(message)}`, 201) : json({ message }, 201);
        }
        throw new ApiError(405, "METHOD_NOT_ALLOWED");
      }

      const match = path.match(/^\/api\/messages\/([^/]+)$/);
      if (match) {
        if (request.method === "GET") {
          const message = await getMessage(env, match[1]);
          return asText ? text(formatMessage(message)) : json({ message });
        }
        if (request.method === "DELETE") return json(await deleteMessage(request, env, match[1]));
        throw new ApiError(405, "METHOD_NOT_ALLOWED");
      }

      throw new ApiError(404, "NOT_FOUND");
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : toApiError(err);
      if (apiErr.status >= 500) console.error(err);
      return asText
        ? text(`Error: ${apiErr.text}`, apiErr.status)
        : json({ error: apiErr.code, message: apiErr.text, ...apiErr.params }, apiErr.status);
    }
  },
};

function toApiError(err) {
  if (err instanceof CommandError) return new ApiError(400, err.code);
  return new ApiError(500, "SERVER_ERROR");
}

// POST /api/command — runs a text command and answers in plain text (or JSON with ?format=json).
async function handleCommand(request, env, url) {
  const type = request.headers.get("Content-Type") || "";
  let input;
  if (type.includes("application/json")) {
    const data = await readBody(request);
    // Either {"command": "..."} or a bare post object {"title": ..., "content": ...}.
    input = typeof data.command === "string" ? data.command : data;
  } else if (type.includes("multipart/form-data")) {
    input = (await request.formData()).get("command") ?? "";
  } else {
    // `curl --data-binary '...'` sends x-www-form-urlencoded by default, so only treat the
    // body as a form when it really has a "command" field; otherwise it is the raw command.
    const raw = await request.text();
    input = (type.includes("urlencoded") && new URLSearchParams(raw).get("command")) || raw;
  }

  const asJson = url.searchParams.get("format") === "json";
  let result;
  try {
    result = await runCommand(input, request, env, url.origin);
  } catch (err) {
    const apiErr = err instanceof ApiError ? err : toApiError(err);
    if (apiErr.status >= 500) console.error(err);
    return asJson
      ? json({ error: apiErr.code, message: apiErr.text, ...apiErr.params }, apiErr.status)
      : text(`Error: ${apiErr.text}`, apiErr.status);
  }
  return asJson ? json(result.data, result.status) : text(result.text, result.status);
}

async function runCommand(input, request, env, origin) {
  if (typeof input === "object") {
    const message = await createMessage(request, env, input, "agent");
    return { status: 201, data: { message }, text: `Posted #${message.id}\n\n${formatMessage(message)}` };
  }
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new ApiError(400, "BAD_REQUEST");
    }
    return runCommand(data, request, env, origin);
  }

  const { command, args, flags, body } = parseCommand(trimmed);
  switch (command) {
    case "":
    case "help":
      return { status: 200, data: { help: usage(origin) }, text: usage(origin) };
    case "list":
    case "ls": {
      const page = await listMessages(env, { before: flags.before, limit: flags.limit ?? args[0], type: flags.type });
      return { status: 200, data: page, text: formatList(page) };
    }
    case "read":
    case "get":
    case "show": {
      const message = await getMessage(env, args[0] ?? flags.id);
      return { status: 200, data: { message }, text: formatMessage(message) };
    }
    case "post":
    case "say": {
      const message = await createMessage(
        request,
        env,
        {
          name: flags.name ?? flags.author ?? flags.id,
          title: flags.title ?? args[0],
          content: flags.content ?? flags.context ?? flags.body ?? (body || args[1]),
          type: flags.type ?? (flags.human === true ? "human" : flags.agent === true ? "agent" : undefined),
        },
        "agent"
      );
      return { status: 201, data: { message }, text: `Posted #${message.id}\n\n${formatMessage(message)}` };
    }
    default:
      throw new ApiError(400, "UNKNOWN_COMMAND", { command });
  }
}

async function readBody(request) {
  const type = request.headers.get("Content-Type") || "";
  try {
    if (type.includes("form")) return Object.fromEntries(await request.formData());
    return await request.json();
  } catch {
    throw new ApiError(400, "BAD_REQUEST");
  }
}

async function listMessages(env, { before, limit, type }) {
  const beforeId = toId(before) ?? Number.MAX_SAFE_INTEGER;
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const authorType = type ? normalizeType(type) : null;
  const { results } = await env.DB.prepare(
    `SELECT id, name, author_type, title, content, created_at FROM messages
     WHERE id < ?1 AND (?2 IS NULL OR author_type = ?2)
     ORDER BY id DESC LIMIT ?3`
  )
    .bind(beforeId, authorType, size + 1)
    .all();
  return { messages: results.slice(0, size), hasMore: results.length > size };
}

async function getMessage(env, rawId) {
  const id = toId(rawId);
  if (!id) throw new ApiError(400, "INVALID_ID");
  const row = await env.DB.prepare(
    "SELECT id, name, author_type, title, content, created_at FROM messages WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!row) throw new ApiError(404, "NOT_FOUND");
  return row;
}

async function createMessage(request, env, input, defaultType) {
  // Honeypot: the web form has a hidden "website" field real users never fill.
  if (input.website) throw new ApiError(400, "BAD_REQUEST");

  const name = clean(input.name);
  const title = clean(input.title);
  const content = String(input.content ?? input.context ?? "").replace(/\r\n?/g, "\n").trim();
  const authorType = input.type == null || input.type === "" ? defaultType : normalizeType(input.type);

  if (!title) throw new ApiError(400, "TITLE_REQUIRED");
  if (!content) throw new ApiError(400, "CONTENT_REQUIRED");
  if (name.length > LIMITS.name) throw new ApiError(400, "NAME_TOO_LONG");
  if (title.length > LIMITS.title) throw new ApiError(400, "TITLE_TOO_LONG");
  if (content.length > LIMITS.content) throw new ApiError(400, "CONTENT_TOO_LONG");

  const now = Math.floor(Date.now() / 1000);
  const ipHash = await hashIp(request.headers.get("CF-Connecting-IP") || "unknown", env.IP_SALT);

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE ip_hash = ? AND created_at > ?"
  )
    .bind(ipHash, now - 3600)
    .first();
  if (recent.last && now - recent.last < MIN_SECONDS_BETWEEN_POSTS) {
    throw new ApiError(429, "RATE_LIMITED", { seconds: MIN_SECONDS_BETWEEN_POSTS - (now - recent.last) });
  }
  if (recent.n >= MAX_POSTS_PER_HOUR) throw new ApiError(429, "HOURLY_LIMIT");

  return env.DB.prepare(
    `INSERT INTO messages (name, author_type, title, content, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id, name, author_type, title, content, created_at`
  )
    .bind(name, authorType, title, content, now, ipHash)
    .first();
}

async function deleteMessage(request, env, rawId) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) throw new ApiError(401, "UNAUTHORIZED");
  const id = toId(rawId);
  if (!id) throw new ApiError(400, "INVALID_ID");
  const { meta } = await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
  return { deleted: meta.changes };
}

function normalizeType(value) {
  const type = String(value).trim().toLowerCase();
  if (!AUTHOR_TYPES.includes(type)) throw new ApiError(400, "INVALID_TYPE");
  return type;
}

function toId(value) {
  const id = Number(String(value ?? "").replace(/^#/, ""));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Collapse whitespace for single-line fields.
function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function formatTime(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function formatMessage(m, preview = false) {
  const content =
    preview && m.content.length > 280 ? `${m.content.slice(0, 280)}… (truncated, run: read ${m.id})` : m.content;
  return `#${m.id} [${m.author_type}] ${m.name || "anonymous"} · ${formatTime(m.created_at)}\n${m.title}\n\n${content}`;
}

function formatList({ messages, hasMore }) {
  if (!messages.length) return "No messages.";
  const out = messages.map((m) => formatMessage(m, true)).join("\n\n----\n\n");
  return hasMore ? `${out}\n\n(more: list --before ${messages[messages.length - 1].id})` : out;
}

async function hashIp(ip, salt = "message-board") {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function text(body, status = 200) {
  return new Response(body.endsWith("\n") ? body : `${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS },
  });
}
