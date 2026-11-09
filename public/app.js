'use strict';
/* Attendly front end. Talks to /api/* with a Bearer token. No frameworks. */

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const todayStr = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShort = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const initials = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const HUES = ['#0b8a8f', '#7c6cf2', '#e0663a', '#2a8f5a', '#c2418f', '#3a6fd8', '#b0832a'];
const hueFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
const avatar = (name) => `<span class="avatar" style="background:${hueFor(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
const band = (r, min = 75) => (r === null || r === undefined ? 'none' : r >= min ? 'good' : r >= min - 15 ? 'warn' : 'bad');
const chip = (r, min) => `<span class="chip ${band(r, min)}">${r === null || r === undefined ? 'No data' : r + '%'}</span>`;
const STATUS = [['present', 'Present'], ['late', 'Late'], ['absent', 'Absent'], ['leave', 'Leave']];

const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  classes: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  register: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.5l2.5 2.5 5-5.5"/>',
  reports: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  out: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="3"/><path d="M5 15V6a2 2 0 012-2h9"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const DROP = '<svg class="drop" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#12b7a5"/><stop offset="1" stop-color="#0b8a8f"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#dg)"/><path d="M8 36c8-8 16 8 24 0s16 8 24 0v20H8z" fill="#fff" fill-opacity=".85"/></svg>';

// ---------- state and API ----------
let user = null;
let token = store.get('attendly_token');
let toastTimer = null;

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the server. Check your internet connection.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && token && !path.startsWith('/auth/')) { signOut(true); throw new Error(data.error || 'Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ').');
  return data;
}

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast glass' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2800);
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('attendly_theme', t);
  const m = $('meta[name="theme-color"]');
  if (m) m.content = t === 'dark' ? '#061019' : '#0b8a8f';
  const b = $('#themeBtn');
  if (b) { b.innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); }
}
applyTheme(store.get('attendly_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- the orb: attendance as water level ----------
function orb(pct, label, max) {
  const empty = pct === null || pct === undefined;
  const p = empty ? 0 : Math.max(0, Math.min(100, pct));
  const y = 200 - (p / 100) * 188;           // water surface height inside a 200-unit circle
  const tone = empty ? 'none' : band(pct, max || 75);
  const col = { good: ['#4fe3c0', '#0b8a8f'], warn: ['#ffd27a', '#e58f00'], bad: ['#ff9d92', '#e03e30'], none: ['#cfe8e5', '#9fc9c6'] }[tone];
  const id = 'o' + Math.random().toString(36).slice(2, 7);
  const wave = 'M0 10q25-12 50 0t50 0t50 0t50 0t50 0t50 0t50 0t50 0V230H0z';
  return `<div class="orb ${empty ? 'empty' : ''}" role="img" aria-label="${empty ? 'No attendance recorded yet' : pct + ' percent attendance'}">
    <svg viewBox="0 0 200 200">
      <defs>
        <clipPath id="${id}c"><circle cx="100" cy="100" r="96"/></clipPath>
        <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col[0]}"/><stop offset="1" stop-color="${col[1]}"/></linearGradient>
        <radialGradient id="${id}s" cx=".32" cy=".24" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".35" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      </defs>
      <circle cx="100" cy="100" r="96" fill="var(--glass)" />
      <g clip-path="url(#${id}c)">
        <g class="orb-level" style="transform:translateY(${y}px)">
          <g class="wave-b" opacity=".55"><path d="${wave}" fill="url(#${id}g)" transform="translate(0 -6)"/></g>
          <g class="wave-a"><path d="${wave}" fill="url(#${id}g)"/></g>
        </g>
        <ellipse cx="72" cy="44" rx="46" ry="22" fill="url(#${id}s)" transform="rotate(-24 72 44)"/>
      </g>
      <circle cx="100" cy="100" r="96" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="2"/>
      <circle cx="100" cy="100" r="93" fill="none" stroke="rgba(8,48,58,.12)" stroke-width="1.5"/>
    </svg>
    <div class="orb-num"><b>${empty ? '--' : p + '%'}</b><span>${esc(label)}</span></div>
  </div>`;
}

// ---------- charts ----------
function trendChart(points) {
  const pts = points.filter((p) => p.rate !== null);
  if (pts.length < 2) return `<div class="empty"><p>Mark attendance on two different days to see the trend.</p></div>`;
  const W = 560, H = 190, L = 30, R = 10, T = 12, B = 26;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  let d = `M${x(0)} ${y(pts[0].rate)}`;
  for (let i = 1; i < pts.length; i++) {
    const cx = (x(i - 1) + x(i)) / 2;
    d += ` C${cx} ${y(pts[i - 1].rate)} ${cx} ${y(pts[i].rate)} ${x(i)} ${y(pts[i].rate)}`;
  }
  const area = `${d} L${x(pts.length - 1)} ${H - B} L${x(0)} ${H - B}Z`;
  const grid = [0, 50, 100].map((v) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const labels = pts.map((p, i) => (i % Math.ceil(pts.length / 6) === 0 || i === pts.length - 1) ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmtShort(p.date)}</text>` : '').join('');
  const dots = pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.rate)}" r="4" fill="var(--tide)" stroke="#fff" stroke-width="2"><title>${fmtDate(p.date)}: ${p.rate}%</title></circle>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Attendance rate over the last ${pts.length} recorded days">
    <defs><linearGradient id="ta" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--tide)" stop-opacity=".35"/><stop offset="1" stop-color="var(--tide)" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#ta)"/><path class="draw" d="${d}" fill="none" stroke="var(--tide)" stroke-width="3.5" stroke-linecap="round"/>${dots}${labels}</svg></div>`;
}

function donut(mix) {
  const total = STATUS.reduce((t, [k]) => t + (mix[k] || 0), 0);
  if (!total) return `<div class="empty"><p>No records in the last 30 days.</p></div>`;
  const colors = { present: 'var(--mint)', late: 'var(--sun)', absent: 'var(--coral)', leave: 'var(--lilac)' };
  const r = 52, c = 2 * Math.PI * r;
  let off = 0;
  const arcs = STATUS.map(([k]) => {
    const len = (mix[k] / total) * c;
    const s = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${colors[k]}" stroke-width="18" stroke-dasharray="${Math.max(len - 2, 0)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
    off += len; return mix[k] ? s : '';
  }).join('');
  const legend = STATUS.map(([k, n]) => `<div><span class="dot ${k}"></span>${n}<b>${mix[k]}</b></div>`).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" role="img" aria-label="Attendance mix">${arcs}<text x="70" y="76" text-anchor="middle" style="font:800 22px var(--display);fill:var(--ink)">${total}</text></svg><div class="legend">${legend}</div></div>`;
}

