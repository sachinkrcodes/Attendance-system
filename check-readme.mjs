// check-readme.mjs
// Checks a README for the habits that make it read as AI-written, and for missing facts.
//
//   Run from your project folder:    node check-readme.mjs
//   Or give the path to a README:    node check-readme.mjs path/to/README.md
//
// Needs Node 18 or newer. It only reads files and changes nothing. No network, no AI.
// It cannot tell whether your facts are true. Run your own commands and look at your own screenshots.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const arg = process.argv[2];
if (arg === "--help" || arg === "-h") {
  console.log("Usage: node check-readme.mjs [path/to/README.md]\nWithout a path it checks README.md in the current folder.");
  process.exit(0);
}

const file = resolve(arg ?? "README.md");
if (!existsSync(file)) {
  console.error(`Cannot find ${file}`);
  console.error("Run this from your project folder, or give the path: node check-readme.mjs path/to/README.md");
  process.exit(2);
}

const lines = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/);
const base = dirname(file);

// Which lines sit inside a ``` code block. The word checks skip them.
const inCode = [];
let fence = null;
for (const line of lines) {
  const m = line.match(/^\s*(`{3,}|~{3,})/);
  if (m) {
    if (fence === null) fence = m[1][0];
    else if (fence === m[1][0]) fence = null;
    inCode.push(true);
  } else {
    inCode.push(fence !== null);
  }
}

// Normal text lines. "text" has `inline code` removed. "words" also has link targets and web addresses removed.
const prose = [];
lines.forEach((raw, i) => {
  if (inCode[i]) return;
  const text = raw.replace(/`[^`]*`/g, "");
  prose.push({ n: i + 1, raw, text, words: text.replace(/\]\([^)]*\)/g, "]").replace(/\bhttps?:\/\/\S+/g, "") });
});

const found = [];
const fail = (msg) => found.push({ level: "FAIL", msg });
const warn = (msg) => found.push({ level: "WARN", msg });
const where = (nums) => {
  const list = [...new Set(nums)];
  return `line${list.length > 1 ? "s" : ""} ${list.slice(0, 8).join(", ")}${list.length > 8 ? ` and ${list.length - 8} more` : ""}`;
};
const isList = (s) => /^\s*([-*+]|\d+[.)])\s+/.test(s);
const isHeading = (s) => /^\s{0,3}#{1,6}\s+\S/.test(s);

// True only if every part of the path exists with exactly this spelling. GitHub is case sensitive, Windows is not.
function existsExact(root, rel) {
  let cur = root;
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      cur = dirname(cur);
      continue;
    }
    let names;
    try {
      names = readdirSync(cur);
    } catch {
      return false;
    }
    if (!names.includes(seg)) return false;
    cur = join(cur, seg);
  }
  return true;
}

// 1. Marks left over from the template
const left = lines.flatMap((l, i) => (/\bFILL\b/.test(l) ? [i + 1] : []));
if (left.length) fail(`${left.length} [FILL] marks are still in the file (${where(left)}). Replace each with a real fact, or delete the line.`);

const unfinished = prose.filter((p) => /\b(TODO|TBD|lorem ipsum|coming soon)\b/i.test(p.text)).map((p) => p.n);
if (unfinished.length) warn(`Unfinished wording such as TODO, TBD or "coming soon" (${where(unfinished)}). Finish it or delete it.`);

// 2. Sections that should exist
const headings = prose
  .filter((p) => isHeading(p.raw))
  .map((p) => ({ n: p.n, title: p.text.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim() }));
const has = (re) => headings.some((h) => re.test(h.title));
if (!has(/^highlights?\b/i)) fail('No "Highlights" section. Add 3 to 5 bullets of facts.');
if (!has(/^(screenshots?|demo)\b/i)) fail('No "Screenshots" section. Show the app working.');
if (!has(/^(run it|how to run|run|getting started|setup|install)/i)) fail('No "Run it" section with the exact commands.');
if (!has(/^(tech|stack|built with|tech stack)\b/i)) warn('No "Tech" section.');
if (!has(/^(hardest problem|hardest part|biggest problem|challenges?)/i)) warn('No "Hardest problem" section. It is where your own thinking shows.');
if (!has(/^(limits|limitations|next|known issues|what is missing)/i)) warn('No "Limits and next" section. Saying what is not done makes the rest more believable.');
if (!prose.some((p) => /\bkeywords?\b\s*:/i.test(p.text))) warn('No "Keywords:" line. List the technologies you really used.');

