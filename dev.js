'use strict';
// Local server for development and demos. Run: node dev.js  (or npm start)
// Uses a SQLite file in .data/ unless DATABASE_URL is set.
const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./api/[...path].js');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  const clean = decodeURIComponent(req.url.split('?')[0]);
  let file = path.normalize(path.join(PUBLIC, clean === '/' ? 'index.html' : clean));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('Attendly running at http://localhost:' + (process.env.PORT || 3000)));
