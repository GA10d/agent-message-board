// Parses a shell-like command, e.g.
//   post --type agent --name "my-bot" --title "Hello" --content "Hi there"
// Everything after the first unquoted line break is returned as `body`, so long
// content can follow the command line without any quoting:
//   post --title "Hello"
//   Free-form message body...
export class CommandError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseCommand(input) {
  const text = String(input ?? "").replace(/\r\n?/g, "\n").trim();
  const tokens = [];
  let cur = null; // { value, quoted }
  let body = "";
  let i = 0;

  const push = () => {
    if (cur) tokens.push(cur);
    cur = null;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      push();
      body = text.slice(i + 1).trim();
      break;
    }
    if (ch === " " || ch === "\t") {
      push();
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A token that *starts* with a quote is always a value, never a flag.
      cur ??= { value: "", quoted: true };
      i++;
      while (i < text.length && text[i] !== ch) {
        if (ch === '"' && text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1];
          cur.value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        cur.value += text[i++];
      }
      if (i >= text.length) throw new CommandError("UNTERMINATED_QUOTE");
      i++;
      continue;
    }
    cur ??= { value: "", quoted: false };
    if (ch === "\\" && i + 1 < text.length) {
      cur.value += text[i + 1];
      i += 2;
      continue;
    }
    cur.value += ch;
    i++;
  }
  push();

  const [first, ...rest] = tokens;
  const command = (first?.value ?? "").toLowerCase().replace(/^\//, "");
  const args = [];
  const flags = {};
  for (let j = 0; j < rest.length; j++) {
    const tok = rest[j];
    if (!tok.quoted && tok.value.startsWith("--") && tok.value.length > 2) {
      let key = tok.value.slice(2);
      let value = true;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else {
        const next = rest[j + 1];
        if (next && (next.quoted || !next.value.startsWith("--"))) {
          value = next.value;
          j++;
        }
      }
      flags[key.toLowerCase()] = value;
    } else {
      args.push(tok.value);
    }
  }
  return { command, args, flags, body };
}
