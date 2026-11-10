'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SECRET =
  process.env.AUTH_SECRET ||
  crypto
    .createHash('sha256')
    .update('attendly:' + (process.env.DATABASE_URL || process.env.POSTGRES_URL || 'local-dev-only'))
    .digest('hex');

const TOKEN_DAYS = 7;
const b64 = (buf) => Buffer.from(buf).toString('base64url');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return salt.toString('hex') + ':' + key.toString('hex');
}

async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = String(stored || '').split(':');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function createToken(user) {
  return sign({ sub: user.id, role: user.role, v: Number(user.token_ver) || 0, exp: Date.now() + TOKEN_DAYS * 86400000 });
}

function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

const hmac = (text) => crypto.createHmac('sha256', SECRET).update(String(text)).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

module.exports = { hashPassword, verifyPassword, createToken, readToken, hmac, safeEqual };
