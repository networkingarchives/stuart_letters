# Stuart Letters — static (GitHub Pages) build

The same Stuart State Papers correspondence explorer as the local version, but
with **no server at all**. The SQLite database runs *in the browser*: SQLite
compiled to WebAssembly reads only the pages each query needs from the chunked
`.db` files over HTTP range requests. Full-text search over 174,278 abstracts,
faceted metadata search, and every entity page work client-side. It costs
nothing to host, cannot go down for want of maintenance, and is archivable as a
single repository.

Everything needed is already in this folder, database included. You do not need
to build anything to deploy it.

---

## Try it locally first

The database loads over HTTP **range requests**, and Python's built-in
`python3 -m http.server` does *not* support them — with it, the database never
loads and pages fail. Use the included range-capable server instead:

```bash
cd stuart-pages
python3 serve-local.py
```

Open <http://localhost:8000>. Enter the password (see below), then the first
search takes a second or two while the database engine loads and fetches its
first pages; after that it's quick.

> Two things that won't work and why: opening `index.html` directly (`file://`
> has no range support), and `python3 -m http.server` (no range support either).
> `serve-local.py` mimics GitHub Pages, which *does* support ranges — so if it
> works here, it works deployed. If a server without range support is ever used,
> the app now says so plainly instead of failing silently.

---

## Deploy to GitHub Pages

1. Create a new GitHub repository (public, so Pages is free).
2. Put the **contents of this folder** at the repository root — including
   `index.html`, `.nojekyll`, `static/`, and the `db/` chunks — and push to
   `main`.
   ```bash
   cd stuart-pages
   git init && git add -A && git commit -m "Stuart Letters"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages** and set the source to
   **GitHub Actions**. The included workflow (`.github/workflows/deploy.yml`)
   publishes the site on every push. (Alternatively, choose *Deploy from a
   branch → main → / (root)*; both work because all asset paths are relative.)
4. Your site appears at `https://<you>.github.io/<repo>/`.

The database is seven ~40 MB chunks, each well under GitHub's 100 MB file limit;
the whole repository is ~260 MB, within Pages' 1 GB limit.

`.nojekyll` is present so GitHub serves the files as-is. The app uses hash-based
routing (`…/#/person/…`), so deep links and reloads work with no extra
configuration.

---

## Password protection — and what it does and doesn't do

The site ships with a login screen. It's enabled by default; the starter
password is **`stuart-letters`**. Change it before you deploy:

```bash
python3 tools/set_password.py          # prompts for a new password
# or:  python3 tools/set_password.py --password "your-password"
# or:  python3 tools/set_password.py --off      # remove the login entirely
```

This writes `static/js/gate-config.js` with a PBKDF2-SHA256 salt and hash; the
plaintext is never stored. The browser recomputes the hash from what the visitor
types and compares. A correct entry is remembered for the browser session, and
nothing — not even the database — loads until it's entered.

**Please read this part.** On a public static host, a password typed in the
browser is a *soft gate*. It hides the interface, keeps the site out of search
engines, and stops casual visitors — but it **cannot make the database files
private**. There is no server here to check credentials, so anyone who knows the
URL of a chunk (`…/db/stuart.db.000`) can still download it directly. The login
protects the front door; the files sit in an unlocked room behind it.

For the Gale-derived abstracts, that distinction matters. If you need the data
itself to be genuinely inaccessible without a login, use a host that enforces
auth at the edge — the files don't change, only where they live:

- **Cloudflare Pages + Cloudflare Access** (free for small teams) is the
  cleanest fit. Push this same folder to Cloudflare Pages, then add an Access
  policy (e.g. "only these email addresses") in front of the project. Every
  request — pages *and* `.db` chunks — is then checked before anything is served.
  You can turn the built-in login off (`tools/set_password.py --off`) since
  Access handles it.
- **Netlify** offers site-wide password protection on paid plans; **Vercel**
  supports password protection and SSO-gated deployments similarly.

In short: keep the built-in login for convenience and casual privacy; add
Cloudflare Access (or similar) when the data must actually be restricted.

---

## Updating the data

When the source CSVs change, rebuild in one command:

```bash
python3 tools/prepare_db.py --src /path/to/networking-archives-data
```

This rebuilds the database at the correct page size, re-splits it into `db/`,
refreshes the JSON indexes, and patches the size constants in
`static/js/dbclient.js` to match. Review the diff, commit, and push — the site
redeploys itself.

---

## How the static version works

```
stuart-pages/
├─ index.html                     app shell
├─ .nojekyll
├─ serve-local.py                 range-capable local test server (mimics Pages)
├─ db/stuart.db.000 … .006        the SQLite database, split into 40 MB chunks
├─ static/
│  ├─ js/
│  │  ├─ gate.js gate-config.js  password login screen (see below)
│  │  ├─ dbclient.js              loads SQLite-WASM and answers /api/* in-browser
│  │  ├─ util.js charts.js map.js views.js app.js   (identical to the local build)
│  ├─ data/*.json                 typeahead, map, tree, stats, global facets
│  ├─ vendor/sqljs/               sql.js-httpvfs runtime (wasm + worker), FTS5-enabled
│  ├─ vendor/leaflet/             Leaflet (zoomable maps; basemap tiles need internet)
│  └─ vendor/fonts/*.woff2        self-hosted fonts
├─ pipeline/build.py              CSVs → SQLite + FTS5 + JSON
├─ tools/prepare_db.py            rebuild + chunk + patch constants
└─ .github/workflows/deploy.yml   publish to Pages
```

The frontend is byte-for-byte the same as the local build; only the data layer
differs. Locally, a Python server answered `/api/…` with SQL. Here,
`dbclient.js` intercepts those same calls and runs the identical SQL against the
in-browser database via [`sql.js-httpvfs`](https://github.com/phiresky/sql.js-httpvfs),
returning identical results. Because the queries never changed, the two builds
stay in lock-step.

Two deliberate choices make the static version efficient:

- **1 KB page size.** The database is built with `page_size = 1024` (matching the
  library's `requestChunkSize`), so a typical indexed query fetches only a few
  kilobytes rather than whole 4 KB pages.
- **Precomputed global facets.** The default, unfiltered view reads its facet
  counts from a small JSON file instead of scanning the whole corpus over the
  network. Once you search or filter, facets are computed live from the (smaller)
  matching set.

There are no third-party JavaScript libraries beyond the SQLite engine itself —
the map, sparklines, and correspondence networks are hand-drawn SVG.

---

## Limitations specific to the static build

- **First-query latency.** Loading the ~1.2 MB WebAssembly engine and the first
  database pages takes a second or two on first use. This is normal and only
  happens once per visit.
- **CSV export is capped** at 2,000 rows here, because assembling a very large
  export over range requests would mean fetching a large share of the database.
  For an unlimited export, use the local server build.
- **Browser support.** Needs a modern browser with WebAssembly and Web Workers
  (anything from the last several years). If the engine can't load, the
  browsing pages that read only static JSON — Browse, Places, Ships, About —
  still work; search and entity pages will report the problem.

---

## A note on rights

These abstracts derive from Gale's *State Papers Online*, and GitHub Pages is
public with no access control. **Confirm that publishing the abstract text is
permitted before making the repository public.** If it isn't, the same app can
run from a private host with access rules, or with abstracts shortened to
snippets. See the plan document for the alternatives.
