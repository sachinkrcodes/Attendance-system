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

## Colleges and the admin (version 6)

- A **platform admin** adds colleges. Anyone whose email is listed in `ADMIN_EMAILS` becomes admin after email verification. Nobody can choose the admin role on the sign-up form.
- Every teacher and student **must pick a college** when signing up.
- **Teachers need the admin's approval** before they can create classes.
- A student can only join classes from **their own college**.
- The admin panel has **Overview** (totals and per-college counts), **Colleges** (add, edit, disable, delete) and **People** (search, approve, assign a college, disable or enable).
- Disabled users are signed out at once.

## Install as an app (PWA)

Attendly is an installable web app: home-screen icon, full-screen window, fast start, and the screen shell opens even when offline (data needs the internet).
- **Android (Chrome):** open the site, tap **Install app** on the Home screen, or menu (⋮) then **Install app**.
- **iPhone (Safari):** Share button, then **Add to Home Screen**.
- **Computer (Chrome or Edge):** install icon in the address bar.
- For a Play Store file (APK or AAB), wrap the live site with PWABuilder (pwabuilder.com) after it is deployed.

## Campus hub (version 5)

Both roles get one home screen with tiles for everything:
- **Timetable:** the teacher sets weekly slots with room numbers, students see them, and the class running now is highlighted.
- **Academic calendar:** holidays, deadlines, events and exams in one list.
- **Exams and marks:** the teacher schedules an exam, enters marks, and the student sees them under **Results** with percentage and grade (A+ from 90, A from 80, B+ from 70, B from 60, C from 50, D from 40).
- **Gate pass and hostel leave:** the student asks, the class teacher approves or rejects.
- **Help desk:** grievances and feedback go to the teacher of the chosen class, who replies.
- **Notifications:** one list of updates from the last 30 days.
- **Profile:** name, email, mobile, roll number, password, sessions.

Speed: the background is static, heavy blur is used only on the top bar, dock and pop-ups, pages show placeholders while loading, and repeat page loads reuse data for 20 seconds.

Not included, because they need real institution data or payment services: fees, transport, mess pass.

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
api/      [...path].js, index.js            one function for /api/* (vercel.json rewrites to index.js)
lib/      routes.js  db.js  auth.js  mail.js
test/     api.test.js                       61 end-to-end checks
dev.js    local server
```

Tables: `users`, `classes`, `enrollments`, `attendance`, `otps`, `activity`, `leave_requests`, `announcements`, `checkins`, `colleges`, `timetable`, `events`, `exams`, `marks`, `passes`, `tickets`.
New columns on old databases are added automatically on the first request.

## Environment variables

| Name | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | yes on Vercel | Added by the Neon integration |
| `AUTH_SECRET` | recommended | Long random text that signs login tokens |
| `SMTP_USER` | for real email | Your Gmail address |
| `SMTP_PASS` | for real email | A Google **App Password** (16 letters), not your normal password |
| `MAIL_FROM` | optional | Sender address, defaults to `SMTP_USER` |
| `ADMIN_EMAILS` | yes, once | Your email (several allowed, comma separated). That person becomes the platform admin |
| `SHOW_OTP` | testing only | `true` shows the code on screen. Leave it unset in real use |

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

## v7
- **HOD role**: admin opens People → "Make HOD". The HOD gets a Department page: all teachers and classes of the college, add/reassign classes, manage timetables, unlock attendance, announce to the college.
- **Attendance lock**: each college has an editing window (Colleges → lock hours, 0 = never). After a first save the teacher can edit for that many hours; then it is locked until the HOD unlocks it (1–72 h). First entry allowed only for the last 7 days.
- **Home**: 30-day ring, today's classes, announcements, then the tiles.
- **Admin**: Overview (per-college attendance), Colleges, People (HOD, sign out, delete, CSV), Notices (announcements), Activity log, Remove practice data.
- All demo/sample/practice features removed. Install prompt appears on first visit.
- Set `ADMIN_EMAILS` in Vercel to your email; delete `SHOW_OTP`.
- **Slow network**: top loading bar, 'Slow connection' message after 2.5 s, 25 s timeout, automatic retry for reads, offline banner, saved data shown when the network drops.

## v8
- **Speed**: database setup now runs once per version (it used to run ~50 steps on every cold start). Extra indexes for big colleges. Register and student pages load their data in parallel.
- **Profiles**: profile photo for everyone (shrunk to 160 px, served with long cache), extra fields per role (student: course, semester, division, city; teacher: department, designation, qualification; admin: designation), photos in the register, People and Department lists, People → Details.
- **Admin Settings → System check**: database speed, server/database region, ADMIN_EMAILS, mail, demo-OTP flag. `/api/health` shows the same.
- Phone: solid top bar/dock/save bar, calmer save bar, install sheet sits above the dock.
- Scale: see the note in the chat. Free plans are not enough for 1.5 lakh users; Neon region should match the Vercel function region.

## v9
- Fixed pages becoming wider than the phone screen (long emails and names pushed the layout). All grids use `minmax(0,1fr)`, long text wraps, and the page cannot scroll sideways.
- Dropdown lists (select) are readable in dark mode.
- Top bar on tablets hides the name text so nothing overlaps.
- Checked 620 screens (teacher, student, admin; light and dark; widths 320 to 1280 px) with no sideways overflow and no clipped top bar or dock.
- v9.1: the service worker now loads CSS/JS from the network first (3 s limit), so new versions appear after one reload.
