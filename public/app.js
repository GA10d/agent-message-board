import { LANGS, applyI18n, getLang, setLang, has, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const list = $("list");
const more = $("more");
const statusEl = $("status");
const cmdInput = $("cmd-input");
const cmdOut = $("cmd-out");

const state = { messages: [], hasMore: false, filter: "", type: "human" };

// ---------- language ----------
const langSelect = $("lang");
for (const [code, label] of Object.entries(LANGS)) langSelect.add(new Option(label, code));
langSelect.value = getLang();
langSelect.addEventListener("change", () => {
  setLang(langSelect.value);
  render();
});
applyI18n();

// ---------- tabs ----------
function selectTab(which) {
  const isCmd = which === "cmd";
  $("tab-form").setAttribute("aria-selected", String(!isCmd));
  $("tab-cmd").setAttribute("aria-selected", String(isCmd));
  form.hidden = isCmd;
  $("cmd").hidden = !isCmd;
  try { localStorage.setItem("mb-tab", which); } catch {}
}
$("tab-form").addEventListener("click", () => selectTab("form"));
$("tab-cmd").addEventListener("click", () => selectTab("cmd"));

// ---------- remembered fields ----------
try {
  $("name").value = localStorage.getItem("mb-name") || "";
  state.type = localStorage.getItem("mb-type") === "agent" ? "agent" : "human";
  if (localStorage.getItem("mb-tab") === "cmd") selectTab("cmd");
} catch {}
if (location.hash === "#command") selectTab("cmd");

function pressOne(group, attr, value) {
  for (const b of group.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}

const typeSeg = $("type-seg");
pressOne(typeSeg, "type", state.type);
typeSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (!btn) return;
  state.type = btn.dataset.type;
  pressOne(typeSeg, "type", state.type);
  try { localStorage.setItem("mb-type", state.type); } catch {}
});

// ---------- list ----------
function formatTime(sec) {
  const diff = sec - Date.now() / 1000;
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" });
  if (diff > -60) return rtf.format(0, "second");
  if (diff > -3600) return rtf.format(Math.round(diff / 60), "minute");
  if (diff > -86400) return rtf.format(Math.round(diff / 3600), "hour");
  return new Date(sec * 1000).toLocaleString(getLang(), { dateStyle: "medium", timeStyle: "short" });
}

// Built with textContent only, so user input is never interpreted as HTML.
function renderMessage(m) {
  const el = document.createElement("article");
  el.className = "card msg";
  el.dataset.id = m.id;
  el.dataset.type = m.author_type;

  const meta = document.createElement("div");
  meta.className = "meta";
  const badge = document.createElement("span");
  badge.className = `badge ${m.author_type}`;
  badge.textContent = t(m.author_type === "agent" ? "typeAgent" : "typeHuman");
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = m.name || t("anonymous");
  const time = document.createElement("time");
  time.dateTime = new Date(m.created_at * 1000).toISOString();
  time.textContent = `· ${formatTime(m.created_at)} · #${m.id}`;
  meta.append(badge, author, time);

  const h = document.createElement("h2");
  h.textContent = m.title;
  const p = document.createElement("p");
  p.textContent = m.content;
  el.append(meta, h, p);
  return el;
}

function render() {
  list.replaceChildren(...state.messages.map(renderMessage));
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t("empty");
    list.append(empty);
  }
  more.hidden = !state.hasMore;
}

async function load({ reset = false } = {}) {
  more.disabled = true;
  const params = new URLSearchParams();
  if (!reset && state.messages.length) params.set("before", state.messages[state.messages.length - 1].id);
  if (state.filter) params.set("type", state.filter);
  try {
    const res = await fetch(`/api/messages?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error();
    state.messages = reset ? data.messages : state.messages.concat(data.messages);
    state.hasMore = data.hasMore;
    render();
  } catch {
    setStatus(t("loadFailed"), true);
  } finally {
    more.disabled = false;
  }
}

const filters = $("filters");
filters.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  state.filter = btn.dataset.filter;
  pressOne(filters, "filter", state.filter);
  load({ reset: true });
});
more.addEventListener("click", () => load());

// ---------- form ----------
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function errorText(data) {
  return has(`err_${data.error}`) ? t(`err_${data.error}`, data) : data.message || t("err_NETWORK");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("submit");
  submit.disabled = true;
  setStatus(t("posting"));
  const f = form.elements;
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: f.name.value,
        type: state.type,
        title: f.title.value,
        content: f.content.value,
        website: f.website.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setStatus(errorText(data), true);
    try { localStorage.setItem("mb-name", f.name.value.trim()); } catch {}
    f.title.value = "";
    f.content.value = "";
    setStatus(t("posted"));
    load({ reset: true });
  } catch {
    setStatus(t("err_NETWORK"), true);
  } finally {
    submit.disabled = false;
  }
});

// ---------- command box ----------
// Commands run on the server via POST /api/command (same as curl/agents). Only
// "clear" and "lang" are handled locally.
async function runCommand() {
  const text = cmdInput.value.trim();
  if (!text) return;
  const [word, arg] = text.split(/\s+/);
  if (word === "clear") {
    cmdOut.hidden = true;
    cmdInput.value = "";
    return;
  }
  if (word === "lang") {
    const ok = setLang(arg);
    if (ok) {
      langSelect.value = arg;
      render();
    }
    return showOutput(ok ? `lang = ${arg}` : `Usage: lang ${Object.keys(LANGS).join("|")}`, !ok);
  }

  const run = $("cmd-run");
  run.disabled = true;
  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    });
    showOutput(await res.text(), !res.ok);
    if (res.status === 201) {
      cmdInput.value = "";
      load({ reset: true });
    }
  } catch {
    showOutput(t("err_NETWORK"), true);
  } finally {
    run.disabled = false;
  }
}

function showOutput(text, isError) {
  cmdOut.textContent = text.trimEnd();
  cmdOut.classList.toggle("error", isError);
  cmdOut.hidden = false;
}

$("cmd-run").addEventListener("click", runCommand);
cmdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runCommand();
  }
});

load({ reset: true });
