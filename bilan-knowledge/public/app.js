"use strict";

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "bilan.adminToken";
let token = null;
let pollTimer = null;
let selectedRun = null;

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(v) {
  try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
  });
  if (res.status === 401) {
    signOut("That token was not accepted.");
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmtDate(d) {
  if (!d) return "–";
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function relative(d) {
  if (!d) return "";
  const diff = new Date(d).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units = [["day", 86400e3], ["hour", 3600e3], ["minute", 60e3]];
  for (const [u, ms] of units) {
    if (abs >= ms || u === "minute") {
      const n = Math.max(1, Math.round(abs / ms));
      return diff < 0 ? `${n} ${u}${n > 1 ? "s" : ""} ago` : `in ${n} ${u}${n > 1 ? "s" : ""}`;
    }
  }
  return "";
}
function duration(a, b) {
  if (!a || !b) return "–";
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}
const badge = (status) => `<span class="badge s-${esc(status)}">${esc(status)}</span>`;
const plat = (p) => `<span class="p-${esc(p)}">${p === "meta" ? "Meta" : "TikTok"}</span>`;
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

/** Minimal, safe Markdown: text is escaped first; only https links are rendered. */
function md(src) {
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  let list = false;
  for (const line of String(src).split("\n")) {
    const l = line.trimEnd();
    const li = /^\s*[-*•] (.*)/.exec(l);
    if (li) {
      if (!list) { out.push("<ul>"); list = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) { out.push("</ul>"); list = false; }
    const h = /^(#{1,3}) (.*)/.exec(l);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (l.startsWith(">")) out.push(`<blockquote>${inline(l.replace(/^>\s?/, ""))}</blockquote>`);
    else if (l) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push("</ul>");
  return `<div class="md">${out.join("")}</div>`;
}

// ---------- Status ----------
async function loadStatus() {
  const s = await api("/api/status");
  $("#interval").textContent = s.limits.refreshIntervalDays;
  const sch = s.schedule;
  const banners = [];

  if (!s.researchConfigured) {
    banners.push(`<div class="banner bad"><strong>Research is not configured.</strong> Set ANTHROPIC_API_KEY on the server; no refreshes can run until then.</div>`);
  }
  if (s.automation.active) {
    banners.push(`<div class="banner ok"><strong>Automatic updates are active.</strong> The deployed scheduler checked in ${esc(relative(s.automation.schedulerLastSeenAt))} and a scheduler-started refresh has completed successfully.</div>`);
  } else {
    banners.push(`<div class="banner warn"><strong>Automatic updates are not confirmed active yet.</strong><ul>${s.automation.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`);
  }
  const last = sch.lastRun;
  if (last && (last.status === "failed" || last.status === "incomplete")) {
    banners.push(`<div class="banner bad"><strong>Refresh #${last.id} ${last.status === "failed" ? "failed" : "was incomplete"}</strong> (${esc(fmtDate(last.finished_at))}). The last verified guidance is still in use for anything that could not be checked.<pre>${esc(last.error || "")}</pre></div>`);
  }
  if (sch.retriesExhausted) banners.push(`<div class="banner bad">${esc(sch.note)}</div>`);
  $("#banners").innerHTML = banners.join("");

  $("#last-success").textContent = sch.lastSuccessAt ? fmtDate(sch.lastSuccessAt) : "Never";
  $("#last-success-sub").textContent = sch.lastSuccessAt ? `${relative(sch.lastSuccessAt)} · refresh #${sch.lastSuccessRunId}` : "No complete refresh yet";

  const next = sch.nextAttemptAt || sch.nextScheduledAt;
  $("#next-refresh").textContent = sch.activeRun ? "In progress" : next ? fmtDate(next) : "Not scheduled";
  $("#next-refresh-sub").textContent = sch.activeRun ? `Refresh #${sch.activeRun.id} is ${sch.activeRun.status}` : `${next ? relative(next) + " · " : ""}${sch.note}`;

  if (last) {
    $("#latest-run").innerHTML = `#${last.id} ${badge(last.status)}`;
    $("#latest-run-sub").textContent = `${last.trigger} · ${last.sources_checked}/${last.sources_total} sources checked · ${last.sources_failed} failed`;
  } else {
    $("#latest-run").textContent = "None yet";
    $("#latest-run-sub").textContent = "";
  }
  $("#spend").textContent = usd(s.spend.monthUsd);
  $("#spend-sub").textContent = `Limit ${usd(s.limits.maxUsdPerMonth)}/month · ${usd(s.limits.maxUsdPerRefresh)}/refresh · model ${s.limits.researchModel}`;

  const btn = $("#update-now");
  btn.disabled = !s.researchConfigured || Boolean(sch.activeRun);
  btn.textContent = sch.activeRun ? `Refresh #${sch.activeRun.id} ${sch.activeRun.status}…` : "Update now";

  $("#limits").innerHTML = Object.entries(s.limits).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  schedulePoll(sch.activeRun ? 5000 : 60000);
}

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshAll, ms);
}

// ---------- History ----------
async function loadRuns() {
  const { runs } = await api("/api/runs?limit=100");
  $("#runs tbody").innerHTML =
    runs.map((r) => `<tr class="clickable${r.id === selectedRun ? " selected" : ""}" data-run="${r.id}">
      <td>${r.id}</td><td>${esc(r.trigger.replace("_", " "))}</td><td>${badge(r.status)}</td>
      <td>${esc(fmtDate(r.started_at || r.created_at))}</td><td>${duration(r.started_at, r.finished_at)}</td>
      <td>${r.sources_checked}/${r.sources_total}</td><td>${r.sources_changed}</td><td>${r.sources_new}</td>
      <td>${r.sources_discontinued}</td><td>${r.sources_failed ? `<strong class="error">${r.sources_failed}</strong>` : 0}</td><td>${usd(r.spend_usd)}</td></tr>`).join("") ||
    `<tr><td colspan="11" class="muted">No refreshes yet.</td></tr>`;
  if (selectedRun) await showRun(selectedRun, false);
}

async function showRun(id, scroll = true) {
  selectedRun = id;
  document.querySelectorAll("#runs tr").forEach((tr) => tr.classList.toggle("selected", Number(tr.dataset.run) === id));
  const d = await api(`/api/runs/${id}`);
  const failed = d.checks.filter((c) => ["failed", "missing", "skipped"].includes(c.outcome));
  const el = $("#run-detail");
  el.hidden = false;
  el.innerHTML = `
    <h2>Refresh #${d.run.id} ${badge(d.run.status)}</h2>
    <p class="muted">${esc(d.run.trigger)} · requested by ${esc(d.run.requested_by || "–")} · started ${esc(fmtDate(d.run.started_at))} · finished ${esc(fmtDate(d.run.finished_at))} · ${d.run.items_added} items added, ${d.run.items_archived} archived</p>
    ${d.run.error ? `<div class="banner bad"><pre>${esc(d.run.error)}</pre></div>` : ""}
    <h3>Sources checked (${d.checks.length}) · failed (${failed.length})</h3>
    <div class="table-wrap"><table><thead><tr><th>Platform</th><th>Outcome</th><th>Source</th><th>Via</th><th>Attempts</th><th>Detail</th></tr></thead><tbody>
      ${d.checks.map((c) => `<tr><td>${plat(c.platform)}</td><td>${badge(c.outcome)}</td><td class="url"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.url)}</a></td><td>${esc(c.fetched_via || "–")}</td><td>${c.attempts}</td><td>${esc(c.error || (c.http_status ? `HTTP ${c.http_status}` : ""))}</td></tr>`).join("")}
    </tbody></table></div>
    ${d.changes.length ? `<h3>Changes (${d.changes.length})</h3><ul>${d.changes.map((c) => `<li>${plat(c.platform)} · <strong>${esc(c.kind)}</strong>: ${esc(c.title)} – ${esc(c.summary)}<br><span class="muted">Relevance to Creative Academy: <strong>${esc(c.relevance)}</strong>${c.relevance_note ? ` – ${esc(c.relevance_note)}` : ""}</span></li>`).join("")}</ul>` : ""}
    ${d.briefing ? `<h3>Briefing</h3>${md(d.briefing.body_markdown)}` : ""}
    <details><summary>Execution log (${d.logs.length})</summary><div class="logs">${d.logs.map((l) => `<div class="l-${esc(l.level)}">${esc(new Date(l.created_at).toISOString().slice(11, 19))} ${esc(l.level)} ${esc(l.message)}</div>`).join("")}</div></details>`;
  if (scroll) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Briefings ----------
async function loadBriefings() {
  const { briefings } = await api("/api/briefings");
  $("#briefings").innerHTML =
    briefings.map((b) => `<article class="panel"><p class="muted">Refresh #${b.run_id} · ${esc(b.trigger)} · ${esc(fmtDate(b.created_at))} ${b.complete ? "" : badge("incomplete")}</p>${md(b.body_markdown)}</article>`).join("") ||
    `<p class="muted">No briefings yet. One is saved after every refresh.</p>`;
}

// ---------- Sources ----------
async function loadSources() {
  const { sources } = await api("/api/sources");
  const byPlatform = { meta: [], tiktok: [] };
  sources.forEach((s) => byPlatform[s.platform].push(s));
  $("#sources").innerHTML = Object.entries(byPlatform).map(([p, list]) => `
    <h2 style="margin-top:1rem">${plat(p)} · ${list.length} sources</h2>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th>Last check</th><th>Last verified</th><th>Items</th><th>Versions</th><th>Monitor</th></tr></thead><tbody>
    ${list.map((s) => `<tr>
      <td class="url"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a><br><span class="muted">${esc(s.category)} · ${esc(s.origin)}${s.status === "discontinued" ? " · " + badge("discontinued") : ""}</span>${s.last_error ? `<br><span class="error">${esc(s.last_error)}</span>` : ""}</td>
      <td>${s.last_check_status ? badge(s.last_check_status) : "–"}<br><span class="muted">${esc(fmtDate(s.last_checked_at))}</span></td>
      <td>${esc(fmtDate(s.last_verified_at))}</td><td>${s.current_items}</td><td>${s.versions}</td>
      <td><input type="checkbox" data-source="${s.id}" ${s.enabled ? "checked" : ""} ${s.status === "discontinued" ? "disabled" : ""} aria-label="Monitor this source" style="width:auto"></td></tr>`).join("")}
    </tbody></table></div>`).join("");
}

// ---------- Ask ----------
async function askQuestion(e) {
  e.preventDefault();
  const out = $("#answer");
  out.innerHTML = `<p class="muted">Retrieving saved knowledge and checking official sources…</p>`;
  try {
    const r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: $("#question").value, platform: $("#ask-platform").value || null }) });
    out.innerHTML = `
      <div class="panel">${r.answer ? md(r.answer) : `<p>${esc(r.note)}</p>`}</div>
      ${r.liveChecks.length ? `<div class="panel"><h3>Live source checks</h3><ul>${r.liveChecks.map((c) => `<li>${badge(c.outcome.replace("skipped_fresh", "recently verified"))} ${esc(c.url)} ${c.error ? `<span class="error">${esc(c.error)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
      <div class="panel"><h3>Saved knowledge used (${r.knowledge.length})</h3><ul>${r.knowledge.map((k) => `<li><strong>[${esc(k.ref)}]</strong> ${plat(k.platform)} · ${esc(k.title)} – <a href="${esc(k.source_url)}" target="_blank" rel="noopener noreferrer">source</a> · verified ${esc(fmtDate(k.verified_at))}</li>`).join("")}</ul>
      <p class="muted">Cost: ${usd(r.spendUsd)} · Recommendations only: nothing is published and no budgets are changed.</p></div>`;
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- Wiring ----------
async function refreshAll() {
  try {
    await loadStatus();
    await loadRuns();
  } catch (err) {
    if (err.message !== "unauthorized") schedulePoll(15000);
  }
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  if (name === "briefings") loadBriefings();
  if (name === "sources") loadSources();
  if (name === "settings") api("/api/settings/campaign-profile").then((r) => ($("#profile").value = r.text));
}

function signOut(message) {
  writeToken(null);
  token = null;
  clearTimeout(pollTimer);
  $("#app").hidden = true;
  $("#sign-out").hidden = true;
  $("#login").hidden = false;
  $("#login-error").hidden = !message;
  $("#login-error").textContent = message || "";
}

function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#sign-out").hidden = false;
  refreshAll();
}

$("#login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("#token").value.trim();
  writeToken(token);
  start();
});
$("#sign-out").addEventListener("click", () => signOut());
$("#update-now").addEventListener("click", async () => {
  const btn = $("#update-now");
  btn.disabled = true;
  try {
    const r = await api("/api/refresh", { method: "POST" });
    btn.textContent = r.message;
  } catch (err) {
    alert(`Could not start refresh: ${err.message}`);
  }
  refreshAll();
});
$("#runs").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-run]");
  if (tr) showRun(Number(tr.dataset.run));
});
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("#sources").addEventListener("change", async (e) => {
  const id = e.target.dataset.source;
  if (!id) return;
  await api(`/api/sources/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) });
});
$("#add-source").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/sources", { method: "POST", body: JSON.stringify({ url: $("#source-url").value }) });
    $("#source-url").value = "";
    loadSources();
  } catch (err) {
    alert(err.message);
  }
});
$("#ask-form").addEventListener("submit", askQuestion);
$("#save-profile").addEventListener("click", async () => {
  await api("/api/settings/campaign-profile", { method: "PUT", body: JSON.stringify({ text: $("#profile").value }) });
  $("#profile-status").textContent = "Saved";
  setTimeout(() => ($("#profile-status").textContent = ""), 2000);
});

token = readToken();
if (token) start();
else signOut();
