'use strict';
const crypto = require('crypto');
const { query } = require('./db');
const { hashPassword, verifyPassword, createToken, readToken, hmac, safeEqual } = require('./auth');
const { sendOtpMail } = require('./mail');

const STATUSES = ['present', 'late', 'absent', 'leave'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}
const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

// ---------- small helpers ----------
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const num = (v) => Number(v) || 0;
const marks = (start, n) => Array.from({ length: n }, (_, i) => '$' + (start + i)).join(',');

function validDate(d) {
  if (!DATE_RE.test(d || '')) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// Present and late count as attended. Leave is excused and left out of the total.
function rateOf(c) {
  const attended = num(c.present) + num(c.late);
  const total = attended + num(c.absent);
  return total === 0 ? null : Math.round((attended / total) * 100);
}
function shapeCounts(r) {
  const c = {
    present: num(r.present),
    late: num(r.late),
    absent: num(r.absent),
    leave: num(r.leave),
  };
  return { ...c, recorded: c.present + c.late + c.absent + c.leave, rate: rateOf(c) };
}
const SUMS = `
  SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
  SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late,
  SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
  SUM(CASE WHEN a.status = 'leave' THEN 1 ELSE 0 END) AS leave`;

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  phone: u.phone || '',
  rollNo: u.roll_no || '',
  threshold: num(u.threshold),
  collegeId: u.college_id || '',
  college: u.college_name || '',
  approved: u.approved === undefined || u.approved === null ? true : num(u.approved) === 1,
});
async function withCollege(u) {
  if (u.college_id && u.college_name === undefined) {
    const r = await query('SELECT name FROM colleges WHERE id = $1', [u.college_id]);
    u = { ...u, college_name: r[0] ? r[0].name : '' };
  }
  return publicUser(u);
}

// ---------- security helpers ----------
const WEAK = ['password', 'password1', 'password123', '12345678', '123456789', 'qwerty123', 'qwertyuiop', 'iloveyou1', 'admin123', 'welcome1'];
function checkPassword(pw, email) {
  if (pw.length < 8) fail(400, 'Password needs at least 8 characters.');
  if (pw.length > 100) fail(400, 'Password is too long.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail(400, 'Password needs at least one letter and one number.');
  if (WEAK.includes(pw.toLowerCase())) fail(400, 'That password is too common. Choose another one.');
  if (email && pw.toLowerCase().includes(String(email).split('@')[0].toLowerCase()) && String(email).split('@')[0].length >= 4) {
    fail(400, 'Do not use your email name inside your password.');
  }
}
function cleanPhone(v, required) {
  const s = String(v == null ? '' : v).replace(/[\s\-()]/g, '');
  if (!s) { if (required) fail(400, 'Enter your mobile number.'); return ''; }
  if (!/^\+?\d{10,14}$/.test(s)) fail(400, 'Enter a valid mobile number, 10 to 14 digits.');
  return s;
}
async function logActivity(userId, action, ip, detail) {
  try {
    await query('INSERT INTO activity (id, user_id, action, detail, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [uuid(), userId, action, detail || '', String(ip || '').slice(0, 60), nowIso()]);
  } catch { /* logging must never break a request */ }
}

// ---------- one-time codes (OTP) ----------
const OTP_MINUTES = 10;
async function issueOtp(email, purpose, silent) {
  const now = Date.now();
  const recent = await query('SELECT created_at FROM otps WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 10', [email, purpose]);
  const tooSoon = recent[0] && now - Date.parse(recent[0].created_at) < 60000;
  const tooMany = recent.filter((r) => now - Date.parse(r.created_at) < 3600000).length >= 5;
  if (tooSoon || tooMany) {
    if (silent) return null;
    fail(429, tooSoon ? 'Wait one minute before asking for another code.' : 'Too many codes asked. Try again in an hour.');
  }
  const code = String(crypto.randomInt(100000, 1000000));
  await query('DELETE FROM otps WHERE expires_at < $1', [new Date(now - 86400000).toISOString()]);
  await query(
    'INSERT INTO otps (id, email, purpose, code_hash, expires_at, attempts, created_at) VALUES ($1,$2,$3,$4,$5,0,$6)',
    [uuid(), email, purpose, hmac(email + '|' + purpose + '|' + code), new Date(now + OTP_MINUTES * 60000).toISOString(), nowIso()]
  );
  return code;
}
async function checkOtp(email, purpose, code) {
  const rows = await query('SELECT * FROM otps WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1', [email, purpose]);
  const o = rows[0];
  if (!o || Date.parse(o.expires_at) < Date.now()) fail(400, 'That code has expired. Ask for a new one.');
  if (num(o.attempts) >= 5) fail(429, 'Too many wrong tries. Ask for a new code.');
  const given = String(code || '').replace(/\s/g, '');
  if (!safeEqual(hmac(email + '|' + purpose + '|' + given), o.code_hash)) {
    await query('UPDATE otps SET attempts = attempts + 1 WHERE id = $1', [o.id]);
    fail(400, 'That code is not correct.');
  }
  await query('DELETE FROM otps WHERE email = $1 AND purpose = $2', [email, purpose]);
}
// Sends the code. With SHOW_OTP=true (demo mode) the code is also returned so a demo works without email.
async function deliver(email, purpose, code, name, quiet) {
  const show = process.env.SHOW_OTP === 'true';
  let sent = false;
  try { sent = await sendOtpMail({ to: email, purpose, code, name }); }
  catch (e) {
    console.error('mail failed:', e && e.message);
    if (!show && !quiet) fail(502, 'We could not send the email. Try again in a minute.');
  }
  if (!sent && !show && !quiet) fail(503, 'Email sending is not set up on this server yet.');
  return show ? { devOtp: code } : {};
}

// Light brute-force guard (per server instance; good enough for a college project).
const attempts = new Map();
function checkAttempts(key) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 10 * 60000);
  attempts.set(key, rec);
  if (rec.length >= 10) fail(429, 'Too many sign-in attempts. Wait 10 minutes and try again.');
}
const noteAttempt = (key) => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

function cleanText(v, max) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
}

// ---------- access checks ----------
async function userFrom(ctx) {
  const auth = ctx.headers.authorization || ctx.headers.Authorization || '';
  const p = readToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!p) fail(401, 'Please sign in again.');
  const rows = await query('SELECT u.*, c.name AS college_name FROM users u LEFT JOIN colleges c ON c.id = u.college_id WHERE u.id = $1', [p.sub]);
  if (!rows[0] || num(p.v) !== num(rows[0].token_ver)) fail(401, 'Please sign in again.');
  if (num(rows[0].disabled) === 1) fail(401, 'This account has been disabled by your college admin.');
  return promoteAdmin(rows[0]);
}
async function promoteAdmin(u) {
  if (u.role !== 'admin' && ADMIN_EMAILS().includes(String(u.email).toLowerCase())) {
    await query("UPDATE users SET role = 'admin', approved = 1, disabled = 0 WHERE id = $1", [u.id]);
    return { ...u, role: 'admin', approved: 1, disabled: 0 };
  }
  return u;
}
const needApproved = (user) => {
  if (user.role === 'teacher' && user.approved !== undefined && num(user.approved) === 0) fail(403, 'Your account is waiting for approval from your college admin.');
};
async function teacherClass(user, classId) {
  if (user.role !== 'teacher') fail(403, 'Only teachers can do this.');
  const rows = await query('SELECT * FROM classes WHERE id = $1 AND teacher_id = $2', [classId, user.id]);
  if (!rows[0]) fail(404, 'Class not found.');
  return rows[0];
}
const needRole = (user, role) => {
  if (user.role !== role) fail(403, role === 'teacher' ? 'Only teachers can do this.' : 'Only students can do this.');
};

// ---------- handlers ----------
async function register(ctx) {
  const b = ctx.body || {};
  const name = cleanText(b.name, 60);
  const email = cleanText(b.email, 120).toLowerCase();
  const isAdminEmail = ADMIN_EMAILS().includes(cleanText(b.email, 120).toLowerCase());
  const role = isAdminEmail ? 'admin' : b.role === 'teacher' ? 'teacher' : b.role === 'student' ? 'student' : '';
  const password = String(b.password || '');
  const phone = cleanPhone(b.phone, true);
  const rollNo = role === 'student' ? cleanText(b.rollNo, 30) : '';
  if (name.length < 2) fail(400, 'Enter your full name.');
  if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email address.');
  if (email.endsWith('@demo.attendly')) fail(400, 'Use a real email address.');
  if (!role) fail(400, 'Choose teacher or student.');
  checkPassword(password, email);
  let collegeId = null;
  if (role !== 'admin') {
    const col = await query('SELECT id FROM colleges WHERE id = $1 AND active = 1', [String(b.collegeId || '')]);
    if (!col[0]) fail(400, 'Choose your college or university from the list.');
    collegeId = col[0].id;
  }
  const approved = role === 'teacher' ? 0 : 1;
  const found = await query('SELECT * FROM users WHERE email = $1', [email]);
  const hash = await hashPassword(password);
  if (found[0] && num(found[0].verified) === 1) fail(409, 'An account with this email already exists. Sign in instead.');
  if (found[0]) {
    await query('UPDATE users SET name=$1, phone=$2, roll_no=$3, pass_hash=$4, role=$5, college_id=$6, approved=$7 WHERE id=$8', [name, phone, rollNo, hash, role, collegeId, approved, found[0].id]);
  } else {
    await query(
      'INSERT INTO users (id, name, email, pass_hash, role, threshold, created_at, phone, roll_no, verified, college_id, approved) VALUES ($1,$2,$3,$4,$5,75,$6,$7,$8,0,$9,$10)',
      [uuid(), name, email, hash, role, nowIso(), phone, rollNo, collegeId, approved]
    );
  }
  const code = await issueOtp(email, 'verify');
  const extra = await deliver(email, 'verify', code, name);
  return { status: 201, body: { pending: true, email, ...extra } };
}

