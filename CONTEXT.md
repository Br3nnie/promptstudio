# LC Prompt Studio — Session Context

## What this is
A web app that guides Leancrest consultants through building AI agent deployment packages for Microsoft Copilot Studio + Azure Prompt Library. Built in Node.js + Express with a vanilla JS frontend. All BBB project lessons are encoded in the system prompts.

## Location
`/Users/bren/Library/CloudStorage/Dropbox/Corbelle/Clients/Leancrest/LC-Prompt-Studio/`

## File structure
```
LC-Prompt-Studio/
├── server.js          — Express API (all backend logic)
├── package.json       — dependencies: express, @anthropic-ai/sdk, @vercel/kv, archiver, dotenv
├── vercel.json        — Vercel deployment config
├── .vercelignore
├── .env               — ANTHROPIC_API_KEY set (live key in place)
├── .env.example       — template including KV vars
└── public/
    ├── index.html     — single-page 7-stage wizard
    ├── style.css      — premium light design, IBM Plex fonts, Leancrest dark blue (#1a3a5c)
    └── app.js         — full wizard logic
```

## 7-Stage workflow
1. **Input** — paste transcript / email / brief, or upload .txt/.md
2. **Analysis** — Claude extracts use cases, stakeholders, constraints, complexity
3. **Clarify** — 8–12 dynamically generated questions (platform → use cases → docs → output → naming)
4. **Scope** — streaming markdown scoping document, preview/edit tabs, hard approval gate
5. **Architecture** — monolithic vs modular recommendation with rationale and file list
6. **Generate** — each prompt streamed one at a time; Copilot Instructions has live char counter (warn 7,500 / block 8,000); feedback logging per prompt
7. **Package** — HTML change tracker generated (matching BBB style), single .zip download, session auto-saved

## Backend API endpoints
| Endpoint | Purpose |
|---|---|
| POST /api/extract | Stage 1 — extract intent from input |
| POST /api/questions | Stage 2 — generate clarifying questions |
| POST /api/scope | Stage 3 — stream scoping document |
| POST /api/architecture | Stage 4 — architecture recommendation |
| POST /api/generate | Stage 5 — stream prompt files |
| POST /api/tracker | Stage 6 — generate HTML change tracker |
| POST /api/package | Stage 7 — zip download |
| GET/POST/DELETE /api/sessions | Session history |
| GET/POST/DELETE /api/feedback | Feedback bank |

## Storage
- **Local dev**: in-memory fallback (sessions reset on restart, which is fine)
- **Production (Vercel)**: Vercel KV (Redis). Needs `KV_REST_API_URL` + `KV_REST_API_TOKEN` in env vars.
- Sessions stored as `session:{id}` keys. Feedback bank stored as single `feedback-bank` key (array).

## Session history
- Auto-saves on package download
- "Sessions" button in sidebar — opens modal, lists past sessions, Load / Delete per session
- Loading a session restores full state and jumps to the correct stage

## Feedback bank
- Per-prompt feedback form in Stage 6 (collapsible, 7 common issue tags + free text)
- "Add to feedback bank" checkbox (default on) — persists across sessions
- "Feedback Bank" button in sidebar — opens table of all logged issues, deleteable
- All entries automatically injected into future generation calls (up to 20 most recent)

## Design
- Premium light: warm off-white bg (#f5f4f0), white surfaces with subtle shadows
- Sidebar: dark blue gradient (#1e4168 → #152f4a), white left-border active indicator, green checkmarks for done stages
- Top progress bar: 2px fill + 7 labelled step dots
- IBM Plex Sans (body) + IBM Plex Mono (code/filenames)
- Smooth cubic-bezier transitions, fadeSlide on stage change

## Current state / what's left
- App runs locally at http://localhost:3000 — restart with: `cd [path] && node server.js`
- Deployed to Vercel: NOT YET — in progress
- Git repo: exists (on main branch) but not pushed to GitHub yet
- Next step: create GitHub repo, push, then deploy to Vercel (Steps 1–5 in the deployment plan)

## Deployment plan (steps remaining)
1. **GitHub** — `git init` already done (on main branch). Create new repo on github.com, then:
   ```bash
   cd "/Users/bren/Library/CloudStorage/Dropbox/Corbelle/Clients/Leancrest/LC-Prompt-Studio"
   git add .
   git commit -m "Initial build — LC Prompt Studio v1.0"
   git remote add origin https://github.com/YOUR_USERNAME/lc-prompt-studio.git
   git push -u origin main
   ```
2. **Vercel** — New Project → import repo → auto-detects vercel.json
3. **Env vars in Vercel** — add `ANTHROPIC_API_KEY` and `NODE_ENV=production`
4. **KV database** — Vercel dashboard → Storage → KV → Create → connect to project (auto-injects KV vars)
5. **Copy KV vars to local .env** — optional, for local session persistence

## Key technical notes
- `@vercel/kv` only loads if `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set — safe to run without them
- Express runs as a single serverless function via `@vercel/node` (all routes in server.js)
- Streaming uses SSE (text/event-stream) — works fine on Vercel
- `module.exports = app` at bottom of server.js — required for Vercel; `app.listen()` skipped when `process.env.VERCEL` is set
- All JSON responses from Claude are stripped of markdown fences before parsing (`parseJSON()` helper)
