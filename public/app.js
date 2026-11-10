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
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShort = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const initials = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const avatar = (name) => `<span class="avatar" aria-hidden="true">${esc(initials(name))}</span>`;
const band = (r, min = 75) => (r === null || r === undefined ? 'none' : r >= min ? 'good' : r >= min - 15 ? 'warn' : 'bad');
const chip = (r, min) => {
  const b = band(r, min);
  if (b === 'none') return '<span class="chip none">No data</span>';
  return b === 'bad' ? `<span class="chip bad"><span>▲ ${r}%</span></span>` : `<span class="chip ${b}">${r}%</span>`;
};
// Four statuses, told apart by symbol and shape, not by colour.
const STATUS = [['present', 'Present'], ['late', 'Late'], ['absent', 'Absent'], ['leave', 'Leave']];
const sym = (k) => `<i class="dot ${k}" aria-hidden="true"></i>`;
const statusChip = (s) => {
  const [, label] = STATUS.find((x) => x[0] === s) || [s, s];
  const cls = s === 'present' ? 'good' : s === 'late' ? 'warn' : s === 'absent' ? 'bad' : 's-leave';
  return s === 'absent' ? `<span class="chip bad"><span>${sym(s)}${label}</span></span>` : `<span class="chip ${cls}">${sym(s)}${label}</span>`;
};
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return (u[0] || '') + '•••' + (u.length > 1 ? u.slice(-1) : '') + '@' + (d || ''); };

const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  classes: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  register: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.5l2.5 2.5 5-5.5"/>',
  reports: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  requests: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 004 0"/>',
  checkin: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v4M15 12v3"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  out: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="4"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  exam: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4M10 12h6M10 16h6"/>',
  award: '<circle cx="12" cy="9" r="5.5"/><path d="M8.5 14l-1.5 7 5-2.5 5 2.5-1.5-7"/>',
  door: '<path d="M5 21V4h10v17M3 21h18"/><circle cx="12" cy="12.5" r="0.8" fill="currentColor"/><path d="M18 9l3 3-3 3M21 12h-7"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c1-4.5 4-6 7.500-6s6.500 1.500 7.500 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="3"/><path d="M5 15V6a2 2 0 012-2h9"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const DROP = '<svg class="drop" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="var(--ink)"/><path d="M8 36c8-8 16 8 24 0s16 8 24 0v20H8z" fill="var(--bg)" fill-opacity=".9"/></svg>';

// ---------- state and API ----------
let user = null;
let token = store.get('attendly_token');

