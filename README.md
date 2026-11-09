# Attendly

Attendance management for classrooms. Teachers run the register, students watch their own attendance.
Built by Sachin Kumar ([@sachinkrcodes](https://github.com/sachinkrcodes)).

## What it does

**Teacher**
- Create classes. Each class gets a 6-character join code.
- Take attendance: Present, Late, Absent, Leave. Saving again for the same day updates it.
- Dashboard: attendance level, 14-day trend, 30-day mix, 10-week heat map, students below your minimum.
- Class reports with CSV download and print.
- Sample class with 12 fictional students and five weeks of history, for demos.

**Student**
- Sign up, then join a class with the code.
- Attendance level for every class, warnings when below the teacher's minimum, full history with filters.

**Rules**
- Present and Late count as attended. Leave is excused and not counted in the percentage.
- Rate = attended / (attended + absent).

## How it is built

| Part | Technology |
|---|---|
| Front end | HTML, CSS, JavaScript (no framework). Liquid-glass design, light and dark mode |
| API | Node.js serverless functions (`api/[...path].js`, logic in `lib/routes.js`) |
| Database | PostgreSQL on Neon in production, SQLite file for local runs |
| Auth | Passwords hashed with scrypt, signed tokens (HMAC-SHA256, 7 days), role checks on every route |
| Hosting | Vercel |

```
public/        index.html, style.css, app.js   (the website)
api/           [...path].js                     (one function handles /api/*)
lib/           routes.js, db.js, auth.js        (API logic, database, login security)
test/          api.test.js                      (27 end-to-end checks)
dev.js         local server
```

### Database tables
`users` (teacher or student) · `classes` · `enrollments` (student in class) · `attendance` (class, student, date, status)

### API (all under /api, JSON, Bearer token)
| Method | Path | Who |
|---|---|---|
| POST | /auth/register, /auth/login | anyone |
| GET, PATCH | /me | signed in |
| GET, POST | /classes | teacher: own classes / create. student: joined classes |
| POST | /classes/join | student |
| DELETE | /classes/:id, /classes/:id/students/:sid | teacher |
| DELETE | /classes/:id/leave | student |
| GET | /classes/:id/roster?date= | teacher |
| PUT | /classes/:id/attendance | teacher |
| GET | /dashboard, /reports/:classId | teacher |
| GET | /student/summary | student |
| POST | /demo | teacher |
| GET | /health | anyone |

## Run it on your computer

Needs Node.js 22 or newer.

```
node dev.js
```
Open http://localhost:3000. Data is saved in `.data/attendly.db`. Run the tests with `node test/api.test.js`.

## Put it live on Vercel

1. Push this folder to GitHub (repo root = this folder).
2. Vercel > Add New > Project > import the repo. Framework Preset: **Other**. Root Directory: `./`. Deploy.
3. In the Vercel project open **Storage**, create a **Neon (Postgres)** database and connect it to the project.
   Vercel adds the `DATABASE_URL` variable for you. The tables are created automatically on the first request.
4. Settings > Environment Variables: add `AUTH_SECRET` with a long random value. Make one with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
5. Deployments > Redeploy. Open `https://YOUR-SITE.vercel.app/api/health`. You should see `{"ok":true}`.

If you skip step 4 the app still works, but set it so login tokens depend on a secret only you know.

## Notes for the viewer

- Sample students use `@demo.attendly` emails and cannot sign in.
- Passwords need 8+ characters. Too many wrong sign-ins from one address are blocked for 10 minutes.
- Do not commit `.env` files or database URLs to GitHub.