function heatmap(days) {
  const map = Object.fromEntries(days.map((d) => [d.date, d.rate]));
  const cells = [];
  const end = new Date(todayStr() + 'T00:00:00');
  const start = new Date(end); start.setDate(start.getDate() - 69);
  while (start.getDay() !== 0) start.setDate(start.getDate() - 1);
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const v = map[key];
    const bg = v === undefined || v === null ? '' : `background:color-mix(in srgb, var(--tide) ${Math.max(18, v)}%, transparent)`;
    cells.push(`<i style="${bg}" title="${fmtDate(key)}${v == null ? ': no register' : ': ' + v + '%'}"></i>`);
  }
  return `<div class="heat chart" role="img" aria-label="Attendance heat map for the last 10 weeks">${cells.join('')}</div>`;
}

// ---------- modal ----------
function openModal(html, onMount) {
  const root = $('#modal-root');
  const prev = document.activeElement;
  root.innerHTML = `<div class="scrim" data-close-modal><div class="modal glass" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', esc_); prev && prev.focus && prev.focus(); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  $('.scrim', root).addEventListener('mousedown', (e) => { if (e.target.dataset.closeModal !== undefined) close(); });
  $$('[data-cancel]', root).forEach((b) => b.addEventListener('click', close));
  const first = $('input, button.btn', root); first && first.focus();
  onMount && onMount(root, close);
}
function confirmBox(title, text, yes, onYes) {
  openModal(`<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p><div class="actions"><button class="btn soft" data-cancel>Cancel</button><button class="btn danger" id="yes">${esc(yes)}</button></div>`, (root, close) => {
    $('#yes', root).addEventListener('click', async () => { close(); await onYes(); });
  });
}

// ---------- auth screen ----------
function showAuth() {
  user = null;
  $('#app').innerHTML = `
  <main class="auth">
    <section class="auth-hero">
      <div class="brand">${DROP}Attendly</div>
      <h1>Take attendance in under a minute.</h1>
      <p>Teachers run the register. Students watch their percentage rise and fall like water.</p>
      <div class="auth-orb">${orb(86, 'attendance')}<p class="sub">Every class gets a live level. Drop below your teacher's minimum and it turns coral.</p></div>
    </section>
    <section class="auth-card glass" aria-label="Sign in or create an account">
      <div class="tabs" role="tablist">
        <button role="tab" id="tabIn" aria-selected="true">Sign in</button>
        <button role="tab" id="tabUp" aria-selected="false">Create account</button>
      </div>
      <form id="authForm" novalidate>
        <div id="roleBox" class="field hidden">
          <label id="roleLbl">I am a</label>
          <div class="roles" role="radiogroup" aria-labelledby="roleLbl">
            <label class="role"><input type="radio" name="role" value="teacher" checked><span>Teacher</span></label>
            <label class="role"><input type="radio" name="role" value="student"><span>Student</span></label>
          </div>
        </div>
        <div id="nameBox" class="field hidden"><label for="fName">Full name</label><input id="fName" type="text" autocomplete="name" maxlength="60"></div>
        <div class="field"><label for="fEmail">Email</label><input id="fEmail" type="email" autocomplete="email" required></div>
        <div class="field"><label for="fPass">Password</label><input id="fPass" type="password" autocomplete="current-password" required minlength="8"><p class="hint hidden" id="passHint">At least 8 characters.</p></div>
        <p class="error" id="authErr" role="alert"></p>
        <button class="btn wide" id="authBtn" type="submit">Sign in</button>
      </form>
      <p class="auth-foot">Your register is stored securely and only your teacher and you can see it.</p>
    </section>
  </main>`;
  let mode = 'in';
  const set = (m) => {
    mode = m;
    $('#tabIn').setAttribute('aria-selected', m === 'in');
    $('#tabUp').setAttribute('aria-selected', m === 'up');
    $('#roleBox').classList.toggle('hidden', m === 'in');
    $('#nameBox').classList.toggle('hidden', m === 'in');
    $('#passHint').classList.toggle('hidden', m === 'in');
    $('#authBtn').textContent = m === 'in' ? 'Sign in' : 'Create account';
    $('#fPass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
    $('#authErr').textContent = '';
  };
  $('#tabIn').onclick = () => set('in');
  $('#tabUp').onclick = () => set('up');
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#authBtn'), err = $('#authErr');
    err.textContent = '';
    const email = $('#fEmail').value.trim(), password = $('#fPass').value;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true;
    try {
      const body = mode === 'in' ? { email, password } : { email, password, name: $('#fName').value, role: $('input[name="role"]:checked').value };
      const out = await api('POST', mode === 'in' ? '/auth/login' : '/auth/register', body);
      token = out.token; store.set('attendly_token', token); user = out.user;
      startApp();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
}

function signOut(silent) {
  token = null; store.del('attendly_token'); user = null;
  showAuth();
  if (!silent) toast('Signed out.');
}

// ---------- app shell and routing ----------
const NAV = {
  teacher: [['home', 'Home', 'home'], ['classes', 'Classes', 'classes'], ['register', 'Register', 'register'], ['reports', 'Reports', 'reports'], ['settings', 'Settings', 'settings']],
  student: [['home', 'Home', 'home'], ['classes', 'Classes', 'classes'], ['history', 'History', 'history'], ['settings', 'Settings', 'settings']],
};

function startApp() {
  const nav = NAV[user.role];
  $('#app').innerHTML = `
  <div class="shell">
    <header class="topbar glass">
      <div class="brand">${DROP}Attendly</div>
      <div class="top-right">
        <button class="icon-btn" id="themeBtn" type="button"></button>
        <div class="who">${avatar(user.name)}<div><b>${esc(user.name)}</b><small>${user.role === 'teacher' ? 'Teacher' : 'Student'}</small></div></div>
        <button class="icon-btn" id="outBtn" type="button" aria-label="Sign out">${icon('out')}</button>
      </div>
    </header>
    <main id="view" tabindex="-1" aria-live="polite"></main>
  </div>
  <nav class="dock glass" aria-label="Main">
    <div class="dock-liquid" aria-hidden="true"><i class="trail"></i><i class="lead"></i></div>
    ${nav.map(([k, label, ic]) => `<a href="#/${k}" data-nav="${k}">${icon(ic)}<span>${label}</span></a>`).join('')}
  </nav>`;
  applyTheme(document.documentElement.dataset.theme);
  $('#themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#outBtn').onclick = () => signOut();
  if (!location.hash || location.hash === '#/') location.hash = '#/home';
  route();
}

function moveDock() {
  const a = $('.dock a[aria-current="page"]'); if (!a) return;
  const wrap = $('.dock-liquid'), base = wrap.getBoundingClientRect();
  const r = a.getBoundingClientRect();
  const lead = $('.lead', wrap), trail = $('.trail', wrap);
  const x = r.left - base.left;
  lead.style.width = trail.style.width = r.width + 'px';
  lead.style.transform = `translateX(${x}px)`;
  trail.style.transform = `translateX(${x}px)`;
}
window.addEventListener('resize', () => user && moveDock());
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => user && moveDock());

async function route() {
  if (!user) return;
  const [, page = 'home', arg] = location.hash.split('/');
  const pages = NAV[user.role].map((n) => n[0]);
  const cur = pages.includes(page) ? page : 'home';
  $$('.dock a').forEach((a) => (a.dataset.nav === cur ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  requestAnimationFrame(moveDock);
  const view = $('#view');
  view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const fn = (user.role === 'teacher' ? T : S)[cur];
    await fn(view, arg);
  } catch (e) {
    if (!user) return;
    view.innerHTML = `<section class="glass panel empty"><h3>Could not load this page</h3><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></section>`;
    $('#retry').onclick = route;
  }
}
window.addEventListener('hashchange', route);

const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const first = (n) => String(n).split(' ')[0];

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Code copied.'); }
  catch { toast('Copy failed. Select the code and copy it by hand.', true); }
}

// ---------- teacher pages ----------
const T = {};

T.home = async (view) => {
  const d = await api('GET', '/dashboard');
  const min = user.threshold;
  if (!d.classes.length) {
    view.innerHTML = `<div class="page-head"><h1>${greet()}, ${esc(first(user.name))}</h1><p>Start by creating a class. Students join with a code.</p></div>
    <section class="glass panel empty"><h3>No classes yet</h3><p>Create your first class, or load a sample class to see how reports look.</p>
    <div class="actions" style="justify-content:center"><button class="btn" id="mk">Create a class</button><button class="btn soft" id="demo">Load sample class</button></div></section>`;
    $('#mk').onclick = () => newClassModal();
    $('#demo').onclick = loadDemo;
    return;
  }
  const risk = d.atRisk.length;
  view.innerHTML = `
  <div class="page-head"><h1>${greet()}, ${esc(first(user.name))}</h1><p>Last 30 days across all your classes.</p></div>
  <div class="grid home-grid">
    <section class="glass panel orb-wrap"><h2>Overall attendance</h2>${orb(d.totals.rate, 'last 30 days', min)}<p class="sub">Minimum you set: ${min}%</p></section>
    <div class="stack">
      <div class="grid cols-3">
        <div class="glass stat"><b>${d.totals.classes}</b><span>Classes</span></div>
        <div class="glass stat"><b>${d.totals.students}</b><span>Students</span></div>
        <div class="glass stat ${risk ? 'warn' : ''}"><b>${risk}</b><span>Below ${min}%</span></div>
      </div>
      <section class="glass panel"><h2>Trend</h2><p class="sub">Attendance rate on your last registers</p>${trendChart(d.trend)}</section>
    </div>
  </div>
  <div class="grid cols-2" style="margin-top:18px">
    <section class="glass panel"><h2>Needs attention</h2><p class="sub">Students under ${min}% in any class</p>
      ${risk ? `<div class="list">${d.atRisk.map((s) => `<div class="row">${avatar(s.name)}<div class="grow"><b>${esc(s.name)}</b><small>${esc(s.className)} · ${s.absent} absent</small></div>${chip(s.rate, min)}</div>`).join('')}</div>` : `<div class="empty"><p>${d.totals.recordedDays ? 'Everyone is above the minimum.' : 'Nothing to flag until you take attendance.'}</p></div>`}
    </section>
    <div class="stack">
      <section class="glass panel"><h2>Mix</h2><p class="sub">Records in the last 30 days</p><div style="margin-top:12px">${donut(d.mix)}</div></section>
      <section class="glass panel"><h2>Last 10 weeks</h2><p class="sub">Darker means higher attendance</p><div style="margin-top:12px">${heatmap(d.heat)}</div></section>
    </div>
  </div>`;
};

function newClassModal() {
  const emojis = ['📘', '💻', '📐', '🧪', '🌍', '🎨', '⚙️', '📊'];
  openModal(`<h2>New class</h2><p class="sub">Students join with a code that appears after you create it.</p>
    <form id="ncf" style="margin-top:16px">
      <div class="field"><label for="ncName">Class name</label><input id="ncName" type="text" maxlength="60" placeholder="Data Structures" required></div>
      <div class="field"><label for="ncCode">Course code (optional)</label><input id="ncCode" type="text" maxlength="20" placeholder="MCA-102"></div>
      <div class="field"><label id="icl">Icon</label><div class="emoji-pick" role="radiogroup" aria-labelledby="icl">${emojis.map((e, i) => `<label><input type="radio" name="em" value="${e}" ${i === 0 ? 'checked' : ''}><span>${e}</span></label>`).join('')}</div></div>
      <p class="error" id="ncErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn soft" data-cancel>Cancel</button><button class="btn" type="submit">Create class</button></div>
    </form>`, (root, close) => {
    $('#ncf', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/classes', { name: $('#ncName', root).value, code: $('#ncCode', root).value, emoji: $('input[name="em"]:checked', root).value });
        close(); toast('Class created.'); location.hash = '#/classes'; route();
      } catch (ex) { $('#ncErr', root).textContent = ex.message; }
    });
  });
}

async function loadDemo() {
  try { await api('POST', '/demo'); toast('Sample class loaded.'); route(); } catch (e) { toast(e.message, true); }
}

T.classes = async (view) => {
  const { classes } = await api('GET', '/classes');
  const min = user.threshold;
  view.innerHTML = `<div class="page-head row"><div><h1>Your classes</h1><p>Share the join code. Students enter it after they sign up.</p></div>
    <div class="actions"><button class="btn" id="nc">New class</button></div></div>
    ${classes.length ? `<div class="grid cards">${classes.map((c) => `
      <article class="glass class-card">
        <div class="class-top"><div class="class-emoji">${esc(c.emoji || '📘')}</div><div><h3>${esc(c.name)}</h3><p class="sub">${esc(c.code || 'No course code')} · ${c.students} student${c.students === 1 ? '' : 's'}</p></div></div>
        <div class="code-box"><div><small>Join code</small><code>${esc(c.joinCode)}</code></div><button class="icon-btn" data-copy="${esc(c.joinCode)}" aria-label="Copy join code for ${esc(c.name)}">${icon('copy')}</button></div>
        <div><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="sub">Attendance</span>${chip(c.rate, min)}</div><div class="meter ${band(c.rate, min)}"><i style="width:${c.rate || 0}%"></i></div></div>
        <div class="actions"><a class="btn small" href="#/register/${c.id}">Take attendance</a><a class="btn small soft" href="#/reports/${c.id}">Report</a><button class="btn small soft" data-del="${c.id}" data-name="${esc(c.name)}">Delete</button></div>
      </article>`).join('')}</div>` : `<section class="glass panel empty"><h3>No classes yet</h3><p>Create one to get a join code for your students.</p><button class="btn" id="nc2">Create a class</button></section>`}`;
  $('#nc').onclick = newClassModal;
  const nc2 = $('#nc2'); if (nc2) nc2.onclick = newClassModal;
  $$('[data-copy]', view).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  $$('[data-del]', view).forEach((b) => (b.onclick = () => confirmBox('Delete ' + b.dataset.name + '?', 'This removes the class and all of its attendance records. It cannot be undone.', 'Delete class', async () => {
    try { await api('DELETE', '/classes/' + b.dataset.del); toast('Class deleted.'); route(); } catch (e) { toast(e.message, true); }
  })));
};

T.register = async (view, arg) => {
  const { classes } = await api('GET', '/classes');
  if (!classes.length) {
    view.innerHTML = `<div class="page-head"><h1>Register</h1></div><section class="glass panel empty"><h3>Create a class first</h3><p>You need a class with students before you can take attendance.</p><a class="btn" href="#/classes">Go to classes</a></section>`;
    return;
  }
  let classId = arg && classes.some((c) => c.id === arg) ? arg : store.get('attendly_class');
  if (!classes.some((c) => c.id === classId)) classId = classes[0].id;
  store.set('attendly_class', classId);
  let date = todayStr();
  let marks = {};
  let students = [];

  const draw = () => {
    const q = ($('#q') && $('#q').value || '').toLowerCase();
    const counts = Object.fromEntries(STATUS.map(([k]) => [k, 0]));
    students.forEach((s) => marks[s.id] && counts[marks[s.id]]++);
    const unmarked = students.filter((s) => !marks[s.id]).length;
    const rows = students.filter((s) => s.name.toLowerCase().includes(q)).map((s) => `
      <div class="reg-row"><div class="row" style="padding:0;background:none">${avatar(s.name)}<div class="grow"><b>${esc(s.name)}</b><small>Overall ${s.rate === null ? 'no data' : s.rate + '%'}</small></div></div>
      <div class="seg" role="radiogroup" aria-label="Attendance for ${esc(s.name)}">${STATUS.map(([k, n]) => `<label class="s-${k}"><input type="radio" name="st-${s.id}" value="${k}" data-sid="${s.id}" ${marks[s.id] === k ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div></div>`).join('');
    $('#roster').innerHTML = students.length
      ? `<div class="list" style="margin-top:0">${rows || '<div class="empty"><p>No student matches that search.</p></div>'}</div>`
      : `<div class="glass panel empty"><h3>No students in this class yet</h3><p>Ask students to sign up and enter the join code <b>${esc(cls().joinCode)}</b>.</p></div>`;
    $('#tally').innerHTML = STATUS.map(([k, n]) => `<span><span class="dot ${k}"></span>${n} ${counts[k]}</span>`).join('') + (unmarked ? `<span class="sub">${unmarked} not marked</span>` : '');
    $('#save').disabled = !students.length;
    $('#allP').disabled = !students.length;
  };
  const cls = () => classes.find((c) => c.id === classId);

  const load = async () => {
    $('#roster').innerHTML = '<div class="loading">Loading…</div>';
    const r = await api('GET', `/classes/${classId}/roster?date=${date}`);
    students = r.students; marks = {};
    students.forEach((s) => { if (s.status) marks[s.id] = s.status; });
    draw();
  };

  view.innerHTML = `<div class="page-head"><h1>Register</h1><p>Mark each student, then save. Saving again for the same day updates it.</p></div>
  <section class="glass toolbar no-print">
    <div class="field"><label for="selC">Class</label><select id="selC">${classes.map((c) => `<option value="${c.id}" ${c.id === classId ? 'selected' : ''}>${esc(c.emoji || '')} ${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="selD">Date</label><input id="selD" type="date" value="${date}" max="${todayStr()}"></div>
    <div class="field"><label for="q">Find a student</label><input id="q" type="search" placeholder="Name"></div>
    <button class="btn soft" id="allP" type="button">Mark all present</button>
  </section>
  <div id="roster"></div>
  <div class="glass savebar no-print"><div class="tally" id="tally"></div><button class="btn" id="save" type="button">Save register</button></div>`;

  $('#selC').onchange = (e) => { classId = e.target.value; store.set('attendly_class', classId); history.replaceState(null, '', '#/register/' + classId); load().catch((x) => toast(x.message, true)); };
  $('#selD').onchange = (e) => { if (e.target.value) { date = e.target.value; load().catch((x) => toast(x.message, true)); } };
  $('#q').oninput = draw;
  $('#allP').onclick = () => { students.forEach((s) => (marks[s.id] = 'present')); draw(); };
  $('#roster').addEventListener('change', (e) => { if (e.target.dataset.sid) { marks[e.target.dataset.sid] = e.target.value; draw(); } });
  $('#save').onclick = async () => {
    const records = students.filter((s) => marks[s.id]).map((s) => ({ studentId: s.id, status: marks[s.id] }));
    if (!records.length) { toast('Mark at least one student first.', true); return; }
    const btn = $('#save'); btn.disabled = true;
    try {
      const out = await api('PUT', `/classes/${classId}/attendance`, { date, records });
      toast(`Saved ${out.saved} record${out.saved === 1 ? '' : 's'} for ${fmtDate(date)}.`);
      await load();
    } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  };
  await load();
};

T.reports = async (view, arg) => {
  const { classes } = await api('GET', '/classes');
  if (!classes.length) { view.innerHTML = `<div class="page-head"><h1>Reports</h1></div><section class="glass panel empty"><h3>No classes yet</h3><p>Reports appear once you have a class with attendance.</p><a class="btn" href="#/classes">Go to classes</a></section>`; return; }
  const classId = arg && classes.some((c) => c.id === arg) ? arg : (classes.some((c) => c.id === store.get('attendly_class')) ? store.get('attendly_class') : classes[0].id);
  const r = await api('GET', '/reports/' + classId);
  view.innerHTML = `<div class="page-head row"><div><h1>Reports</h1><p>${r.days} register day${r.days === 1 ? '' : 's'} recorded. Late counts as attended. Leave is excused.</p></div>
    <div class="actions no-print"><button class="btn soft" id="csv">Download CSV</button><button class="btn soft" id="prt">Print</button></div></div>
    <section class="glass toolbar no-print"><div class="field"><label for="rc">Class</label><select id="rc">${classes.map((c) => `<option value="${c.id}" ${c.id === classId ? 'selected' : ''}>${esc(c.emoji || '')} ${esc(c.name)}</option>`).join('')}</select></div></section>
    <section class="glass panel"><h2>${esc(r.class.name)}</h2><p class="sub">Highlighted when below ${r.threshold}%</p>
    ${r.rows.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Student</th><th class="n">Present</th><th class="n">Late</th><th class="n">Absent</th><th class="n">Leave</th><th class="n">Rate</th></tr></thead><tbody>
      ${r.rows.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="sub">${esc(s.email.endsWith('@demo.attendly') ? 'sample student' : s.email)}</span></td><td class="n">${s.present}</td><td class="n">${s.late}</td><td class="n">${s.absent}</td><td class="n">${s.leave}</td><td class="n">${chip(s.rate, r.threshold)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><p>No students have joined this class yet.</p></div>`}</section>`;
  $('#rc').onchange = (e) => { store.set('attendly_class', e.target.value); location.hash = '#/reports/' + e.target.value; };
  $('#prt').onclick = () => window.print();
  $('#csv').onclick = () => {
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [['Student', 'Email', 'Present', 'Late', 'Absent', 'Leave', 'Rate %'].map(q).join(',')]
      .concat(r.rows.map((s) => [s.name, s.email, s.present, s.late, s.absent, s.leave, s.rate === null ? '' : s.rate].map(q).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `${r.class.name.replace(/[^\w-]+/g, '_')}-attendance-${todayStr()}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };
};

// ---------- settings (both roles) ----------
async function settingsPage(view) {
  const teacher = user.role === 'teacher';
  view.innerHTML = `<div class="page-head"><h1>Settings</h1><p>${esc(user.email)}</p></div>
  <div class="grid cols-2">
    <section class="glass panel"><h2>Profile</h2>
      <form id="pf" style="margin-top:14px">
        <div class="field"><label for="sName">Full name</label><input id="sName" type="text" maxlength="60" value="${esc(user.name)}"></div>
        ${teacher ? `<div class="field"><label for="sMin">Minimum attendance: <b id="minVal">${user.threshold}%</b></label><input id="sMin" type="range" min="40" max="100" step="5" value="${user.threshold}"><p class="hint">Students below this show up under Needs attention.</p></div>` : ''}
        <p class="error" id="pfErr" role="alert"></p>
        <button class="btn" type="submit">Save changes</button>
      </form></section>
    <div class="stack">
      <section class="glass panel"><h2>Appearance</h2><p class="sub">Light and dark both follow the water.</p><div class="actions" style="margin-top:12px"><button class="btn soft" id="th">Switch theme</button></div></section>
      ${teacher ? `<section class="glass panel"><h2>Sample class</h2><p class="sub">Adds 12 fictional students with five weeks of attendance. Good for a demo. Delete it from Classes when you are done.</p><div class="actions" style="margin-top:12px"><button class="btn soft" id="dm">Load sample class</button></div></section>` : ''}
      <section class="glass panel"><h2>Session</h2><div class="actions" style="margin-top:12px"><button class="btn soft" id="so">Sign out</button></div></section>
    </div>
  </div>`;
  const m = $('#sMin'); if (m) m.oninput = () => ($('#minVal').textContent = m.value + '%');
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const out = await api('PATCH', '/me', { name: $('#sName').value, ...(m ? { threshold: Number(m.value) } : {}) });
      user = out.user; toast('Saved.');
      $('.who b').textContent = user.name;
    } catch (ex) { $('#pfErr').textContent = ex.message; }
  };
  $('#th').onclick = () => $('#themeBtn').click();
  $('#so').onclick = () => signOut();
  const dm = $('#dm'); if (dm) dm.onclick = loadDemo;
}
T.settings = settingsPage;

// ---------- student pages ----------
const S = {};

S.home = async (view) => {
  const d = await api('GET', '/student/summary');
  const low = d.classes.filter((c) => c.stats.rate !== null && c.stats.rate < c.threshold);
  view.innerHTML = `<div class="page-head"><h1>${greet()}, ${esc(first(user.name))}</h1><p>${d.classes.length ? 'Your attendance across every class.' : 'Join your first class with the code your teacher gave you.'}</p></div>
  <div class="grid home-grid">
    <section class="glass panel orb-wrap"><h2>Overall attendance</h2>${orb(d.overall.rate, 'all classes', Math.min(...d.classes.map((c) => c.threshold), 75))}
      <p class="sub">${d.overall.present + d.overall.late} attended · ${d.overall.absent} missed · ${d.overall.leave} on leave</p></section>
    <div class="stack">
      ${low.length ? `<section class="glass panel"><h2>Watch these</h2><p class="sub">Below the minimum your teacher set</p><div class="list">${low.map((c) => `<div class="row"><div class="class-emoji" style="width:40px;height:40px;font-size:1.2rem">${esc(c.emoji || '📘')}</div><div class="grow"><b>${esc(c.name)}</b><small>Minimum ${c.threshold}% · ${esc(c.teacher)}</small></div>${chip(c.stats.rate, c.threshold)}</div>`).join('')}</div></section>` : ''}
      <section class="glass panel"><h2>Join a class</h2><p class="sub">Enter the 6-character code from your teacher.</p>
        <form id="jf" style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap"><input id="jc" type="text" maxlength="12" placeholder="e.g. K7M2QX" autocomplete="off" aria-label="Join code" style="flex:1;min-width:140px;text-transform:uppercase;letter-spacing:.14em;font-weight:700"><button class="btn" type="submit">Join class</button></form>
        <p class="error" id="jErr" style="margin:10px 0 0" role="alert"></p></section>
      ${d.classes.length ? `<section class="glass panel"><h2>Your classes</h2><div class="list">${d.classes.map((c) => `<div class="row"><div class="class-emoji" style="width:40px;height:40px;font-size:1.2rem">${esc(c.emoji || '📘')}</div><div class="grow"><b>${esc(c.name)}</b><small>${esc(c.teacher)}</small><div class="meter ${band(c.stats.rate, c.threshold)}" style="margin-top:6px"><i style="width:${c.stats.rate || 0}%"></i></div></div>${chip(c.stats.rate, c.threshold)}</div>`).join('')}</div></section>` : ''}
    </div>
  </div>`;
  $('#jf').onsubmit = async (e) => {
    e.preventDefault();
    try { const o = await api('POST', '/classes/join', { code: $('#jc').value }); toast('Joined ' + o.joined + '.'); route(); }
    catch (ex) { $('#jErr').textContent = ex.message; }
  };
};

S.classes = async (view) => {
  const { classes } = await api('GET', '/classes');
  view.innerHTML = `<div class="page-head"><h1>Your classes</h1><p>Leaving a class removes its attendance from your view.</p></div>
  ${classes.length ? `<div class="grid cards">${classes.map((c) => `<article class="glass class-card">
    <div class="class-top"><div class="class-emoji">${esc(c.emoji || '📘')}</div><div><h3>${esc(c.name)}</h3><p class="sub">${esc(c.teacher)}${c.code ? ' · ' + esc(c.code) : ''}</p></div></div>
    <div><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="sub">${c.stats.present + c.stats.late} of ${c.stats.present + c.stats.late + c.stats.absent} sessions</span>${chip(c.stats.rate, c.threshold)}</div><div class="meter ${band(c.stats.rate, c.threshold)}"><i style="width:${c.stats.rate || 0}%"></i></div></div>
    <div class="actions"><button class="btn small soft" data-leave="${c.id}" data-name="${esc(c.name)}">Leave class</button></div></article>`).join('')}</div>`
    : `<section class="glass panel empty"><h3>You are not in any class</h3><p>Ask your teacher for a join code, then enter it on Home.</p><a class="btn" href="#/home">Go to Home</a></section>`}`;
  $$('[data-leave]', view).forEach((b) => (b.onclick = () => confirmBox('Leave ' + b.dataset.name + '?', 'You can join again later with the code.', 'Leave class', async () => {
    try { await api('DELETE', `/classes/${b.dataset.leave}/leave`); toast('You left the class.'); route(); } catch (e) { toast(e.message, true); }
  })));
};

S.history = async (view) => {
  const d = await api('GET', '/student/summary');
  let cls = 'all', st = 'all';
  const draw = () => {
    const rows = d.history.filter((h) => (cls === 'all' || h.classId === cls) && (st === 'all' || h.status === st));
    const groups = {};
    rows.forEach((h) => (groups[h.date] = groups[h.date] || []).push(h));
    $('#hist').innerHTML = rows.length
      ? Object.keys(groups).map((date) => `<div class="day-group"><h3>${fmtDate(date)}</h3><div class="list" style="margin-top:0">${groups[date].map((h) => `<div class="row"><div class="class-emoji" style="width:38px;height:38px;font-size:1.1rem">${esc(h.emoji || '📘')}</div><div class="grow"><b>${esc(h.className)}</b></div><span class="chip ${h.status === 'present' ? 'good' : h.status === 'late' ? 'warn' : h.status === 'absent' ? 'bad' : 'none'}">${esc(STATUS.find((s) => s[0] === h.status)[1])}</span></div>`).join('')}</div></div>`).join('')
      : `<div class="empty"><h3>Nothing to show</h3><p>${d.history.length ? 'No records match these filters.' : 'Your teachers have not recorded attendance yet.'}</p></div>`;
  };
  view.innerHTML = `<div class="page-head"><h1>History</h1><p>Every day your teachers recorded.</p></div>
  <section class="glass panel"><div class="toolbar" style="padding:0;margin:0">
    <div class="field"><label for="hc">Class</label><select id="hc"><option value="all">All classes</option>${d.classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div></div>
    <div class="filters" role="group" aria-label="Filter by status">${[['all', 'All'], ...STATUS].map(([k, n]) => `<button type="button" data-st="${k}" aria-pressed="${k === 'all'}">${n}</button>`).join('')}</div>
    <div id="hist"></div></section>`;
  $('#hc').onchange = (e) => { cls = e.target.value; draw(); };
  $$('[data-st]', view).forEach((b) => (b.onclick = () => { st = b.dataset.st; $$('[data-st]', view).forEach((x) => x.setAttribute('aria-pressed', x === b)); draw(); }));
  draw();
};
S.settings = settingsPage;

// ---------- boot ----------
(async function boot() {
  if (!token) return showAuth();
  try { user = (await api('GET', '/me')).user; startApp(); }
  catch { if (!token) return; showAuth(); }
})();