async function verifyEmail(ctx) {
  const email = cleanText((ctx.body || {}).email, 120).toLowerCase();
  const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
  if (!rows[0]) fail(400, 'That code is not correct.');
  await checkOtp(email, 'verify', (ctx.body || {}).code);
  await query('UPDATE users SET verified = 1 WHERE id = $1', [rows[0].id]);
  await logActivity(rows[0].id, 'Email verified', ctx.ip);
  const vu = await promoteAdmin(rows[0]);
  return { body: { token: createToken(vu), user: await withCollege({ ...vu, verified: 1 }) } };
}

async function resendCode(ctx) {
  const email = cleanText((ctx.body || {}).email, 120).toLowerCase();
  const purpose = (ctx.body || {}).purpose === 'reset' ? 'reset' : 'verify';
  const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
  const u = rows[0];
  const ok = u && (purpose === 'verify' ? num(u.verified) === 0 : num(u.verified) === 1);
  let extra = {};
  if (ok) {
    const code = await issueOtp(email, purpose, true);
    if (code) extra = await deliver(email, purpose, code, u.name, true);
  }
  return { body: { ok: true, ...extra } };
}

async function login(ctx) {
  const b = ctx.body || {};
  const email = cleanText(b.email, 120).toLowerCase();
  const key = (ctx.ip || '') + '|' + email;
  checkAttempts(key);
  const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
  const u = rows[0];
  if (u && u.locked_until && Date.parse(u.locked_until) > Date.now()) {
    const mins = Math.ceil((Date.parse(u.locked_until) - Date.now()) / 60000);
    fail(423, `Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}. You can also reset your password.`);
  }
  const ok = u && (await verifyPassword(String(b.password || ''), u.pass_hash));
  if (!ok) {
    noteAttempt(key);
    if (u) {
      const n = num(u.failed_logins) + 1;
      if (n >= 5) {
        await query('UPDATE users SET failed_logins = 0, locked_until = $1 WHERE id = $2', [new Date(Date.now() + 15 * 60000).toISOString(), u.id]);
        await logActivity(u.id, 'Account locked after 5 wrong passwords', ctx.ip);
      } else {
        await query('UPDATE users SET failed_logins = $1 WHERE id = $2', [n, u.id]);
      }
    }
    fail(401, 'Email or password is wrong.');
  }
  if (num(u.verified) === 0) {
    let extra = {};
    const code = await issueOtp(email, 'verify', true);
    if (code) extra = await deliver(email, 'verify', code, u.name, true);
    fail(403, 'Verify your email first. We sent you a code.', { needsVerify: true, email, ...extra });
  }
  if (num(u.disabled) === 1) fail(403, 'This account has been disabled by your college admin.');
  const lu = await promoteAdmin(u);
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  await logActivity(u.id, 'Signed in', ctx.ip);
  return { body: { token: createToken(lu), user: await withCollege(lu) } };
}

