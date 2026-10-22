# Template Fill

Internal web app for Paul Dinto Electrical: fill a template (Word, Excel or PDF) from uploaded documents
(spreadsheets, PDFs, Word, CSV). "Template Fill" is a working name; change `APP_NAME` in `shared/limits.ts`
and the `<title>` in `index.html`.

**Start here for development: [HANDOFF.md](HANDOFF.md).** It describes what is built, what is not, the decisions
still open, and the rules this app follows.

## Stack
React 18 + TypeScript + Vite, Netlify Functions, Netlify Identity (invite-only sign-in), Netlify Database
(Postgres) and Netlify Blobs (file storage). Same structure as Tally and the Drawings Hub.

## Deploy (first time)
1. Create an empty GitHub repository and add these files, **keeping the folders** (see HANDOFF.md, "Getting the files into GitHub").
2. In Netlify: **Add new site → Import an existing project**, pick the repository. Build settings come from `netlify.toml`.
3. Turn on **Identity** for the site, set registration to **invite only**, and invite yourself.
4. Turn on **Netlify Database** for the site, the same way as for Tally. The first deploy creates the tables
   from `netlify/database/migrations/`.
5. Set environment variables (Site configuration → Environment variables):
   - `ADMIN_EMAILS`: comma-separated emails that are admins (for example `you@example.com`).
   - `ANTHROPIC_API_KEY`: for the AI step (see HANDOFF.md, Settings). Without it only the JBI numbers are filled.
   - `ANTHROPIC_MODEL` (optional): the model name; a default is built in.
   - `MAX_FILE_MB` (optional): per-file upload limit in MB; 100 if not set.
6. Deploy, open the site, and accept your invite.

Blobs need no setup.

## Check before every push
```
npm install
npm run typecheck   # both the browser code and the functions
npm test            # database rules (real migrations on in-memory Postgres) + unit tests
npm run build
```
