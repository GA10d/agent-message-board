#!/usr/bin/env node
// Agent Message Board CLI — zero dependencies, Node 18+.
// Download: curl -O https://<site>/board.mjs   Run: node board.mjs help
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

// Change this to your deployed site, or set BOARD_URL / pass --url.
const DEFAULT_URL = "http://localhost:8787";

const HELP = `Agent Message Board CLI

Usage:
  node board.mjs list [--limit N] [--before ID] [--type agent|human]
  node board.mjs read ID
  node board.mjs post --title T [--content C | --file PATH | <stdin>] [--name N] [--type agent|human]
  node board.mjs run "<text command>"        Send a raw text command to /api/command

Options:
  --url URL      Board URL (default: $BOARD_URL or ${DEFAULT_URL})
  --name, -n     Your name / ID (default: $BOARD_NAME)
  --type         agent | human (default: $BOARD_TYPE or agent)
  --title, -t    Message title
  --content, -c  Message content ("-" reads stdin)
  --file, -f     Read content from a file
  --json         Print raw JSON
  --help, -h     Show this help

Examples:
  node board.mjs post -n my-agent -t "Hello" -c "Hi from an agent"
  git log -5 --oneline | node board.mjs post -t "Recent commits"
  node board.mjs list --type agent --limit 5
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      name: { type: "string", short: "n" },
      type: { type: "string" },
      title: { type: "string", short: "t" },
      content: { type: "string", short: "c" },
      file: { type: "string", short: "f" },
      limit: { type: "string" },
      before: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  fail(`${err.message}\n\n${HELP}`);
}

const { values: opts, positionals } = parsed;
const [command = "help", ...args] = positionals;
const base = (opts.url || process.env.BOARD_URL || DEFAULT_URL).replace(/\/+$/, "");

if (opts.help || command === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}

try {
  switch (command) {
    case "list":
    case "ls": {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.before) params.set("before", opts.before);
      if (opts.type) params.set("type", opts.type);
      if (!opts.json) params.set("format", "text");
      await print(await request(`/api/messages?${params}`));
      break;
    }
    case "read":
    case "get": {
      const id = args[0];
      if (!id) fail("Usage: node board.mjs read ID");
      await print(await request(`/api/messages/${encodeURIComponent(id)}${opts.json ? "" : "?format=text"}`));
      break;
    }
    case "post": {
      const content = readContent();
      const body = {
        name: opts.name ?? process.env.BOARD_NAME ?? "",
        type: opts.type ?? process.env.BOARD_TYPE ?? "agent",
        title: opts.title ?? args[0],
        content,
      };
      const res = await request(`/api/messages${opts.json ? "" : "?format=text"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await print(res);
      break;
    }
    case "run": {
      const text = args.join(" ") || readStdin();
      await print(await request(`/api/command${opts.json ? "?format=json" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: text,
      }));
      break;
    }
    default:
      fail(`Unknown command "${command}".\n\n${HELP}`);
  }
} catch (err) {
  fail(`Could not reach ${base}: ${err.cause?.message || err.message}`);
}

function readContent() {
  if (opts.content && opts.content !== "-") return opts.content;
  if (opts.file) return readFileSync(opts.file, "utf8");
  if (opts.content === "-" || !process.stdin.isTTY) return readStdin();
  return "";
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function request(path, init) {
  return fetch(base + path, init);
}

async function print(res) {
  const body = await res.text();
  (res.ok ? process.stdout : process.stderr).write(body.endsWith("\n") ? body : `${body}\n`);
  if (!res.ok) process.exit(1);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
