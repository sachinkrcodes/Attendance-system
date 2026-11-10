# Attendly

Attendance management for classrooms, with email-verified accounts, a live check-in code, leave requests and reports.
Built by Sachin Kumar ([@sachinkrcodes](https://github.com/sachinkrcodes)).

Design: two colours only, Slate Tint `#F7FAFC` and Deep Navy `#1A2B3C`, about 90% background and 10% ink.
Status is shown by shape (filled, half, striped, hollow), not by colour, so it also works for colour-blind users.

## Features

**Accounts and security**
- Sign up with name, mobile number, email and password. Students can add a roll number.
- Email verification with a 6-digit one-time code (OTP). Codes are stored hashed, expire in 10 minutes, allow 5 tries, and can be re-sent once a minute (max 5 an hour).
- Forgot password: code by email, then a new password. The answer is the same whether or not the email has an account.
- Password rules (8+ characters, letter and number, common passwords refused) with a strength meter.
- Account lock for 15 minutes after 5 wrong passwords.
- Change password and "sign out of all devices". Both end every other session.
- Security activity log (sign-ins, password changes, locks).
- Passwords hashed with scrypt, signed session tokens, role checks on every API route, strict security headers (CSP, HSTS, no framing).

**Teacher**
- Classes with a join code. Take attendance: Present, Late, Absent, Leave.
- **Live check-in code:** show a 6-digit code on the board, students type it on their phone and are marked present. It expires after 5 to 30 minutes.
- **Leave requests:** students ask, the teacher approves or rejects. Approving marks the day as Leave.
- **Class notices** shown on the students' Home page.
- Dashboard: attendance level, trend, mix, 10-week heat map, students below the minimum.
- Reports with mobile numbers, CSV download and print. Sample class for demos.

**Student**
- Join with a code, see attendance per class, notices, full history with filters.
- **Planner:** "You can miss 3 more classes and stay at 75%" or "Attend the next 4 classes to get back to 75%".
- Check in with the teacher's code. Ask for leave and track the answer.

**Rules:** Present and Late count as attended. Leave is excused and left out of the percentage.

## How it is built

| Part | Technology |
|---|---|
| Front end | HTML, CSS, JavaScript (no framework), liquid-glass design, light and inverted theme |
| API | Node.js serverless functions (`api/[...path].js`, logic in `lib/`) |
| Database | PostgreSQL on Neon in production, SQLite file for local runs |
| Email | Nodemailer over SMTP (Gmail App Password works) |
| Hosting | Vercel |

```
public/   index.html, style.css, app.js     the website
api/      [...path].js                      one function for /api/*
lib/      routes.js  db.js  auth.js  mail.js
test/     api.test.js                       44 end-to-end checks
dev.js    local server
```

Tables: `users`, `classes`, `enrollments`, `attendance`, `otps`, `activity`, `leave_requests`, `announcements`, `checkins`.
New columns on old databases are added automatically on the first request.

## Environment variables

| Name | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | yes on Vercel | Added by the Neon integration |
| `AUTH_SECRET` | recommended | Long random text that signs login tokens |
| `SMTP_USER` | for real email | Your Gmail address |
| `SMTP_PASS` | for real email | A Google **App Password** (16 letters), not your normal password |
| `MAIL_FROM` | optional | Sender address, defaults to `SMTP_USER` |
| `SHOW_OTP` | demo only | `true` shows the code on screen so a demo works without email. Remove it when real email works |

### Gmail App Password
1. Google Account > Security > turn on **2-Step Verification**.
2. Open https://myaccount.google.com/apppasswords, create one named Attendly, copy the 16 letters (no spaces).
3. Put it in `SMTP_PASS` and your Gmail address in `SMTP_USER`.

## Run on your computer (Node.js 22 or newer)

```
npm install
set SHOW_OTP=true
node dev.js
```
Open http://localhost:3000. With `SHOW_OTP=true` the code appears on screen. Without it, set `SMTP_USER` and `SMTP_PASS`.
Tests: `node test/api.test.js`.

## Put it live on Vercel
1. Push this folder to GitHub and import the repo in Vercel (Framework Preset **Other**).
2. Storage > create **Neon**, connect it to the project. This adds `DATABASE_URL`.
3. Settings > Environment Variables: add `AUTH_SECRET`, `SMTP_USER`, `SMTP_PASS`.
4. Redeploy. Open `/api/health`. You should see `{"ok":true}`.

## Notes
- Sample students use `@demo.attendly` emails and cannot sign in.
- Mobile numbers are stored and shown to the teacher of the class. Phone OTP by SMS is not included because SMS needs a paid provider.
- Never put passwords, App Passwords or database URLs in GitHub.