async function forgotPassword(ctx) {
  const email = cleanText((ctx.body || {}).email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email address.');
  if (process.env.SHOW_OTP !== 'true' && !process.env.MAIL_STUB && !(process.env.SMTP_USER && process.env.SMTP_PASS)) {
    fail(503, 'Email sending is not set up on this server yet.');
  }
  const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
  let extra = {};
  if (rows[0] && num(rows[0].verified) === 1) {
    const code = await issueOtp(email, 'reset', true);
    if (code) extra = await deliver(email, 'reset', code, rows[0].name, true);
  }
  // Same answer whether or not the email has an account, so nobody can probe for accounts.
  return { body: { ok: true, ...extra } };
}

async function resetPassword(ctx) {
  const b = ctx.body || {};
  const email = cleanText(b.email, 120).toLowerCase();
  const password = String(b.password || '');
  checkPassword(password, email);
  const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
  if (!rows[0]) fail(400, 'That code is not correct.');
  await checkOtp(email, 'reset', b.code);
  await query('UPDATE users SET pass_hash = $1, token_ver = token_ver + 1, failed_logins = 0, locked_until = NULL WHERE id = $2', [await hashPassword(password), rows[0].id]);
  await logActivity(rows[0].id, 'Password reset with email code', ctx.ip);
  return { body: { ok: true } };
}

async function updateMe(ctx, user) {
  const b = ctx.body || {};
  const name = b.name === undefined ? user.name : cleanText(b.name, 60);
  const threshold = b.threshold === undefined ? num(user.threshold) : Math.round(Number(b.threshold));
  const phone = b.phone === undefined ? user.phone || '' : cleanPhone(b.phone, true);
  const rollNo = b.rollNo === undefined ? user.roll_no || '' : (user.role === 'student' ? cleanText(b.rollNo, 30) : '');
  if (name.length < 2) fail(400, 'Enter your full name.');
  if (!(threshold >= 1 && threshold <= 100)) fail(400, 'Minimum attendance must be between 1 and 100.');
  await query('UPDATE users SET name = $1, threshold = $2, phone = $3, roll_no = $4 WHERE id = $5', [name, threshold, phone, rollNo, user.id]);
  return { body: { user: publicUser({ ...user, name, threshold, phone, roll_no: rollNo }) } };
}

async function changePassword(ctx, user) {
  const b = ctx.body || {};
  if (!(await verifyPassword(String(b.current || ''), user.pass_hash))) fail(400, 'Your current password is not correct.');
  const next = String(b.next || '');
  checkPassword(next, user.email);
  if (next === String(b.current)) fail(400, 'Choose a password you have not used just now.');
  await query('UPDATE users SET pass_hash = $1, token_ver = token_ver + 1 WHERE id = $2', [await hashPassword(next), user.id]);
  await logActivity(user.id, 'Password changed', ctx.ip);
  const fresh = { ...user, token_ver: num(user.token_ver) + 1 };
  return { body: { token: createToken(fresh), user: publicUser(fresh) } };
}

async function signOutEverywhere(ctx, user) {
  await query('UPDATE users SET token_ver = token_ver + 1 WHERE id = $1', [user.id]);
  await logActivity(user.id, 'Signed out of all devices', ctx.ip);
  const fresh = { ...user, token_ver: num(user.token_ver) + 1 };
  return { body: { token: createToken(fresh) } };
}

async function myActivity(ctx, user) {
  const rows = await query('SELECT action, ip, created_at FROM activity WHERE user_id = $1 ORDER BY created_at DESC LIMIT 12', [user.id]);
  return { body: { items: rows.map((r) => ({ action: r.action, ip: r.ip, at: r.created_at })) } };
}

async function listClasses(ctx, user) {
  if (user.role === 'teacher') {
    const classes = await query(
      `SELECT c.id, c.name, c.code, c.emoji, c.join_code, c.is_demo,
              (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS students
       FROM classes c WHERE c.teacher_id = $1 ORDER BY c.created_at`,
      [user.id]
    );
    const ids = classes.map((c) => c.id);
    const stats = ids.length
      ? await query(`SELECT a.class_id, ${SUMS} FROM attendance a WHERE a.class_id IN (${marks(1, ids.length)}) GROUP BY a.class_id`, ids)
      : [];
    const byId = Object.fromEntries(stats.map((s) => [s.class_id, shapeCounts(s)]));
    return {
      body: {
        classes: classes.map((c) => ({
          id: c.id, name: c.name, code: c.code, emoji: c.emoji, joinCode: c.join_code,
          isDemo: !!num(c.is_demo), students: num(c.students),
          rate: byId[c.id] ? byId[c.id].rate : null,
        })),
      },
    };
  }
  const classes = await query(
    `SELECT c.id, c.name, c.code, c.emoji, u.name AS teacher, u.threshold
     FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN users u ON u.id = c.teacher_id
     WHERE e.student_id = $1 ORDER BY c.name`,
    [user.id]
  );
  const stats = await query(`SELECT a.class_id, ${SUMS} FROM attendance a WHERE a.student_id = $1 GROUP BY a.class_id`, [user.id]);
  const byId = Object.fromEntries(stats.map((s) => [s.class_id, shapeCounts(s)]));
  return {
    body: {
      classes: classes.map((c) => ({
        id: c.id, name: c.name, code: c.code, emoji: c.emoji, teacher: c.teacher,
        threshold: num(c.threshold),
        stats: byId[c.id] || shapeCounts({}),
      })),
    },
  };
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function uniqueJoinCode() {
  for (let i = 0; i < 8; i++) {
    let code = '';
    for (const byte of crypto.randomBytes(6)) code += CODE_CHARS[byte % CODE_CHARS.length];
    const hit = await query('SELECT id FROM classes WHERE join_code = $1', [code]);
    if (!hit[0]) return code;
  }
  fail(500, 'Could not create a join code. Try again.');
}

async function createClass(ctx, user) {
  needRole(user, 'teacher'); needApproved(user);
  const b = ctx.body || {};
  const name = cleanText(b.name, 60);
  const code = cleanText(b.code, 20);
  const emoji = cleanText(b.emoji, 4) || '📘';
  if (name.length < 2) fail(400, 'Enter a class name.');
  const count = await query('SELECT COUNT(*) AS n FROM classes WHERE teacher_id = $1', [user.id]);
  if (num(count[0].n) >= 30) fail(400, 'You can have up to 30 classes.');
  const id = uuid();
  const joinCode = await uniqueJoinCode();
  await query(
    'INSERT INTO classes (id, teacher_id, name, code, emoji, join_code, is_demo, created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7)',
    [id, user.id, name, code, emoji, joinCode, nowIso()]
  );
  return { status: 201, body: { class: { id, name, code, emoji, joinCode, isDemo: false, students: 0, rate: null } } };
}

async function purgeClass(classId) {
  const demoStudents = await query(
    `SELECT u.id FROM enrollments e JOIN users u ON u.id = e.student_id
     WHERE e.class_id = $1 AND u.email LIKE '%@demo.attendly'`,
    [classId]
  );
  for (const t of ['leave_requests', 'announcements', 'checkins', 'timetable', 'events', 'passes', 'tickets']) await query(`DELETE FROM ${t} WHERE class_id = $1`, [classId]);
  await query('DELETE FROM marks WHERE exam_id IN (SELECT id FROM exams WHERE class_id = $1)', [classId]);
  await query('DELETE FROM exams WHERE class_id = $1', [classId]);
  await query('DELETE FROM attendance WHERE class_id = $1', [classId]);
  await query('DELETE FROM enrollments WHERE class_id = $1', [classId]);
  await query('DELETE FROM classes WHERE id = $1', [classId]);
  for (const s of demoStudents) {
    const left = await query('SELECT 1 AS x FROM enrollments WHERE student_id = $1', [s.id]);
    if (!left[0]) await query('DELETE FROM users WHERE id = $1', [s.id]);
  }
}
async function deleteClass(ctx, user, classId) {
  await teacherClass(user, classId);
  await purgeClass(classId);
  return { body: { ok: true } };
}

async function joinClass(ctx, user) {
  needRole(user, 'student');
  const code = cleanText((ctx.body || {}).code, 12).toUpperCase();
  if (!code) fail(400, 'Enter the join code from your teacher.');
  const rows = await query(
    'SELECT c.id, c.name, u.name AS teacher, u.college_id AS tcollege FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.join_code = $1',
    [code]
  );
  if (!rows[0]) fail(404, 'No class uses that code. Check it with your teacher.');
  if (user.college_id && rows[0].tcollege && user.college_id !== rows[0].tcollege) fail(403, 'That class belongs to another college.');
  const already = await query('SELECT 1 AS x FROM enrollments WHERE class_id = $1 AND student_id = $2', [rows[0].id, user.id]);
  if (already[0]) fail(409, 'You are already in ' + rows[0].name + '.');
  await query('INSERT INTO enrollments (class_id, student_id, joined_at) VALUES ($1,$2,$3)', [rows[0].id, user.id, nowIso()]);
  return { status: 201, body: { joined: rows[0].name, teacher: rows[0].teacher } };
}

async function leaveClass(ctx, user, classId) {
  needRole(user, 'student');
  await query('DELETE FROM enrollments WHERE class_id = $1 AND student_id = $2', [classId, user.id]);
  return { body: { ok: true } };
}

async function removeStudent(ctx, user, classId, studentId) {
  await teacherClass(user, classId);
  await query('DELETE FROM enrollments WHERE class_id = $1 AND student_id = $2', [classId, studentId]);
  await query('DELETE FROM attendance WHERE class_id = $1 AND student_id = $2', [classId, studentId]);
  return { body: { ok: true } };
}

async function roster(ctx, user, classId) {
  const cls = await teacherClass(user, classId);
  const date = ctx.query.date || isoDay();
  if (!validDate(date)) fail(400, 'Pick a valid date.');
  const students = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.roll_no FROM enrollments e JOIN users u ON u.id = e.student_id
     WHERE e.class_id = $1 ORDER BY u.name`,
    [classId]
  );
  const marked = await query('SELECT student_id, status FROM attendance WHERE class_id = $1 AND date = $2', [classId, date]);
  const status = Object.fromEntries(marked.map((m) => [m.student_id, m.status]));
  const stats = await query(`SELECT a.student_id, ${SUMS} FROM attendance a WHERE a.class_id = $1 GROUP BY a.student_id`, [classId]);
  const byId = Object.fromEntries(stats.map((s) => [s.student_id, shapeCounts(s)]));
  return {
    body: {
      class: { id: cls.id, name: cls.name, emoji: cls.emoji, code: cls.code, joinCode: cls.join_code },
      date,
      students: students.map((s) => ({
        id: s.id, name: s.name, email: s.email, phone: s.phone || '', rollNo: s.roll_no || '',
        status: status[s.id] || null,
        rate: byId[s.id] ? byId[s.id].rate : null,
      })),
    },
  };
}

async function saveAttendance(ctx, user, classId) {
  await teacherClass(user, classId);
  const { date, records } = ctx.body || {};
  if (!validDate(date)) fail(400, 'Pick a valid date.');
  if (date > isoDay(1)) fail(400, 'You cannot mark attendance for a future date.');
  if (!Array.isArray(records) || records.length === 0) fail(400, 'Nothing to save.');
  if (records.length > 500) fail(400, 'Too many records in one save.');
  const enrolled = await query('SELECT student_id FROM enrollments WHERE class_id = $1', [classId]);
  const ok = new Set(enrolled.map((e) => e.student_id));
  const clean = [];
  for (const r of records) {
    if (!r || !ok.has(r.studentId)) fail(400, 'A student in this list is not in the class.');
    if (!STATUSES.includes(r.status)) fail(400, 'Unknown status: ' + r.status);
    clean.push(r);
  }
  const values = [];
  const params = [];
  clean.forEach((r, i) => {
    const o = i * 4;
    values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4})`);
    params.push(classId, r.studentId, date, r.status);
  });
  await query(
    `INSERT INTO attendance (class_id, student_id, date, status) VALUES ${values.join(',')}
     ON CONFLICT (class_id, student_id, date) DO UPDATE SET status = excluded.status`,
    params
  );
  return { body: { saved: clean.length, date } };
}

async function teacherDashboard(ctx, user) {
  needRole(user, 'teacher');
  const classes = (await listClasses(ctx, user)).body.classes;
  const ids = classes.map((c) => c.id);
  const empty = {
    totals: { classes: 0, students: 0, rate: null, recordedDays: 0 },
    classes, atRisk: [], trend: [], heat: [], mix: { present: 0, late: 0, absent: 0, leave: 0 }, pendingRequests: 0,
  };
  if (!ids.length) return { body: empty };
  const since = isoDay(-69);
  const inIds = marks(1, ids.length);
  const perDay = await query(
    `SELECT a.date, ${SUMS} FROM attendance a WHERE a.class_id IN (${inIds}) AND a.date >= $${ids.length + 1}
     GROUP BY a.date ORDER BY a.date`,
    [...ids, since]
  );
  const days = perDay.map((d) => ({ date: d.date, ...shapeCounts(d) }));
  const last30 = isoDay(-29);
  const mix = { present: 0, late: 0, absent: 0, leave: 0 };
  let recent = { present: 0, late: 0, absent: 0 };
  for (const d of days) {
    if (d.date < last30) continue;
    for (const k of Object.keys(mix)) mix[k] += d[k];
    recent = { present: recent.present + d.present, late: recent.late + d.late, absent: recent.absent + d.absent };
  }
  const perStudent = await query(
    `SELECT a.class_id, a.student_id, u.name, ${SUMS}
     FROM attendance a JOIN users u ON u.id = a.student_id
     WHERE a.class_id IN (${inIds}) GROUP BY a.class_id, a.student_id, u.name`,
    ids
  );
  const classNames = Object.fromEntries(classes.map((c) => [c.id, c.name]));
  const atRisk = perStudent
    .map((s) => ({ classId: s.class_id, className: classNames[s.class_id], studentId: s.student_id, name: s.name, ...shapeCounts(s) }))
    .filter((s) => s.rate !== null && s.rate < num(user.threshold))
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 12);
  const studentCount = await query(
    `SELECT COUNT(DISTINCT student_id) AS n FROM enrollments WHERE class_id IN (${inIds})`, ids
  );
  const recordedDays = await query(
    `SELECT COUNT(DISTINCT date) AS n FROM attendance WHERE class_id IN (${inIds})`, ids
  );
  const pending = await query(`SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending' AND class_id IN (${inIds})`, ids);
  return {
    body: {
      totals: {
        classes: classes.length,
        students: num(studentCount[0].n),
        rate: rateOf(recent),
        recordedDays: num(recordedDays[0].n),
      },
      classes,
      atRisk,
      trend: days.slice(-14).map((d) => ({ date: d.date, rate: d.rate })),
      heat: days.map((d) => ({ date: d.date, rate: d.rate })),
      mix,
      pendingRequests: num(pending[0].n),
    },
  };
}