const cache = new Map();
async function api(method, path, body) {
  const cacheable = method === 'GET' && !path.includes('/checkin') && !path.startsWith('/auth');
  if (cacheable) { const h = cache.get(path); if (h && Date.now() - h.t < 20000) return structuredClone(h.d); }
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
  if (!res.ok) { const e = new Error(data.error || 'Request failed (' + res.status + ').'); e.data = data; throw e; }
  if (cacheable) cache.set(path, { t: Date.now(), d: structuredClone(data) }); else if (method !== 'GET') cache.clear();
  return data;
}

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2800);
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('attendly_theme', t);
  const m = $('meta[name="theme-color"]');
  if (m) m.content = t === 'dark' ? '#1A2B3C' : '#F7FAFC';
  const b = $('#themeBtn');
  if (b) { b.innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); }
}
applyTheme(store.get('attendly_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- the orb: attendance as water level ----------
function orb(pct, label, min) {
  const empty = pct === null || pct === undefined;
  const p = empty ? 0 : Math.max(0, Math.min(100, pct));
  const y = 200 - (p / 100) * 188;
  const tone = empty ? 'none' : band(pct, min || 75);
  const id = 'o' + Math.random().toString(36).slice(2, 7);
  const wave = 'M0 10q25-12 50 0t50 0t50 0t50 0t50 0t50 0t50 0t50 0V230H0z';
  const fill = tone === 'bad' ? `url(#${id}h)` : `url(#${id}g)`;
  const top = tone === 'warn' ? 0.5 : 0.78;
  const onWater = tone === 'good' && p >= 52;
  return `<div class="orb ${empty ? 'empty' : ''}" role="img" aria-label="${empty ? 'No attendance recorded yet' : pct + ' percent attendance'}">
    <svg viewBox="0 0 200 200">
      <defs>
        <clipPath id="${id}c"><circle cx="100" cy="100" r="96"/></clipPath>
        <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ink)" stop-opacity="${top}"/><stop offset="1" stop-color="var(--ink)" stop-opacity="${tone === 'warn' ? 0.75 : 1}"/></linearGradient>
        <pattern id="${id}h" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="var(--ink)" fill-opacity=".16"/><rect width="2.4" height="7" fill="var(--ink)"/></pattern>
        <radialGradient id="${id}s" cx=".32" cy=".24" r=".8"><stop offset="0" stop-color="var(--bg)" stop-opacity=".7"/><stop offset=".4" stop-color="var(--bg)" stop-opacity=".12"/><stop offset="1" stop-color="var(--bg)" stop-opacity="0"/></radialGradient>
      </defs>
      <circle cx="100" cy="100" r="96" fill="var(--glass)"/>
      <g clip-path="url(#${id}c)">
        <g class="orb-level" style="transform:translateY(${y}px)">
          <g class="wave-b" opacity=".5"><path d="${wave}" fill="${fill}" transform="translate(0 -6)"/></g>
          <g class="wave-a"><path d="${wave}" fill="${fill}"/></g>
        </g>
        <ellipse cx="72" cy="44" rx="46" ry="22" fill="url(#${id}s)" transform="rotate(-24 72 44)"/>
      </g>
      <circle cx="100" cy="100" r="96" fill="none" stroke="var(--ink)" stroke-width="2"/>
    </svg>
    <div class="orb-num ${onWater ? 'on-water' : ''}"><b>${empty ? '--' : p + '%'}</b><span>${esc(label)}</span></div>
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
  const dots = pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.rate)}" r="4.5" fill="var(--ink)" stroke="var(--bg)" stroke-width="2"><title>${fmtDate(p.date)}: ${p.rate}%</title></circle>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Attendance rate over the last ${pts.length} recorded days">
    <defs><linearGradient id="ta" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ink)" stop-opacity=".22"/><stop offset="1" stop-color="var(--ink)" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#ta)"/><path class="draw" d="${d}" fill="none" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round"/>${dots}${labels}</svg></div>`;
}

function donut(mix) {
  const total = STATUS.reduce((t, [k]) => t + (mix[k] || 0), 0);
  if (!total) return `<div class="empty"><p>No records in the last 30 days.</p></div>`;
  const paint = { present: 'var(--ink)', late: 'color-mix(in srgb, var(--ink) 55%, transparent)', leave: 'color-mix(in srgb, var(--ink) 22%, transparent)', absent: 'url(#hd)' };
  const r = 52, c = 2 * Math.PI * r;
  let off = 0;
  const arcs = STATUS.map(([k]) => {
    const len = (mix[k] / total) * c;
    const s = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${paint[k]}" stroke-width="18" stroke-dasharray="${Math.max(len - 2, 0)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"/>`;
    off += len; return mix[k] ? s : '';
  }).join('');
  const legend = STATUS.map(([k, n]) => `<div><span class="dot ${k}"></span>${n}<b>${mix[k]}</b></div>`).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" role="img" aria-label="Attendance mix"><defs><pattern id="hd" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="currentColor" fill-opacity=".1"/><rect width="2" height="5" fill="currentColor"/></pattern></defs>${arcs}<text x="70" y="76" text-anchor="middle" style="font:800 22px var(--display);fill:var(--ink)">${total}</text></svg><div class="legend">${legend}</div></div>`;
}

function heatmap(days) {
  const map = Object.fromEntries(days.map((d) => [d.date, d.rate]));
  const cells = [];
  const end = todayStr();
  let start = addDays(end, -69);
  while (new Date(start + 'T00:00:00').getDay() !== 0) start = addDays(start, -1);
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const v = map[d];
    const bg = v === undefined || v === null ? '' : `background:color-mix(in srgb, var(--ink) ${Math.max(14, v)}%, transparent)`;
    cells.push(`<i style="${bg}" title="${fmtDate(d)}${v == null ? ': no register' : ': ' + v + '%'}"></i>`);
  }
  return `<div class="heat chart" role="img" aria-label="Attendance heat map for the last 10 weeks">${cells.join('')}</div>`;
}

// What a student can still miss, or must attend, to stay at or above the minimum.
function planner(s, min) {
  const a = s.present + s.late, t = a + s.absent;
  if (!t) return 'No attendance recorded yet.';
  const rate = (a / t) * 100;
  if (rate >= min) {
    const can = Math.floor((a * 100) / min - t + 1e-9);
    return can > 0 ? `You can miss <b>${can}</b> more class${can === 1 ? '' : 'es'} and stay at ${min}%.` : `You are right at ${min}%. Do not miss the next class.`;
  }
  if (min >= 100) return 'Attend every class from now on to recover.';
  const need = Math.ceil((min * t - 100 * a) / (100 - min) - 1e-9);
  return `Attend the next <b>${need}</b> class${need === 1 ? '' : 'es'} in a row to get back to ${min}%.`;
}

// ---------- modal ----------
let modalCleanup = null;
let modalPrev = null;
function closeModal() {
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  $('#modal-root').innerHTML = '';
  document.removeEventListener('keydown', onModalKey);
  if (modalPrev && modalPrev.focus) modalPrev.focus();
}
function onModalKey(e) { if (e.key === 'Escape') closeModal(); }
function openModal(html, onMount) {
  closeModal();
  const root = $('#modal-root');
  modalPrev = document.activeElement;
  root.innerHTML = `<div class="scrim" data-close-modal><div class="modal glass" role="dialog" aria-modal="true">${html}</div></div>`;
  document.addEventListener('keydown', onModalKey);
  $('.scrim', root).addEventListener('mousedown', (e) => { if (e.target.dataset.closeModal !== undefined) closeModal(); });
  $$('[data-cancel]', root).forEach((b) => b.addEventListener('click', closeModal));
  const first = $('input, textarea, select, button.btn', root); first && first.focus();
  onMount && onMount(root, closeModal, (fn) => { modalCleanup = fn; });
}
function confirmBox(title, text, yes, onYes) {
  openModal(`<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p><div class="actions"><button class="btn soft" data-cancel>Cancel</button><button class="btn danger" id="yes">${esc(yes)}</button></div>`, (root, close) => {
    $('#yes', root).addEventListener('click', async () => { close(); await onYes(); });
  });
}

// ---------- password field and strength meter ----------
const strength = (pw) => (pw.length >= 8) + (pw.length >= 12) + (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw)) + /[^A-Za-z0-9]/.test(pw);
const pwField = (id, label, auto, meter) => `<div class="field"><label for="${id}">${label}</label>
  <div class="pw"><input id="${id}" type="password" autocomplete="${auto}" maxlength="100"><button type="button" data-show="${id}" aria-label="Show password">Show</button></div>
  ${meter ? `<div class="strength" id="${id}M" aria-live="polite">${'<i></i>'.repeat(4)}<span></span></div><p class="hint">8+ characters with a letter and a number. Longer is stronger.</p>` : ''}</div>`;
function bindPw(root) {
  $$('[data-show]', root).forEach((b) => (b.onclick = () => {
    const i = $('#' + b.dataset.show, root); const show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show';
  }));
  $$('.strength', root).forEach((m) => {
    const input = $('#' + m.id.slice(0, -1), root);
    input.addEventListener('input', () => {
      const s = strength(input.value);
      $$('i', m).forEach((el, i) => el.classList.toggle('on', i < s));
      $('span', m).textContent = input.value ? ['Weak', 'Weak', 'Okay', 'Good', 'Strong'][s] : '';
    });
  });
}
function pwProblem(pw) {
  if (pw.length < 8) return 'Password needs at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password needs at least one letter and one number.';
  return '';
}

// ---------- auth screens ----------
let authTimer = null;
function showAuth(mode = 'in', data = {}) {
  user = null;
  closeModal();
  if (!$('#authCard')) {
    $('#app').innerHTML = `
    <main class="auth">
      <section class="auth-hero">
        <div class="brand">${DROP}Attendly</div>
        <h1>Your campus, in one place.</h1>
        <p class="lead">Attendance, timetable, exams, results and requests for teachers and students.</p>
        <div class="auth-orb">${orb(86, 'attendance')}<p class="sub">Verified accounts, live attendance and instant updates.</p></div>
      </section>
      <section class="auth-card glass" id="authCard" aria-label="Account"></section>
    </main>`;
  }
  authCard(mode, data);
}

function authCard(mode, d) {
  clearInterval(authTimer);
  const card = $('#authCard');
  const tabs = (m) => `<div class="tabs" role="tablist"><button role="tab" id="tabIn" aria-selected="${m === 'in'}">Sign in</button><button role="tab" id="tabUp" aria-selected="${m === 'up'}">Create account</button></div>`;
  const demo = (code) => (code ? `<p class="demo-note">Your code: <b>${esc(code)}</b></p>` : '');

  if (mode === 'in') {
    card.innerHTML = `${tabs('in')}<form id="f" novalidate>
      <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" value="${esc(d.email || '')}"></div>
      ${pwField('pass', 'Password', 'current-password')}
      <div class="between"><span></span><button type="button" class="link" id="forgot">Forgot password?</button></div>
      <p class="error" id="err" role="alert"></p><button class="btn wide" id="go" type="submit">Sign in</button></form>
      <p class="auth-foot">New here? Create an account. We confirm your email with a code.</p>`;
    $('#tabUp').onclick = () => authCard('up', {});
    $('#forgot').onclick = () => authCard('forgot', { email: $('#email').value.trim() });
    bindPw(card);
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#err'), btn = $('#go'); err.textContent = '';
      const email = $('#email').value.trim(), password = $('#pass').value;
      if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
      btn.disabled = true;
      try { finishLogin(await api('POST', '/auth/login', { email, password })); }
      catch (ex) {
        if (ex.data && ex.data.needsVerify) return authCard('verify', { email: ex.data.email, devOtp: ex.data.devOtp });
        err.textContent = ex.message; btn.disabled = false;
      }
    };
  }

  if (mode === 'up') {
    card.innerHTML = `${tabs('up')}<form id="f" novalidate>
      <div class="field"><label id="rl">I am a</label><div class="roles" role="radiogroup" aria-labelledby="rl">
        <label class="role"><input type="radio" name="role" value="teacher" checked><span>Teacher</span></label>
        <label class="role"><input type="radio" name="role" value="student"><span>Student</span></label></div></div>
      <div class="field"><label for="name">Full name</label><input id="name" type="text" autocomplete="name" maxlength="60"></div>
      <div class="row2">
        <div class="field"><label for="phone">Mobile number</label><input id="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="16" placeholder="98765 43210"></div>
        <div class="field hidden" id="rollBox"><label for="roll">Roll number</label><input id="roll" type="text" maxlength="30" placeholder="Optional"></div>
      </div>
      <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email"><p class="hint">We send a 6-digit code to this address.</p></div>
      ${pwField('pass', 'Password', 'new-password', true)}
      <p class="error" id="err" role="alert"></p><button class="btn wide" id="go" type="submit">Send verification code</button></form>`;
    $('#tabIn').onclick = () => authCard('in', {});
    bindPw(card);
    $$('input[name="role"]', card).forEach((r) => (r.onchange = () => $('#rollBox').classList.toggle('hidden', r.value !== 'student' || !r.checked)));
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#err'), btn = $('#go'); err.textContent = '';
      const body = { role: $('input[name="role"]:checked').value, name: $('#name').value, phone: $('#phone').value, rollNo: $('#roll').value, email: $('#email').value.trim(), password: $('#pass').value };
      if (body.name.trim().length < 2) { err.textContent = 'Enter your full name.'; return; }
      if (!/^\+?\d{10,14}$/.test(body.phone.replace(/[\s\-()]/g, ''))) { err.textContent = 'Enter a valid mobile number, 10 to 14 digits.'; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) { err.textContent = 'Enter a valid email address.'; return; }
      const pp = pwProblem(body.password); if (pp) { err.textContent = pp; return; }
      btn.disabled = true;
      try { const o = await api('POST', '/auth/register', body); authCard('verify', { email: o.email, devOtp: o.devOtp, fresh: true }); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
  }

  if (mode === 'verify') {
    card.innerHTML = `<h2>Check your email</h2><p class="sub">We sent a 6-digit code to <b>${esc(maskEmail(d.email))}</b>. It works for 10 minutes.</p>
      <form id="f" novalidate style="margin-top:18px">${demo(d.devOtp)}
      <div class="field"><label for="code" class="sr-only" style="position:absolute;left:-9999px">Verification code</label><input id="code" class="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></div>
      <p class="error" id="err" role="alert"></p><button class="btn wide" id="go" type="submit">Verify and continue</button>
      <div class="between" style="margin-top:14px"><button type="button" class="link" id="resend" disabled>Send again</button><button type="button" class="link" id="back">Use another email</button></div></form>`;
    $('#code').focus();
    const rs = $('#resend'); let left = 60;
    const tick = () => { rs.disabled = left > 0; rs.textContent = left > 0 ? `Send again in ${left}s` : 'Send again'; left--; };
    tick(); authTimer = setInterval(() => { if (left < -1) clearInterval(authTimer); tick(); }, 1000);
    rs.onclick = async () => {
      try { const o = await api('POST', '/auth/resend', { email: d.email, purpose: 'verify' }); toast('New code sent.'); authCard('verify', { email: d.email, devOtp: o.devOtp }); }
      catch (ex) { toast(ex.message, true); }
    };
    $('#back').onclick = () => authCard('up', {});
    $('#code').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); };
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#err'), btn = $('#go'); err.textContent = '';
      if ($('#code').value.length !== 6) { err.textContent = 'Type the 6-digit code from the email.'; return; }
      btn.disabled = true;
      try { finishLogin(await api('POST', '/auth/verify', { email: d.email, code: $('#code').value })); toast('Email verified. Welcome to Attendly.'); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
  }

  if (mode === 'forgot') {
    card.innerHTML = `<h2>Forgot your password?</h2><p class="sub">Type your email. If an account exists, we send a code to reset it.</p>
      <form id="f" novalidate style="margin-top:18px"><div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" value="${esc(d.email || '')}"></div>
      <p class="error" id="err" role="alert"></p><button class="btn wide" id="go" type="submit">Send reset code</button>
      <div class="between" style="margin-top:14px"><button type="button" class="link" id="back">Back to sign in</button><span></span></div></form>`;
    $('#back').onclick = () => authCard('in', { email: $('#email').value.trim() });
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#err'), btn = $('#go'); err.textContent = '';
      const email = $('#email').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
      btn.disabled = true;
      try { const o = await api('POST', '/auth/forgot', { email }); authCard('reset', { email, devOtp: o.devOtp }); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
  }

  if (mode === 'reset') {
    card.innerHTML = `<h2>Set a new password</h2><p class="sub">If <b>${esc(maskEmail(d.email))}</b> has an account, a code is on its way. Type it with your new password.</p>
      <form id="f" novalidate style="margin-top:18px">${demo(d.devOtp)}
      <div class="field"><label for="code">6-digit code</label><input id="code" class="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></div>
      ${pwField('pass', 'New password', 'new-password', true)}
      <p class="error" id="err" role="alert"></p><button class="btn wide" id="go" type="submit">Change password</button>
      <div class="between" style="margin-top:14px"><button type="button" class="link" id="resend" disabled>Send again</button><button type="button" class="link" id="back">Back to sign in</button></div></form>`;
    bindPw(card);
    const rs = $('#resend'); let left = 60;
    const tick = () => { rs.disabled = left > 0; rs.textContent = left > 0 ? `Send again in ${left}s` : 'Send again'; left--; };
    tick(); authTimer = setInterval(() => { if (left < -1) clearInterval(authTimer); tick(); }, 1000);
    rs.onclick = async () => { try { const o = await api('POST', '/auth/resend', { email: d.email, purpose: 'reset' }); toast('If the account exists, a new code was sent.'); authCard('reset', { email: d.email, devOtp: o.devOtp }); } catch (ex) { toast(ex.message, true); } };
    $('#back').onclick = () => authCard('in', { email: d.email });
    $('#code').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); };
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#err'), btn = $('#go'); err.textContent = '';
      if ($('#code').value.length !== 6) { err.textContent = 'Type the 6-digit code from the email.'; return; }
      const pp = pwProblem($('#pass').value); if (pp) { err.textContent = pp; return; }
      btn.disabled = true;
      try { await api('POST', '/auth/reset', { email: d.email, code: $('#code').value, password: $('#pass').value }); toast('Password changed. Sign in with the new one.'); authCard('in', { email: d.email }); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
  }
}

