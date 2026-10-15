// Carl web app: no framework, no build. Talks to the gateway's /carl API with the bearer key kept in this browser.
const $ = (sel) => document.querySelector(sel);
const store = {
  get key() { try { return localStorage.getItem("carl.key") || ""; } catch { return ""; } },
  set key(v) { try { v ? localStorage.setItem("carl.key", v) : localStorage.removeItem("carl.key"); } catch {} },
  get conversation() { try { return localStorage.getItem("carl.conversation") || "web:main"; } catch { return "web:main"; } },
  set conversation(v) { try { localStorage.setItem("carl.conversation", v); } catch {} },
};

class ApiError extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${store.key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin("The key was not accepted."); throw new ApiError("unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

// Minimal Markdown for replies: escape first, then code, bold, italics, links and bullets. Nothing else renders.
function md(text) {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = String(text).split(/```(?:[\w+-]*)\n?([\s\S]*?)```/g);
  return parts.map((part, i) => {
    if (i % 2) return `<pre class="code">${esc(part)}</pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => `<a href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .replace(/^[-*] (.*)$/gm, "• $1");
  }).join("");
}
function rich(text) { const span = document.createElement("span"); span.innerHTML = md(text); return span; }

const time = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };

// ---- login --------------------------------------------------------------------------------------------------
function showLogin(error = "") {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-error").textContent = error;
  $("#key").focus();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  store.key = $("#key").value.trim();
  try {
    await api("/carl/status");
    $("#login").hidden = true;
    start();
  } catch (err) {
    if (!(err instanceof ApiError && err.message === "unauthorized")) $("#login-error").textContent = err.message;
  }
});

// ---- navigation ---------------------------------------------------------------------------------------------
const loaders = { chat: loadChat, schedules: loadSchedules, psyche: loadPsyche, status: loadStatus };
function show(view) {
  for (const b of document.querySelectorAll(".rail button")) b.toggleAttribute("aria-current", b.dataset.view === view) || b.removeAttribute("aria-current");
  for (const b of document.querySelectorAll(".rail button")) if (b.dataset.view === view) b.setAttribute("aria-current", "page");
  for (const s of document.querySelectorAll(".view")) s.hidden = s.id !== `view-${view}`;
  loaders[view]?.().catch(report);
}
for (const b of document.querySelectorAll(".rail button")) b.addEventListener("click", () => show(b.dataset.view));
function report(err) { if (!(err instanceof ApiError && err.message === "unauthorized")) console.error(err); }

// ---- chat ---------------------------------------------------------------------------------------------------
let streaming = false;

async function loadChat() {
  const { data } = await api("/carl/conversations");
  const list = $("#conversation-list");
  list.replaceChildren(...data.map((c) => el("li", {}, el("button", { "aria-current": c.key === store.conversation ? "true" : null, onclick: () => openConversation(c.key) }, c.key, el("small", {}, c.busy ? "working" : time(c.updatedAt))))));
  await openConversation(store.conversation, false);
}

async function openConversation(key, reloadList = true) {
  store.conversation = key;
  $("#thread-title").textContent = key;
  for (const b of document.querySelectorAll("#conversation-list button")) b.setAttribute("aria-current", b.firstChild.textContent === key ? "true" : "false");
  const { data } = await api(`/carl/conversations/${encodeURIComponent(key)}/messages?limit=200`);
  $("#messages").replaceChildren(...data.map(line));
  scrollDown();
  if (reloadList) void 0;
}