async function classReport(ctx, user, classId) {
  const cls = await teacherClass(user, classId);
  const students = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.roll_no FROM enrollments e JOIN users u ON u.id = e.student_id
     WHERE e.class_id = $1 ORDER BY u.name`,
    [classId]
  );
  const stats = await query(`SELECT a.student_id, ${SUMS} FROM attendance a WHERE a.class_id = $1 GROUP BY a.student_id`, [classId]);
  const byId = Object.fromEntries(stats.map((s) => [s.student_id, shapeCounts(s)]));
  const days = await query('SELECT COUNT(DISTINCT date) AS n FROM attendance WHERE class_id = $1', [classId]);
  return {
    body: {
      class: { id: cls.id, name: cls.name, code: cls.code, emoji: cls.emoji },
      threshold: num(user.threshold),
      days: num(days[0].n),
      rows: students.map((s) => ({ id: s.id, name: s.name, email: s.email, phone: s.phone || '', rollNo: s.roll_no || '', ...(byId[s.id] || shapeCounts({})) })),
    },
  };
}

async function studentSummary(ctx, user) {
  needRole(user, 'student');
  const classes = (await listClasses(ctx, user)).body.classes;
  const total = classes.reduce(
    (t, c) => ({
      present: t.present + c.stats.present, late: t.late + c.stats.late,
      absent: t.absent + c.stats.absent, leave: t.leave + c.stats.leave,
    }),
    { present: 0, late: 0, absent: 0, leave: 0 }
  );
  const history = await query(
    `SELECT a.date, a.status, c.id AS class_id, c.name AS class_name, c.emoji
     FROM attendance a JOIN classes c ON c.id = a.class_id
     WHERE a.student_id = $1 ORDER BY a.date DESC, c.name LIMIT 300`,
    [user.id]
  );
  const requests = await query(
    `SELECT r.id, r.date, r.reason, r.status, c.name AS class_name, c.id AS class_id
     FROM leave_requests r JOIN classes c ON c.id = r.class_id WHERE r.student_id = $1 ORDER BY r.created_at DESC LIMIT 30`,
    [user.id]
  );
  const notices = classes.length
    ? await query(
        `SELECT n.id, n.body, n.created_at, c.name AS class_name FROM announcements n JOIN classes c ON c.id = n.class_id
         WHERE n.class_id IN (${marks(1, classes.length)}) ORDER BY n.created_at DESC LIMIT 10`,
        classes.map((c) => c.id)
      )
    : [];
  return {
    body: {
      overall: shapeCounts(total),
      classes,
      requests: requests.map((r) => ({ id: r.id, date: r.date, reason: r.reason, status: r.status, className: r.class_name, classId: r.class_id })),
      notices: notices.map((n) => ({ id: n.id, body: n.body, at: n.created_at, className: n.class_name })),
      history: history.map((h) => ({ date: h.date, status: h.status, classId: h.class_id, className: h.class_name, emoji: h.emoji })),
    },
  };
}

// ---------- sample class for demos ----------
const DEMO_NAMES = [
  'Aarav Mehta', 'Diya Nair', 'Kabir Singh', 'Meera Iyer', 'Rohan Das', 'Ishita Rao',
  'Vihaan Shah', 'Ananya Roy', 'Arjun Patel', 'Saanvi Kulkarni', 'Yash Verma', 'Tara Menon',
];
async function loadDemo(ctx, user) {
  needRole(user, 'teacher'); needApproved(user);
  const exists = await query('SELECT id FROM classes WHERE teacher_id = $1 AND is_demo = 1', [user.id]);
  if (exists[0]) fail(409, 'Sample class is already loaded.');
  const classId = uuid();
  await query(
    'INSERT INTO classes (id, teacher_id, name, code, emoji, join_code, is_demo, created_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7)',
    [classId, user.id, 'Practice: Data Structures', 'DEMO-101', '🧪', await uniqueJoinCode(), nowIso()]
  );
  const salt = crypto.randomBytes(3).toString('hex');
  const studentIds = [];
  for (const [i, name] of DEMO_NAMES.entries()) {
    const id = uuid();
    studentIds.push(id);
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${salt}@demo.attendly`;
    await query(
      "INSERT INTO users (id, name, email, pass_hash, role, threshold, created_at) VALUES ($1,$2,$3,'disabled','student',75,$4)",
      [id, name, email, nowIso()]
    );
    await query('INSERT INTO enrollments (class_id, student_id, joined_at) VALUES ($1,$2,$3)', [classId, id, nowIso()]);
  }
  // Fixed pattern, no randomness: each student has a steady attendance habit.
  const habit = [0.97, 0.93, 0.62, 0.9, 0.7, 0.95, 0.55, 0.88, 0.92, 0.8, 0.66, 0.96];
  const rows = [];
  for (let back = 35; back >= 0; back--) {
    const date = isoDay(-back);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) continue;
    studentIds.forEach((sid, i) => {
      const roll = ((back * 37 + i * 61 + 17) % 100) / 100;
      let status = roll < habit[i] ? 'present' : 'absent';
      if (status === 'present' && (back * 13 + i * 7) % 11 === 0) status = 'late';
      if (status === 'absent' && (back + i) % 5 === 0) status = 'leave';
      rows.push([classId, sid, date, status]);
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await query(
      `INSERT INTO attendance (class_id, student_id, date, status) VALUES ${part.map((_, k) => `($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4})`).join(',')}`,
      part.flat()
    );
  }
  return { status: 201, body: { ok: true, classId } };
}

// ---------- leave requests ----------
async function requestLeave(ctx, user, classId) {
  needRole(user, 'student');
  const enr = await query('SELECT 1 AS x FROM enrollments WHERE class_id = $1 AND student_id = $2', [classId, user.id]);
  if (!enr[0]) fail(404, 'You are not in this class.');
  const { date } = ctx.body || {};
  const reason = cleanText((ctx.body || {}).reason, 200);
  if (!validDate(date)) fail(400, 'Pick a valid date.');
  if (date < isoDay(-7) || date > isoDay(60)) fail(400, 'Leave can be asked from 7 days ago up to 60 days ahead.');
  if (reason.length < 3) fail(400, 'Write a short reason (at least 3 letters).');
  const dup = await query('SELECT status FROM leave_requests WHERE class_id = $1 AND student_id = $2 AND date = $3', [classId, user.id, date]);
  if (dup[0]) fail(409, 'You already asked for leave on that day (' + dup[0].status + ').');
  await query(
    "INSERT INTO leave_requests (id, class_id, student_id, date, reason, status, created_at) VALUES ($1,$2,$3,$4,$5,'pending',$6)",
    [uuid(), classId, user.id, date, reason, nowIso()]
  );
  return { status: 201, body: { ok: true } };
}
async function cancelLeave(ctx, user, id) {
  needRole(user, 'student');
  await query("DELETE FROM leave_requests WHERE id = $1 AND student_id = $2 AND status = 'pending'", [id, user.id]);
  return { body: { ok: true } };
}
async function listLeave(ctx, user) {
  needRole(user, 'teacher');
  const rows = await query(
    `SELECT r.id, r.date, r.reason, r.status, r.decided_at, c.name AS class_name, c.emoji, u.name AS student, u.phone, u.roll_no
     FROM leave_requests r JOIN classes c ON c.id = r.class_id JOIN users u ON u.id = r.student_id
     WHERE c.teacher_id = $1 ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.date DESC LIMIT 60`,
    [user.id]
  );
  return { body: { items: rows.map((r) => ({ id: r.id, date: r.date, reason: r.reason, status: r.status, className: r.class_name, emoji: r.emoji, student: r.student, phone: r.phone || '', rollNo: r.roll_no || '' })) } };
}
async function decideLeave(ctx, user, id) {
  needRole(user, 'teacher');
  const decision = (ctx.body || {}).decision;
  if (decision !== 'approve' && decision !== 'reject') fail(400, 'Choose approve or reject.');
  const rows = await query(
    `SELECT r.*, c.teacher_id FROM leave_requests r JOIN classes c ON c.id = r.class_id WHERE r.id = $1`, [id]
  );
  const r = rows[0];
  if (!r || r.teacher_id !== user.id) fail(404, 'Request not found.');
  if (r.status !== 'pending') fail(409, 'This request was already decided.');
  await query('UPDATE leave_requests SET status = $1, decided_at = $2 WHERE id = $3', [decision === 'approve' ? 'approved' : 'rejected', nowIso(), id]);
  if (decision === 'approve') {
    const cur = await query('SELECT status FROM attendance WHERE class_id = $1 AND student_id = $2 AND date = $3', [r.class_id, r.student_id, r.date]);
    if (!cur[0] || cur[0].status === 'absent') {
      await query(
        `INSERT INTO attendance (class_id, student_id, date, status) VALUES ($1,$2,$3,'leave')
         ON CONFLICT (class_id, student_id, date) DO UPDATE SET status = excluded.status`,
        [r.class_id, r.student_id, r.date]
      );
    }
  }
  return { body: { ok: true } };
}