function finishLogin(out) {
  token = out.token; store.set('attendly_token', token); user = out.user;
  startApp();
}

function signOut(silent) {
  token = null; store.del('attendly_token'); user = null; cache.clear();
  showAuth('in');
  if (!silent) toast('Signed out.');
}

// ---------- app shell and routing ----------
const NAV = {
  teacher: [['home', 'Home', 'home'], ['classes', 'Classes', 'classes'], ['register', 'Register', 'register'], ['requests', 'Requests', 'requests'], ['reports', 'Reports', 'reports'], ['settings', 'Settings', 'settings']],
  student: [['home', 'Home', 'home'], ['classes', 'Classes', 'classes'], ['checkin', 'Check in', 'checkin'], ['history', 'History', 'history'], ['settings', 'Settings', 'settings']],
};

function startApp() {
  clearInterval(authTimer);
  const nav = NAV[user.role];
  $('#app').innerHTML = `
  <div class="shell">
    <header class="topbar glass">
      <div class="brand">${DROP}Attendly</div>
      <div class="top-right">
        <a class="icon-btn" href="#/notifications" aria-label="Notifications">${icon('requests')}</a>
        <button class="icon-btn" id="themeBtn" type="button"></button>
        <a class="who" href="#/settings" aria-label="Profile">${avatar(user.name)}<div><b>${esc(user.name)}</b><small>${user.role === 'teacher' ? 'Teacher' : 'Student'}</small></div></a>
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
  refreshBadge();
}

async function refreshBadge() {
  if (!user || user.role !== 'teacher') return;
  try {
    const { items } = await api('GET', '/leave-requests');
    const n = items.filter((i) => i.status === 'pending').length;
    const a = $('.dock a[data-nav="requests"]'); if (!a) return;
    const old = $('.badge', a); if (old) old.remove();
    if (n) a.insertAdjacentHTML('beforeend', `<span class="badge" aria-label="${n} waiting">${n}</span>`);
  } catch { /* badge is optional */ }
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
  closeModal();
  const [, page = 'home', arg] = location.hash.split('/');
  const pages = NAV[user.role].map((n) => n[0]);
  const own = (user.role === 'teacher' ? T : S)[page];
  const cur = pages.includes(page) || own || P[page] ? page : 'home';
  const dockKey = pages.includes(cur) ? cur : 'home';
  $$('.dock a').forEach((a) => (a.dataset.nav === dockKey ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  requestAnimationFrame(moveDock);
  const view = $('#view');
  view.innerHTML = '<div class="loading"><div class="sk short"></div><div class="sk"></div><div class="sk tall"></div></div>';
  try {
    await (own || P[cur])(view, arg);
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
const classOptions = (classes, sel) => classes.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.emoji || '')} ${esc(c.name)}</option>`).join('');

// ---------- teacher pages ----------
const T = {};

T.home = async (view) => {
  const d = await api('GET', '/dashboard');
  const min = user.threshold;
  if (!d.classes.length) {
    view.innerHTML = `<div class="page-head"><h1>${greet()}, ${esc(first(user.name))}</h1><p>Start by creating a class. Students join with a code.</p></div>${hub()}
    <section class="glass panel empty"><h3>No classes yet</h3><p>Create your first class, or add a practice class to see how reports look.</p>
    <div class="actions" style="justify-content:center"><button class="btn" id="mk">Create a class</button><button class="btn soft" id="demo">Add practice class</button></div></section>`;
    $('#mk').onclick = () => newClassModal();
    $('#demo').onclick = loadDemo;
    return;
  }
  const risk = d.atRisk.length;
  view.innerHTML = `
  <div class="page-head"><h1>${greet()}, ${esc(first(user.name))}</h1><p>Last 30 days across all your classes.</p></div>${hub()}
  <div class="grid home-grid" style="margin-top:18px">
    <section class="glass panel orb-wrap"><h2>Overall attendance</h2>${orb(d.totals.rate, 'last 30 days', min)}<p class="sub">Minimum you set: ${min}%</p></section>
    <div class="stack">
      <div class="grid cols-3">
        <div class="glass stat"><b>${d.totals.classes}</b><span>Classes</span></div>
        <div class="glass stat"><b>${d.totals.students}</b><span>Students</span></div>
        <div class="glass stat ${risk ? 'alert' : ''}"><b>${risk}</b><span>Below ${min}%</span></div>
      </div>
      ${d.pendingRequests ? `<a class="glass stat alert" href="#/requests"><b>${d.pendingRequests}</b><span>Leave request${d.pendingRequests === 1 ? '' : 's'} waiting for you. Open Requests.</span></a>` : ''}
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
      <div class="field"><label for="ncName">Class name</label><input id="ncName" type="text" maxlength="60" placeholder="Data Structures"></div>
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
  try { await api('POST', '/demo'); toast('Practice class added.'); route(); } catch (e) { toast(e.message, true); }
}

function noticeModal(classes, selected) {
  openModal(`<h2>Post a notice</h2><p class="sub">Students in the class see it on their Home page.</p>
    <form id="nf" style="margin-top:16px">
      <div class="field"><label for="nc">Class</label><select id="nc">${classOptions(classes, selected)}</select></div>
      <div class="field"><label for="nb">Notice</label><textarea id="nb" maxlength="500" placeholder="Test on Monday. Bring a calculator."></textarea></div>
      <p class="error" id="nErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn soft" data-cancel>Cancel</button><button class="btn" type="submit">Post notice</button></div></form>`, (root, close) => {
    $('#nf', root).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', `/classes/${$('#nc', root).value}/notices`, { body: $('#nb', root).value }); close(); toast('Notice posted.'); if (location.hash.startsWith('#/requests')) route(); }
      catch (ex) { $('#nErr', root).textContent = ex.message; }
    };
  });
}

// Live check-in code: students type it on their own phone to mark themselves present.
async function checkinModal(cls) {
  const st = await api('GET', `/classes/${cls.id}/checkin`);
  openModal(`<h2>Check-in code</h2><p class="sub">${esc(cls.emoji || '')} ${esc(cls.name)}</p><div id="ck" style="margin-top:14px"></div>`, (root, close, setCleanup) => {
    let timer = null, poll = null;
    const stop = () => { clearInterval(timer); clearInterval(poll); };
    setCleanup(stop);
    const idle = (msg) => {
      stop();
      $('#ck', root).innerHTML = `${msg ? `<p class="sub" style="margin-bottom:12px">${msg}</p>` : '<p class="sub" style="margin-bottom:12px">Show a code on the board. Students enter it in Attendly under Check in and are marked present. The code stops working when time is up.</p>'}
        <div class="field"><label for="mins">Code works for</label><select id="mins"><option value="5">5 minutes</option><option value="10" selected>10 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option></select></div>
        <p class="error" id="ckErr" role="alert"></p>
        <div class="actions"><button class="btn soft" data-cancel>Close</button><button class="btn" id="start">Start check-in</button></div>`;
      $$('[data-cancel]', root).forEach((b) => (b.onclick = close));
      $('#start', root).onclick = async () => {
        try { const a = await api('POST', `/classes/${cls.id}/checkin`, { minutes: Number($('#mins', root).value), date: todayStr() }); live(a, 0); }
        catch (ex) { $('#ckErr', root).textContent = ex.message; }
      };
    };
    const live = (a, present) => {
      stop();
      const left = () => Math.max(0, Math.round((Date.parse(a.expiresAt) - Date.now()) / 1000));
      $('#ck', root).innerHTML = `<div class="big-code" aria-label="Code ${a.code.split('').join(' ')}">${a.code}</div>
        <p class="timer" id="tm"></p><p class="timer" id="pc" style="margin-top:6px"></p>
        <div class="actions" style="margin-top:18px"><button class="btn soft" id="end">Stop now</button><button class="btn" data-cancel>Keep running</button></div>`;
      $$('[data-cancel]', root).forEach((b) => (b.onclick = close));
      const paint = (n) => { $('#pc', root).textContent = `${n} student${n === 1 ? '' : 's'} marked present today`; };
      const tick = () => { const s = left(); $('#tm', root).textContent = s ? `Time left ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Time is up'; if (!s) idle('The code expired.'); };
      paint(present); tick(); timer = setInterval(tick, 1000);
      poll = setInterval(async () => { try { const x = await api('GET', `/classes/${cls.id}/checkin`); if (x.active) paint(x.present); } catch { /* ignore */ } }, 5000);
      $('#end', root).onclick = async () => { try { await api('DELETE', `/classes/${cls.id}/checkin`); idle('Check-in stopped.'); } catch (ex) { toast(ex.message, true); } };
    };
    if (st.active) live(st.active, st.present); else idle('');
  });
}

