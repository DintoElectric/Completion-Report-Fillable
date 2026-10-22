# Template Fill: handoff

Paste or attach this file at the start of a new conversation. It is the brief for continuing the build.

## What this app is for
Paul Dinto Electrical needs to **fill a template from uploaded documents**: someone picks a template (for example
a pay application, a submittal cover sheet, a material list form), uploads the documents the information comes
from (spreadsheets, PDFs, Word files, CSV exports), and gets the template back filled in, to review and download.

Working name: **Template Fill** (change `APP_NAME` in `shared/limits.ts` and `index.html`).

## Status
**Built and tested:** everything in the starter (sign-in, roles, templates, jobs, chunked file transfer, file checks, cleanup), plus
**filling the Excel closeout sheet** (the 50% / closeout meeting workbook).

How filling works (job page -> "Fill the template" -> `/j/:id/fill`):
1. The browser reads the template (.xlsx) and finds every blank **by the sheet's own labels and column headings**, not fixed cell
   addresses (`shared/closeout.ts`, `buildFields`). Formula cells are never offered and never written.
2. Each source document is turned into text in the browser (`src/fill/sources.ts`). The CF Data "Budget/Cost Report" (.xls/.xlsx) is
   recognised and used directly. PDFs keep their column layout. A PDF with no text layer (a scan) is sent to the AI as the PDF itself,
   up to `MAX_SCAN_BYTES` in total.
3. **Hours and dollars by cost code are computed from the JBI report by fixed rules** (`aggregateJbi`), not by the AI:
   - code = last 3 digits of the JBI category ("1030 M" is code 030); a leading 9 is pre-fab and kept apart
   - type L = labor hours; every type except L and burden (B) = material dollars
   - estimate = contract section's Budget columns; approved CO = change-order sections' Budget columns; consumed = actuals of all sections
   - job average rate = (labor + burden dollars) / labor hours, all lines
   Consumed/CO materials and CO hours are marked "check" (medium confidence); the rest "high".
4. Everything else (header, contract and profit, completed & proceeding COs, purchase orders, comments, notes) is read by the AI.
   `POST /api/fill` stores the request; the browser starts `/api/fill-background` (a Netlify background function, up to 15 min);
   the browser polls `GET /api/fill/:id`. The documents' text is deleted from the database when the run ends.
5. The person reviews every value (grid for cost codes and POs), then `fillWorkbook` (`src/fill/writeXlsx.ts`) writes them **straight into
   the sheet's XML**, so dropdowns, logo, page setup and formulas survive. Cached formula results are dropped and Excel is told to
   recalculate on open. The result is saved as an `output` file on the job.

Template checks: `checkTemplate` warns when a TOTAL row's SUM stops short of the rows it totals (this happened in a previous job's sheet:
the total skipped the first cost code).

**Not built yet:** Word and PDF templates; reading pictures (PNG/JPEG); keeping a history of reviewed values; a PO source document
(budget cost and PO amount have no source in the documents used so far, so the AI leaves them empty).

## Two ways to get the AI-read values
- **API route** (above): the app calls Claude itself. Needs `ANTHROPIC_API_KEY`.
- **Claude Project route** (no key needed): on the Fill screen, "Download the field list for a Claude Project", then on the check screen
  "Import a values file" (JSON or CSV with `cell, value, source, confidence, note`). Imported values go through the same checks
  (`importProposals`): only blanks meant for the AI are accepted, never JBI-computed ones. Setup and the instructions to paste into the
  Project are in `docs/closeout-project-instructions.md`.

## Settings (Netlify environment variables)
- `ADMIN_EMAILS`: admins (as before).
- `ANTHROPIC_API_KEY`: needed for the AI step. Without it the app still fills the JBI numbers. Never put it in the repository.
- `ANTHROPIC_MODEL` (optional): defaults to `claude-sonnet-5-5` (`netlify/functions/_lib/ai.ts`). Set it if that name is not accepted.
- `MAX_FILE_MB` (optional): as before.

