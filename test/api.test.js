'use strict';
// End-to-end API test against a throwaway SQLite file. Run: npm test
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attendly-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
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

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
  let n = 0;
  const ok = (name) => console.log('  ok', ++n, name);

  // auth
  let r = await call('POST', '/auth/register', { name: 'T', email: 'bad', password: 'x', role: 'teacher' });
  assert.equal(r.status, 400); ok('register validates input');
  r = await call('POST', '/auth/register', { name: 'Prof Rao', email: 'Rao@School.edu', password: 'longpassword', role: 'teacher' });
  assert.equal(r.status, 201); const T = r.data.token; ok('teacher registers');
  r = await call('POST', '/auth/register', { name: 'Prof Rao', email: 'rao@school.edu', password: 'longpassword', role: 'teacher' });
  assert.equal(r.status, 409); ok('duplicate email blocked (case-insensitive)');
  r = await call('POST', '/auth/login', { email: 'rao@school.edu', password: 'wrongwrong' });
  assert.equal(r.status, 401); ok('wrong password rejected');
  r = await call('POST', '/auth/login', { email: 'rao@school.edu', password: 'longpassword' });
  assert.equal(r.status, 200); ok('login works');
  r = await call('GET', '/me'); assert.equal(r.status, 401); ok('no token = 401');
  r = await call('GET', '/me', null, T + 'x'); assert.equal(r.status, 401); ok('tampered token = 401');

  // classes
  r = await call('POST', '/classes', { name: 'Maths', code: 'MA-1', emoji: '📐' }, T);
  assert.equal(r.status, 201); const C = r.data.class; assert.equal(C.joinCode.length, 6); ok('class created with join code');

  // students
  const S = [];
  for (const nm of ['Asha', 'Bilal', 'Chitra']) {
    r = await call('POST', '/auth/register', { name: nm + ' K', email: nm.toLowerCase() + '@mail.com', password: 'studentpass', role: 'student' });
    assert.equal(r.status, 201); S.push({ token: r.data.token, id: r.data.user.id });
  }
  r = await call('POST', '/classes/join', { code: 'ZZZZZZ' }, S[0].token); assert.equal(r.status, 404); ok('bad join code');
  for (const s of S) { r = await call('POST', '/classes/join', { code: C.joinCode.toLowerCase() }, s.token); assert.equal(r.status, 201); }
  r = await call('POST', '/classes/join', { code: C.joinCode }, S[0].token); assert.equal(r.status, 409); ok('students join, duplicate join blocked');
  r = await call('POST', '/classes/join', { code: C.joinCode }, T); assert.equal(r.status, 403); ok('teacher cannot join as student');

  // attendance
  r = await call('GET', `/classes/${C.id}/roster?date=${today}`, null, T);
  assert.equal(r.data.students.length, 3); assert.equal(r.data.students[0].status, null); ok('roster lists 3 students');
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [
    { studentId: S[0].id, status: 'present' }, { studentId: S[1].id, status: 'absent' }, { studentId: S[2].id, status: 'late' } ] }, T);
  assert.equal(r.status, 200); ok('attendance saved');
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [{ studentId: S[1].id, status: 'present' }] }, T);
  assert.equal(r.status, 200); ok('attendance update (upsert)');
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [{ studentId: S[1].id, status: 'nope' }] }, T);
  assert.equal(r.status, 400); ok('invalid status rejected');
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: '2999-01-01', records: [{ studentId: S[1].id, status: 'present' }] }, T);
  assert.equal(r.status, 400); ok('future date rejected');
  r = await call('PUT', `/classes/${C.id}/attendance`, { date: today, records: [{ studentId: S[0].id, status: 'present' }] }, S[0].token);
  assert.equal(r.status, 403); ok('student cannot mark attendance');

  // second teacher cannot touch first teacher's class
  r = await call('POST', '/auth/register', { name: 'Other Teacher', email: 'other@school.edu', password: 'longpassword', role: 'teacher' });
  const T2 = r.data.token;
  r = await call('GET', `/classes/${C.id}/roster`, null, T2); assert.equal(r.status, 404); ok('other teacher is locked out');

  // dashboard + report + student view
  await call('PUT', `/classes/${C.id}/attendance`, { date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), records: [
    { studentId: S[0].id, status: 'present' }, { studentId: S[1].id, status: 'absent' }, { studentId: S[2].id, status: 'leave' } ] }, T);
  r = await call('GET', '/dashboard', null, T);
  assert.equal(r.data.totals.students, 3); assert.equal(r.data.totals.classes, 1);
  assert.equal(r.data.atRisk.length, 1); assert.equal(r.data.atRisk[0].name, 'Bilal K'); ok('dashboard totals + at-risk');
  r = await call('GET', `/reports/${C.id}`, null, T);
  const asha = r.data.rows.find((x) => x.name === 'Asha K'); assert.equal(asha.rate, 100);
  const chitra = r.data.rows.find((x) => x.name === 'Chitra K'); assert.equal(chitra.rate, 100); assert.equal(chitra.leave, 1); ok('report: leave is excused, late counts as attended');
  r = await call('GET', '/student/summary', null, S[1].token);
  assert.equal(r.data.overall.rate, 50); assert.equal(r.data.history.length, 2); ok('student summary');
  r = await call('GET', '/dashboard', null, S[1].token); assert.equal(r.status, 403); ok('student blocked from teacher dashboard');

  // settings
  r = await call('PATCH', '/me', { threshold: 150 }, T); assert.equal(r.status, 400);
  r = await call('PATCH', '/me', { threshold: 60 }, T); assert.equal(r.data.user.threshold, 60); ok('threshold setting');

  // demo
  r = await call('POST', '/demo', null, T2); assert.equal(r.status, 201);
  r = await call('POST', '/demo', null, T2); assert.equal(r.status, 409);
  r = await call('GET', '/dashboard', null, T2);
  assert.equal(r.data.totals.students, 12); assert.ok(r.data.totals.rate > 50); assert.ok(r.data.heat.length > 20); ok('sample class loads (12 students, history)');
  const demoId = r.data.classes[0].id;
  r = await call('DELETE', `/classes/${demoId}`, null, T2); assert.equal(r.status, 200);
  r = await call('GET', '/dashboard', null, T2); assert.equal(r.data.totals.classes, 0); ok('sample class deletes cleanly');

  // leave / remove / delete
  r = await call('DELETE', `/classes/${C.id}/leave`, null, S[2].token); assert.equal(r.status, 200);
  r = await call('DELETE', `/classes/${C.id}/students/${S[1].id}`, null, T); assert.equal(r.status, 200);
  r = await call('GET', `/classes/${C.id}/roster`, null, T); assert.equal(r.data.students.length, 1); ok('leave class + remove student');
  r = await call('GET', '/nothing', null, T); assert.equal(r.status, 404); ok('unknown route 404');

  console.log(`\nAll ${n} checks passed.`);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', e.stack); process.exit(1); });