T.classes = async (view) => {
  const { classes } = await api('GET', '/classes');
  const min = user.threshold;
  view.innerHTML = `<div class="page-head row"><div><h1>Your classes</h1><p>Share the join code. Students enter it after they sign up.</p></div>
    <div class="actions"><button class="btn soft" id="pn" ${classes.length ? '' : 'disabled'}>Post notice</button><button class="btn" id="nc">New class</button></div></div>
    ${classes.length ? `<div class="grid cards">${classes.map((c) => `
      <article class="glass class-card">
        <div class="class-top"><div class="class-emoji">${esc(c.emoji || '📘')}</div><div><h3>${esc(c.name)}</h3><p class="sub">${esc(c.code || 'No course code')} · ${c.students} student${c.students === 1 ? '' : 's'}${c.isDemo ? ' · practice' : ''}</p></div></div>
        <div class="code-box"><div><small>Join code</small><code>${esc(c.joinCode)}</code></div><button class="icon-btn" data-copy="${esc(c.joinCode)}" aria-label="Copy join code for ${esc(c.name)}">${icon('copy')}</button></div>
        <div><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="sub">Attendance</span>${chip(c.rate, min)}</div><div class="meter ${band(c.rate, min)}"><i style="width:${c.rate || 0}%"></i></div></div>
        <div class="actions"><a class="btn small" href="#/register/${c.id}">Take attendance</a><button class="btn small soft" data-ck="${c.id}">Check-in code</button><a class="btn small soft" href="#/reports/${c.id}">Report</a><button class="btn small soft" data-del="${c.id}" data-name="${esc(c.name)}">Delete</button></div>
      </article>`).join('')}</div>` : `<section class="glass panel empty"><h3>No classes yet</h3><p>Create one to get a join code for your students.</p><button class="btn" id="nc2">Create a class</button></section>`}`;
  $('#nc').onclick = newClassModal;
  $('#pn').onclick = () => noticeModal(classes);
  const nc2 = $('#nc2'); if (nc2) nc2.onclick = newClassModal;
  $$('[data-copy]', view).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  $$('[data-ck]', view).forEach((b) => (b.onclick = () => checkinModal(classes.find((c) => c.id === b.dataset.ck)).catch((e) => toast(e.message, true))));
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
  const cls = () => classes.find((c) => c.id === classId);

  const draw = () => {
    const q = ($('#q') && $('#q').value || '').toLowerCase();
    const counts = Object.fromEntries(STATUS.map(([k]) => [k, 0]));
    students.forEach((s) => marks[s.id] && counts[marks[s.id]]++);
    const unmarked = students.filter((s) => !marks[s.id]).length;
    const rows = students.filter((s) => s.name.toLowerCase().includes(q) || (s.rollNo || '').toLowerCase().includes(q)).map((s) => `
      <div class="reg-row"><div class="row" style="padding:0;background:none">${avatar(s.name)}<div class="grow"><b>${esc(s.name)}</b><small>${s.rollNo ? esc(s.rollNo) + ' · ' : ''}Overall ${s.rate === null ? 'no data' : s.rate + '%'}</small></div></div>
      <div class="seg" role="radiogroup" aria-label="Attendance for ${esc(s.name)}">${STATUS.map(([k, n]) => `<label><input type="radio" name="st-${s.id}" value="${k}" data-sid="${s.id}" ${marks[s.id] === k ? 'checked' : ''}><span>${sym(k)}${n}</span></label>`).join('')}</div></div>`).join('');
    $('#roster').innerHTML = students.length
      ? `<div class="list" style="margin-top:0">${rows || '<div class="empty"><p>No student matches that search.</p></div>'}</div>`
      : `<div class="glass panel empty"><h3>No students in this class yet</h3><p>Ask students to sign up and enter the join code <b>${esc(cls().joinCode)}</b>.</p></div>`;
    $('#tally').innerHTML = STATUS.map(([k, n]) => `<span><span class="dot ${k}"></span>${n} ${counts[k]}</span>`).join('') + (unmarked ? `<span class="sub">${unmarked} not marked</span>` : '');
    $('#save').disabled = !students.length;
    $('#allP').disabled = !students.length;
  };
  const load = async () => {
    $('#roster').innerHTML = '<div class="loading">Loading…</div>';
    const r = await api('GET', `/classes/${classId}/roster?date=${date}`);
    students = r.students; marks = {};
    students.forEach((s) => { if (s.status) marks[s.id] = s.status; });
    draw();
  };

  view.innerHTML = `<div class="page-head"><h1>Register</h1><p>Mark each student, then save. Saving again for the same day updates it.</p></div>
  <section class="glass toolbar no-print">
    <div class="field"><label for="selC">Class</label><select id="selC">${classOptions(classes, classId)}</select></div>
    <div class="field"><label for="selD">Date</label><input id="selD" type="date" value="${date}" max="${todayStr()}"></div>
    <div class="field"><label for="q">Find a student</label><input id="q" type="search" placeholder="Name or roll number"></div>
    <button class="btn soft" id="allP" type="button">Mark all present</button>
    <button class="btn soft" id="ck" type="button">Check-in code</button>
  </section>
  <div id="roster"></div>
  <div class="glass savebar no-print"><div class="tally" id="tally"></div><button class="btn" id="save" type="button">Save register</button></div>`;

  $('#selC').onchange = (e) => { classId = e.target.value; store.set('attendly_class', classId); history.replaceState(null, '', '#/register/' + classId); load().catch((x) => toast(x.message, true)); };
  $('#selD').onchange = (e) => { if (e.target.value) { date = e.target.value; load().catch((x) => toast(x.message, true)); } };
  $('#q').oninput = draw;
  $('#allP').onclick = () => { students.forEach((s) => (marks[s.id] = 'present')); draw(); };
  $('#ck').onclick = () => checkinModal(cls()).then(() => {}).catch((x) => toast(x.message, true));
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

T.requests = async (view) => {
  const [lv, nt, cl] = await Promise.all([api('GET', '/leave-requests'), api('GET', '/notices'), api('GET', '/classes')]);
  const pending = lv.items.filter((i) => i.status === 'pending');
  const done = lv.items.filter((i) => i.status !== 'pending');
  const card = (r, actions) => `<div class="row wrap">${avatar(r.student)}<div class="grow"><b>${esc(r.student)}${r.rollNo ? ' · ' + esc(r.rollNo) : ''}</b><small>${esc(r.className)} · ${fmtDate(r.date)}</small><small>“${esc(r.reason)}”${r.phone ? ' · ' + esc(r.phone) : ''}</small></div>${actions}</div>`;
  view.innerHTML = `<div class="page-head row"><div><h1>Requests</h1><p>Leave requests from students, and notices you posted.</p></div><div class="actions"><button class="btn" id="pn" ${cl.classes.length ? '' : 'disabled'}>Post notice</button></div></div>
  <div class="grid cols-2">
    <section class="glass panel"><h2>Waiting for you</h2><p class="sub">Approving marks that day as Leave in the register.</p>
      ${pending.length ? `<div class="list">${pending.map((r) => card(r, `<div class="actions"><button class="btn small" data-do="approve" data-id="${r.id}">Approve</button><button class="btn small soft" data-do="reject" data-id="${r.id}">Reject</button></div>`)).join('')}</div>` : '<div class="empty"><p>No requests waiting.</p></div>'}</section>
    <section class="glass panel"><h2>Decided</h2><p class="sub">Most recent first</p>
      ${done.length ? `<div class="list">${done.slice(0, 12).map((r) => card(r, `<span class="chip ${r.status === 'approved' ? 'good' : 'bad'}">${r.status === 'approved' ? 'Approved' : '<span>Rejected</span>'}</span>`)).join('')}</div>` : '<div class="empty"><p>Nothing decided yet.</p></div>'}</section>
  </div>
  <h2 class="section-title">Your notices</h2>
  <section class="glass panel">${nt.items.length ? `<div class="list" style="margin-top:0">${nt.items.map((n) => `<div class="notice"><small>${esc(n.className)} · ${fmtWhen(n.at)}</small>${esc(n.body)}<div style="margin-top:8px"><button class="link" data-del-n="${n.id}">Delete</button></div></div>`).join('')}</div>` : '<div class="empty"><p>No notices yet. Post one for a class and students see it on Home.</p></div>'}</section>`;
  $('#pn').onclick = () => noticeModal(cl.classes);
  $$('[data-do]', view).forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await api('POST', '/leave-requests/' + b.dataset.id, { decision: b.dataset.do }); toast(b.dataset.do === 'approve' ? 'Approved.' : 'Rejected.'); await route(); refreshBadge(); }
    catch (e) { toast(e.message, true); b.disabled = false; }
  }));
  $$('[data-del-n]', view).forEach((b) => (b.onclick = async () => { try { await api('DELETE', '/notices/' + b.dataset.delN); toast('Notice deleted.'); route(); } catch (e) { toast(e.message, true); } }));
};