function line(m) {
  if (m.role === "tool") return el("li", { class: "tool" }, `⚙ ${m.tool} ${m.text}`);
  return el("li", { class: m.role }, m.role === "assistant" ? rich(m.text) : m.text, m.model && m.role === "assistant" ? el("span", { class: "meta" }, `${m.model.split("/").pop()} · ${time(m.at)}`) : null);
}
function scrollDown() { const box = $("#messages"); box.scrollTop = box.scrollHeight; }

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#input").value.trim();
  if (!text || streaming) return;
  $("#input").value = "";
  $("#messages").append(el("li", { class: "user" }, text));
  const reply = el("li", { class: "assistant" }, "…");
  $("#messages").append(reply);
  scrollDown();
  streaming = true;
  $("#send").disabled = true;
  $("#stop").hidden = false;
  try {
    const res = await fetch(`/carl/conversations/${encodeURIComponent(store.conversation)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${store.key}`, "content-type": "application/json" }, body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new ApiError((await res.json().catch(() => ({})))?.error?.message || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = frame.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? "{}");
        if (event === "text") reply.textContent = data.text;
        else if (event === "tool") reply.before(el("li", { class: "tool" }, `⚙ ${data.name} ${data.detail}`));
        else if (event === "done") {
          if (data.steered) reply.textContent = "(added to the running reply)";
          else if (!data.ok) reply.replaceChildren(rich(`${data.text ? data.text + "\n\n" : ""}${data.aborted ? "Stopped." : `Run failed: ${data.error}`}`));
          else reply.replaceChildren(rich(data.text || "Done."));
          reply.append(el("span", { class: "meta" }, `${data.model.split("/").pop()} · ${(data.ms / 1000).toFixed(1)} s`));
        }
        scrollDown();
      }
    }
  } catch (err) {
    reply.textContent = `Could not send: ${err.message}`;
  } finally {
    streaming = false;
    $("#send").disabled = false;
    $("#stop").hidden = true;
  }
});
$("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#stop").addEventListener("click", () => api(`/carl/conversations/${encodeURIComponent(store.conversation)}/stop`, { method: "POST" }).catch(report));
$("#thread-reset").addEventListener("click", async () => {
  await api(`/carl/conversations/${encodeURIComponent(store.conversation)}/new`, { method: "POST" });
  $("#messages").replaceChildren();
});
$("#new-conversation").addEventListener("click", () => {
  const key = `web:${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  openConversation(key).then(loadChat).catch(report);
});

// ---- schedules ----------------------------------------------------------------------------------------------
async function loadSchedules() {
  const { data } = await api("/carl/schedules");
  const act = (id, action) => api(`/carl/schedules/${id}/${action}`, { method: "POST" }).then(loadSchedules).catch(report);
  $("#schedule-rows").replaceChildren(...data.map((j) => el("tr", {},
    el("td", {}, j.name),
    el("td", {}, j.when),
    el("td", {}, j.prompt ? "agent" : j.command ? "command" : "built-in"),
    el("td", {}, j.enabled && j.nextRunAt ? time(new Date(j.nextRunAt).toISOString()) : "paused"),
    el("td", {}, j.lastStatus ? `${j.lastStatus}${j.lastError ? `: ${j.lastError}` : ""}` : ""),
    el("td", {},
      el("button", { class: "quiet", onclick: () => act(j.id, "run") }, "Run"),
      el("button", { class: "quiet", onclick: () => act(j.id, j.enabled ? "pause" : "resume") }, j.enabled ? "Pause" : "Resume"),
      j.builtin ? null : el("button", { class: "quiet", onclick: () => act(j.id, "remove") }, "Remove")),
  )));
}
$("#schedule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/carl/schedules", { method: "POST", body: Object.fromEntries(form) });
    e.target.reset();
    $("#schedule-error").textContent = "";
    await loadSchedules();
  } catch (err) {
    $("#schedule-error").textContent = err.message;
  }
});

// ---- psyche -------------------------------------------------------------------------------------------------
async function loadPsyche() {
  const p = await api("/carl/psyche");
  $("#self").value = p.self;
  $("#persona").value = p.persona;
  $("#lessons").textContent = p.lessons || "None yet.";
  $("#lessons-when").textContent = p.lastIndividuation ? `updated ${time(p.lastIndividuation)}` : "";
  const none = () => el("li", { class: "none" }, "None");
  $("#shadow").replaceChildren(...(p.shadow.length ? p.shadow.map((s) => el("li", {}, s.summary, el("small", {}, `${s.kind} · ${time(s.at)}`))) : [none()]));
  $("#decisions").replaceChildren(...(p.decisions.length ? p.decisions.map((d) => el("li", {}, d.decision, el("small", {}, `${time(d.at)}${d.outcome ? ` · outcome: ${d.outcome}` : " · outcome open"}`))) : [none()]));
}
for (const b of document.querySelectorAll("[data-save]")) {
  b.addEventListener("click", async () => {
    const which = b.dataset.save;
    try {
      const r = await api(`/carl/psyche/${which}`, { method: "PUT", body: { text: $(`#${which}`).value } });
      $("#psyche-note").textContent = r.note;
    } catch (err) {
      $("#psyche-note").textContent = err.message;
    }
  });
}
$("#reflect").addEventListener("click", async () => {
  $("#reflect").disabled = true;
  try {
    const r = await api("/carl/reflect", { method: "POST" });
    $("#reflect-report").hidden = false;
    $("#reflect-report").textContent = r.report || "Nothing to flag.";
    $("#lessons").textContent = r.lessons || "";
  } catch (err) {
    $("#reflect-report").hidden = false;
    $("#reflect-report").textContent = err.message;
  } finally {
    $("#reflect").disabled = false;
  }
});

// ---- status -------------------------------------------------------------------------------------------------
async function loadStatus() {
  const [s, logs] = await Promise.all([api("/carl/status"), api("/carl/logs?lines=120")]);
  const facts = [
    ["Version", s.version], ["Model", s.primary], ["Fallbacks", s.fallbacks.join(", ") || "none"],
    ["At its limit", Object.entries(s.limits).map(([m, until]) => `${m} until ${time(until)}`).join("; ") || "none"],
    ["Telegram", `${s.telegram.state}${s.telegram.error ? ` (${s.telegram.error})` : ""}`], ["API", `${s.api.state} :${s.api.port}`],
    ["Runs active", s.activeRuns], ["Conversations open", s.conversations], ["Schedules", s.schedules], ["Lessons", s.lessons], ["Started", time(s.startedAt)],
  ];
  $("#status-list").replaceChildren(...facts.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, String(v))]));
  $("#log").replaceChildren(...logs.data.reverse().map((l) => el("li", { class: l.level }, `${(l.at || "").slice(11, 19)} ${l.msg}${l.error ? ` · ${l.error}` : ""}`)));
}

async function refreshRail() {
  try {
    const s = await api("/carl/status");
    $("#rail-status").textContent = `${s.activeRuns ? `${s.activeRuns} running · ` : ""}${s.telegram.state === "off" ? "" : `telegram ${s.telegram.state}`}`;
  } catch {}
}

function start() {
  $("#app").hidden = false;
  show("chat");
  refreshRail();
  setInterval(refreshRail, 15_000);
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (store.key) api("/carl/status").then(start).catch(() => {}); else showLogin();