// ---------- class notices ----------
async function addNotice(ctx, user, classId) {
  await teacherClass(user, classId);
  const body = cleanText((ctx.body || {}).body, 500);
  if (body.length < 3) fail(400, 'Write the notice first.');
  await query('INSERT INTO announcements (id, class_id, body, created_at) VALUES ($1,$2,$3,$4)', [uuid(), classId, body, nowIso()]);
  return { status: 201, body: { ok: true } };
}
async function listNotices(ctx, user) {
  needRole(user, 'teacher');
  const rows = await query(
    `SELECT n.id, n.body, n.created_at, c.name AS class_name, c.id AS class_id FROM announcements n JOIN classes c ON c.id = n.class_id
     WHERE c.teacher_id = $1 ORDER BY n.created_at DESC LIMIT 20`, [user.id]
  );
  return { body: { items: rows.map((n) => ({ id: n.id, body: n.body, at: n.created_at, className: n.class_name, classId: n.class_id })) } };
}
async function deleteNotice(ctx, user, id) {
  needRole(user, 'teacher');
  const rows = await query('SELECT n.id FROM announcements n JOIN classes c ON c.id = n.class_id WHERE n.id = $1 AND c.teacher_id = $2', [id, user.id]);
  if (!rows[0]) fail(404, 'Notice not found.');
  await query('DELETE FROM announcements WHERE id = $1', [id]);
  return { body: { ok: true } };
}

// ---------- live check-in code ----------
async function startCheckin(ctx, user, classId) {
  await teacherClass(user, classId);
  const minutes = [5, 10, 15, 30].includes(Number((ctx.body || {}).minutes)) ? Number(ctx.body.minutes) : 10;
  const date = validDate((ctx.body || {}).date) ? ctx.body.date : isoDay();
  if (date > isoDay(1) || date < isoDay(-2)) fail(400, 'Pick today for check-in.');
  await query('DELETE FROM checkins WHERE class_id = $1', [classId]);
  const code = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  await query('INSERT INTO checkins (id, class_id, date, code, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [uuid(), classId, date, code, expires, nowIso()]);
  return { status: 201, body: { code, expiresAt: expires, date } };
}
async function getCheckin(ctx, user, classId) {
  await teacherClass(user, classId);
  const rows = await query('SELECT * FROM checkins WHERE class_id = $1 AND expires_at > $2', [classId, nowIso()]);
  if (!rows[0]) return { body: { active: null } };
  const n = await query("SELECT COUNT(*) AS n FROM attendance WHERE class_id = $1 AND date = $2 AND status = 'present'", [classId, rows[0].date]);
  return { body: { active: { code: rows[0].code, expiresAt: rows[0].expires_at, date: rows[0].date }, present: num(n[0].n) } };
}
async function stopCheckin(ctx, user, classId) {
  await teacherClass(user, classId);
  await query('DELETE FROM checkins WHERE class_id = $1', [classId]);
  return { body: { ok: true } };
}
const checkinTries = new Map();
async function studentCheckin(ctx, user) {
  needRole(user, 'student');
  const now = Date.now();
  const tries = (checkinTries.get(user.id) || []).filter((t) => now - t < 600000);
  if (tries.length >= 8) fail(429, 'Too many wrong codes. Wait 10 minutes.');
  const code = cleanText((ctx.body || {}).code, 12).replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) fail(400, 'Enter the 6-digit code your teacher is showing.');
  const rows = await query(
    `SELECT s.class_id, s.date, c.name FROM checkins s
     JOIN enrollments e ON e.class_id = s.class_id AND e.student_id = $1
     JOIN classes c ON c.id = s.class_id
     WHERE s.code = $2 AND s.expires_at > $3`,
    [user.id, code, nowIso()]
  );
  if (!rows[0]) {
    checkinTries.set(user.id, [...tries, now]);
    fail(404, 'That code is wrong or has expired. Ask your teacher for the current code.');
  }
  await query(
    `INSERT INTO attendance (class_id, student_id, date, status) VALUES ($1,$2,$3,'present')
     ON CONFLICT (class_id, student_id, date) DO UPDATE SET status = excluded.status`,
    [rows[0].class_id, user.id, rows[0].date]
  );
  await logActivity(user.id, 'Checked in to ' + rows[0].name, ctx.ip);
  return { body: { ok: true, className: rows[0].name, date: rows[0].date } };
}

// ---------- campus: timetable, calendar, exams, results, passes, help desk, notifications ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
async function myClasses(user) {
  const rows = user.role === 'teacher'
    ? await query('SELECT id, name, emoji FROM classes WHERE teacher_id = $1', [user.id])
    : await query('SELECT c.id, c.name, c.emoji FROM classes c JOIN enrollments e ON e.class_id = c.id WHERE e.student_id = $1', [user.id]);
  return rows;
}
const inList = (ids, start = 1) => marks(start, ids.length);
async function ownedBy(user, table, id) {
  // teacher owns a row when its class belongs to them
  const rows = await query(`SELECT t.* FROM ${table} t JOIN classes c ON c.id = t.class_id WHERE t.id = $1 AND c.teacher_id = $2`, [id, user.id]);
  if (!rows[0]) fail(404, 'Not found.');
  return rows[0];
}
const gradeOf = (p) => (p >= 90 ? 'A+' : p >= 80 ? 'A' : p >= 70 ? 'B+' : p >= 60 ? 'B' : p >= 50 ? 'C' : p >= 40 ? 'D' : 'F');

async function listTimetable(ctx, user) {
  const cls = await myClasses(user);
  if (!cls.length) return { body: { items: [] } };
  const info = new Map(cls.map((c) => [c.id, c]));
  const rows = await query(`SELECT * FROM timetable WHERE class_id IN (${inList(cls)}) ORDER BY day, start_time`, cls.map((c) => c.id));
  return { body: { items: rows.map((r) => ({ id: r.id, classId: r.class_id, className: info.get(r.class_id).name, emoji: info.get(r.class_id).emoji, day: num(r.day), start: r.start_time, end: r.end_time, room: r.room || '' })) } };
}
async function addSlot(ctx, user, classId) {
  await teacherClass(user, classId);
  const b = ctx.body || {};
  const day = num(b.day), start = String(b.start || ''), end = String(b.end || '');
  if (day < 1 || day > 7) fail(400, 'Choose a day.');
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) fail(400, 'Enter start and end time.');
  if (end <= start) fail(400, 'End time must be after the start time.');
  await query('INSERT INTO timetable (id, class_id, day, start_time, end_time, room) VALUES ($1,$2,$3,$4,$5,$6)', [uuid(), classId, day, start, end, cleanText(b.room, 30)]);
  return { status: 201, body: { ok: true } };
}
async function deleteSlot(ctx, user, id) {
  needRole(user, 'teacher'); await ownedBy(user, 'timetable', id);
  await query('DELETE FROM timetable WHERE id = $1', [id]);
  return { body: { ok: true } };
}

