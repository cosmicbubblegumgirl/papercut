# PaperCut

**Cut through the fine print.** PaperCut turns complicated paperwork into a clear summary, detected deadlines, required documents, and a step-by-step roadmap.

A Quantum Cupcake Creation ✦

## Architecture

- `docs/`: Responsive GitHub Pages frontend. Includes an interactive sample, text-based local preview, and account controls when the backend is connected.
- `server.js`: Node.js 22+ HTTP backend. Includes sign-up, sign-in, salted scrypt password hashes, random session tokens, user-specific document storage, task completion and preferences.
- `PAPERCUT_DB`: Persistent SQLite database path, mounted on the backend server.
- `Dockerfile`: Backend container with optional PDF, DOCX, Word and image text extraction utilities.

**GitHub Pages does not run the backend or the SQLite database.** Until a separate HTTPS backend is deployed and connected, the public Pages site is an interactive preview only: live sign-in, uploaded-document processing and shared/persistent accounts will not be available.

## Deploy the website (no Vercel)

In this repository open **Settings → Pages → Build and deployment**. Select **Deploy from a branch**, branch **main**, folder **/docs** and Save. Wait for the green publication status and test the site in a browser.

## Deploy the backend

Deploy the root of this repository to an always-on Node.js 22+ HTTPS host with a **persistent disk mounted at /data**. Railway or any equivalent provider with volumes can run the provided Dockerfile. Set these environment variables:

```sh
PORT=8787
PAPERCUT_DB=/data/papercut.db
ALLOWED_ORIGINS=https://cosmicbubblegumgirl.github.io
SESSION_DAYS=30
MAX_UPLOAD_MB=12
```

The port may be provided automatically by the host. Set `ALLOWED_ORIGINS` to the exact origin of the GitHub Pages website, not its path. Once the backend is live, open PaperCut on GitHub Pages, select **Connect workspace**, and enter the backend's HTTPS base URL. PaperCut checks `/api/health` before enabling account creation.

### Run locally

```sh
node server.js
```

Open `http://localhost:8787` and connect that URL in the website. Node.js 22.13+ is required for its built-in `node:sqlite` support.

## HTTP API

```
GET    /api/health
POST   /api/auth/signup
POST   /api/auth/signin
POST   /api/auth/signout
GET    /api/auth/me
GET    /api/dashboard
GET    /api/documents
POST   /api/documents
GET    /api/documents/:id
DELETE /api/documents/:id
PATCH  /api/documents/:id/steps/:stepId
GET    /api/preferences
PATCH  /api/preferences
```

PaperCut's document summaries and extracted dates are **rule-based suggestions**, not definitive readings. Users must check the original paperwork before acting, especially for legal, medical and financial documents. The public example uses fictional information.

## Privacy and deployment notes

Keep the SQLite database and credentials out of the public GitHub repository. Use HTTPS for accounts and uploads, configure rate limits and monitoring before inviting broad public usage, restrict CORS origins, and maintain backups of the persistent volume. Local-storage bearer tokens mean XSS controls and a security review are important before handling sensitive user documents.