const hi = headings.findIndex((h) => /^highlights?\b/i.test(h.title));
if (hi >= 0) {
  const end = headings[hi + 1]?.n ?? lines.length + 1;
  const count = prose.filter((p) => p.n > headings[hi].n && p.n < end && isList(p.raw)).length;
  if (count < 3) warn(`Highlights has ${count} bullet${count === 1 ? "" : "s"}. Aim for 3 to 5 facts.`);
  else if (count > 7) warn(`Highlights has ${count} bullets. Keep the best 5, a long list hides the good ones.`);
}

// 3. Pictures
const images = [];
for (const p of prose) {
  for (const m of p.text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) images.push({ n: p.n, alt: m[1].trim(), src: m[2] });
  for (const m of p.text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    images.push({ n: p.n, alt: ((m[0].match(/\balt=["']([^"']*)["']/i) || [])[1] ?? "").trim(), src: m[1] });
  }
}
if (!images.length) {
  fail("No screenshot or GIF found. Add 3 to 5 pictures of the app working, in the order a user would use it. Image file names cannot have spaces.");
} else {
  const missing = [];
  const backslash = [];
  for (const im of images) {
    if (/^(https?:|data:|\/\/)/i.test(im.src)) continue;
    let rel = im.src.split("#")[0].split("?")[0];
    try {
      rel = decodeURIComponent(rel);
    } catch {
      // keep the path as written
    }
    if (rel.includes("\\")) backslash.push(im);
    if (!existsExact(base, rel)) missing.push(im);
  }
  if (missing.length) fail(`Image file not found: ${missing.map((m) => m.src).join(", ")} (${where(missing.map((m) => m.n))}). Check the path and the exact spelling, capital letters count on GitHub.`);
  if (backslash.length) warn(`Image path with a backslash (${where(backslash.map((m) => m.n))}). Use forward slashes: docs/screenshots/01-login.png`);
  const noAlt = images.filter((im) => !im.alt);
  if (noAlt.length) warn(`Image without a description (${where(noAlt.map((i) => i.n))}). Write what the screen shows between the [ ].`);
  if (images.length < 2) warn("Only one picture. Three to five, in the order of use, show how it works.");
}

// 4. Commands
if (!inCode.some(Boolean)) warn("No code block. Put the exact commands to run it inside a ``` block.");

// 5. Words and habits that read as AI-written
const SLOP = [
  "seamless(?:ly)?", "robust(?:ness)?", "powerful", "leverag(?:e|es|ed|ing)", "cutting[- ]edge", "comprehensive", "innovative", "revolutionary",
  "streamlin(?:e|es|ed|ing)", "empower(?:s|ed|ing)?", "effortless(?:ly)?", "state[- ]of[- ]the[- ]art", "game[- ]chang(?:er|ing)", "user[- ]friendly",
  "intuitive", "holistic", "next[- ]level", "world[- ]class", "best[- ]in[- ]class", "blazing(?:ly)?[- ]fast", "scalable", "delv(?:e|es|ed|ing)",
  "elevat(?:e|es|ed|ing)", "unlock(?:s|ed|ing)?", "harness(?:es|ed|ing)?",
];
const slopRe = new RegExp("\\b(" + SLOP.join("|") + ")\\b", "gi");
const slop = new Map();
for (const p of prose) {
  for (const m of p.words.matchAll(slopRe)) {
    const w = m[1].toLowerCase();
    if (!slop.has(w)) slop.set(w, []);
    slop.get(w).push(p.n);
  }
}
if (slop.size) warn(`Words that read as AI-written: ${[...slop].map(([w, n]) => `"${w}" (${where(n)})`).join("; ")}. Replace each with the plain fact, or delete it.`);

