'use strict';
const crypto = require('crypto');
const { query } = require('./db');
const { hashPassword, verifyPassword, createToken, readToken } = require('./auth');

const STATUSES = ['present', 'late', 'absent', 'leave'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
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
  threshold: num(u.threshold),
});

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
  const rows = await query('SELECT * FROM users WHERE id = $1', [p.sub]);
  if (!rows[0]) fail(401, 'Please sign in again.');
  return rows[0];
}
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
  const role = b.role === 'teacher' ? 'teacher' : b.role === 'student' ? 'student' : '';
  const password = String(b.password || '');
  if (name.length < 2) fail(400, 'Enter your full name.');
  if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email address.');
  if (email.endsWith('@demo.attendly')) fail(400, 'Use a real email address.');
  if (!role) fail(400, 'Choose teacher or student.');
  if (password.length < 8) fail(400, 'Password needs at least 8 characters.');
  if (password.length > 100) fail(400, 'Password is too long.');
  const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists[0]) fail(409, 'An account with this email already exists. Sign in instead.');
  const user = { id: uuid(), name, email, role, threshold: 75 };
  await query(
    'INSERT INTO users (id, name, email, pass_hash, role, threshold, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [user.id, name, email, await hashPassword(password), role, 75, nowIso()]
  );
  return { status: 201, body: { token: createToken(user), user: publicUser(user) } };
}

async function login(ctx) {
  const b = ctx.body || {};
  const email = cleanText(b.email, 120).toLowerCase();
  const key = (ctx.ip || '') + '|' + email;
  checkAttempts(key);
  const rows = await query('SELECT * FROM users WHERE email = $1', [email]);
  const ok = rows[0] && (await verifyPassword(String(b.password || ''), rows[0].pass_hash));
  if (!ok) {
    noteAttempt(key);
    fail(401, 'Email or password is wrong.');
  }
  return { body: { token: createToken(rows[0]), user: publicUser(rows[0]) } };
}

async function updateMe(ctx, user) {
  const b = ctx.body || {};
  const name = b.name === undefined ? user.name : cleanText(b.name, 60);
  let threshold = b.threshold === undefined ? num(user.threshold) : Math.round(Number(b.threshold));
  if (name.length < 2) fail(400, 'Enter your full name.');
  if (!(threshold >= 1 && threshold <= 100)) fail(400, 'Minimum attendance must be between 1 and 100.');
  await query('UPDATE users SET name = $1, threshold = $2 WHERE id = $3', [name, threshold, user.id]);
  return { body: { user: publicUser({ ...user, name, threshold }) } };
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
  needRole(user, 'teacher');
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
    'SELECT c.id, c.name, u.name AS teacher FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.join_code = $1',
    [code]
  );
  if (!rows[0]) fail(404, 'No class uses that code. Check it with your teacher.');
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
    `SELECT u.id, u.name, u.email FROM enrollments e JOIN users u ON u.id = e.student_id
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
        id: s.id, name: s.name, email: s.email,
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
    classes, atRisk: [], trend: [], heat: [], mix: { present: 0, late: 0, absent: 0, leave: 0 },
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
    },
  };
}

async function classReport(ctx, user, classId) {
  const cls = await teacherClass(user, classId);
  const students = await query(
    `SELECT u.id, u.name, u.email FROM enrollments e JOIN users u ON u.id = e.student_id
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
      rows: students.map((s) => ({ id: s.id, name: s.name, email: s.email, ...(byId[s.id] || shapeCounts({})) })),
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
  return {
    body: {
      overall: shapeCounts(total),
      classes,
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
  needRole(user, 'teacher');
  const exists = await query('SELECT id FROM classes WHERE teacher_id = $1 AND is_demo = 1', [user.id]);
  if (exists[0]) fail(409, 'Sample class is already loaded.');
  const classId = uuid();
  await query(
    'INSERT INTO classes (id, teacher_id, name, code, emoji, join_code, is_demo, created_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7)',
    [classId, user.id, 'Sample: Data Structures', 'DEMO-101', '🧪', await uniqueJoinCode(), nowIso()]
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

// ---------- router ----------
async function handle(ctx) {
  const [a, b, c, d] = ctx.segs;
  const m = ctx.method;

  if (a === 'health' && m === 'GET') {
    await query('SELECT 1 AS ok', []);
    return { body: { ok: true } };
  }
  if (a === 'auth' && b === 'register' && m === 'POST') return register(ctx);
  if (a === 'auth' && b === 'login' && m === 'POST') return login(ctx);

  const user = await userFrom(ctx);

  if (a === 'me' && m === 'GET') return { body: { user: publicUser(user) } };
  if (a === 'me' && m === 'PATCH') return updateMe(ctx, user);

  if (a === 'classes') {
    if (!b && m === 'GET') return listClasses(ctx, user);
    if (!b && m === 'POST') return createClass(ctx, user);
    if (b === 'join' && m === 'POST') return joinClass(ctx, user);
    if (b && !c && m === 'DELETE') return deleteClass(ctx, user, b);
    if (b && c === 'leave' && m === 'DELETE') return leaveClass(ctx, user, b);
    if (b && c === 'roster' && m === 'GET') return roster(ctx, user, b);
    if (b && c === 'attendance' && m === 'PUT') return saveAttendance(ctx, user, b);
    if (b && c === 'students' && d && m === 'DELETE') return removeStudent(ctx, user, b, d);
  }
  if (a === 'dashboard' && m === 'GET') return teacherDashboard(ctx, user);
  if (a === 'reports' && b && m === 'GET') return classReport(ctx, user, b);
  if (a === 'student' && b === 'summary' && m === 'GET') return studentSummary(ctx, user);
  if (a === 'demo' && m === 'POST') return loadDemo(ctx, user);

  fail(404, 'That endpoint does not exist.');
}

module.exports = { handle, HttpError };
