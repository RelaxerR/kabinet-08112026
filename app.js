// ====== НАСТРОЙКИ ======
// Перед публикацией поставь false: тогда ?now=... перестанет работать и время нельзя будет подкрутить.
const DEBUG_ENABLED = true;
// =======================

const enc = new TextEncoder();
const dec = new TextDecoder();
const $ = (s) => document.querySelector(s);
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");

const store = {
  get() { try { return JSON.parse(localStorage.getItem("adv_answers") || "{}"); } catch { return {}; } },
  set(id, a) { try { const o = this.get(); o[id] = a; localStorage.setItem("adv_answers", JSON.stringify(o)); } catch {} },
};

// ---------- время ----------
// Берём время с сервера (заголовок Date), чтобы подкрутка часов на устройстве не работала.
let offset = 0;
let debugBase = null;
const bootPerf = performance.now();

async function syncTime() {
  const q = new URLSearchParams(location.search).get("now");
  if (DEBUG_ENABLED && q && !isNaN(Date.parse(q))) { debugBase = Date.parse(q); return; }
  try {
    const t0 = Date.now();
    const r = await fetch(location.pathname + "?t=" + t0, { method: "HEAD", cache: "no-store" });
    const d = r.headers.get("date");
    if (d) offset = Date.parse(d) + (Date.now() - t0) / 2 - Date.now();
  } catch {}
}
const now = () => (debugBase !== null ? debugBase + (performance.now() - bootPerf) : Date.now() + offset);

// ---------- данные и расшифровка ----------
let DATA;
const opened = {}; // id -> расшифрованный контент

async function tryDecrypt(day, answer) {
  const n = norm(answer);
  if (!n) return null;
  const base = await crypto.subtle.importKey("raw", enc.encode(n), "PBKDF2", false, ["deriveKey"]);
  for (const w of day.wraps) {
    try {
      const k = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: b64(w.salt), iterations: DATA.iter, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(w.iv) }, k, b64(w.ct));
      const ck = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(day.iv) }, ck, b64(day.ct));
      return JSON.parse(dec.decode(pt));
    } catch {}
  }
  return null;
}

// ---------- состояния ----------
function state(day) {
  const t = now();
  if (t < Date.parse(day.riddleAt)) return "locked";
  if (opened[day.id]) return t >= Date.parse(day.revealAt) ? "open" : "waiting";
  return "riddle";
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
const dayNum = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", timeZone: "Europe/Moscow" });
const monthName = (iso) => new Date(iso).toLocaleDateString("ru-RU", { month: "long", timeZone: "Europe/Moscow" });
function left(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (x) => String(x).padStart(2, "0");
  return (d ? d + " д " : "") + `${p(h)}:${p(m)}:${p(sec)}`;
}

// ---------- сетка ----------
function renderGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  DATA.days.forEach((day) => {
    const st = state(day);
    const b = document.createElement("button");
    b.className = `card ${st}${day.finale ? " finale" : ""}`;
    b.dataset.id = day.id;
    const icon = { locked: "🔒", riddle: "❓", waiting: "⏳", open: day.finale ? "💝" : "🎁" }[st];
    let text = "";
    if (st === "locked") text = `Откроется в 18:00 МСК<br><span data-cd="${day.riddleAt}"></span>`;
    if (st === "riddle") text = "Загадка уже ждёт тебя ✨";
    if (st === "waiting") text = `Ответ верный! Подарок появится через <span data-cd="${day.revealAt}"></span>`;
    if (st === "open") text = day.giftCount > 1 ? `Подарков: ${day.giftCount} — открыто` : "Подарок открыт";
    b.innerHTML = `<span class="ic">${icon}</span><div><span class="num">${dayNum(day.id + "T12:00:00+03:00")}</span><span class="mon">${monthName(day.id + "T12:00:00+03:00")}</span></div><div class="st">${text}</div>`;
    b.addEventListener("click", () => openDay(day));
    grid.appendChild(b);
  });
}

function tick() {
  const t = now();
  $("#clock").textContent = "Сейчас " + new Date(t).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + " по Москве";
  document.querySelectorAll("[data-cd]").forEach((el) => (el.textContent = left(Date.parse(el.dataset.cd) - t)));

  // перерисовываем сетку, только если у какой-то карточки сменилось состояние
  let changed = false;
  document.querySelectorAll(".card").forEach((c) => {
    const day = DATA.days.find((d) => d.id === c.dataset.id);
    if (!c.classList.contains(state(day))) changed = true;
  });
  if (changed) {
    renderGrid();
    if (dlg.open && currentDay) renderDialog(currentDay);
  }
}

// ---------- диалог ----------
const dlg = $("#dlg");
let currentDay = null;
let hintShown = {};

function openDay(day) {
  const st = state(day);
  if (st === "locked") return;
  currentDay = day;
  renderDialog(day);
  if (!dlg.open) dlg.showModal();
}