const emoji = prose.filter((p) => /(?![©®™])\p{Extended_Pictographic}/u.test(p.text)).map((p) => p.n);
if (emoji.length) warn(`Emoji (${where(emoji)}). Emoji in headings and bullets are one of the clearest signs of AI text. Remove them.`);

const dashes = prose.filter((p) => /[–—]/.test(p.words)).map((p) => p.n);
if (dashes.length) warn(`Long dashes (${where(dashes)}). Heavy use of them is a known AI sign. Use a comma, a colon or a full stop.`);

const longText = prose
  .filter((p) => p.raw.trim().length > 220 && !isList(p.raw) && !isHeading(p.raw) && !/^\s*(>|\||!\[|<)/.test(p.raw))
  .map((p) => p.n);
if (longText.length) warn(`Long paragraphs (${where(longText)}). Write facts as short bullets, not paragraphs.`);
const longBullets = prose.filter((p) => isList(p.raw) && p.raw.trim().length > 200).map((p) => p.n);
if (longBullets.length) warn(`Long bullets (${where(longBullets)}). One fact per bullet. Split it.`);

const bullets = prose.filter((p) => isList(p.raw));
const boldLead = bullets.filter((p) => /^\s*([-*+]|\d+[.)])\s+\*\*[^*]+\*\*/.test(p.raw));
if (bullets.length >= 6 && boldLead.length / bullets.length > 0.5) {
  warn(`${boldLead.length} of ${bullets.length} bullets start with a bold label. A list built like that looks AI-written. Use plain sentences.`);
}

const opener = prose.find((p) => p.raw.trim() && !isHeading(p.raw) && !isList(p.raw) && !/^\s*(>|\||!\[|<|\*\*)/.test(p.raw));
if (opener && /^\s*(this (project|repo|repository|app|application|website|tool|is)\b|welcome to\b|a (modern|simple|powerful|comprehensive|full[- ]stack)\b)/i.test(opener.text)) {
  warn(`The opening line (line ${opener.n}) is generic. Say what it does and who it is for, in plain words, with no adjectives.`);
}

// 6. Sections that do not belong in a project README
const interview = [
  ...headings.filter((h) => /interview/i.test(h.title)).map((h) => h.n),
  ...prose.filter((p) => !isHeading(p.raw) && /interview (answers?|questions?|prep)/i.test(p.text)).map((p) => p.n),
];
if (interview.length) fail(`Interview wording (${where(interview)}). A README is not an interview. Delete it. "Hardest problem" already shows how you think.`);

const speech = headings.filter((h) => /design (and|&) decisions?|why (i|you) (am|are|should)|key takeaways?|conclusion/i.test(h.title)).map((h) => h.n);
if (speech.length) warn(`Heading that reads like a speech (${where(speech)}). Use facts under "Tech" and "Hardest problem" instead.`);
if (headings.some((h) => /^contribut/i.test(h.title))) warn('A "Contributing" section. Keep it only if you want other people to contribute.');
if (headings.some((h) => /^(table of )?contents$/i.test(h.title))) warn("A table of contents. A short README does not need one.");
const badges = prose.filter((p) => /img\.shields\.io|badge\.svg|badgen\.net/i.test(p.raw)).map((p) => p.n);
if (badges.length) warn(`Badges (${where(badges)}). They are decoration. Remove them unless they show something a reader needs.`);

// 7. License file next to the README
if (!["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"].some((name) => existsExact(base, name))) {
  warn("No LICENSE file next to the README. Copy the MIT LICENSE file from the kit into the project.");
}

// Result
console.log(`README check: ${file}\n`);
found.sort((a, b) => (a.level === b.level ? 0 : a.level === "FAIL" ? -1 : 1));
for (const f of found) console.log(`${f.level}  ${f.msg}\n`);
const nFail = found.filter((f) => f.level === "FAIL").length;
const nWarn = found.length - nFail;
if (!found.length) {
  console.log("No problems found.");
  console.log("Now the checks no script can do: clone into a fresh folder and run your commands, open the repo in a private window, and read it out loud once.");
} else {
  console.log(`Result: ${nFail} FAIL, ${nWarn} WARN. ${nFail ? "Fix every FAIL first." : "No FAIL. Read each WARN and decide."}`);
}
process.exit(nFail ? 1 : 0);
