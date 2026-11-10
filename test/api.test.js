'use strict';
// End-to-end API test against a throwaway SQLite file. Run: npm test
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attendly-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.MAIL_STUB = '1';
process.env.SHOW_OTP = 'true';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
const api = require('../api/[...path].js');

const server = http.createServer(api);
let base;
async function call(method, url, body, token) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

async function signup(role, name, email, extra = {}) {
  let r = await call('POST', '/auth/register', { name, email, phone: '9876543210', password: 'Strong#Pass1', role, ...extra });
  assert.equal(r.status, 201, 'register ' + email + ' ' + JSON.stringify(r.data));
  assert.equal(r.data.pending, true);
  r = await call('POST', '/auth/verify', { email, code: r.data.devOtp });
  assert.equal(r.status, 200, 'verify ' + JSON.stringify(r.data));
  return { token: r.data.token, id: r.data.user.id, email };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
  let n = 0;
  const ok = (name) => console.log('  ok', ++n, name);

  // ---- sign up rules ----
  const good = { name: 'Prof Rao', email: 'Rao@School.edu', phone: '98765 43210', role: 'teacher' };
  let r = await call('POST', '/auth/register', { ...good, password: 'short1' }); assert.equal(r.status, 400); ok('short password rejected');
  r = await call('POST', '/auth/register', { ...good, password: 'onlyletters' }); assert.equal(r.status, 400); ok('password without a number rejected');
  r = await call('POST', '/auth/register', { ...good, password: 'Password123' }); assert.equal(r.status, 400); ok('common password rejected');
  r = await call('POST', '/auth/register', { ...good, password: 'Strong#Pass1', phone: '' }); assert.equal(r.status, 400); ok('phone number is required');
  r = await call('POST', '/auth/register', { ...good, password: 'Strong#Pass1', phone: '12ab' }); assert.equal(r.status, 400); ok('bad phone number rejected');

  // ---- email code (OTP) ----
  r = await call('POST', '/auth/register', { ...good, password: 'Strong#Pass1' });
  assert.equal(r.status, 201); assert.equal(r.data.pending, true); assert.ok(!r.data.token); const code1 = r.data.devOtp; ok('register sends code, gives no token yet');
  assert.ok(global.__mailbox.length >= 1 && global.__mailbox[0].to === 'rao@school.edu' && global.__mailbox[0].text.includes(code1)); ok('email contains the code and goes to the typed address');
  r = await call('POST', '/auth/register', { ...good, password: 'Strong#Pass1' }); assert.equal(r.status, 429); ok('asking for a second code within a minute is blocked');
  r = await call('POST', '/auth/login', { email: 'rao@school.edu', password: 'Strong#Pass1' });
  assert.equal(r.status, 403); assert.equal(r.data.needsVerify, true); ok('cannot sign in before email is verified');
  r = await call('POST', '/auth/verify', { email: 'rao@school.edu', code: '000000' }); assert.equal(r.status, 400); ok('wrong code rejected');
  for (let i = 0; i < 4; i++) await call('POST', '/auth/verify', { email: 'rao@school.edu', code: '111111' });
  r = await call('POST', '/auth/verify', { email: 'rao@school.edu', code: code1 }); assert.equal(r.status, 429); ok('after 5 wrong tries even the right code is refused');

  // fresh signup flows from here (new emails)
  const T = await signup('teacher', 'Prof Mehta', 'mehta@school.edu'); ok('teacher signs up and verifies');
  r = await call('GET', '/me'); assert.equal(r.status, 401);
  r = await call('GET', '/me', null, T.token + 'x'); assert.equal(r.status, 401); ok('missing or tampered token = 401');
  r = await call('GET', '/me', null, T.token); assert.equal(r.data.user.phone, '9876543210'); ok('phone number saved on profile');

  // ---- wrong passwords lock the account ----
  const L = await signup('student', 'Lock Test', 'lock@mail.com');
  for (let i = 0; i < 4; i++) { r = await call('POST', '/auth/login', { email: L.email, password: 'wrong-pass-9' }); assert.equal(r.status, 401); }
  r = await call('POST', '/auth/login', { email: L.email, password: 'wrong-pass-9' }); assert.equal(r.status, 401);
  r = await call('POST', '/auth/login', { email: L.email, password: 'Strong#Pass1' }); assert.equal(r.status, 423); ok('5 wrong passwords lock the account (right password refused while locked)');

  // ---- forgot + reset password ----
  r = await call('POST', '/auth/forgot', { email: 'nobody@nowhere.com' });
  assert.equal(r.status, 200); assert.ok(!r.data.devOtp); ok('forgot password gives the same answer for unknown emails');
  r = await call('POST', '/auth/forgot', { email: L.email }); assert.equal(r.status, 200); const rc = r.data.devOtp; assert.ok(rc);
  r = await call('POST', '/auth/reset', { email: L.email, code: rc, password: 'weak' }); assert.equal(r.status, 400);
  r = await call('POST', '/auth/reset', { email: L.email, code: '123450', password: 'Brand#New77' }); assert.equal(r.status, 400); ok('reset needs the right code and a strong password');
  r = await call('POST', '/auth/reset', { email: L.email, code: rc, password: 'Brand#New77' }); assert.equal(r.status, 200);
  r = await call('GET', '/me', null, L.token); assert.equal(r.status, 401); ok('reset signs out old sessions');
  r = await call('POST', '/auth/login', { email: L.email, password: 'Brand#New77' }); assert.equal(r.status, 200); const Ltoken = r.data.token; ok('reset clears the lock and new password works');

  // ---- change password / sign out everywhere / activity ----
  r = await call('POST', '/me/password', { current: 'nope', next: 'Another#Pass8' }, Ltoken); assert.equal(r.status, 400);
  r = await call('POST', '/me/password', { current: 'Brand#New77', next: 'Another#Pass8' }, Ltoken); assert.equal(r.status, 200);
  const newTok = r.data.token;
  r = await call('GET', '/me', null, Ltoken); assert.equal(r.status, 401);
  r = await call('GET', '/me', null, newTok); assert.equal(r.status, 200); ok('change password keeps this session, ends the others');
  r = await call('POST', '/me/logout-all', null, newTok); assert.equal(r.status, 200);
  r = await call('GET', '/me', null, newTok); assert.equal(r.status, 401); ok('sign out of all devices');
  r = await call('POST', '/auth/login', { email: L.email, password: 'Another#Pass8' }); const act = await call('GET', '/me/activity', null, r.data.token);
  assert.ok(act.data.items.length >= 3 && act.data.items.some((i) => /Password changed/.test(i.action))); ok('activity log records security events');

  // ---- classes, join, attendance (core) ----
  r = await call('POST', '/classes', { name: 'Maths', code: 'MA-1', emoji: '📐' }, T.token);
  assert.equal(r.status, 201); const C = r.data.class; assert.equal(C.joinCode.length, 6); ok('class created with join code');
  const S = [];
  for (const nm of ['Asha', 'Bilal', 'Chitra']) S.push(await signup('student', nm + ' K', nm.toLowerCase() + '@mail.com', { rollNo: 'R-' + nm }));
  for (const s of S) { r = await call('POST', '/classes/join', { code: C.joinCode.toLowerCase() }, s.token); assert.equal(r.status, 201); }
  r = await call('POST', '/classes/join', { code: C.joinCode }, S[0].token); assert.equal(r.status, 409);
  r = await call('POST', '/classes/join', { code: C.joinCode }, T.token); assert.equal(r.status, 403); ok('students join; duplicate and teacher joins blocked');
  r = await call('GET', `/classes/${C.id}/roster?date=${today}`, null, T.token);
  assert.equal(r.data.students.length, 3); assert.equal(r.data.students[0].phone, '9876543210'); assert.equal(r.data.students[0].rollNo, 'R-Asha'); ok('teacher sees phone and roll number');
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [
    { studentId: S[0].id, status: 'present' }, { studentId: S[1].id, status: 'absent' }, { studentId: S[2].id, status: 'late' } ] }, T.token);
  assert.equal(r.status, 200);
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [{ studentId: S[1].id, status: 'present' }] }, T.token); assert.equal(r.status, 200); ok('attendance saved and updated');
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [{ studentId: S[1].id, status: 'nope' }] }, T.token); assert.equal(r.status, 400);
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: '2999-01-01', records: [{ studentId: S[1].id, status: 'present' }] }, T.token); assert.equal(r.status, 400);
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [{ studentId: S[0].id, status: 'present' }] }, S[0].token); assert.equal(r.status, 403); ok('bad status, future date and student writes are refused');
  const T2 = await signup('teacher', 'Other Teacher', 'other@school.edu');
  r = await call('GET', `/classes/${C.id}/roster`, null, T2.token); assert.equal(r.status, 404); ok('other teacher is locked out');
  await call('PUT', `/classes/${C.id}/attendance`, { date: yesterday, records: [
    { studentId: S[0].id, status: 'present' }, { studentId: S[1].id, status: 'absent' }, { studentId: S[2].id, status: 'leave' } ] }, T.token);
  r = await call('GET', '/dashboard', null, T.token);
  assert.equal(r.data.totals.students, 3); assert.equal(r.data.atRisk.length, 1); assert.equal(r.data.atRisk[0].name, 'Bilal K'); ok('dashboard totals and at-risk list');
  r = await call('GET', `/reports/${C.id}`, null, T.token);
  assert.equal(r.data.rows.find((x) => x.name === 'Chitra K').rate, 100); ok('report: late counts, leave is excused');

  // ---- leave requests ----
  r = await call('POST', `/classes/${C.id}/leave-requests`, { date: nextWeek, reason: 'Family function' }, S[0].token); assert.equal(r.status, 201);
  r = await call('POST', `/classes/${C.id}/leave-requests`, { date: nextWeek, reason: 'Again' }, S[0].token); assert.equal(r.status, 409);
  r = await call('POST', `/classes/${C.id}/leave-requests`, { date: nextWeek, reason: 'Hi' }, S[1].token); assert.equal(r.status, 400); ok('student asks for leave; duplicates and empty reasons refused');
  r = await call('POST', `/classes/${C.id}/leave-requests`, { date: today, reason: 'Fever since morning' }, S[1].token); assert.equal(r.status, 201);
  r = await call('GET', '/leave-requests', null, T.token); assert.equal(r.data.items.length, 2); assert.equal(r.data.items[0].status, 'pending'); const reqs = r.data.items;
  r = await call('GET', '/dashboard', null, T.token); assert.equal(r.data.pendingRequests, 2); ok('teacher sees pending requests');
  r = await call('GET', '/leave-requests', null, T2.token); assert.equal(r.data.items.length, 0);
  r = await call('POST', '/leave-requests/' + reqs[0].id, { decision: 'approve' }, T2.token); assert.equal(r.status, 404); ok('other teacher cannot decide requests');
  const sick = reqs.find((x) => x.student === 'Bilal K'), fam = reqs.find((x) => x.student === 'Asha K');
  r = await call('POST', '/leave-requests/' + fam.id, { decision: 'approve' }, T.token); assert.equal(r.status, 200);
  r = await call('POST', '/leave-requests/' + fam.id, { decision: 'reject' }, T.token); assert.equal(r.status, 409);
  r = await call('POST', '/leave-requests/' + sick.id, { decision: 'reject' }, T.token); assert.equal(r.status, 200);
  r = await call('GET', `/classes/${C.id}/roster?date=${nextWeek}`, null, T.token);
  assert.equal(r.data.students.find((x) => x.name === 'Asha K').status, 'leave'); ok('approving marks the day as leave; rejecting does not');
  r = await call('GET', '/student/summary', null, S[1].token); assert.equal(r.data.requests[0].status, 'rejected'); ok('student sees the decision');

  // ---- notices ----
  r = await call('POST', `/classes/${C.id}/notices`, { body: 'Test on Monday. Bring a calculator.' }, T.token); assert.equal(r.status, 201);
  r = await call('POST', `/classes/${C.id}/notices`, { body: 'Hack' }, S[0].token); assert.equal(r.status, 403);
  r = await call('GET', '/student/summary', null, S[0].token); assert.equal(r.data.notices.length, 1); ok('teacher posts a notice; students see it; students cannot post');
  r = await call('GET', '/notices', null, T.token); r = await call('DELETE', '/notices/' + r.data.items[0].id, null, T2.token); assert.equal(r.status, 404); ok('other teacher cannot delete notices');

  // ---- live check-in code ----
  r = await call('POST', `/classes/${C.id}/checkin`, { minutes: 10, date: today }, S[0].token); assert.equal(r.status, 403);
  r = await call('POST', `/classes/${C.id}/checkin`, { minutes: 10, date: today }, T.token); assert.equal(r.status, 201); const ck = r.data.code; assert.equal(ck.length, 6);
  const out = await signup('student', 'Outsider', 'outsider@mail.com');
  r = await call('POST', '/checkin', { code: ck }, out.token); assert.equal(r.status, 404); ok('student outside the class cannot use the code');
  r = await call('POST', '/checkin', { code: '123456' }, S[2].token); assert.equal(r.status, 404);
  await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [{ studentId: S[2].id, status: 'absent' }] }, T.token);
  r = await call('POST', '/checkin', { code: ck }, S[2].token); assert.equal(r.status, 200);
  r = await call('GET', `/classes/${C.id}/roster?date=${today}`, null, T.token); assert.equal(r.data.students.find((x) => x.name === 'Chitra K').status, 'present'); ok('right code marks the student present');
  r = await call('GET', `/classes/${C.id}/checkin`, null, T.token); assert.equal(r.data.active.code, ck);
  r = await call('DELETE', `/classes/${C.id}/checkin`, null, T.token);
  r = await call('POST', '/checkin', { code: ck }, S[0].token); assert.equal(r.status, 404); ok('closing the check-in stops the code');

  // ---- campus: timetable, calendar, exams, results, passes, help desk ----
  r = await call('POST', `/classes/${C.id}/timetable`, { day: 1, start: '09:00', end: '10:00', room: 'B-12' }, S[0].token); assert.equal(r.status, 403);
  r = await call('POST', `/classes/${C.id}/timetable`, { day: 1, start: '10:00', end: '09:00' }, T.token); assert.equal(r.status, 400);
  r = await call('POST', `/classes/${C.id}/timetable`, { day: 1, start: '09:00', end: '10:00', room: 'B-12' }, T.token); assert.equal(r.status, 201);
  r = await call('GET', '/timetable', null, S[0].token); assert.equal(r.data.items.length, 1); assert.equal(r.data.items[0].room, 'B-12');
  r = await call('GET', '/timetable', null, out.token); assert.equal(r.data.items.length, 0); ok('timetable: teacher sets it, enrolled students see it, outsiders do not');
  r = await call('POST', `/classes/${C.id}/events`, { title: 'Diwali break', date: nextWeek, kind: 'holiday' }, T.token); assert.equal(r.status, 201);
  r = await call('POST', `/classes/${C.id}/events`, { title: 'x', date: 'bad' }, T.token); assert.equal(r.status, 400);
  r = await call('GET', '/events', null, S[0].token); assert.equal(r.data.items[0].kind, 'holiday'); ok('academic calendar events');
  r = await call('POST', `/classes/${C.id}/exams`, { title: 'Mid-term', date: nextWeek, start: '10:00', room: 'Hall 1', maxMarks: 50 }, T.token); assert.equal(r.status, 201);
  r = await call('GET', '/exams', null, T.token); const ex = r.data.items[0]; assert.equal(ex.maxMarks, 50);
  r = await call('PUT', `/exams/${ex.id}/marks`, { marks: [{ studentId: S[0].id, score: 60 }] }, T.token); assert.equal(r.status, 400); ok('marks above the maximum are rejected');
  r = await call('PUT', `/exams/${ex.id}/marks`, { marks: [{ studentId: S[0].id, score: 42 }, { studentId: out.id, score: 40 }] }, T.token); assert.equal(r.status, 200);
  r = await call('PUT', `/exams/${ex.id}/marks`, { marks: [{ studentId: S[0].id, score: 42 }] }, T2.token); assert.equal(r.status, 404);
  r = await call('GET', '/results', null, S[0].token); assert.equal(r.data.items[0].percent, 84); assert.equal(r.data.items[0].grade, 'A'); assert.equal(r.data.average, 84);
  r = await call('GET', '/results', null, out.token); assert.equal(r.data.items.length, 0); ok('exam marks, results and grades; only enrolled students; other teacher blocked');
  r = await call('POST', `/classes/${C.id}/passes`, { kind: 'Gate pass', from: today, to: nextWeek, reason: 'Family function' }, S[0].token); assert.equal(r.status, 201);
  r = await call('POST', `/classes/${C.id}/passes`, { kind: 'Gate pass', from: nextWeek, to: today, reason: 'bad dates' }, S[0].token); assert.equal(r.status, 400);
  r = await call('POST', `/classes/${C.id}/passes`, { kind: 'Gate pass', from: today, to: today, reason: 'No' }, out.token); assert.equal(r.status, 404);
  r = await call('GET', '/passes', null, T.token); const ps = r.data.items[0]; assert.equal(ps.status, 'pending');
  r = await call('POST', '/passes/' + ps.id, { decision: 'approve' }, T2.token); assert.equal(r.status, 404);
  r = await call('POST', '/passes/' + ps.id, { decision: 'approve' }, T.token); assert.equal(r.status, 200);
  r = await call('GET', '/passes', null, S[0].token); assert.equal(r.data.items[0].status, 'approved'); ok('gate pass request and approval');
  r = await call('POST', '/tickets', { kind: 'grievance', classId: C.id, subject: 'Projector broken', message: 'The projector in room B-12 has not worked for a week.' }, S[0].token); assert.equal(r.status, 201);
  r = await call('POST', '/tickets', { kind: 'feedback', classId: C.id, subject: 'Hi', message: 'short' }, S[0].token); assert.equal(r.status, 400);
  r = await call('GET', '/tickets', null, T.token); const tk = r.data.items[0];
  r = await call('POST', `/tickets/${tk.id}/reply`, { reply: 'We will fix it this week.' }, S[0].token); assert.equal(r.status, 403);
  r = await call('POST', `/tickets/${tk.id}/reply`, { reply: 'We will fix it this week.' }, T.token); assert.equal(r.status, 200);
  r = await call('GET', '/tickets', null, S[0].token); assert.equal(r.data.items[0].status, 'resolved'); ok('help desk: student writes, teacher replies');
  r = await call('GET', '/notifications', null, S[0].token); assert.ok(r.data.items.length >= 3); ok('notifications centre');
  r = await call('DELETE', '/exams/' + ex.id, null, T.token); assert.equal(r.status, 200);

  // ---- settings, demo, cleanup ----
  r = await call('PATCH', '/me', { threshold: 150 }, T.token); assert.equal(r.status, 400);
  r = await call('PATCH', '/me', { threshold: 60, phone: '+919812345678' }, T.token); assert.equal(r.data.user.threshold, 60); assert.equal(r.data.user.phone, '+919812345678'); ok('profile settings');
  r = await call('POST', '/demo', null, T2.token); assert.equal(r.status, 201);
  r = await call('GET', '/dashboard', null, T2.token); assert.equal(r.data.totals.students, 12); assert.ok(r.data.heat.length > 20);
  r = await call('DELETE', `/classes/${r.data.classes[0].id}`, null, T2.token); assert.equal(r.status, 200); ok('sample class loads and deletes cleanly');
  r = await call('DELETE', `/classes/${C.id}/leave`, null, S[2].token); assert.equal(r.status, 200);
  r = await call('DELETE', `/classes/${C.id}/students/${S[1].id}`, null, T.token); assert.equal(r.status, 200); ok('leave class and remove student');
  r = await call('GET', '/nothing', null, T.token); assert.equal(r.status, 404); ok('unknown route is 404');

  console.log(`\nAll ${n} checks passed.`);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', e.stack); process.exit(1); });