## Things to check after the first deploy (could not be tested before it)
- The AI call itself, and `/api/fill-background` answering 202 through the `/api` redirect.
- Reading PDFs on the tablets (the legacy PDF.js build is used for older Safari).
- JBI `.xls` reading uses SheetJS `xlsx@0.18.5`, the newest on npm, which has published advisories about crafted files. It only reads files
  staff upload. Move to SheetJS's own download of a newer version when convenient.
- The template to upload must be a **blank** closeout workbook. In a filled copy every existing value shows as "Keep".

## Facts learned from the first job's files
- The CF Data export must have "Combine C/O's With Base Job" ticked; the report then has CONTRACT TOTAL, C/O sections and FINAL TOTAL lines.
- The M25 file used was a scan (no text) and a billing projection, not the profit report; contract value at the meeting and profit may
  need typing in.
- In the old sheet, the approved-CO-hours column was exactly twice the JBI's change-order hours (subtotal rows summed with the lines).

## Likely building blocks
Check current versions when adding any of these (pin exact versions, as in `package.json`):
- Word templates: `docxtemplater` + `pizzip` (fills `{{placeholders}}` in .docx).
- Excel read and write: `exceljs` (already used by Tally's export). Old .xls files: SheetJS (`xlsx`).
- PDF forms: `pdf-lib` (fills form fields; can also write text onto a flat PDF).
- Reading PDF text: `pdfjs-dist` (already used by Tally).
- CSV: `papaparse`.

**Where filling runs:** Netlify functions have short time limits and the ~6 MB request cap, so reading and filling
documents is best done **in the browser** (as Tally reads drawings), saving the result with the existing chunked
upload as an `output` file. Only an AI call must run on the server, since the API key must never reach the browser.

## Repository map
```
netlify.toml                         build, /api redirects, security headers
package.json / package-lock.json     exact dependency versions
index.html                           page shell (title, icon)
shared/
  closeout.ts                        field detection, JBI rules, template checks, value mapping (no browser/server code)
  limits.ts                          every limit and constant; accepted file types and their signatures; user messages
  types.ts                           types shared by browser and functions (roles, files, templates, jobs)
netlify/
  database/migrations/
    20261022120000_init.sql          tables: templates, jobs, files
    20261022150000_fill_runs.sql     table: fill_runs (AI runs)
  functions/
    _lib/auth.ts                     who is signed in; roles; ADMIN_EMAILS
    _lib/db.ts                       database connection and transactions
    _lib/blobs.ts                    file storage (Netlify Blobs), pieces under files/<id>/<n>
    _lib/files.ts                    file columns; delete files with their stored pieces
    _lib/http.ts                     JSON responses; every error becomes a plain message
    _lib/validate.ts                 input checks (text, numbers, ids, choices)
    _lib/limits.ts                   limits, with MAX_FILE_MB override
    _lib/ai.ts                       the prompt, the answer check, the Anthropic call
    _lib/fillRequest.ts              checks a fill request before it is stored
    me.ts                            GET /api/me (includes aiReady)
    fill.ts                          POST /api/fill (start) · GET /api/fill/:id (status, result)
    fill-background.ts               runs one queued fill (background function)
    templates.ts                     /api/templates
    jobs.ts                          /api/jobs
    files.ts                         /api/files (chunked upload and download)
    cleanup.ts                       hourly: removes abandoned uploads
src/
  main.tsx, app/App.tsx              start-up; sign-in gate; routes
  app/router.ts                      /  (jobs) · /j/:id (a job) · /templates
  app/ui.tsx                         top bar, toast, dialog, small helpers
  app/useFetch.ts                    load data from the API
  auth/                              Identity sign-in (AuthProvider, Gate) and the API client
  upload/files.ts                    chunked upload, download, file checks
  upload/Dropzone.tsx                drop or choose files
  screens/Jobs.tsx, Job.tsx, Templates.tsx, FileTable.tsx, Fill.tsx
  fill/template.ts, sources.ts, writeXlsx.ts  read the template, read documents, write the workbook
  styles/nocturne.css                the Nocturne design system (shared with your other apps)
  styles/app.css                     this app's layout
scripts/
  db.test.mjs                        migrations + schema rules on in-memory Postgres
  unit.test.ts, closeout.test.ts     unit tests (closeout tests build their own template; no real job files are stored)
```

## Data model
- **templates**: name, description, `file_id` (its current file), archived_at.
- **jobs**: name, `template_id`, status (`draft` | `filled`), notes, created_by, archived_at.
- **files**: kind (`template` | `source` | `output`), owner (`template_id` for template files, `job_id` for sources
  and outputs, enforced by the database), file_name, file_type, size, chunk_count, upload_status
  (`uploading` | `ready`), uploaded_by. Deleting a job deletes its files; replacing a template's file deletes the old one.

## API
| Method | Path | Who | What |
|---|---|---|---|
| GET | /api/me | signed in | you, your role, upload limits |
| GET / POST | /api/templates | signed in / admin | list / create |
| PATCH / DELETE | /api/templates/:id | admin | rename or describe / archive |
| GET / POST | /api/jobs | signed in / member | list / create |
| GET / PATCH / DELETE | /api/jobs/:id | signed in / creator or admin | job with its files / change / delete with its files |
| POST | /api/files/begin | member (admin for templates) | start an upload: kind, owner, name, size |
| POST | /api/files/:id/chunk | the uploader | one 3 MB piece, base64 |
| POST | /api/files/:id/commit | the uploader | check all pieces arrived; mark ready |
| GET | /api/files/:id, /api/files/:id/chunk/:n | signed in | file details / one piece |
| DELETE | /api/files/:id | uploader or admin (templates: admin) | delete the file and its pieces |
| POST | /api/fill | member | store a request for the AI (blanks + document text) -> run |
| POST | /api/fill-background | anyone with a run id | start a queued run (answers 202) |
| GET | /api/fill/:id | signed in | run status and result |

A filled output is saved with the same upload, as `kind: 'output'` on the job.

## Rules this app follows (learned on Tally and the Drawings Hub)
- **Never edit a migration after it has deployed.** Netlify checksums every migration it has run and refuses to build
  if one changes, even by a space. Change the schema with a **new** timestamped file in `netlify/database/migrations/`.
- **Updates contain only the files that changed**, with their exact paths, and **never** a migration that has already
  deployed.
- **The server enforces every permission**; the browser only hides buttons.
- **Every limit lives in `shared/limits.ts`**, and every error a person sees says what happened and what to do.
- **No secrets in the repository.** Keys and admin emails go in Netlify environment variables.
- **Large files travel in pieces** (already built). Never send a whole file in one request.
- **Design:** Nocturne (dark, compact, blurple accent `#9184d9`) from `src/styles/nocturne.css`; app-specific styles
  in `src/styles/app.css`.
- **Before each delivery:** `npm run typecheck`, `npm test`, `npm run build`, and a check against real documents.

## Getting the files into GitHub
GitHub's upload page keeps folders only if you **drag folders** onto it. Choosing files puts them all in the main
folder. For a brand-new repository:
1. Create the repository (empty, no README).
2. On its page, click **uploading an existing file**.
3. Open the unzipped `template-fill` folder on your computer, select **everything inside it** (the folders and the
   files, including `.gitignore` and `.nvmrc`), and drag that selection onto the upload area. Commit.
4. Check the main page shows only these folders and files: `netlify/`, `scripts/`, `shared/`, `src/`, `.gitignore`,
   `.nvmrc`, `HANDOFF.md`, `README.md`, `index.html`, `netlify.toml`, `package.json`, `package-lock.json`,
   `tsconfig.json`, `vite.config.ts`.

For later updates touching several folders, either upload into each folder separately (open the folder, then
**Add file → Upload files**), or use a Codespace: drag the update zip in, then
`unzip -o <file>.zip -d . && rm <file>.zip && git add -A && git commit -m "…" && git push`.

## Suggested first message for the next conversation
> I'm continuing Template Fill. HANDOFF.md is attached. The closeout sheet filling is deployed. Here is what happened on a real job
> (what the AI got right and wrong, anything the review screen made awkward). Let's fix that, then add [Word/PDF templates | a PO source | ...].