T.reports = async (view, arg) => {
  const { classes } = await api('GET', '/classes');
  if (!classes.length) { view.innerHTML = `<div class="page-head"><h1>Reports</h1></div><section class="glass panel empty"><h3>No classes yet</h3><p>Reports appear once you have a class with attendance.</p><a class="btn" href="#/classes">Go to classes</a></section>`; return; }
  const classId = arg && classes.some((c) => c.id === arg) ? arg : (classes.some((c) => c.id === store.get('attendly_class')) ? store.get('attendly_class') : classes[0].id);
  const r = await api('GET', '/reports/' + classId);
  view.innerHTML = `<div class="page-head row"><div><h1>Reports</h1><p>${r.days} register day${r.days === 1 ? '' : 's'} recorded. Late counts as attended. Leave is excused.</p></div>
    <div class="actions no-print"><button class="btn soft" id="csv">Download CSV</button><button class="btn soft" id="prt">Print</button></div></div>
    <section class="glass toolbar no-print"><div class="field"><label for="rc">Class</label><select id="rc">${classOptions(classes, classId)}</select></div></section>
    <section class="glass panel"><h2>${esc(r.class.name)}</h2><p class="sub">Dashed marks are below ${r.threshold}%</p>
    ${r.rows.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Student</th><th>Mobile</th><th class="n">Present</th><th class="n">Late</th><th class="n">Absent</th><th class="n">Leave</th><th class="n">Rate</th></tr></thead><tbody>
      ${r.rows.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="sub">${s.rollNo ? esc(s.rollNo) + ' · ' : ''}${esc(s.email.endsWith('@demo.attendly') ? 'placeholder student' : s.email)}</span></td><td>${esc(s.phone || '-')}</td><td class="n">${s.present}</td><td class="n">${s.late}</td><td class="n">${s.absent}</td><td class="n">${s.leave}</td><td class="n">${chip(s.rate, r.threshold)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><p>No students have joined this class yet.</p></div>`}</section>`;
  $('#rc').onchange = (e) => { store.set('attendly_class', e.target.value); location.hash = '#/reports/' + e.target.value; };
  $('#prt').onclick = () => window.print();
  $('#csv').onclick = () => {
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [['Student', 'Roll no', 'Email', 'Mobile', 'Present', 'Late', 'Absent', 'Leave', 'Rate %'].map(q).join(',')]
      .concat(r.rows.map((s) => [s.name, s.rollNo, s.email, s.phone, s.present, s.late, s.absent, s.leave, s.rate === null ? '' : s.rate].map(q).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `${r.class.name.replace(/[^\w-]+/g, '_')}-attendance-${todayStr()}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };
};

// ---------- settings (both roles) ----------
async function settingsPage(view) {
  const teacher = user.role === 'teacher';
  const act = await api('GET', '/me/activity').catch(() => ({ items: [] }));
  view.innerHTML = `<div class="page-head"><h1>Profile and settings</h1></div>
  <section class="glass panel" style="margin-bottom:18px"><div class="profile-card">${avatar(user.name)}<div><h2 style="font-size:1.5rem">${esc(user.name)}</h2><p class="sub">${teacher ? 'Teacher' : 'Student'} account</p></div></div>
    <div class="kv"><div><small>Email</small><b>${esc(user.email)}</b></div><div><small>Mobile</small><b>${esc(user.phone || 'Not added')}</b></div>${teacher ? '' : `<div><small>Roll number</small><b>${esc(user.rollNo || 'Not added')}</b></div>`}<div><small>Role</small><b>${teacher ? 'Teacher' : 'Student'}</b></div></div></section>
  <div class="grid cols-2">
    <div class="stack">
      <section class="glass panel"><h2>Profile</h2>
        <form id="pf" style="margin-top:14px">
          <div class="field"><label for="sName">Full name</label><input id="sName" type="text" maxlength="60" value="${esc(user.name)}"></div>
          <div class="row2"><div class="field"><label for="sPhone">Mobile number</label><input id="sPhone" type="tel" maxlength="16" value="${esc(user.phone || '')}"></div>
          ${teacher ? '' : `<div class="field"><label for="sRoll">Roll number</label><input id="sRoll" type="text" maxlength="30" value="${esc(user.rollNo || '')}"></div>`}</div>
          ${teacher ? `<div class="field"><label for="sMin">Minimum attendance: <b id="minVal">${user.threshold}%</b></label><input id="sMin" type="range" min="40" max="100" step="5" value="${user.threshold}"><p class="hint">Students below this show up under Needs attention.</p></div>` : ''}
          <p class="error" id="pfErr" role="alert"></p><button class="btn" type="submit">Save changes</button>
        </form></section>
      <section class="glass panel"><h2>Change password</h2><p class="sub">Your other devices are signed out when you change it.</p>
        <form id="pw" style="margin-top:14px">${pwField('cur', 'Current password', 'current-password')}${pwField('nxt', 'New password', 'new-password', true)}
          <p class="error" id="pwErr" role="alert"></p><button class="btn" type="submit">Change password</button></form></section>
    </div>
    <div class="stack">
      <section class="glass panel"><h2>Recent security activity</h2><p class="sub">If you do not recognise something, change your password and sign out everywhere.</p>
        <div class="list">${act.items.length ? act.items.map((i) => `<div class="row"><div class="grow"><b>${esc(i.action)}</b><small>${fmtWhen(i.at)}${i.ip ? ' · ' + esc(i.ip) : ''}</small></div></div>`).join('') : '<div class="empty"><p>Nothing yet.</p></div>'}</div>
        <div class="actions" style="margin-top:14px"><button class="btn soft" id="all">Sign out of all devices</button></div></section>
      <section class="glass panel"><h2>Appearance</h2><p class="sub">Two colours, light or inverted.</p><div class="actions" style="margin-top:12px"><button class="btn soft" id="th">Switch theme</button></div></section>
      ${teacher ? `<section class="glass panel"><h2>Test data</h2><p class="sub">Adds a practice class with 12 placeholder students and five weeks of attendance. Delete it from Classes when you are done.</p><div class="actions" style="margin-top:12px"><button class="btn soft" id="dm">Add practice class</button></div></section>` : ''}
      <section class="glass panel"><h2>Session</h2><div class="actions" style="margin-top:12px"><button class="btn soft" id="so">Sign out</button></div></section>
    </div>
  </div>`;
  bindPw(view);
  const m = $('#sMin'); if (m) m.oninput = () => ($('#minVal').textContent = m.value + '%');
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const out = await api('PATCH', '/me', { name: $('#sName').value, phone: $('#sPhone').value, ...(m ? { threshold: Number(m.value) } : { rollNo: $('#sRoll').value }) });
      user = out.user; toast('Saved.'); $('.who b').textContent = user.name; $('#pfErr').textContent = '';
    } catch (ex) { $('#pfErr').textContent = ex.message; }
  };
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    const pp = pwProblem($('#nxt').value); if (pp) { $('#pwErr').textContent = pp; return; }
    try {
      const out = await api('POST', '/me/password', { current: $('#cur').value, next: $('#nxt').value });
      token = out.token; store.set('attendly_token', token); toast('Password changed. Other devices were signed out.'); route();
    } catch (ex) { $('#pwErr').textContent = ex.message; }
  };
  $('#all').onclick = () => confirmBox('Sign out of all devices?', 'Every device, including this one, will need the password again.', 'Sign out everywhere', async () => {
    try { await api('POST', '/me/logout-all'); signOut(true); toast('Signed out of all devices.'); } catch (e) { toast(e.message, true); }
  });
  $('#th').onclick = () => $('#themeBtn').click();
  $('#so').onclick = () => signOut();
  const dm = $('#dm'); if (dm) dm.onclick = loadDemo;
}
T.settings = settingsPage;

// ---------- student pages ----------
const S = {};

function leaveModal(c) {
  openModal(`<h2>Ask for leave</h2><p class="sub">${esc(c.emoji || '')} ${esc(c.name)} · your teacher approves or rejects it.</p>
    <form id="lf" style="margin-top:16px">
      <div class="field"><label for="ld">Date</label><input id="ld" type="date" value="${todayStr()}" min="${addDays(todayStr(), -7)}" max="${addDays(todayStr(), 60)}"></div>
      <div class="field"><label for="lr">Reason</label><textarea id="lr" maxlength="200" placeholder="Fever, family function, exam in another subject…"></textarea></div>
      <p class="error" id="lErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn soft" data-cancel>Cancel</button><button class="btn" type="submit">Send request</button></div></form>`, (root, close) => {
    $('#lf', root).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', `/classes/${c.id}/leave-requests`, { date: $('#ld', root).value, reason: $('#lr', root).value }); close(); toast('Request sent to your teacher.'); route(); }
      catch (ex) { $('#lErr', root).textContent = ex.message; }
    };
  });
}

