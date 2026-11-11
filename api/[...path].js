'use strict';
const { handle, HttpError } = require('../lib/routes');

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
    }
    if (Buffer.isBuffer(req.body)) {
      try { return JSON.parse(req.body.toString() || '{}'); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
    }
    return req.body;
  }
  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://localhost');
    // Vercel rewrite sends /api/<anything> to /api/index?p=<anything>
    let pathname = url.pathname;
    if (url.searchParams.has('p')) { pathname = '/api/' + url.searchParams.get('p'); url.searchParams.delete('p'); }
    const segs = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
    const out = await handle({
      method: req.method,
      segs,
      query: Object.fromEntries(url.searchParams),
      body: await readBody(req),
      headers: req.headers,
      ip,
    });
    res.statusCode = out.status || 200;
    if (out.raw) {
      res.setHeader('Content-Type', out.type || 'application/octet-stream');
      for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
      res.end(out.raw);
      return;
    }
    res.end(JSON.stringify(out.body));
  } catch (e) {
    const known = e instanceof HttpError;
    if (!known) console.error(e);
    res.statusCode = known ? e.status : 500;
    res.end(JSON.stringify({ error: known ? e.message : 'Something went wrong on the server. Try again in a moment.', ...(known ? e.extra : {}) }));
  }
};
