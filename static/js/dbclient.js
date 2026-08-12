/* ============================================================================
   Static data layer for GitHub Pages.

   There is no server here. This module loads the SQLite database in the browser
   with sql.js-httpvfs — SQLite compiled to WebAssembly, reading only the pages
   it needs from the chunked .db files over HTTP range requests — and answers the
   same queries the local Python server did, returning identical JSON shapes.

   It installs a shim over SP.api so that requests to "/api/…" run client-side
   SQL, while "/static/…" requests remain ordinary file fetches. Every view then
   works unchanged.
   ========================================================================== */
(function (SP) {
  "use strict";

  // Absolute URLs (resolved against the page) so they're correct on a project
  // subpath like username.github.io/stuart-letters/ AND when used inside the
  // worker, which resolves relative URLs against its own location, not the page.
  const abs = (rel) => new URL(rel, document.baseURI).href;

  function rangeBanner() {
    if (document.getElementById("range-banner")) return;
    const b = document.createElement("div");
    b.id = "range-banner";
    b.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:10000;background:#A11E1E;color:#fff;"
      + "font:14px/1.55 system-ui,sans-serif;padding:12px 18px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.25)";
    b.innerHTML = "This server doesn’t support byte-range requests, so the archive can’t load. "
      + "Run it with the included <b>serve-local.py</b> (not <code>python3 -m http.server</code>), "
      + "or deploy to GitHub Pages, which supports them.";
    const add = () => document.body.appendChild(b);
    if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
  }
  const DB_CONFIG = [{
    from: "inline",
    virtualFilename: "stuart.db",
    config: {
      serverMode: "chunked",
      urlPrefix: abs("db/stuart.db."),
      requestChunkSize: 1024,        // must equal the DB page_size
      serverChunkSize: 41943040,     // 40 MiB per file
      databaseLengthBytes: 257301504,
      suffixLength: 3,
    },
  }];
  const WORKER_URL = abs("static/vendor/sqljs/sqlite.worker.js");
  const WASM_URL = abs("static/vendor/sqljs/sql-wasm.wasm");

  // --- worker bootstrap -----------------------------------------------------
  let _db = null;
  SP._dbLoaded = false;   // flips true once the WASM engine + first DB pages are ready
  SP._dbReady = (async function init() {
    await (SP._unlock || Promise.resolve());   // wait for the password gate

    // Preflight: this app reads the database with HTTP range requests. Some
    // static servers (notably `python3 -m http.server`) don't support them, in
    // which case the DB can't load — fail with a clear, actionable message
    // rather than a mysterious "not found" later. Probe a real chunk (so it's
    // representative — GitHub Pages returns 206 for these) but abort the body
    // as soon as the status is known, so a non-range server's full-file reply
    // isn't actually downloaded.
    try {
      const ac = new AbortController();
      const probe = await fetch(abs("db/stuart.db.000"), { headers: { Range: "bytes=0-0" }, signal: ac.signal });
      const status = probe.status;
      try { ac.abort(); } catch (e) {}
      if (status !== 206) throw new Error("no-range");
    } catch (e) {
      if (e && e.name === "AbortError") { /* our own abort after reading status is fine */ }
      else {
        rangeBanner();
        throw new Error("This server does not support HTTP range requests, so the archive can't load. "
          + "Run it with the included serve-local.py (not `python3 -m http.server`), or deploy to GitHub Pages.");
      }
    }

    // httpvfs.js is a UMD bundle; loaded via <script> it sets window.createDbWorker
    if (typeof window.createDbWorker !== "function") {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = abs("static/vendor/sqljs/httpvfs.js");
        s.onload = res; s.onerror = () => rej(new Error("failed to load httpvfs.js"));
        document.head.appendChild(s);
      });
    }
    const worker = await window.createDbWorker(DB_CONFIG, WORKER_URL, WASM_URL);
    _db = worker.db;
    SP._worker = worker;
    SP._dbLoaded = true;
    return _db;
  })().catch((e) => { console.error("DB init failed", e); SP._dbError = e; throw e; });

  const q = async (sql, params = []) => {
    if (!_db) await SP._dbReady;
    return _db.query(sql, params);
  };
  const one = async (sql, params = []) => { const r = await q(sql, params); return r[0] || null; };
  const inList = (arr) => arr.map(() => "?").join(",");

  // --- FTS query sanitiser (ported from serve.py) ---------------------------
  function ftsQuery(raw) {
    raw = (raw || "").trim();
    if (!raw) return null;
    const phrases = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const rest = raw.replace(/"[^"]+"/g, " ");
    const terms = [...rest.matchAll(/[\w']+\*?/gu)].map((m) => m[0]);
    const parts = phrases.map((p) => `"${p}"`);
    for (const t of terms) {
      if (["and", "or", "not", "near"].includes(t.toLowerCase())) continue;
      parts.push(t.endsWith("*") ? t : `"${t}"`);
    }
    return parts.join(" ") || null;
  }

  const FILTER_KEYS = ["author", "recipient", "place", "ship", "series", "series2", "series3",
    "has_abstract", "year_min", "year_max", "dated", "precision"];
  const g1 = (qs, k) => (Array.isArray(qs[k]) ? qs[k][0] : qs[k]) || null;

  // --- build the shared WHERE/JOIN for a search -----------------------------
  function buildQuery(qs) {
    const where = [], params = [];
    let joins = "", relevance = false;
    const q0 = (g1(qs, "q") || "").trim();
    const match = q0 ? ftsQuery(q0) : null;
    if (match) {
      joins += " JOIN letters_fts fts ON fts.rowid = l.id ";
      where.push("letters_fts MATCH ?"); params.push(match); relevance = true;
    }
    for (const [key, role, alias] of [["author", "author", "au"], ["recipient", "recipient", "re"]]) {
      const v = g1(qs, key);
      if (v) {
        joins += ` JOIN letter_person ${alias} ON ${alias}.letter_id=l.id AND ${alias}.role='${role}' AND ${alias}.person_key=? `;
        params.push(v);
      }
    }
    const eq = (col, key) => { const v = g1(qs, key); if (v) { where.push(`${col} = ?`); params.push(v); } };
    eq("l.place_key", "place"); eq("l.ship_code", "ship");
    eq("l.series_l1", "series"); eq("l.series_l2", "series2"); eq("l.series_l3", "series3");
    if (g1(qs, "has_abstract") === "1") where.push("l.has_abstract = 1");
    const ymin = g1(qs, "year_min"), ymax = g1(qs, "year_max");
    if (ymin) { where.push("l.year >= ?"); params.push(+ymin); }
    if (ymax) { where.push("l.year <= ?"); params.push(+ymax); }
    if (g1(qs, "dated") === "1") where.push("l.date_certainty <> 'unknown'");
    const prec = g1(qs, "precision");
    if (prec === "day_month") where.push("l.date_certainty IN ('day','dual_calendar','month')");
    else if (prec === "day") where.push("l.date_certainty IN ('day','dual_calendar')");
    const wsql = where.length ? " WHERE " + where.join(" AND ") : "";
    return { joins, wsql, params, match, relevance };
  }

  function hasFilters(qs) {
    if ((g1(qs, "q") || "").trim()) return true;
    return FILTER_KEYS.some((k) => g1(qs, k));
  }

  // --- batched enrichment of letter rows (mirrors serve.enrich_letter) ------
  async function enrichRows(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    // people
    const pr = await q(
      `SELECT lp.letter_id lid, lp.role, lp.person_key k, pe.main_name n
       FROM letter_person lp JOIN person pe ON pe.person_key=lp.person_key
       WHERE lp.letter_id IN (${ids.join(",")})`);
    const people = new Map();
    for (const r of pr) {
      let e = people.get(r.lid); if (!e) people.set(r.lid, e = { author: [], recipient: [] });
      e[r.role].push({ k: r.k, n: r.n });
    }
    // places & ships
    const placeKeys = [...new Set(rows.map((r) => r.place_key).filter(Boolean))];
    const shipKeys = [...new Set(rows.map((r) => r.ship_code).filter(Boolean))];
    const placeName = new Map(), shipName = new Map();
    if (placeKeys.length) (await q(
      `SELECT place_id k, place_name n FROM place WHERE place_id IN (${inList(placeKeys)})`, placeKeys))
      .forEach((r) => placeName.set(r.k, r.n));
    if (shipKeys.length) (await q(
      `SELECT ship_code k, master_name n FROM ship WHERE ship_code IN (${inList(shipKeys)})`, shipKeys))
      .forEach((r) => shipName.set(r.k, r.n));

    return rows.map((r) => {
      const pp = people.get(r.id) || { author: [], recipient: [] };
      return {
        id: r.id, shelfmark: r.letter_id,
        date: r.date_display, certainty: r.date_certainty, year: r.year,
        authors: pp.author, recipients: pp.recipient,
        place: r.place_key ? { k: r.place_key, n: placeName.get(r.place_key) || r.place_key } : null,
        ship: r.ship_code ? { k: r.ship_code, n: shipName.get(r.ship_code) || r.ship_code } : null,
        has_abstract: r.has_abstract,
        series: [r.series_l1, r.series_l2].filter(Boolean),
        snippet: r.snip != null ? r.snip : null,
      };
    });
  }

  // --- endpoint: search -----------------------------------------------------
  // A filtered/text search's facets each re-run the full (network-backed) FTS
  // match from scratch — 5-6 separate full scans, on top of the count and the
  // results page. Re-using one materialized match set across them would be
  // faster but isn't safe here (see git history — it hit a real bug in the
  // vendored sql.js-httpvfs worker's chunk loader under concurrent
  // read/write). Instead, facets=only lets the frontend fetch the letters
  // first (one scan) and load facets separately afterwards, so results appear
  // without waiting on all of them.
  async function apiSearch(qs) {
    const { joins, wsql, params, match, relevance } = buildQuery(qs);
    const base = `FROM letter l ${joins} ${wsql}`;
    const wantResults = g1(qs, "facets") !== "only";

    const out = {};
    if (wantResults) {
      out.total = (await one(`SELECT COUNT(DISTINCT l.id) c ${base}`, params)).c;

      const sort = g1(qs, "sort") || (match ? "relevance" : "date");
      let order;
      if (sort === "relevance" && relevance) order = "ORDER BY rank";
      else if (sort === "date_desc") order = "ORDER BY l.year DESC, l.date_start DESC";
      else order = "ORDER BY (l.year IS NULL), l.year, l.date_start";

      out.limit = Math.min(+(g1(qs, "limit") || 50), 500);
      out.offset = +(g1(qs, "offset") || 0);
      const snip = match ? "snippet(letters_fts,0,'<mark>','</mark>','…',12)" : "NULL";
      const rows = await q(
        `SELECT l.id, l.letter_id, l.date_display, l.date_certainty, l.year,
                l.place_key, l.ship_code, l.has_abstract, l.series_l1, l.series_l2,
                ${snip} AS snip
         ${base} ${order} LIMIT ? OFFSET ?`, [...params, out.limit, out.offset]);
      out.results = await enrichRows(rows);
    }
    if (g1(qs, "facets") === "1" || g1(qs, "facets") === "only") {
      out.facets = hasFilters(qs)
        ? await computeFacets(joins, wsql, params)
        : await SP.api("/static/data/facets-global.json");
    }
    return out;
  }

  async function computeFacets(joins, wsql, params) {
    const frm = (extra = "") => `FROM letter l ${joins} ${extra} ${wsql}`;
    const andWhere = (cond) => (wsql.trim() ? wsql + ` AND ${cond}` : ` WHERE ${cond}`);
    const facets = {};
    const colFacet = async (col) => q(
      `SELECT ${col} k, COUNT(*) n FROM letter l ${joins} ${andWhere(`${col} IS NOT NULL`)}
       GROUP BY ${col} ORDER BY n DESC LIMIT 12`, params);
    facets.series = await colFacet("l.series_l1");
    facets.source_series = await colFacet("l.series_l2");
    for (const [role, label] of [["author", "authors"], ["recipient", "recipients"]]) {
      const j = `JOIN letter_person lp ON lp.letter_id=l.id AND lp.role='${role}' JOIN person pe ON pe.person_key=lp.person_key`;
      facets[label] = await q(
        `SELECT lp.person_key k, pe.main_name n, COUNT(*) c ${frm(j)}
         GROUP BY lp.person_key ORDER BY c DESC LIMIT 10`, params);
    }
    facets.places = await q(
      `SELECT l.place_key k, pl.place_name n, COUNT(*) c ${frm("JOIN place pl ON pl.place_id=l.place_key")}
       GROUP BY l.place_key ORDER BY c DESC LIMIT 10`, params);
    facets.year_hist = await q(
      `SELECT l.year year, COUNT(*) n FROM letter l ${joins} ${andWhere("l.year IS NOT NULL")}
       GROUP BY l.year ORDER BY l.year`, params);
    return facets;
  }

  // --- endpoint: letter -----------------------------------------------------
  async function apiLetter(id) {
    id = +id;
    const r = await one("SELECT * FROM letter WHERE id=?", [id]);
    if (!r) return { error: "not found" };
    const [enriched] = await enrichRows([{ ...r, snip: null }]);
    const ab = await one("SELECT text, text_raw FROM abstract WHERE letter_id=?", [id]);
    enriched.abstract = ab ? ab.text : "";
    enriched.abstract_raw = ab ? ab.text_raw : "";
    enriched.folio = r.folio;
    enriched.series_full = [r.series_l1, r.series_l2, r.series_l3, r.folio].filter(Boolean);
    if (r.place_key) {
      const pr = await one("SELECT lat, lon, wikidata_id FROM place WHERE place_id=?", [r.place_key]);
      if (pr && pr.lat) { enriched.place.lat = +pr.lat; enriched.place.lon = +pr.lon; enriched.place.wikidata = pr.wikidata_id; }
    }
    if (r.ship_code) {
      const sr = await one("SELECT labels FROM ship WHERE ship_code=?", [r.ship_code]);
      if (sr) enriched.ship.labels = sr.labels;
    }
    if (r.series_l3) {
      enriched.siblings = await q(
        "SELECT id, letter_id, date_display FROM letter WHERE series_l3=? " +
        "ORDER BY (year IS NULL), year, date_start LIMIT 400", [r.series_l3]);
    }
    return enriched;
  }

  // --- endpoint: person -----------------------------------------------------
  async function apiPerson(key) {
    const p = await one("SELECT * FROM person WHERE person_key=?", [key]);
    if (!p) return { error: "not found" };
    const topCorr = (myRole, theirRole) => q(
      `SELECT other.person_key k, pe.main_name n, COUNT(DISTINCT l.id) c
       FROM letter_person mine JOIN letter l ON l.id=mine.letter_id
       JOIN letter_person other ON other.letter_id=l.id AND other.role='${theirRole}'
       JOIN person pe ON pe.person_key=other.person_key
       WHERE mine.person_key=? AND mine.role='${myRole}'
       GROUP BY other.person_key ORDER BY c DESC LIMIT 12`, [key]);
    p.top_recipients = await topCorr("author", "recipient");
    p.top_authors = await topCorr("recipient", "author");

    // ego + alter network with ties among the correspondents (mirrors serve.py)
    const alters = new Map();
    for (const r of p.top_recipients) alters.set(r.k, { k: r.k, n: r.n, out: r.c, in: 0 });
    for (const r of p.top_authors) { const a = alters.get(r.k) || { k: r.k, n: r.n, out: 0, in: 0 }; a.in = r.c; alters.set(r.k, a); }
    const alterKeys = [...alters.keys()].filter((k) => k !== key).slice(0, 14);
    const edges = [];
    for (const k of alterKeys) { const a = alters.get(k); edges.push({ a: key, b: k, c: a.out + a.in }); }
    if (alterKeys.length >= 2) {
      const ph = inList(alterKeys);
      const rows = await q(
        `SELECT la.person_key a, lb.person_key b, COUNT(DISTINCT l.id) c
         FROM letter l
         JOIN letter_person la ON la.letter_id=l.id AND la.role='author'    AND la.person_key IN (${ph})
         JOIN letter_person lb ON lb.letter_id=l.id AND lb.role='recipient' AND lb.person_key IN (${ph})
         WHERE la.person_key <> lb.person_key
         GROUP BY la.person_key, lb.person_key`, [...alterKeys, ...alterKeys]);
      const seen = new Map();
      for (const r of rows) { const pr = [r.a, r.b].sort().join("|"); seen.set(pr, (seen.get(pr) || 0) + r.c); }
      for (const [pr, cc] of seen) { const [a, b] = pr.split("|"); edges.push({ a, b, c: cc, alter: 1 }); }
    }
    const nodes = [{ k: key, n: p.main_name, dir: "ego", w: (p.n_authored || 0) + (p.n_received || 0) }];
    for (const k of alterKeys) {
      const a = alters.get(k);
      nodes.push({ k, n: a.n, dir: a.out && a.in ? "both" : a.out ? "out" : "in", w: a.out + a.in });
    }
    p.network = { nodes, edges };
    p.year_hist = await q(
      `SELECT l.year y, SUM(lp.role='author') a, SUM(lp.role='recipient') r
       FROM letter_person lp JOIN letter l ON l.id=lp.letter_id
       WHERE lp.person_key=? AND l.year IS NOT NULL GROUP BY l.year ORDER BY l.year`, [key]);
    p.places = await q(
      `SELECT l.place_key k, pl.place_name n, pl.lat, pl.lon, COUNT(*) c
       FROM letter_person lp JOIN letter l ON l.id=lp.letter_id
       JOIN place pl ON pl.place_id=l.place_key
       WHERE lp.person_key=? AND lp.role='author'
       GROUP BY l.place_key ORDER BY c DESC LIMIT 40`, [key]);
    return p;
  }

  // --- endpoint: pair -------------------------------------------------------
  async function apiPair(a, b) {
    const rows = await q(
      `SELECT DISTINCT l.id, l.letter_id, l.date_display, l.date_certainty, l.year,
              l.place_key, l.ship_code, l.has_abstract, l.series_l1, l.series_l2
       FROM letter l
       JOIN letter_person la ON la.letter_id=l.id AND la.role='author' AND la.person_key=?
       JOIN letter_person lb ON lb.letter_id=l.id AND lb.role='recipient' AND lb.person_key=?
       ORDER BY (l.year IS NULL), l.year, l.date_start`, [a, b]);
    const names = {};
    for (const k of [a, b]) { const r = await one("SELECT main_name FROM person WHERE person_key=?", [k]); names[k] = r ? r.main_name : k; }
    return { a: { k: a, n: names[a] }, b: { k: b, n: names[b] },
             letters: await enrichRows(rows.map((r) => ({ ...r, snip: null }))) };
  }

  // --- endpoint: place ------------------------------------------------------
  async function apiPlace(key) {
    const p = await one("SELECT * FROM place WHERE place_id=?", [key]);
    if (!p) return { error: "not found" };
    p.year_hist = await q(
      "SELECT year y, COUNT(*) n FROM letter WHERE place_key=? AND year IS NOT NULL GROUP BY year ORDER BY year", [key]);
    p.top_authors = await q(
      `SELECT lp.person_key k, pe.main_name n, COUNT(DISTINCT l.id) c
       FROM letter l JOIN letter_person lp ON lp.letter_id=l.id AND lp.role='author'
       JOIN person pe ON pe.person_key=lp.person_key
       WHERE l.place_key=? GROUP BY lp.person_key ORDER BY c DESC LIMIT 12`, [key]);
    return p;
  }

  // --- endpoint: ship -------------------------------------------------------
  async function apiShip(key) {
    const s = await one("SELECT * FROM ship WHERE ship_code=?", [key]);
    if (!s) return { error: "not found" };
    s.itinerary = await q(
      `SELECT l.place_key k, pl.place_name n, pl.lat, pl.lon,
              MIN(l.year) y0, MAX(l.year) y1, COUNT(*) c
       FROM letter l JOIN place pl ON pl.place_id=l.place_key
       WHERE l.ship_code=? GROUP BY l.place_key ORDER BY y0`, [key]);
    return s;
  }

  // --- CSV export (client-side blob) ---------------------------------------
  const CSV_CAP = 2000;
  SP.exportCsv = async function (params) {
    const header = ["letter_id", "shelfmark", "date", "certainty", "year",
      "authors", "recipients", "place", "ship", "series", "has_abstract"];
    const esc = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [header.join(",")];
    let offset = 0, total = Infinity;
    const qs = { ...params, facets: "0", limit: String(500) };
    while (offset < total && offset < CSV_CAP) {
      qs.offset = String(offset);
      const page = await apiSearch(qs);
      total = page.total;
      for (const r of page.results) {
        lines.push([r.id, r.shelfmark, r.date, r.certainty, r.year || "",
          r.authors.map((a) => a.n).join("; "), r.recipients.map((a) => a.n).join("; "),
          r.place ? r.place.n : "", r.ship ? r.ship.n : "", r.series.join(" / "), r.has_abstract
        ].map(esc).join(","));
      }
      offset += page.limit;
    }
    if (total > CSV_CAP) lines.push(esc(`… ${total - CSV_CAP} further rows omitted (static export is capped at ${CSV_CAP}; use the local server build for the full set)`));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "stuart-letters.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // --- install the /api shim over SP.api ------------------------------------
  const rawApi = SP.api;
  SP.api = async function (path) {
    // Static files: resolve against the deployment base (e.g. /<repo>/) so they
    // work on a GitHub Pages project subpath, not just at the site root.
    if (!path.startsWith("/api/")) return rawApi(abs(path.replace(/^\//, "")));
    const u = new URL(path, location.origin);
    const p = u.pathname;
    let m;
    if (p === "/api/search") {
      const obj = {};
      for (const [k, v] of u.searchParams) obj[k] = v;
      return apiSearch(obj);
    }
    if ((m = p.match(/^\/api\/letter\/(\d+)$/))) return apiLetter(m[1]);
    if ((m = p.match(/^\/api\/person\/(.+)$/))) return apiPerson(decodeURIComponent(m[1]));
    if ((m = p.match(/^\/api\/pair\/([^/]+)\/([^/]+)$/))) return apiPair(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if ((m = p.match(/^\/api\/place\/(.+)$/))) return apiPlace(decodeURIComponent(m[1]));
    if ((m = p.match(/^\/api\/ship\/(.+)$/))) return apiShip(decodeURIComponent(m[1]));
    throw new Error("unknown endpoint " + p);
  };
})(window.SP);
