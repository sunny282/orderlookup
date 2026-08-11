# ATAAD Order Lookup

A mobile-first Progressive Web App (PWA) for Ataad staff to look up Oman
Broadband CRM order details from a phone and copy them straight into
WhatsApp — no manual CRM login, searching, or copy-pasting of individual
fields required.

```
Open ATAAD Order Lookup → Enter Order ID → Tap SEARCH
   → See order details → Tap COPY DETAILS → Paste into WhatsApp
```

---

## 1. What it does

1. You enter a numeric Order ID on your phone.
2. The app calls a Netlify Function, which logs into the Oman Broadband
   CRM **on the server**, searches the order, and returns only the fields
   needed.
3. The app formats those fields into clean WhatsApp-ready text.
4. You tap **📋 COPY DETAILS** and paste into WhatsApp.

CRM credentials live only in Netlify environment variables. They are
never present in the frontend, never sent to the browser, and never
committed to Git.

---

## 2. Project structure

```
ataad-order-lookup/
├── index.html                       Main app shell
├── manifest.json                    PWA manifest
├── service-worker.js                Caches only the static app shell
├── css/style.css                    Mobile-first styling
├── js/app.js                        Frontend logic (search, copy, install)
├── icons/icon-192.png, icon-512.png App icons
├── netlify/functions/order-lookup.js  CRM login + order lookup (server-side)
├── netlify.toml                     Netlify build/headers config
├── package.json
└── README.md
```

**All CRM-specific logic lives in one file:**
`netlify/functions/order-lookup.js`. If the CRM's login page markup or
order-lookup response shape differs from what was assumed, that is the
only file you should need to edit — see the comment block at the top of
that file for exactly what to adjust (CSRF token extraction, login form
fields, extra session fields, response field names).

---

## 3. Run locally

You'll need the [Netlify CLI](https://docs.netlify.com/cli/get-started/):

```bash
npm install -g netlify-cli
cd ataad-order-lookup
netlify dev
```

`netlify dev` serves the static frontend **and** runs the Netlify
Function locally, so `/​.netlify/functions/order-lookup` works exactly as
it will in production.

Before running, set your local environment variables (see below) either
in a `.env` file (already gitignored) or via `netlify env:set`.

---

## 4. Configuring CRM credentials

The app needs two environment variables:

| Variable       | Description                          |
|----------------|---------------------------------------|
| `CRM_USERNAME` | Your Oman Broadband CRM username      |
| `CRM_PASSWORD` | Your Oman Broadband CRM password      |

**Never put these in source code.** Configure them in the Netlify
dashboard:

```
Netlify Dashboard
 → Your Site
 → Site configuration
 → Environment variables
 → Add a variable
```

Add:
```
CRM_USERNAME = your-crm-username
CRM_PASSWORD = your-crm-password
```

Then redeploy (or trigger a new deploy) so the function picks up the
new values.

### Optional extra session fields

If your CRM account requires additional fixed values for order lookup
(`contractorId`, `userId`, `roleId`, `mvnoId`, `teamId` — observed in the
captured request), you can supply them the same way, using
underscore-separated env var names, e.g.:

```
CRM_CONTRACTOR_ID = ...
CRM_USER_ID = ...
CRM_ROLE_ID = ...
CRM_MVNO_ID = ...
CRM_TEAM_ID = ...
```

Only set the ones your CRM account actually requires — leave the rest
unset.

---

## 5. Deploy to Netlify

### Option A — via GitHub

1. Push this project to a GitHub repository (the `.gitignore` already
   excludes `.env` and other local-only files).
2. In Netlify: **Add new site → Import an existing project** and select
   the repository.
3. Build settings: no build command needed (`publish = "."`,
   `functions = "netlify/functions"` are already set in `netlify.toml`).
4. Add the environment variables from Section 4.
5. Deploy.

### Option B — via Netlify CLI

```bash
cd ataad-order-lookup
netlify init      # creates/links a Netlify site
netlify env:set CRM_USERNAME "your-crm-username"
netlify env:set CRM_PASSWORD "your-crm-password"
netlify deploy --prod
```

6. Open the generated Netlify URL (e.g. `https://ataad-order-lookup.netlify.app`).
7. Test an order lookup (Section 8).
8. Install the PWA on your phone (Section 6).

No custom domain or paid plan is required.

---

## 6. Installing the PWA

### Android (Chrome)

1. Open the Netlify URL in Chrome.
2. A banner may appear automatically: **Install ATAAD Order Lookup**.
   Tap **📱 INSTALL APP**.
3. If the banner doesn't appear, tap the **⋮** menu → **Add to Home
   screen** / **Install app**.
4. The app now opens full-screen from your home screen, without browser
   address bars.

### iPhone (Safari)

iOS Safari does not support the automatic `beforeinstallprompt` banner,
so add it manually:

1. Open the Netlify URL in **Safari** (not Chrome — iOS PWA install
   requires Safari).