function renderDialog(day) {
  const body = $("#dlgBody");
  const st = state(day);
  const head = `<div class="date">${fmtDate(day.riddleAt)}</div>`;

  if (st === "open") {
    const c = opened[day.id];
    body.innerHTML = head + `<h2>${day.finale ? "С днём рождения! 💝" : "Твой подарок"}</h2>` +
      c.gifts.map((g, i) => `<div class="gift" style="animation-delay:${i * 0.15}s"><div class="e">${esc(g.emoji || "🎁")}</div><h3>${esc(g.title)}</h3><p>${esc(g.text)}</p></div>`).join("") +
      (c.finalMessage ? `<div class="final">${esc(c.finalMessage)}</div>` : "");
    if (day.finale && !day.fxShown) { day.fxShown = true; startFinale(); }
    return;
  }

  if (st === "waiting") {
    body.innerHTML = head + `<h2>Верно! 🎉</h2><p class="greet">Подарок появится в 18:30 по Москве.</p>
      <div class="big" data-cd="${day.revealAt}"></div>`;
    return;
  }

  // riddle
  body.innerHTML = head + `<h2>Загадка дня</h2>
    <p class="greet">${esc(day.greeting)}</p>
    <div class="riddle">${esc(day.riddle)}</div>
    <form id="f"><input type="text" id="ans" placeholder="Твой ответ" autocomplete="off" required><button class="btn" id="go">Проверить</button></form>
    <p class="msg" id="msg"></p>
    ${day.hint ? `<div class="hint">${hintShown[day.id] ? esc(day.hint) : `<button type="button" id="hb">Нужна подсказка?</button>`}</div>` : ""}`;
  $("#f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#go"), msg = $("#msg");
    btn.disabled = true; msg.className = "msg"; msg.textContent = "Проверяю…";
    const res = await tryDecrypt(day, $("#ans").value);
    btn.disabled = false;
    if (!res) { msg.className = "msg err"; msg.textContent = "Хм, не то. Подумай ещё 🙂"; return; }
    opened[day.id] = res; store.set(day.id, $("#ans").value);
    renderGrid(); renderDialog(day);
  });
  const hb = $("#hb");
  if (hb) hb.addEventListener("click", () => { hintShown[day.id] = true; renderDialog(day); });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
$("#close").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

// ---------- эффекты: сердечки и конфетти ----------
const cv = $("#fx"), ctx = cv.getContext("2d");
let parts = [], fxRunning = false;
function resize() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; }
addEventListener("resize", resize); resize();

function heart(x, y, s, color, a) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.globalAlpha = a; ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(0, 0.3);
  ctx.bezierCurveTo(-1, -0.5, -0.6, -1.1, 0, -0.6);
  ctx.bezierCurveTo(0.6, -1.1, 1, -0.5, 0, 0.3);
  ctx.fill(); ctx.restore();
}
function spawn(n, burst) {
  const W = cv.width, H = cv.height, colors = ["#ff7ab6", "#ff4d8d", "#ffd36e", "#c26bff", "#fff"];
  for (let i = 0; i < n; i++) {
    parts.push(burst
      ? { x: W / 2, y: H / 2, vx: (Math.random() - 0.5) * 22 * devicePixelRatio, vy: (Math.random() - 0.8) * 22 * devicePixelRatio, g: 0.35 * devicePixelRatio, s: (14 + Math.random() * 26) * devicePixelRatio, c: colors[i % colors.length], life: 1, d: 0.006 + Math.random() * 0.006 }
      : { x: Math.random() * W, y: H + 40, vx: (Math.random() - 0.5) * 1.2 * devicePixelRatio, vy: -(1.5 + Math.random() * 2.5) * devicePixelRatio, g: 0, s: (10 + Math.random() * 22) * devicePixelRatio, c: colors[i % colors.length], life: 1, d: 0.0025 + Math.random() * 0.003 });
  }
}
function loop() {
  ctx.clearRect(0, 0, cv.width, cv.height);
  parts.forEach((p) => { p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life -= p.d; heart(p.x, p.y, p.s, p.c, Math.max(0, p.life)); });
  parts = parts.filter((p) => p.life > 0 && p.y < cv.height + 80 && p.y > -80);
  if (parts.length) requestAnimationFrame(loop); else fxRunning = false;
}
function startFx() { if (!fxRunning) { fxRunning = true; requestAnimationFrame(loop); } }
function startFinale() {
  spawn(90, true); startFx();
  let n = 0;
  const iv = setInterval(() => { spawn(8, false); startFx(); if (++n > 40) clearInterval(iv); }, 350);
}

// ---------- старт ----------
(async function init() {
  await syncTime();
  DATA = await (await fetch("data.json", { cache: "no-store" })).json();
  // восстанавливаем уже решённые дни
  const saved = store.get();
  for (const day of DATA.days) {
    if (saved[day.id] && now() >= Date.parse(day.riddleAt)) {
      const r = await tryDecrypt(day, saved[day.id]);
      if (r) opened[day.id] = r;
    }
  }
  renderGrid(); tick();
  setInterval(tick, 1000);
})();