S.home = async (view) => {
  const d = await api('GET', '/student/summary');
  const mins = d.classes.map((c) => c.threshold);
  const low = d.classes.filter((c) => c.stats.rate !== null && c.stats.rate < c.threshold);
  view.innerHTML = `<div class="page-head"><h1>${greet()}, ${esc(first(user.name))}</h1><p>${d.classes.length ? 'Your attendance across every class.' : 'Join your first class with the code your teacher gave you.'}</p></div>${hub()}
  <div class="grid home-grid" style="margin-top:18px">
    <section class="glass panel orb-wrap"><h2>Overall attendance</h2>${orb(d.overall.rate, 'all classes', mins.length ? Math.min(...mins) : 75)}
      <p class="sub">${d.overall.present + d.overall.late} attended · ${d.overall.absent} missed · ${d.overall.leave} on leave</p></section>
    <div class="stack">
      ${d.notices.length ? `<section class="glass panel"><h2>Class notices</h2><div class="list">${d.notices.slice(0, 4).map((n) => `<div class="notice"><small>${esc(n.className)} · ${fmtWhen(n.at)}</small>${esc(n.body)}</div>`).join('')}</div></section>` : ''}
      ${low.length ? `<section class="glass panel"><h2>Watch these</h2><p class="sub">Below the minimum your teacher set</p><div class="list">${low.map((c) => `<div class="row"><div class="mini">${esc(c.emoji || '📘')}</div><div class="grow"><b>${esc(c.name)}</b><small>Minimum ${c.threshold}% · ${esc(c.teacher)}</small></div>${chip(c.stats.rate, c.threshold)}</div>`).join('')}</div></section>` : ''}
      <section class="glass panel"><h2>Join a class</h2><p class="sub">Enter the 6-character code from your teacher.</p>
        <form id="jf" style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap"><input id="jc" type="text" maxlength="12" placeholder="K7M2QX" autocomplete="off" aria-label="Join code" style="flex:1;min-width:140px;text-transform:uppercase;letter-spacing:.14em;font-weight:700"><button class="btn" type="submit">Join class</button></form>
        <p class="error" id="jErr" style="margin:10px 0 0" role="alert"></p></section>
      ${d.classes.length ? `<section class="glass panel"><h2>Your classes</h2><div class="list">${d.classes.map((c) => `<div class="row wrap"><div class="mini">${esc(c.emoji || '📘')}</div><div class="grow"><b>${esc(c.name)}</b><small>${esc(c.teacher)}</small><div class="meter ${band(c.stats.rate, c.threshold)}" style="margin-top:6px"><i style="width:${c.stats.rate || 0}%"></i></div></div>${chip(c.stats.rate, c.threshold)}</div>`).join('')}</div></section>` : ''}
    </div>
  </div>`;
  $('#jf').onsubmit = async (e) => {
    e.preventDefault();
    try { const o = await api('POST', '/classes/join', { code: $('#jc').value }); toast('Joined ' + o.joined + '.'); route(); }
    catch (ex) { $('#jErr').textContent = ex.message; }
  };
};

S.classes = async (view) => {
  const d = await api('GET', '/student/summary');
  const reqs = d.requests;
  view.innerHTML = `<div class="page-head"><h1>Your classes</h1><p>See how many classes you can still miss, and ask for leave.</p></div>
  ${d.classes.length ? `<div class="grid cards">${d.classes.map((c) => `<article class="glass class-card">
    <div class="class-top"><div class="class-emoji">${esc(c.emoji || '📘')}</div><div><h3>${esc(c.name)}</h3><p class="sub">${esc(c.teacher)}${c.code ? ' · ' + esc(c.code) : ''}</p></div></div>
    <div><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span class="sub">${c.stats.present + c.stats.late} of ${c.stats.present + c.stats.late + c.stats.absent} sessions</span>${chip(c.stats.rate, c.threshold)}</div><div class="meter ${band(c.stats.rate, c.threshold)}"><i style="width:${c.stats.rate || 0}%"></i></div></div>
    <p class="planner">${planner(c.stats, c.threshold)}</p>
    <div class="actions"><button class="btn small" data-leave-req="${c.id}">Ask for leave</button><button class="btn small soft" data-leave="${c.id}" data-name="${esc(c.name)}">Leave class</button></div></article>`).join('')}</div>
  <h2 class="section-title">Your leave requests</h2>
  <section class="glass panel">${reqs.length ? `<div class="list" style="margin-top:0">${reqs.map((r) => `<div class="row wrap"><div class="grow"><b>${esc(r.className)} · ${fmtDate(r.date)}</b><small>“${esc(r.reason)}”</small></div>${r.status === 'pending' ? `<span class="chip warn">Waiting</span><button class="btn small soft" data-cancel-req="${r.id}">Cancel</button>` : `<span class="chip ${r.status === 'approved' ? 'good' : 'bad'}">${r.status === 'approved' ? 'Approved' : '<span>Rejected</span>'}</span>`}</div>`).join('')}</div>` : '<div class="empty"><p>No requests yet.</p></div>'}</section>`
    : `<section class="glass panel empty"><h3>You are not in any class</h3><p>Ask your teacher for a join code, then enter it on Home.</p><a class="btn" href="#/home">Go to Home</a></section>`}`;
  $$('[data-leave-req]', view).forEach((b) => (b.onclick = () => leaveModal(d.classes.find((c) => c.id === b.dataset.leaveReq))));
  $$('[data-cancel-req]', view).forEach((b) => (b.onclick = async () => { try { await api('DELETE', '/leave-requests/' + b.dataset.cancelReq); toast('Request cancelled.'); route(); } catch (e) { toast(e.message, true); } }));
  $$('[data-leave]', view).forEach((b) => (b.onclick = () => confirmBox('Leave ' + b.dataset.name + '?', 'You can join again later with the code.', 'Leave class', async () => {
    try { await api('DELETE', `/classes/${b.dataset.leave}/leave`); toast('You left the class.'); route(); } catch (e) { toast(e.message, true); }
  })));
};

S.checkin = async (view) => {
  view.innerHTML = `<div class="page-head"><h1>Check in</h1><p>Your teacher shows a 6-digit code in class. Type it here to mark yourself present.</p></div>
  <section class="glass panel check-card"><h2>Enter the code</h2>
    <form id="cf"><input id="cc" class="code-input" type="text" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="000000" aria-label="6-digit check-in code">
    <p class="error" id="cErr" role="alert"></p><button class="btn wide" type="submit">Mark me present</button></form>
    <p class="hint" style="margin-top:14px">Only students in the class can use the code, and it stops working when your teacher ends check-in.</p></section>`;
  $('#cc').focus();
  $('#cc').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); };
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    try { const o = await api('POST', '/checkin', { code: $('#cc').value }); $('#cErr').textContent = ''; toast('Marked present in ' + o.className + '.'); $('#cc').value = ''; }
    catch (ex) { $('#cErr').textContent = ex.message; }
  };
};

S.history = async (view) => {
  const d = await api('GET', '/student/summary');
  let cls = 'all', st = 'all';
  const draw = () => {
    const rows = d.history.filter((h) => (cls === 'all' || h.classId === cls) && (st === 'all' || h.status === st));
    const groups = {};
    rows.forEach((h) => (groups[h.date] = groups[h.date] || []).push(h));
    $('#hist').innerHTML = rows.length
      ? Object.keys(groups).map((date) => `<div class="day-group"><h3>${fmtDate(date)}</h3><div class="list" style="margin-top:0">${groups[date].map((h) => `<div class="row"><div class="mini">${esc(h.emoji || '📘')}</div><div class="grow"><b>${esc(h.className)}</b></div>${statusChip(h.status)}</div>`).join('')}</div></div>`).join('')
      : `<div class="empty"><h3>Nothing to show</h3><p>${d.history.length ? 'No records match these filters.' : 'Your teachers have not recorded attendance yet.'}</p></div>`;
  };
  view.innerHTML = `<div class="page-head"><h1>History</h1><p>Every day your teachers recorded.</p></div>
  <section class="glass panel"><div class="field" style="max-width:320px"><label for="hc">Class</label><select id="hc"><option value="all">All classes</option>${d.classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="filters" role="group" aria-label="Filter by status">${[['all', 'All'], ...STATUS].map(([k, n]) => `<button type="button" data-st="${k}" aria-pressed="${k === 'all'}">${k === 'all' ? '' : sym(k)}${n}</button>`).join('')}</div>
    <div id="hist"></div></section>`;
  $('#hc').onchange = (e) => { cls = e.target.value; draw(); };
  $$('[data-st]', view).forEach((b) => (b.onclick = () => { st = b.dataset.st; $$('[data-st]', view).forEach((x) => x.setAttribute('aria-pressed', x === b)); draw(); }));
  draw();
};
S.settings = settingsPage;

// ---------- campus pages shared by both roles ----------
const P = {};
const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const t12 = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
const isTeacher = () => user.role === 'teacher';
const dateBox = (d) => { const x = new Date(d + 'T00:00:00'); return `<div class="cal-date"><b>${x.getDate()}</b><small>${x.toLocaleDateString(undefined, { month: 'short' })}</small></div>`; };
const statusPill = (s) => `<span class="chip ${s === 'approved' || s === 'resolved' ? 'good' : s === 'rejected' ? 'bad' : 'warn'}">${s === 'rejected' ? '<span>Rejected</span>' : s[0].toUpperCase() + s.slice(1)}</span>`;
const myClassList = async () => (await api('GET', '/classes')).classes;

function formModal(title, sub, fields, submit, onSubmit) {
  openModal(`<h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}<form id="fm" style="margin-top:16px">${fields}<p class="error" id="fmErr" role="alert"></p>
    <div class="actions"><button type="button" class="btn soft" data-cancel>Cancel</button><button class="btn" type="submit">${esc(submit)}</button></div></form>`, (root, close) => {
    $('#fm', root).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', root); btn.disabled = true;
      try { await onSubmit(root); close(); route(); } catch (ex) { $('#fmErr', root).textContent = ex.message; btn.disabled = false; }
    };
  });
}
const classField = (classes, id = 'fc') => `<div class="field"><label for="${id}">Class</label><select id="${id}">${classOptions(classes)}</select></div>`;
const needClasses = (view, classes, what) => {
  if (classes.length) return false;
  view.innerHTML = `<section class="glass panel empty"><h3>${isTeacher() ? 'Create a class first' : 'Join a class first'}</h3><p>${isTeacher() ? 'Your ' + what + ' are linked to a class.' : 'Your ' + what + ' appear once you are in a class.'}</p><a class="btn" href="#/${isTeacher() ? 'classes' : 'home'}">${isTeacher() ? 'Go to Classes' : 'Go to Home'}</a></section>`;
  return true;
};

