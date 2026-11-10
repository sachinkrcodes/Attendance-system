'use strict';
// One small database layer, two engines:
//  - DATABASE_URL set  -> Postgres through Neon (used on Vercel)
//  - not set           -> SQLite file in .data/ (used for local runs and tests)
// All SQL below uses $1, $2 placeholders and syntax that works on both.

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
let exec = null;

function makePg() {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(PG_URL);
  return async (text, params = []) => sql.query(text, params);
}

function makeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('fs');
  const path = require('path');
  const dir = process.env.SQLITE_DIR || path.join(process.cwd(), '.data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(process.env.SQLITE_FILE || path.join(dir, 'attendly.db'));
  return async (text, params = []) => {
    const q = text.replace(/\$(\d+)/g, '?$1');
    const rows = db.prepare(q).all(...params.map((v) => (v === undefined ? null : v)));
    return rows.map((r) => ({ ...r }));
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     pass_hash TEXT NOT NULL,
     role TEXT NOT NULL,
     threshold INTEGER NOT NULL DEFAULT 75,
     created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS classes (
     id TEXT PRIMARY KEY,
     teacher_id TEXT NOT NULL,
     name TEXT NOT NULL,
     code TEXT,
     emoji TEXT,
     join_code TEXT NOT NULL UNIQUE,
     is_demo INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS enrollments (
     class_id TEXT NOT NULL,
     student_id TEXT NOT NULL,
     joined_at TEXT NOT NULL,
     PRIMARY KEY (class_id, student_id))`,
  `CREATE TABLE IF NOT EXISTS attendance (
     class_id TEXT NOT NULL,
     student_id TEXT NOT NULL,
     date TEXT NOT NULL,
     status TEXT NOT NULL,
     PRIMARY KEY (class_id, student_id, date))`,
  `CREATE INDEX IF NOT EXISTS idx_att_class_date ON attendance (class_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_att_student ON attendance (student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_enr_student ON enrollments (student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes (teacher_id)`,
  `CREATE TABLE IF NOT EXISTS otps (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     purpose TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_otps_email ON otps (email, purpose)`,
  `CREATE TABLE IF NOT EXISTS activity (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     action TEXT NOT NULL,
     detail TEXT,
     ip TEXT,
     created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_user ON activity (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS leave_requests (
     id TEXT PRIMARY KEY,
     class_id TEXT NOT NULL,
     student_id TEXT NOT NULL,
     date TEXT NOT NULL,
     reason TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TEXT NOT NULL,
     decided_at TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_unique ON leave_requests (class_id, student_id, date)`,
  `CREATE TABLE IF NOT EXISTS announcements (
     id TEXT PRIMARY KEY,
     class_id TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_ann_class ON announcements (class_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS checkins (
     id TEXT PRIMARY KEY,
     class_id TEXT NOT NULL,
     date TEXT NOT NULL,
     code TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_checkins_class ON checkins (class_id)`,
  `CREATE TABLE IF NOT EXISTS timetable (
     id TEXT PRIMARY KEY, class_id TEXT NOT NULL, day INTEGER NOT NULL,
     start_time TEXT NOT NULL, end_time TEXT NOT NULL, room TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_tt_class ON timetable (class_id)`,
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY, class_id TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'event', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_events_class ON events (class_id, date)`,
  `CREATE TABLE IF NOT EXISTS exams (
     id TEXT PRIMARY KEY, class_id TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
     start_time TEXT, room TEXT, max_marks INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_exams_class ON exams (class_id, date)`,
  `CREATE TABLE IF NOT EXISTS marks (
     exam_id TEXT NOT NULL, student_id TEXT NOT NULL, score REAL NOT NULL,
     PRIMARY KEY (exam_id, student_id))`,
  `CREATE TABLE IF NOT EXISTS passes (
     id TEXT PRIMARY KEY, class_id TEXT NOT NULL, student_id TEXT NOT NULL, kind TEXT NOT NULL,
     from_date TEXT NOT NULL, to_date TEXT NOT NULL, reason TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_passes_class ON passes (class_id, status)`,
  `CREATE TABLE IF NOT EXISTS tickets (
     id TEXT PRIMARY KEY, class_id TEXT NOT NULL, student_id TEXT NOT NULL, kind TEXT NOT NULL,
     subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
     reply TEXT, created_at TEXT NOT NULL, replied_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_class ON tickets (class_id, status)`,
  `CREATE TABLE IF NOT EXISTS colleges (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, code TEXT,
     active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
];

// Added later. Each one is tried once; "already exists" errors are fine.
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN phone TEXT`,
  `ALTER TABLE users ADD COLUMN roll_no TEXT`,
  `ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN locked_until TEXT`,
  `ALTER TABLE users ADD COLUMN token_ver INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN college_id TEXT`,
  `ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`,
];

let ready = null;

async function query(text, params) {
  if (!exec) exec = PG_URL ? makePg() : makeSqlite();
  if (!ready) {
    ready = (async () => {
      for (const stmt of SCHEMA) await exec(stmt, []);
      for (const stmt of MIGRATIONS) {
        try { await exec(stmt, []); } catch (e) {
          if (!/duplicate column|already exists/i.test(String(e && e.message))) throw e;
        }
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
  return exec(text, params);
}

module.exports = { query, usingPostgres: () => !!PG_URL };