async function listEvents(ctx, user) {
  const cls = await myClasses(user);
  if (!cls.length) return { body: { items: [] } };
  const info = new Map(cls.map((c) => [c.id, c]));
  const rows = await query(`SELECT * FROM events WHERE class_id IN (${inList(cls)}) AND date >= $${cls.length + 1} ORDER BY date LIMIT 200`, [...cls.map((c) => c.id), isoDay(-30)]);
  return { body: { items: rows.map((r) => ({ id: r.id, classId: r.class_id, className: info.get(r.class_id).name, title: r.title, date: r.date, kind: r.kind })) } };
}
async function addEvent(ctx, user, classId) {
  await teacherClass(user, classId);
  const b = ctx.body || {};
  const title = cleanText(b.title, 80);
  if (title.length < 2) fail(400, 'Give the event a title.');
  if (!validDate(b.date)) fail(400, 'Choose a valid date.');
  const kind = ['event', 'holiday', 'deadline'].includes(b.kind) ? b.kind : 'event';
  await query('INSERT INTO events (id, class_id, title, date, kind, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [uuid(), classId, title, b.date, kind, nowIso()]);
  return { status: 201, body: { ok: true } };
}
async function deleteEvent(ctx, user, id) {
  needRole(user, 'teacher'); await ownedBy(user, 'events', id);
  await query('DELETE FROM events WHERE id = $1', [id]);
  return { body: { ok: true } };
}

async function listExams(ctx, user) {
  const cls = await myClasses(user);
  if (!cls.length) return { body: { items: [] } };
  const info = new Map(cls.map((c) => [c.id, c]));
  const rows = await query(`SELECT * FROM exams WHERE class_id IN (${inList(cls)}) ORDER BY date DESC LIMIT 100`, cls.map((c) => c.id));
  let scored = new Map();
  if (user.role === 'teacher' && rows.length) {
    const c = await query(`SELECT exam_id, COUNT(*) AS n FROM marks WHERE exam_id IN (${inList(rows)}) GROUP BY exam_id`, rows.map((r) => r.id));
    scored = new Map(c.map((x) => [x.exam_id, num(x.n)]));
  }
  return { body: { items: rows.map((r) => ({ id: r.id, classId: r.class_id, className: info.get(r.class_id).name, title: r.title, date: r.date, start: r.start_time || '', room: r.room || '', maxMarks: num(r.max_marks), graded: scored.get(r.id) || 0 })) } };
}
async function addExam(ctx, user, classId) {
  await teacherClass(user, classId);
  const b = ctx.body || {};
  const title = cleanText(b.title, 80);
  if (title.length < 2) fail(400, 'Give the exam a name.');
  if (!validDate(b.date)) fail(400, 'Choose a valid date.');
  const start = b.start ? String(b.start) : '';
  if (start && !TIME_RE.test(start)) fail(400, 'Enter a valid start time.');
  const max = num(b.maxMarks);
  if (max < 1 || max > 1000) fail(400, 'Maximum marks must be between 1 and 1000.');
  await query('INSERT INTO exams (id, class_id, title, date, start_time, room, max_marks, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uuid(), classId, title, b.date, start, cleanText(b.room, 30), max, nowIso()]);
  return { status: 201, body: { ok: true } };
}
async function deleteExam(ctx, user, id) {
  needRole(user, 'teacher'); await ownedBy(user, 'exams', id);
  await query('DELETE FROM marks WHERE exam_id = $1', [id]);
  await query('DELETE FROM exams WHERE id = $1', [id]);
  return { body: { ok: true } };
}
async function examMarks(ctx, user, id) {
  needRole(user, 'teacher');
  const ex = await ownedBy(user, 'exams', id);
  const rows = await query(
    `SELECT u.id, u.name, u.roll_no, m.score FROM enrollments e JOIN users u ON u.id = e.student_id
     LEFT JOIN marks m ON m.exam_id = $1 AND m.student_id = u.id WHERE e.class_id = $2 ORDER BY u.name`, [id, ex.class_id]);
  return { body: { exam: { id: ex.id, title: ex.title, maxMarks: num(ex.max_marks) }, students: rows.map((r) => ({ id: r.id, name: r.name, rollNo: r.roll_no || '', score: r.score === null || r.score === undefined ? null : Number(r.score) })) } };
}
async function saveMarks(ctx, user, id) {
  needRole(user, 'teacher');
  const ex = await ownedBy(user, 'exams', id);
  const list = Array.isArray((ctx.body || {}).marks) ? ctx.body.marks.slice(0, 500) : [];
  const enrolled = new Set((await query('SELECT student_id FROM enrollments WHERE class_id = $1', [ex.class_id])).map((r) => r.student_id));
  for (const m of list) {
    if (!enrolled.has(m.studentId)) continue;
    if (m.score === null || m.score === '' || m.score === undefined) { await query('DELETE FROM marks WHERE exam_id = $1 AND student_id = $2', [id, m.studentId]); continue; }
    const s = Number(m.score);
    if (!Number.isFinite(s) || s < 0 || s > num(ex.max_marks)) fail(400, `Marks must be between 0 and ${num(ex.max_marks)}.`);
    await query(`INSERT INTO marks (exam_id, student_id, score) VALUES ($1,$2,$3) ON CONFLICT (exam_id, student_id) DO UPDATE SET score = excluded.score`, [id, m.studentId, s]);
  }
  return { body: { ok: true } };
}
async function myResults(ctx, user) {
  needRole(user, 'student');
  const rows = await query(
    `SELECT x.id, x.title, x.date, x.max_marks, c.name AS class_name, c.emoji, m.score FROM marks m
     JOIN exams x ON x.id = m.exam_id JOIN classes c ON c.id = x.class_id JOIN enrollments e ON e.class_id = c.id AND e.student_id = m.student_id
     WHERE m.student_id = $1 ORDER BY x.date DESC LIMIT 100`, [user.id]);
  const items = rows.map((r) => { const pct = Math.round((Number(r.score) / num(r.max_marks)) * 1000) / 10; return { id: r.id, title: r.title, date: r.date, className: r.class_name, emoji: r.emoji, score: Number(r.score), maxMarks: num(r.max_marks), percent: pct, grade: gradeOf(pct) }; });
  const avg = items.length ? Math.round((items.reduce((t, i) => t + i.percent, 0) / items.length) * 10) / 10 : null;
  return { body: { items, average: avg, grade: avg === null ? null : gradeOf(avg) } };
}

async function listPasses(ctx, user) {
  const rows = user.role === 'teacher'
    ? await query(`SELECT p.*, c.name AS class_name, u.name AS student, u.phone, u.roll_no FROM passes p JOIN classes c ON c.id = p.class_id JOIN users u ON u.id = p.student_id WHERE c.teacher_id = $1 ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.created_at DESC LIMIT 60`, [user.id])
    : await query(`SELECT p.*, c.name AS class_name, u.name AS student, u.phone, u.roll_no FROM passes p JOIN classes c ON c.id = p.class_id JOIN users u ON u.id = p.student_id WHERE p.student_id = $1 ORDER BY p.created_at DESC LIMIT 60`, [user.id]);
  return { body: { items: rows.map((p) => ({ id: p.id, kind: p.kind, from: p.from_date, to: p.to_date, reason: p.reason, status: p.status, className: p.class_name, student: p.student, phone: p.phone || '', rollNo: p.roll_no || '' })) } };
}
async function requestPass(ctx, user, classId) {
  needRole(user, 'student');
  const enr = await query('SELECT 1 AS x FROM enrollments WHERE class_id = $1 AND student_id = $2', [classId, user.id]);
  if (!enr[0]) fail(404, 'You are not in that class.');
  const b = ctx.body || {};
  const kind = b.kind === 'Hostel leave' ? 'Hostel leave' : 'Gate pass';
  if (!validDate(b.from) || !validDate(b.to)) fail(400, 'Choose the dates.');
  if (b.to < b.from) fail(400, 'The end date must not be before the start date.');
  if (b.from < isoDay(-1) || b.to > isoDay(120)) fail(400, 'Choose dates from today to the next 4 months.');
  const reason = cleanText(b.reason, 200);
  if (reason.length < 3) fail(400, 'Write a short reason.');
  const open = await query("SELECT COUNT(*) AS n FROM passes WHERE student_id = $1 AND status = 'pending'", [user.id]);
  if (num(open[0].n) >= 5) fail(429, 'You already have 5 requests waiting.');
  await query('INSERT INTO passes (id, class_id, student_id, kind, from_date, to_date, reason, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,\'pending\',$8)', [uuid(), classId, user.id, kind, b.from, b.to, reason, nowIso()]);
  return { status: 201, body: { ok: true } };
}
async function decidePass(ctx, user, id) {
  needRole(user, 'teacher');
  const d = (ctx.body || {}).decision;
  if (d !== 'approve' && d !== 'reject') fail(400, 'Choose approve or reject.');
  const p = await ownedBy(user, 'passes', id);
  if (p.status !== 'pending') fail(409, 'Already decided.');
  await query('UPDATE passes SET status = $1, decided_at = $2 WHERE id = $3', [d === 'approve' ? 'approved' : 'rejected', nowIso(), id]);
  return { body: { ok: true } };
}
async function cancelPass(ctx, user, id) {
  needRole(user, 'student');
  await query("DELETE FROM passes WHERE id = $1 AND student_id = $2 AND status = 'pending'", [id, user.id]);
  return { body: { ok: true } };
}

async function listTickets(ctx, user) {
  const base = `SELECT t.*, c.name AS class_name, u.name AS student FROM tickets t JOIN classes c ON c.id = t.class_id JOIN users u ON u.id = t.student_id`;
  const rows = user.role === 'teacher'
    ? await query(`${base} WHERE c.teacher_id = $1 ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.created_at DESC LIMIT 60`, [user.id])
    : await query(`${base} WHERE t.student_id = $1 ORDER BY t.created_at DESC LIMIT 60`, [user.id]);
  return { body: { items: rows.map((t) => ({ id: t.id, kind: t.kind, subject: t.subject, message: t.message, status: t.status, reply: t.reply || '', at: t.created_at, className: t.class_name, student: t.student })) } };
}
async function createTicket(ctx, user) {
  needRole(user, 'student');
  const b = ctx.body || {};
  const enr = await query('SELECT 1 AS x FROM enrollments WHERE class_id = $1 AND student_id = $2', [b.classId, user.id]);
  if (!enr[0]) fail(400, 'Choose one of your classes.');
  const kind = b.kind === 'feedback' ? 'feedback' : 'grievance';
  const subject = cleanText(b.subject, 80), message = cleanText(b.message, 800);
  if (subject.length < 3) fail(400, 'Add a short subject.');
  if (message.length < 10) fail(400, 'Describe it in at least a sentence.');
  const open = await query("SELECT COUNT(*) AS n FROM tickets WHERE student_id = $1 AND created_at > $2", [user.id, new Date(Date.now() - 86400000).toISOString()]);
  if (num(open[0].n) >= 5) fail(429, 'You can send 5 messages a day. Try again tomorrow.');
  await query('INSERT INTO tickets (id, class_id, student_id, kind, subject, message, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,\'open\',$7)', [uuid(), b.classId, user.id, kind, subject, message, nowIso()]);
  return { status: 201, body: { ok: true } };
}
async function replyTicket(ctx, user, id) {
  needRole(user, 'teacher');
  await ownedBy(user, 'tickets', id);
  const reply = cleanText((ctx.body || {}).reply, 600);
  if (reply.length < 2) fail(400, 'Write your reply.');
  await query("UPDATE tickets SET reply = $1, status = 'resolved', replied_at = $2 WHERE id = $3", [reply, nowIso(), id]);
  return { body: { ok: true } };
}

async function notifications(ctx, user) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const out = [];
  if (user.role === 'student') {
    const cls = await myClasses(user);
    if (cls.length) {
      const n = await query(`SELECT n.body, n.created_at, c.name FROM announcements n JOIN classes c ON c.id = n.class_id WHERE n.class_id IN (${inList(cls)}) AND n.created_at > $${cls.length + 1} ORDER BY n.created_at DESC LIMIT 15`, [...cls.map((c) => c.id), since]);
      n.forEach((x) => out.push({ at: x.created_at, title: 'Notice from ' + x.name, text: x.body, link: '#/home' }));
    }
    const l = await query(`SELECT r.date, r.status, r.decided_at, c.name FROM leave_requests r JOIN classes c ON c.id = r.class_id WHERE r.student_id = $1 AND r.status <> 'pending' AND r.decided_at > $2 ORDER BY r.decided_at DESC LIMIT 10`, [user.id, since]);
    l.forEach((x) => out.push({ at: x.decided_at, title: `Leave ${x.status}`, text: `${x.name}, ${x.date}`, link: '#/classes' }));
    const p = await query(`SELECT kind, from_date, status, decided_at FROM passes WHERE student_id = $1 AND status <> 'pending' AND decided_at > $2 ORDER BY decided_at DESC LIMIT 10`, [user.id, since]);
    p.forEach((x) => out.push({ at: x.decided_at, title: `${x.kind} ${x.status}`, text: 'From ' + x.from_date, link: '#/passes' }));
    const t = await query(`SELECT subject, replied_at FROM tickets WHERE student_id = $1 AND status = 'resolved' AND replied_at > $2 ORDER BY replied_at DESC LIMIT 10`, [user.id, since]);
    t.forEach((x) => out.push({ at: x.replied_at, title: 'Reply to your message', text: x.subject, link: '#/help' }));
    const r = await query(`SELECT x.title, x.created_at, c.name FROM marks m JOIN exams x ON x.id = m.exam_id JOIN classes c ON c.id = x.class_id WHERE m.student_id = $1 AND x.created_at > $2 ORDER BY x.created_at DESC LIMIT 5`, [user.id, since]);
    r.forEach((x) => out.push({ at: x.created_at, title: 'Result published', text: `${x.name}: ${x.title}`, link: '#/results' }));
  } else {
    const l = await query(`SELECT r.created_at, u.name AS s, c.name FROM leave_requests r JOIN classes c ON c.id = r.class_id JOIN users u ON u.id = r.student_id WHERE c.teacher_id = $1 AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 15`, [user.id]);
    l.forEach((x) => out.push({ at: x.created_at, title: 'Leave request', text: `${x.s} · ${x.name}`, link: '#/requests' }));
    const p = await query(`SELECT p.created_at, p.kind, u.name AS s FROM passes p JOIN classes c ON c.id = p.class_id JOIN users u ON u.id = p.student_id WHERE c.teacher_id = $1 AND p.status = 'pending' ORDER BY p.created_at DESC LIMIT 15`, [user.id]);
    p.forEach((x) => out.push({ at: x.created_at, title: x.kind + ' request', text: x.s, link: '#/passes' }));
    const t = await query(`SELECT t.created_at, t.kind, t.subject, u.name AS s FROM tickets t JOIN classes c ON c.id = t.class_id JOIN users u ON u.id = t.student_id WHERE c.teacher_id = $1 AND t.status = 'open' ORDER BY t.created_at DESC LIMIT 15`, [user.id]);
    t.forEach((x) => out.push({ at: x.created_at, title: (x.kind === 'feedback' ? 'Feedback' : 'Grievance') + ' from ' + x.s, text: x.subject, link: '#/help' }));
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { body: { items: out.slice(0, 40) } };
}

// ---------- colleges and the admin panel ----------
const ADMIN_EMAILS = () => String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
async function publicColleges() {
  const rows = await query('SELECT id, name, city FROM colleges WHERE active = 1 ORDER BY name', []);
  return { body: { colleges: rows.map((c) => ({ id: c.id, name: c.name, city: c.city || '' })) } };
}
async function adminOverview(ctx, user) {
  needRole(user, 'admin');
  const by = await query("SELECT role, COUNT(*) AS n FROM users WHERE verified = 1 AND role <> 'admin' AND email NOT LIKE '%@demo.attendly' GROUP BY role", []);
  const count = (r) => num((by.find((x) => x.role === r) || {}).n);
  const pend = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher' AND approved = 0 AND disabled = 0 AND verified = 1", []);
  const cls = await query('SELECT COUNT(*) AS n FROM classes WHERE is_demo = 0', []);
  const rows = await query(
    `SELECT c.id, c.name, c.city, c.code, c.active,
       (SELECT COUNT(*) FROM users u WHERE u.college_id = c.id AND u.role = 'teacher' AND u.verified = 1) AS teachers,
       (SELECT COUNT(*) FROM users u WHERE u.college_id = c.id AND u.role = 'student' AND u.verified = 1) AS students,
       (SELECT COUNT(*) FROM classes k JOIN users t ON t.id = k.teacher_id WHERE t.college_id = c.id AND k.is_demo = 0) AS classes
     FROM colleges c ORDER BY c.name`, []);
  const unassigned = await query("SELECT COUNT(*) AS n FROM users WHERE college_id IS NULL AND role <> 'admin' AND verified = 1 AND email NOT LIKE '%@demo.attendly'", []);
  return { body: {
    totals: { colleges: rows.length, teachers: count('teacher'), students: count('student'), classes: num(cls[0].n), pending: num(pend[0].n), unassigned: num(unassigned[0].n) },
    colleges: rows.map((c) => ({ id: c.id, name: c.name, city: c.city || '', code: c.code || '', active: num(c.active) === 1, teachers: num(c.teachers), students: num(c.students), classes: num(c.classes) })),
  } };
}
async function adminAddCollege(ctx, user) {
  needRole(user, 'admin');
  const b = ctx.body || {};
  const name = cleanText(b.name, 100), city = cleanText(b.city, 60), code = cleanText(b.code, 20);
  if (name.length < 3) fail(400, 'Enter the full college or university name.');
  const dup = await query('SELECT 1 AS x FROM colleges WHERE lower(name) = lower($1)', [name]);
  if (dup[0]) fail(409, 'That college is already added.');
  await query('INSERT INTO colleges (id, name, city, code, active, created_at) VALUES ($1,$2,$3,$4,1,$5)', [uuid(), name, city, code, nowIso()]);
  return { status: 201, body: { ok: true } };
}
async function adminEditCollege(ctx, user, id) {
  needRole(user, 'admin');
  const rows = await query('SELECT * FROM colleges WHERE id = $1', [id]);
  const c = rows[0]; if (!c) fail(404, 'College not found.');
  const b = ctx.body || {};
  const name = b.name === undefined ? c.name : cleanText(b.name, 100);
  const city = b.city === undefined ? c.city || '' : cleanText(b.city, 60);
  const code = b.code === undefined ? c.code || '' : cleanText(b.code, 20);
  const active = b.active === undefined ? num(c.active) : b.active ? 1 : 0;
  if (name.length < 3) fail(400, 'Enter the full college or university name.');
  const dup = await query('SELECT 1 AS x FROM colleges WHERE lower(name) = lower($1) AND id <> $2', [name, id]);
  if (dup[0]) fail(409, 'Another college already has that name.');
  await query('UPDATE colleges SET name = $1, city = $2, code = $3, active = $4 WHERE id = $5', [name, city, code, active, id]);
  return { body: { ok: true } };
}
async function adminDeleteCollege(ctx, user, id) {
  needRole(user, 'admin');
  const used = await query('SELECT 1 AS x FROM users WHERE college_id = $1 LIMIT 1', [id]);
  if (used[0]) fail(409, 'People belong to this college. Disable it instead of deleting.');
  await query('DELETE FROM colleges WHERE id = $1', [id]);
  return { body: { ok: true } };
}
async function adminUsers(ctx, user) {
  needRole(user, 'admin');
  const q = ctx.query || {};
  const where = ["u.verified = 1", "u.role <> 'admin'", "u.email NOT LIKE '%@demo.attendly'"];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (q.role === 'teacher' || q.role === 'student') add('u.role = ?', q.role);
  if (q.collegeId === 'none') where.push('u.college_id IS NULL'); else if (q.collegeId) add('u.college_id = ?', q.collegeId);
  if (q.status === 'pending') where.push("u.role = 'teacher' AND u.approved = 0 AND u.disabled = 0");
  if (q.status === 'disabled') where.push('u.disabled = 1');
  const text = cleanText(q.q, 60).toLowerCase();
  if (text) { params.push('%' + text + '%'); where.push(`(lower(u.name) LIKE $${params.length} OR lower(u.email) LIKE $${params.length})`); }
  const rows = await query(
    `SELECT u.id, u.name, u.email, u.role, u.phone, u.roll_no, u.approved, u.disabled, u.college_id, u.created_at, c.name AS college_name
     FROM users u LEFT JOIN colleges c ON c.id = u.college_id WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN u.role = 'teacher' AND u.approved = 0 AND u.disabled = 0 THEN 0 ELSE 1 END, u.created_at DESC LIMIT 200`, params);
  return { body: { items: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || '', rollNo: u.roll_no || '', approved: num(u.approved) === 1, disabled: num(u.disabled) === 1, collegeId: u.college_id || '', college: u.college_name || '', at: u.created_at })) } };
}
async function adminUserAction(ctx, user, id) {
  needRole(user, 'admin');
  const rows = await query('SELECT * FROM users WHERE id = $1', [id]);
  const u = rows[0];
  if (!u || u.role === 'admin') fail(404, 'User not found.');
  const b = ctx.body || {};
  if (b.action === 'approve') await query('UPDATE users SET approved = 1, disabled = 0 WHERE id = $1', [id]);
  else if (b.action === 'reject' || b.action === 'disable') await query('UPDATE users SET disabled = 1, token_ver = token_ver + 1 WHERE id = $1', [id]);
  else if (b.action === 'enable') await query('UPDATE users SET disabled = 0 WHERE id = $1', [id]);
  else if (b.action === 'assign') {
    const c = await query('SELECT id FROM colleges WHERE id = $1', [b.collegeId]);
    if (!c[0]) fail(400, 'Choose a college.');
    await query('UPDATE users SET college_id = $1 WHERE id = $2', [b.collegeId, id]);
  } else fail(400, 'Unknown action.');
  await logActivity(id, 'Admin action: ' + b.action, ctx.ip, 'by ' + user.email);
  return { body: { ok: true } };
}