P.timetable = async (view) => {
  const [{ items }, classes] = await Promise.all([api('GET', '/timetable'), myClassList()]);
  const today = ((new Date().getDay() + 6) % 7) + 1;
  const nowT = new Date().toTimeString().slice(0, 5);
  const days = [...new Set(items.map((i) => i.day))].sort();
  view.innerHTML = `<div class="page-head row"><div><h1>Timetable</h1><p>${isTeacher() ? 'Weekly schedule for your classes. Students see it instantly.' : 'Your weekly schedule.'}</p></div>${isTeacher() ? '<button class="btn" id="add">Add a slot</button>' : ''}</div>
  ${items.length ? `<div class="grid cols-2">${days.map((d) => `<section class="glass panel day-col"><h3>${DAYS[d]}${d === today ? ' · today' : ''}</h3>${items.filter((i) => i.day === d).map((i) => `<div class="slot ${d === today && nowT >= i.start && nowT < i.end ? 'now' : ''}"><time>${t12(i.start)} – ${t12(i.end)}</time><div class="grow" style="flex:1;min-width:0"><b>${esc(i.emoji || '')} ${esc(i.className)}</b>${i.room ? `<small class="sub" style="display:block">Room ${esc(i.room)}</small>` : ''}</div>${isTeacher() ? `<button class="btn small soft" data-del="${i.id}" aria-label="Remove slot">Remove</button>` : ''}</div>`).join('')}</section>`).join('')}</div>`
    : `<section class="glass panel empty"><h3>No schedule yet</h3><p>${isTeacher() ? 'Add the first slot to publish a timetable.' : 'Your teachers have not added a timetable yet.'}</p></section>`}`;
  $$('[data-del]', view).forEach((b) => (b.onclick = async () => { try { await api('DELETE', '/timetable/' + b.dataset.del); toast('Slot removed.'); route(); } catch (e) { toast(e.message, true); } }));
  const add = $('#add'); if (add) add.onclick = () => {
    if (!classes.length) return toast('Create a class first.', true);
    formModal('Add a slot', 'It repeats every week.', `${classField(classes)}<div class="field"><label for="fd">Day</label><select id="fd">${DAYS.slice(1, 7).map((n, i) => `<option value="${i + 1}" ${i + 1 === today ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="row2"><div class="field"><label for="fs">Starts</label><input id="fs" type="time" value="09:00"></div><div class="field"><label for="fe">Ends</label><input id="fe" type="time" value="10:00"></div></div>
      <div class="field"><label for="fr">Room</label><input id="fr" type="text" maxlength="30" placeholder="B-12"></div>`, 'Add slot',
    (r) => api('POST', `/classes/${$('#fc', r).value}/timetable`, { day: +$('#fd', r).value, start: $('#fs', r).value, end: $('#fe', r).value, room: $('#fr', r).value }).then(() => toast('Slot added.')));
  };
};

P.calendar = async (view) => {
  const [ev, ex, classes] = await Promise.all([api('GET', '/events'), api('GET', '/exams'), myClassList()]);
  const td = todayStr();
  const all = [...ev.items.map((e) => ({ ...e, type: e.kind })), ...ex.items.map((e) => ({ id: e.id, date: e.date, title: e.title + ' (exam)', className: e.className, type: 'exam', start: e.start }))]
    .filter((e) => e.date >= td).sort((a, b) => (a.date < b.date ? -1 : 1));
  view.innerHTML = `<div class="page-head row"><div><h1>Academic calendar</h1><p>Holidays, deadlines, events and exams in one list.</p></div>${isTeacher() ? '<button class="btn" id="add">Add an event</button>' : ''}</div>
  <section class="glass panel">${all.length ? `<div class="list" style="margin-top:0">${all.map((e) => `<div class="row">${dateBox(e.date)}<div class="grow"><b>${esc(e.title)}</b><small>${esc(e.className)}${e.start ? ' · ' + t12(e.start) : ''}</small></div><span class="kind ${e.type}">${e.type}</span>${isTeacher() && e.type !== 'exam' ? `<button class="btn small soft" data-del="${e.id}">Remove</button>` : ''}</div>`).join('')}</div>` : '<div class="empty"><h3>Nothing coming up</h3><p>New events and exams will appear here.</p></div>'}</section>`;
  $$('[data-del]', view).forEach((b) => (b.onclick = async () => { try { await api('DELETE', '/events/' + b.dataset.del); toast('Event removed.'); route(); } catch (e) { toast(e.message, true); } }));
  const add = $('#add'); if (add) add.onclick = () => {
    if (!classes.length) return toast('Create a class first.', true);
    formModal('Add an event', 'Students in the class will see it.', `${classField(classes)}<div class="field"><label for="ft">Title</label><input id="ft" type="text" maxlength="80" placeholder="Project submission"></div>
      <div class="row2"><div class="field"><label for="fd">Date</label><input id="fd" type="date" value="${td}"></div><div class="field"><label for="fk">Type</label><select id="fk"><option value="event">Event</option><option value="deadline">Deadline</option><option value="holiday">Holiday</option></select></div></div>`, 'Add event',
    (r) => api('POST', `/classes/${$('#fc', r).value}/events`, { title: $('#ft', r).value, date: $('#fd', r).value, kind: $('#fk', r).value }).then(() => toast('Event added.')));
  };
};

async function marksModal(examId) {
  const d = await api('GET', `/exams/${examId}/marks`);
  openModal(`<h2>${esc(d.exam.title)}</h2><p class="sub">Marks out of ${d.exam.maxMarks}. Leave blank if absent.</p>
    <form id="mf" style="margin-top:14px"><div class="list" style="margin-top:0;max-height:50vh;overflow:auto">${d.students.length ? d.students.map((s) => `<div class="row">${avatar(s.name)}<div class="grow"><b>${esc(s.name)}</b><small>${esc(s.rollNo || '')}</small></div><input class="score-in" type="number" step="0.5" min="0" max="${d.exam.maxMarks}" data-s="${s.id}" value="${s.score ?? ''}" aria-label="Marks for ${esc(s.name)}"></div>`).join('') : '<div class="empty"><p>No students in this class yet.</p></div>'}</div>
    <p class="error" id="fmErr" role="alert"></p><div class="actions"><button type="button" class="btn soft" data-cancel>Cancel</button><button class="btn" type="submit">Save marks</button></div></form>`, (root, close) => {
    $('#mf', root).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('PUT', `/exams/${examId}/marks`, { marks: $$('[data-s]', root).map((i) => ({ studentId: i.dataset.s, score: i.value === '' ? null : Number(i.value) })) }); close(); toast('Marks saved.'); route(); }
      catch (ex) { $('#fmErr', root).textContent = ex.message; }
    };
  });
}

P.exams = async (view) => {
  const [{ items }, classes] = await Promise.all([api('GET', '/exams'), myClassList()]);
  const td = todayStr();
  const row = (e) => `<div class="row wrap">${dateBox(e.date)}<div class="grow"><b>${esc(e.title)}</b><small>${esc(e.className)}${e.start ? ' · ' + t12(e.start) : ''}${e.room ? ' · Room ' + esc(e.room) : ''} · ${e.maxMarks} marks</small></div>${isTeacher() ? `<button class="btn small" data-marks="${e.id}">${e.graded ? 'Edit marks' : 'Enter marks'}</button><button class="btn small soft" data-del="${e.id}">Delete</button>` : ''}</div>`;
  const up = items.filter((e) => e.date >= td).reverse(), past = items.filter((e) => e.date < td);
  view.innerHTML = `<div class="page-head row"><div><h1>${isTeacher() ? 'Exams and marks' : 'Exam schedule'}</h1><p>${isTeacher() ? 'Schedule an exam, then enter marks after it.' : 'Dates, times and rooms for your exams.'}</p></div>${isTeacher() ? '<button class="btn" id="add">Schedule an exam</button>' : '<a class="btn soft" href="#/results">See results</a>'}</div>
  <h2 class="section-title" style="margin-top:0">Upcoming</h2><section class="glass panel">${up.length ? `<div class="list" style="margin-top:0">${up.map(row).join('')}</div>` : '<div class="empty"><p>No upcoming exams.</p></div>'}</section>
  ${past.length ? `<h2 class="section-title">Earlier</h2><section class="glass panel"><div class="list" style="margin-top:0">${past.map(row).join('')}</div></section>` : ''}`;
  $$('[data-marks]', view).forEach((b) => (b.onclick = () => marksModal(b.dataset.marks).catch((e) => toast(e.message, true))));
  $$('[data-del]', view).forEach((b) => (b.onclick = () => confirmBox('Delete this exam?', 'Its marks will be deleted too.', 'Delete', async () => { try { await api('DELETE', '/exams/' + b.dataset.del); toast('Exam deleted.'); route(); } catch (e) { toast(e.message, true); } })));
  const add = $('#add'); if (add) add.onclick = () => {
    if (!classes.length) return toast('Create a class first.', true);
    formModal('Schedule an exam', '', `${classField(classes)}<div class="field"><label for="ft">Name</label><input id="ft" type="text" maxlength="80" placeholder="Mid-term test"></div>
      <div class="row2"><div class="field"><label for="fd">Date</label><input id="fd" type="date" value="${td}"></div><div class="field"><label for="fs">Time</label><input id="fs" type="time" value="10:00"></div></div>
      <div class="row2"><div class="field"><label for="fr">Room</label><input id="fr" type="text" maxlength="30" placeholder="Hall 1"></div><div class="field"><label for="fm2">Maximum marks</label><input id="fm2" type="number" min="1" max="1000" value="50"></div></div>`, 'Schedule',
    (r) => api('POST', `/classes/${$('#fc', r).value}/exams`, { title: $('#ft', r).value, date: $('#fd', r).value, start: $('#fs', r).value, room: $('#fr', r).value, maxMarks: +$('#fm2', r).value }).then(() => toast('Exam scheduled.')));
  };
};

P.results = async (view) => {
  if (isTeacher()) { location.hash = '#/exams'; return; }
  const d = await api('GET', '/results');
  view.innerHTML = `<div class="page-head"><h1>Results</h1><p>Marks your teachers have published.</p></div>
  ${d.items.length ? `<div class="grid home-grid"><section class="glass panel orb-wrap"><h2>Average</h2><div class="grade" style="font-size:4rem;margin:10px 0">${d.average}%</div><p class="sub">Overall grade ${esc(d.grade)} across ${d.items.length} exam${d.items.length === 1 ? '' : 's'}</p></section>
  <section class="glass panel"><h2>All results</h2><div class="list">${d.items.map((r) => `<div class="row wrap"><div class="mini">${esc(r.emoji || '📘')}</div><div class="grow"><b>${esc(r.title)}</b><small>${esc(r.className)} · ${fmtShort(r.date)} · ${r.score} / ${r.maxMarks} (${r.percent}%)</small><div class="meter ${band(r.percent, 50)}" style="margin-top:6px"><i style="width:${r.percent}%"></i></div></div><div class="grade">${esc(r.grade)}</div></div>`).join('')}</div></section></div>`
    : '<section class="glass panel empty"><h3>No results yet</h3><p>They appear here when a teacher enters marks.</p></section>'}`;
};

P.passes = async (view) => {
  const [{ items }, classes] = await Promise.all([api('GET', '/passes'), isTeacher() ? [] : myClassList()]);
  view.innerHTML = `<div class="page-head row"><div><h1>Gate pass and hostel leave</h1><p>${isTeacher() ? 'Approve or reject requests from your students.' : 'Ask your class teacher for permission and track the answer.'}</p></div>${isTeacher() ? '' : '<button class="btn" id="add">New request</button>'}</div>
  <section class="glass panel">${items.length ? `<div class="list" style="margin-top:0">${items.map((p) => `<div class="row wrap"><div class="grow"><b>${isTeacher() ? esc(p.student) + ' · ' : ''}${esc(p.kind)}</b><small>${fmtShort(p.from)}${p.to !== p.from ? ' to ' + fmtShort(p.to) : ''} · ${esc(p.className)}${p.rollNo ? ' · ' + esc(p.rollNo) : ''}${isTeacher() && p.phone ? ' · ' + esc(p.phone) : ''}</small><small>“${esc(p.reason)}”</small></div>
      ${p.status === 'pending' ? (isTeacher() ? `<button class="btn small" data-do="approve" data-id="${p.id}">Approve</button><button class="btn small soft" data-do="reject" data-id="${p.id}">Reject</button>` : `${statusPill('pending')}<button class="btn small soft" data-cancel-p="${p.id}">Cancel</button>`) : statusPill(p.status)}</div>`).join('')}</div>` : '<div class="empty"><h3>No requests</h3><p>Nothing here yet.</p></div>'}</section>`;
  $$('[data-do]', view).forEach((b) => (b.onclick = async () => { try { await api('POST', '/passes/' + b.dataset.id, { decision: b.dataset.do }); toast(b.dataset.do === 'approve' ? 'Approved.' : 'Rejected.'); route(); } catch (e) { toast(e.message, true); } }));
  $$('[data-cancel-p]', view).forEach((b) => (b.onclick = async () => { try { await api('DELETE', '/passes/' + b.dataset.cancelP); toast('Request cancelled.'); route(); } catch (e) { toast(e.message, true); } }));
  const add = $('#add'); if (add) add.onclick = () => {
    if (!classes.length) return toast('Join a class first. Your class teacher approves the request.', true);
    formModal('New request', 'Your class teacher decides.', `${classField(classes)}<div class="field"><label for="fk">Type</label><select id="fk"><option>Gate pass</option><option>Hostel leave</option></select></div>
      <div class="row2"><div class="field"><label for="ff">From</label><input id="ff" type="date" value="${todayStr()}" min="${todayStr()}"></div><div class="field"><label for="ft">To</label><input id="ft" type="date" value="${todayStr()}" min="${todayStr()}"></div></div>
      <div class="field"><label for="fr">Reason</label><textarea id="fr" maxlength="200" placeholder="Why do you need it?"></textarea></div>`, 'Send request',
    (r) => api('POST', `/classes/${$('#fc', r).value}/passes`, { kind: $('#fk', r).value, from: $('#ff', r).value, to: $('#ft', r).value, reason: $('#fr', r).value }).then(() => toast('Request sent.')));
  };
};

P.help = async (view) => {
  const [{ items }, classes] = await Promise.all([api('GET', '/tickets'), isTeacher() ? [] : myClassList()]);
  view.innerHTML = `<div class="page-head row"><div><h1>Help desk</h1><p>${isTeacher() ? 'Grievances and feedback from your students.' : 'Raise a grievance or send feedback to a teacher.'}</p></div>${isTeacher() ? '' : '<button class="btn" id="add">Write a message</button>'}</div>
  <section class="glass panel">${items.length ? `<div class="list" style="margin-top:0">${items.map((t) => `<div class="row wrap" style="align-items:flex-start"><div class="grow" style="white-space:normal"><b style="white-space:normal">${esc(t.subject)}</b><small>${t.kind === 'feedback' ? 'Feedback' : 'Grievance'} · ${esc(t.className)}${isTeacher() ? ' · ' + esc(t.student) : ''} · ${fmtWhen(t.at)}</small><small style="margin-top:4px;color:var(--ink)">${esc(t.message)}</small>${t.reply ? `<div class="notice" style="margin-top:8px"><small>Reply</small>${esc(t.reply)}</div>` : ''}</div>${statusPill(t.status)}${isTeacher() && t.status === 'open' ? `<button class="btn small" data-reply="${t.id}">Reply</button>` : ''}</div>`).join('')}</div>` : '<div class="empty"><h3>No messages</h3><p>Nothing here yet.</p></div>'}</section>`;
  $$('[data-reply]', view).forEach((b) => (b.onclick = () => formModal('Reply', 'The student sees this and the message is marked resolved.', '<div class="field"><label for="fr">Your reply</label><textarea id="fr" maxlength="600"></textarea></div>', 'Send reply',
    (r) => api('POST', `/tickets/${b.dataset.reply}/reply`, { reply: $('#fr', r).value }).then(() => toast('Reply sent.')))));
  const add = $('#add'); if (add) add.onclick = () => {
    if (!classes.length) return toast('Join a class first. Messages go to that class teacher.', true);
    formModal('Write a message', 'It goes to the teacher of the class you choose.', `${classField(classes)}<div class="field"><label for="fk">Type</label><select id="fk"><option value="grievance">Grievance</option><option value="feedback">Feedback</option></select></div>
      <div class="field"><label for="fs">Subject</label><input id="fs" type="text" maxlength="80"></div><div class="field"><label for="fmsg">Message</label><textarea id="fmsg" maxlength="800"></textarea></div>`, 'Send',
    (r) => api('POST', '/tickets', { classId: $('#fc', r).value, kind: $('#fk', r).value, subject: $('#fs', r).value, message: $('#fmsg', r).value }).then(() => toast('Message sent.')));
  };
};

P.notifications = async (view) => {
  const { items } = await api('GET', '/notifications');
  view.innerHTML = `<div class="page-head"><h1>Notifications</h1><p>Updates from the last 30 days.</p></div>
  <section class="glass panel">${items.length ? `<div class="list" style="margin-top:0">${items.map((n) => `<a class="row" href="${n.link}" style="text-decoration:none"><div class="grow"><b>${esc(n.title)}</b><small>${esc(n.text)}</small></div><small class="sub">${fmtWhen(n.at)}</small></a>`).join('')}</div>` : '<div class="empty"><h3>You are up to date</h3><p>Nothing new.</p></div>'}</section>`;
};

function hub() {
  const t = isTeacher();
  const tiles = t
    ? [['register', 'Register', 'register'], ['timetable', 'Timetable', 'history'], ['calendar', 'Calendar', 'cal'], ['exams', 'Exams', 'exam'], ['requests', 'Leave', 'classes'], ['passes', 'Gate pass', 'door'], ['help', 'Help desk', 'chat'], ['reports', 'Reports', 'reports'], ['notifications', 'Updates', 'requests'], ['settings', 'Profile', 'user']]
    : [['history', 'Attendance', 'register'], ['timetable', 'Timetable', 'history'], ['calendar', 'Calendar', 'cal'], ['exams', 'Exams', 'exam'], ['results', 'Results', 'award'], ['checkin', 'Check in', 'checkin'], ['passes', 'Gate pass', 'door'], ['help', 'Help desk', 'chat'], ['notifications', 'Updates', 'requests'], ['settings', 'Profile', 'user']];
  return `<section class="tiles" aria-label="Everything in one place">${tiles.map(([h, n, i]) => `<a class="glass tile" href="#/${h}">${icon(i)}<span>${n}</span></a>`).join('')}</section>`;
}

// ---------- boot ----------
(async function boot() {
  if (!token) return showAuth('in');
  try { user = (await api('GET', '/me')).user; startApp(); }
  catch { if (!token) return; showAuth('in'); }
})();
