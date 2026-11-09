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
];

let ready = null;

async function query(text, params) {
  if (!exec) exec = PG_URL ? makePg() : makeSqlite();
  if (!ready) {
    ready = (async () => {
      for (const stmt of SCHEMA) await exec(stmt, []);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
  return exec(text, params);
}

module.exports = { query, usingPostgres: () => !!PG_URL };