// ---------- router ----------
async function handle(ctx) {
  const [a, b, c, d] = ctx.segs;
  const m = ctx.method;

  if (a === 'health' && m === 'GET') {
    await query('SELECT 1 AS ok', []);
    return { body: { ok: true } };
  }
  if (a === 'auth' && m === 'POST') {
    if (b === 'register') return register(ctx);
    if (b === 'login') return login(ctx);
    if (b === 'verify') return verifyEmail(ctx);
    if (b === 'resend') return resendCode(ctx);
    if (b === 'forgot') return forgotPassword(ctx);
    if (b === 'reset') return resetPassword(ctx);
  }

  if (a === 'colleges' && !b && m === 'GET') return publicColleges();

  const user = await userFrom(ctx);

  if (a === 'admin') {
    if (b === 'overview' && m === 'GET') return adminOverview(ctx, user);
    if (b === 'colleges' && !c && m === 'POST') return adminAddCollege(ctx, user);
    if (b === 'colleges' && c && m === 'PATCH') return adminEditCollege(ctx, user, c);
    if (b === 'colleges' && c && m === 'DELETE') return adminDeleteCollege(ctx, user, c);
    if (b === 'users' && !c && m === 'GET') return adminUsers(ctx, user);
    if (b === 'users' && c && m === 'POST') return adminUserAction(ctx, user, c);
  }

  if (a === 'me' && !b && m === 'GET') return { body: { user: publicUser(user) } };
  if (a === 'me' && !b && m === 'PATCH') return updateMe(ctx, user);
  if (a === 'me' && b === 'password' && m === 'POST') return changePassword(ctx, user);
  if (a === 'me' && b === 'logout-all' && m === 'POST') return signOutEverywhere(ctx, user);
  if (a === 'me' && b === 'activity' && m === 'GET') return myActivity(ctx, user);
  if (a === 'checkin' && m === 'POST') return studentCheckin(ctx, user);
  if (a === 'leave-requests') {
    if (!b && m === 'GET') return listLeave(ctx, user);
    if (b && m === 'POST') return decideLeave(ctx, user, b);
    if (b && m === 'DELETE') return cancelLeave(ctx, user, b);
  }
  if (a === 'notices') {
    if (!b && m === 'GET') return listNotices(ctx, user);
    if (b && m === 'DELETE') return deleteNotice(ctx, user, b);
  }

  if (a === 'timetable') { if (!b && m === 'GET') return listTimetable(ctx, user); if (b && m === 'DELETE') return deleteSlot(ctx, user, b); }
  if (a === 'events') { if (!b && m === 'GET') return listEvents(ctx, user); if (b && m === 'DELETE') return deleteEvent(ctx, user, b); }
  if (a === 'exams') {
    if (!b && m === 'GET') return listExams(ctx, user);
    if (b && !c && m === 'DELETE') return deleteExam(ctx, user, b);
    if (b && c === 'marks' && m === 'GET') return examMarks(ctx, user, b);
    if (b && c === 'marks' && m === 'PUT') return saveMarks(ctx, user, b);
  }
  if (a === 'results' && m === 'GET') return myResults(ctx, user);
  if (a === 'passes') {
    if (!b && m === 'GET') return listPasses(ctx, user);
    if (b && m === 'POST') return decidePass(ctx, user, b);
    if (b && m === 'DELETE') return cancelPass(ctx, user, b);
  }
  if (a === 'tickets') {
    if (!b && m === 'GET') return listTickets(ctx, user);
    if (!b && m === 'POST') return createTicket(ctx, user);
    if (b && c === 'reply' && m === 'POST') return replyTicket(ctx, user, b);
  }
  if (a === 'notifications' && m === 'GET') return notifications(ctx, user);

  if (a === 'classes') {
    if (!b && m === 'GET') return listClasses(ctx, user);
    if (!b && m === 'POST') return createClass(ctx, user);
    if (b === 'join' && m === 'POST') return joinClass(ctx, user);
    if (b && !c && m === 'DELETE') return deleteClass(ctx, user, b);
    if (b && c === 'leave' && m === 'DELETE') return leaveClass(ctx, user, b);
    if (b && c === 'roster' && m === 'GET') return roster(ctx, user, b);
    if (b && c === 'attendance' && m === 'PUT') return saveAttendance(ctx, user, b);
    if (b && c === 'students' && d && m === 'DELETE') return removeStudent(ctx, user, b, d);
    if (b && c === 'leave-requests' && m === 'POST') return requestLeave(ctx, user, b);
    if (b && c === 'notices' && m === 'POST') return addNotice(ctx, user, b);
    if (b && c === 'timetable' && m === 'POST') return addSlot(ctx, user, b);
    if (b && c === 'events' && m === 'POST') return addEvent(ctx, user, b);
    if (b && c === 'exams' && m === 'POST') return addExam(ctx, user, b);
    if (b && c === 'passes' && m === 'POST') return requestPass(ctx, user, b);
    if (b && c === 'checkin' && m === 'POST') return startCheckin(ctx, user, b);
    if (b && c === 'checkin' && m === 'GET') return getCheckin(ctx, user, b);
    if (b && c === 'checkin' && m === 'DELETE') return stopCheckin(ctx, user, b);
  }
  if (a === 'dashboard' && m === 'GET') return teacherDashboard(ctx, user);
  if (a === 'reports' && b && m === 'GET') return classReport(ctx, user, b);
  if (a === 'student' && b === 'summary' && m === 'GET') return studentSummary(ctx, user);
  if (a === 'demo' && m === 'POST') return loadDemo(ctx, user);

  fail(404, 'That endpoint does not exist.');
}

module.exports = { handle, HttpError };