2. Tap the **Share** icon (square with an arrow).
3. Tap **Add to Home Screen**.
4. Tap **Add**.
5. The app icon appears on your home screen and opens in standalone mode.

---

## 7. Testing checklist

### Login
- [ ] Valid CRM credentials → order lookup succeeds
- [ ] Invalid CRM credentials → "CRM login failed. Please check the
      configured CRM credentials."
- [ ] CSRF token is fetched fresh on each request (no hard-coded token)

### Order lookup
- [ ] Valid Order ID → details displayed correctly
- [ ] Invalid Order ID (letters/symbols) → "Please enter a valid numeric
      Order ID."
- [ ] Non-existent Order ID → "Order not found. Please check the Order
      ID and try again."
- [ ] CRM slow/unreachable → "CRM is taking too long to respond." /
      "CRM is currently unavailable."

### Mobile
- [ ] Install banner appears on Android Chrome
- [ ] App installs and opens in standalone mode
- [ ] COPY DETAILS copies text correctly on Android Chrome
- [ ] Pasting into WhatsApp looks correct (bold header, spacing, no
      stray blank fields)

### Desktop
- [ ] Works in Chrome, Firefox, Edge
- [ ] Layout stays centered and readable (not full-width)

### Security
- [ ] View page source on the deployed site — `CRM_USERNAME` /
      `CRM_PASSWORD` do not appear anywhere
- [ ] Browser dev tools → Network tab — the `order-lookup` function
      response contains no cookies, CSRF tokens, or credentials
- [ ] `localStorage` / `sessionStorage` (DevTools → Application) contain
      only the last-searched Order ID, nothing CRM-related

---

## 8. How to test end-to-end

1. Open the Netlify URL on your phone or desktop.
2. Enter a known valid Order ID (e.g. `02575111`).
3. Tap **SEARCH ORDER** — you should see "Searching CRM..." then
   "Order found ✓".
4. Verify the displayed details match the CRM.
5. Tap **📋 COPY DETAILS** — you should see "✓ Details copied!".
6. Open WhatsApp and paste — confirm formatting looks correct.

---

## 9. Troubleshooting

**Login fails / "CRM login failed"**
Check that `CRM_USERNAME` and `CRM_PASSWORD` are set correctly in
Netlify's environment variables and that the deploy has picked them up
(redeploy after changing env vars). Check the Netlify Function logs
(Netlify Dashboard → your site → Functions → order-lookup → Logs) for
the specific error code — passwords/cookies are never logged, but the
failure reason is.

**Order lookup fails even though login succeeds**
The CRM's `viewOrderDetails_New` request may need additional fields.
See "Optional extra session fields" in Section 4, and check the Function
logs for the response the CRM actually returned.

**"CRM is currently unavailable" for every request**
This usually means the login page's HTML no longer matches the CSRF
extraction patterns in `netlify/functions/order-lookup.js`
(`CONFIG.csrfPatterns`). Re-inspect the live login page and update the
pattern, or add a new one — the config array supports multiple
fallback patterns.

**CRM changed its request/response format**
All CRM-specific logic is isolated in
`netlify/functions/order-lookup.js` — update `fetchLoginPage`,
`performLogin`, `lookupOrder`, or `extractOrderFields` there. No other
file should need to change.

**PWA install button doesn't show**
`beforeinstallprompt` only fires on supported Chromium browsers (Android
Chrome, desktop Chrome/Edge) and only over HTTPS (which Netlify
provides automatically). It won't fire on iOS Safari — use "Add to Home
Screen" manually there (Section 6). It also won't fire again once the
app is already installed.

**Copy button doesn't work**
Most Android Chrome versions support the Clipboard API directly. If it's
blocked (e.g. inside certain in-app browsers), the app automatically
falls back to selecting the text and using `execCommand('copy')`. If
both fail, you'll see a message asking you to select and copy manually.

**Netlify Function returns an error / 502**
Check Netlify Function logs. Common causes: missing environment
variables, CRM request timeout (default 15s), or an unexpected CRM
response shape (see `extractOrderFields` in the function file).

---

## 10. Security considerations

- CRM credentials exist **only** as Netlify environment variables —
  never in frontend code, HTML, the manifest, Git, or logs.
- The browser only ever talks to `/.netlify/functions/order-lookup` on
  the same origin — it never contacts `bss.omanbroadband.om` directly,
  avoiding CORS issues and keeping the CRM session fully server-side.
- CRM session cookies and CSRF tokens are held only in memory for the
  duration of a single function invocation. They are never returned to
  the browser, never written to disk, and never stored in any database
  (this project intentionally uses no database).
- The function logs technical error codes server-side for debugging but
  never logs passwords, cookies, or CSRF token values.
- Order IDs are validated as numeric-only before any CRM request is
  made.
- No order or customer data is persisted anywhere — each search is a
  fresh, stateless lookup.

---

## 11. Notes on future expansion

The codebase intentionally keeps CRM logic isolated in one file and
avoids a database, so it stays easy to extend later with things like
multiple CRM users, saved search history, or an admin panel — none of
that is implemented in this version by design.
