/* Page renderers. window.SP.views — each returns nothing, renders into #app. */
(function (SP) {
  "use strict";
  SP.views = SP.views || {};
  const { el, esc, fmt, api, certGlyph, personLink, placeLink, shipLink, corr } = SP;
  const app = () => document.getElementById("app");
  SP._pendingMaps = [];
  const mount = (node) => {
    app().replaceChildren(node); SP.top();
    const q = SP._pendingMaps; SP._pendingMaps = [];
    q.forEach(({ el, points, opts }) => { try { SP.map.render(el, points, opts); } catch (e) { console.error(e); } });
  };
  // register a Leaflet map to be initialised once `el` is in the DOM (after mount)
  const queueMap = (el, points, opts) => { SP._pendingMaps.push({ el, points, opts }); return el; };
  const loading = (label) => mount(el("div.loading-wrap", {}, [
    el("div.loading", { text: label || "Loading" }),
    !SP._dbLoaded && el("div.loading-hint", {
      text: "First load takes a few seconds — the search engine and database are still downloading."
    }),
  ]));

  // shared: a ledger result row from an enriched letter
  function entryRow(L) {
    const shortDate = (L.date || "").replace(/\s*\(O\.S\.\/N\.S\.\)/, "");
    const dateHtml = `${esc(shortDate)} ${certGlyph(L.certainty)}`;
    const meta = [];
    if (L.place) meta.push(`from ${placeLink(L.place)}`);
    if (L.ship) meta.push(`ship ${shipLink(L.ship)}`);
    if (L.series && L.series.length) meta.push(esc(L.series[L.series.length - 1]));
    const snip = L.snippet
      ? `<div class="snip">${L.snippet}</div>`
      : (L.has_abstract ? "" : "");
    return el("li.entry", { html: `
      <div class="col-date">${dateHtml}</div>
      <div>
        <div class="corr"><a href="#/letter/${L.id}" style="color:var(--ink)">${corr(L.authors,"author")}</a>
          <span class="arrow">→</span> ${corr(L.recipients,"recipient")}</div>
        ${snip}
        <div class="meta-line">${meta.join('<span class="dim">·</span> ')}</div>
      </div>
      <div class="col-mark">
        <a href="#/letter/${L.id}" class="mono">${esc(L.shelfmark || "")}</a>
        ${L.has_abstract ? "" : '<div class="noabs">no abstract</div>'}
      </div>` });
  }

  // =========================================================================
  // HOME
  // =========================================================================
  SP.views.home = async function () {
    SP.setNav("search"); SP.title("");
    loading("Reading the corpus");
    const s = await api("/static/data/stats.json");
    const node = el("div");
    node.append(el("div.hero", { html: `
      <h1>The <span class="rubric">Stuart</span> State Papers, as a correspondence</h1>
      <p class="lede">A research interface to ${fmt(s.records)} correspondence records —
        ${fmt(s.letters)} letters — calendared in the State Papers of the Stuart period.
        Search the abstracts, follow a hand through the archive, trace a ship, read a
        volume folio by folio.</p>` }));
    const form = el("form.hero-search");
    const input = el("input", { type: "search", placeholder: "Search abstracts, people, shelfmarks…", "aria-label": "Search" });
    form.append(input, el("button", { type: "submit", text: "Search" }));
    form.addEventListener("submit", (e) => { e.preventDefault(); SP.go("#/search?" + SP.qs({ q: input.value.trim() })); });
    node.querySelector(".hero").append(form);

    node.append(el("div.corpus-strip", { html: `
      ${cell(s.letters, "letters")}
      ${cell(s.with_abstract, "with abstracts")}
      ${cell(s.people, "people")}
      ${cell(s.places_used, "places")}
      ${cell(s.ships, "ships")}
      ${cell(s.shipboard_letters, "shipboard letters")}` }));

    // year ribbon (clickable + brushable → search by year)
    const ribbon = el("div.year-ribbon");
    ribbon.append(el("div.panel-h", { html: `Letters by year · ${SP.YEAR_MIN}–${SP.YEAR_MAX} <span class="dim" style="text-transform:none;letter-spacing:0">— click or drag to filter</span>` }));
    ribbon.append(SP.charts.yearRibbon(s.year_hist, {
      onRange: (a, b) => SP.go("#/search?" + SP.qs({ year_min: a, year_max: b })),
    }));
    node.append(ribbon);

    node.append(el("div.home-cols", {}, colList("Most-addressed", await topPeople("recipients")),
      colList("Most prolific authors", await topPeople("authors"))));

    // honest caveat
    node.append(el("p.map-note", { style: { marginTop: "30px" }, html:
      `${fmt(s.no_place)} letters (${Math.round(100 * s.no_place / s.letters)}%) record no place of sending, and ${fmt(s.undated)} are undated. The interface shows these gaps rather than hiding them.` }));
    mount(node);

    function cell(n, l) { return `<div class="cell"><div class="num tnum">${fmt(n)}</div><div class="lbl">${l}</div></div>`; }
    function colList(title, items) {
      const ul = el("ul.home-list");
      items.forEach((p) => ul.append(el("li", { html: `${personLink(p)}<span class="c tnum">${fmt(p.c)}</span>` })));
      return el("div", {}, el("h3", { text: title }), ul);
    }
  };
  async function topPeople(kind) {
    // derive from a facet-less search: cheap enough via people-index
    const idx = await peopleIndex();
    const key = kind === "recipients" ? "r" : "a";
    return idx.slice().sort((a, b) => b[key] - a[key]).slice(0, 12)
      .map((p) => ({ k: p.k, n: p.n, c: p[key] }));
  }

  // people index cache (shared with omnisearch)
  let _pidx = null;
  async function peopleIndex() {
    if (!_pidx) _pidx = await api("/static/data/people-index.json");
    return _pidx;
  }
  SP.peopleIndex = peopleIndex;

  // =========================================================================
  // SEARCH
  // =========================================================================
  SP.views.search = async function (params) {
    SP.setNav("search");
    const q = params.q || "";
    SP.title(q ? `“${q}”` : "Search");
    loading("Searching");

    const query = { ...params, facets: "1", limit: params.limit || "50", offset: params.offset || "0" };
    let data;
    try { data = await api("/api/search?" + SP.qs(query)); }
    catch (e) { return mount(el("div.empty", { text: "Search failed: " + e.message })); }

    const wrap = el("div.wrap-search");
    // ---- facet rail ----
    const rail = el("aside.rail");
    rail.append(activeChips(params));
    rail.append(dateFacet(params, data));
    rail.append(facetBlock("Author", data.facets.authors, "author", params, (x) => x.n, (x) => x.k, (x) => x.c));
    rail.append(facetBlock("Recipient", data.facets.recipients, "recipient", params, (x) => x.n, (x) => x.k, (x) => x.c));
    rail.append(facetBlock("Place of sending", data.facets.places, "place", params, (x) => x.n, (x) => x.k, (x) => x.c));
    rail.append(facetBlock("Archive division", data.facets.series, "series", params, (x) => x.k, (x) => x.k, (x) => x.n));
    rail.append(facetBlock("Class", data.facets.source_series, "series2", params, (x) => x.k, (x) => x.k, (x) => x.n));
    rail.append(togglesFacet(params));
    wrap.append(rail);

    // ---- results ----
    const main = el("div");
    const tools = el("div.results-tools");
    const sortSel = el("select.btn");
    [["date", "Date ↑"], ["date_desc", "Date ↓"], ["relevance", "Relevance"]].forEach(([v, l]) => {
      const o = el("option", { value: v, text: l }); if ((params.sort || (q ? "relevance" : "date")) === v) o.selected = true; sortSel.append(o);
    });
    sortSel.addEventListener("change", () => updateParam(params, "sort", sortSel.value));
    const exportBtn = el("button.btn", { text: "Export CSV", onclick: () => { exportBtn.textContent = "Preparing…"; SP.exportCsv(params).then(() => exportBtn.textContent = "Export CSV").catch(() => exportBtn.textContent = "Export failed"); } });
    const permaBtn = el("button.btn", { text: "Copy link",
      onclick: () => { navigator.clipboard?.writeText(location.href); permaBtn.textContent = "Copied"; setTimeout(() => permaBtn.textContent = "Copy link", 1200); } });
    tools.append(sortSel, exportBtn, permaBtn);

    main.append(el("div.results-head", {},
      el("div.results-count", { html: `<b>${fmt(data.total)}</b> ${data.total === 1 ? "letter" : "letters"}` }),
      tools));

    if (q) main.append(el("div.fulltext-note", { html:
      `Searching the text of ${data.total ? "" : ""}Stuart abstracts for <b>${esc(q)}</b>. Abstracts are Gale’s calendar summaries, not full transcriptions — matches are in the summary text.` }));

    if (!data.results.length) {
      main.append(el("div.empty", { text: "No letters match these filters. Try removing one." }));
    } else {
      const ul = el("ul.ledger");
      data.results.forEach((L) => ul.append(entryRow(L)));
      main.append(ul);
      main.append(pager(params, data));
    }
    wrap.append(main);
    mount(wrap);
  };

  function activeChips(params) {
    const box = el("div", { style: { marginBottom: "6px" } });
    const labels = { q: "text", author: "author", recipient: "recipient", place: "place",
      ship: "ship", series: "division", series2: "series", series3: "class", year_min: "from", year_max: "to",
      has_abstract: "has abstract", dated: "dated only", precision: "precision" };
    let any = false;
    Object.keys(labels).forEach((k) => {
      if (params[k]) {
        any = true;
        const chip = el("span.chip-active", { html: `${labels[k]}: ${esc(shortVal(k, params[k]))} ` });
        chip.append(el("button", { text: "×", title: "remove", onclick: () => removeParam(params, k) }));
        box.append(chip);
      }
    });
    if (any) { const clr = el("a.btn", { href: "#/search", text: "Clear all", style: { marginTop: "4px", display: "inline-block" } }); box.append(clr); }
    return box;
  }
  function shortVal(k, v) {
    if ((k === "author" || k === "recipient") && SP._nameCache && SP._nameCache[v]) return SP._nameCache[v];
    return v.length > 20 ? v.slice(0, 19) + "…" : v;
  }

  function dateFacet(params, data) {
    const f = el("div.facet");
    f.append(el("div.facet-h", { html: `<span>Date</span><span class="dim" style="text-transform:none;letter-spacing:0;font-size:10px">drag to filter</span>` }));
    const box = el("div");
    const ymin = +params.year_min || null, ymax = +params.year_max || null;
    // Prefer the histogram scoped to the current results (from computeFacets);
    // only an unfiltered search falls back to the whole-corpus one from stats.json.
    const histSource = data.facets && data.facets.year_hist ? Promise.resolve(data.facets.year_hist) : statsCache().then((s) => s.year_hist);
    histSource.then((hist) => {
      const ribbon = SP.charts.yearRibbon(hist, {
        selMin: ymin, selMax: ymax,
        onRange: (a, b) => { const np = { ...params }; np.year_min = a; np.year_max = b; np.offset = ""; SP.go("#/search?" + SP.qs(clean(np))); },
      });
      const holder = el("div", { style: { height: "48px", margin: "2px 0 8px" } });
      holder.append(ribbon);
      box.prepend(holder);
    });
    const range = el("div.year-range");
    const lo = el("input", { type: "number", min: SP.YEAR_MIN, max: SP.YEAR_MAX, placeholder: String(SP.YEAR_MIN), value: params.year_min || "", "aria-label": "year from" });
    const hi = el("input", { type: "number", min: SP.YEAR_MIN, max: SP.YEAR_MAX, placeholder: String(SP.YEAR_MAX), value: params.year_max || "", "aria-label": "year to" });
    const apply = () => {
      const np = { ...params }; np.year_min = lo.value || ""; np.year_max = hi.value || ""; np.offset = "";
      SP.go("#/search?" + SP.qs(clean(np)));
    };
    lo.addEventListener("change", apply); hi.addEventListener("change", apply);
    range.append(lo, hi);
    box.append(range);
    f.append(box);
    return f;
  }

  function togglesFacet(params) {
    const f = el("div.facet");
    f.append(el("div.facet-h", { html: "<span>Refine</span>" }));
    const row = el("div.toggle-row");
    const mk = (key, val, label) => {
      const cb = el("input", { type: "checkbox" }); cb.checked = params[key] === val;
      cb.addEventListener("change", () => updateParam(params, key, cb.checked ? val : ""));
      return el("label", {}, cb, label);
    };
    row.append(mk("has_abstract", "1", "Has an abstract"));
    row.append(mk("dated", "1", "Dated letters only"));
    row.append(mk("precision", "day_month", "Month-precision or better"));
    f.append(row);
    return f;
  }

  function facetBlock(title, items, key, params, labelFn, keyFn, countFn) {
    if (!items || !items.length) return document.createComment("");
    const f = el("div.facet");
    f.append(el("div.facet-h", { html: `<span>${title}</span>` }));
    const ul = el("ul.facet-list");
    items.forEach((it) => {
      const li = el("li", { html: `<span>${esc(labelFn(it))}</span><span class="c tnum">${fmt(countFn(it))}</span>` });
      li.addEventListener("click", () => {
        if (key === "author" || key === "recipient") { SP._nameCache = SP._nameCache || {}; SP._nameCache[keyFn(it)] = labelFn(it); }
        updateParam(params, key, keyFn(it));
      });
      ul.append(li);
    });
    f.append(ul);
    return f;
  }

  function pager(params, data) {
    const p = el("div.pager");
    const off = +params.offset || 0, lim = data.limit;
    if (off > 0) p.append(el("button.btn", { text: "‹ Previous", onclick: () => updateParam(params, "offset", String(Math.max(0, off - lim))) }));
    const from = off + 1, to = Math.min(off + lim, data.total);
    p.append(el("span.results-count", { style: { alignSelf: "center" }, html: `${fmt(from)}–${fmt(to)} of ${fmt(data.total)}` }));
    if (to < data.total) p.append(el("button.btn", { text: "Next ›", onclick: () => updateParam(params, "offset", String(off + lim)) }));
    return p;
  }

  const clean = (o) => { const r = {}; for (const k in o) if (o[k] != null && o[k] !== "") r[k] = o[k]; return r; };
  function updateParam(params, k, v) { const np = { ...params }; np[k] = v; if (k !== "offset") np.offset = ""; SP.go("#/search?" + SP.qs(clean(np))); }
  function removeParam(params, k) { const np = { ...params }; delete np[k]; np.offset = ""; SP.go("#/search?" + SP.qs(clean(np))); }

  // stats cache + helpers
  let _stats = null;
  function statsCache() { if (!_stats) _stats = api("/static/data/stats.json"); return _stats; }
  function binYears(hist, y0, y1, nbins) {
    const step = Math.max(1, Math.ceil((y1 - y0) / nbins));
    const map = new Map();
    hist.forEach((d) => { const b = y0 + Math.floor((d.year - y0) / step) * step; map.set(b, (map.get(b) || 0) + d.n); });
    const out = [];
    for (let b = y0; b <= y1; b += step) out.push({ y0: b, y1: b + step - 1, n: map.get(b) || 0 });
    return out;
  }

  // =========================================================================
  // LETTER
  // =========================================================================
  SP.views.letter = async function (params, id) {
    SP.setNav(null); loading("Retrieving letter");
    let L;
    try { L = await api("/api/letter/" + id); } catch { return notFound("letter"); }
    if (!L || L.error) return notFound("letter");
    SP.title(`${L.authors.map((a) => a.n).join(", ") || "?"} → ${L.recipients.map((r) => r.n).join(", ") || "?"}`);

    const node = el("div.entity");
    node.append(el("div.breadcrumb", { html: `<a href="#/search">Search</a> › Letter ${esc(L.shelfmark || "")}` }));

    node.append(el("div.record-head", { html:
      `<span class="record-date">${esc(L.date)}</span> ${certGlyph(L.certainty)}
       <span class="dim mono">${esc(SP.CERT_LABEL[L.certainty])}</span>` }));

    node.append(el("div.corresp-line", { html:
      `${corr(L.authors, "author")} <span class="arrow">→</span> ${corr(L.recipients, "recipient")}` }));

    if (L.ship) node.append(el("p", { html: `Sent aboard the <b>${shipLink(L.ship)}</b>${L.ship.labels ? ` <span class="dim">— “${esc(L.ship.labels.split(" | ")[0])}”</span>` : ""}` }));

    node.append(el("hr.rule-strong"));

    // abstract
    if (L.abstract && L.abstract.trim()) {
      node.append(el("div.abstract.rubric-initial", { html: esc(L.abstract) }));
    } else {
      node.append(el("div.no-abstract", { text: "No abstract is recorded for this letter in the dataset." }));
    }
    // raw disclosure
    if (L.abstract_raw && L.abstract_raw !== L.abstract) {
      const d = el("details.disclosure");
      d.append(el("summary", { text: "View raw extracted text (before cleaning)" }));
      d.append(el("pre", { text: L.abstract_raw }));
      node.append(d);
    }

    // provenance
    const prov = el("div.provenance");
    const dl = el("dl");
    dl.innerHTML = `
      <dt>Shelfmark</dt><dd class="mono">${esc(L.shelfmark || "—")}</dd>
      <dt>Place of sending</dt><dd>${L.place ? placeLink(L.place) : '<span class="dim">unrecorded</span>'}</dd>
      <dt>Archival series</dt><dd class="series-crumb">${seriesCrumb(L.series_full)}</dd>`;
    prov.append(dl);
    node.append(el("div.panel-h", { text: "Provenance", style: { marginTop: "22px" } }), prov);

    // mini-map if coords
    if (L.place && L.place.lat != null) {
      const m = el("div.map.map-mini");
      node.append(m);
      queueMap(m, [{ ...L.place, c: 1 }], {});
    }

    // siblings (volume reader)
    if (L.siblings && L.siblings.length > 1) {
      const idx = L.siblings.findIndex((s) => s.id === L.id);
      const prev = L.siblings[idx - 1], next = L.siblings[idx + 1];
      const navb = el("div.pager", { style: { justifyContent: "space-between", marginTop: "30px" } });
      navb.append(prev ? el("a.btn", { href: `#/letter/${prev.id}`, html: `‹ ${esc(prev.date_display)}` }) : el("span"));
      navb.append(el("span.dim", { html: `folio ${idx + 1} of ${L.siblings.length} in <span class="mono">${esc(L.series_full ? L.series_full[2] || "" : "")}</span>` }));
      navb.append(next ? el("a.btn", { href: `#/letter/${next.id}`, html: `${esc(next.date_display)} ›` }) : el("span"));
      node.append(el("hr.rule-faint"), navb);
    }

    mount(node);
  };

  function seriesCrumb(arr) {
    if (!arr || !arr.length) return '<span class="dim">series unrecorded</span>';
    const keys = ["series", "series2", "series3"];
    return arr.map((s, i) => {
      if (i < 3) return `<a href="#/search?${SP.qs({ [keys[i]]: s })}">${esc(s)}</a>`;
      return `<span>${esc(s)}</span>`;   // folio: not a filter
    }).join('<span>›</span>');
  }

  // =========================================================================
  // PERSON
  // =========================================================================
  SP.views.person = async function (params, key) {
    SP.setNav(null); loading("Retrieving correspondent");
    let P;
    try { P = await api("/api/person/" + encodeURIComponent(key)); } catch { return notFound("person"); }
    if (!P || P.error) return notFound("person");
    SP.title(P.main_name);

    const node = el("div.entity");
    node.append(el("div.breadcrumb", { html: `<a href="#/search">Search</a> › Correspondent` }));
    node.append(el("h1", { text: P.main_name }));

    const sub = [];
    if (P.birth_year || P.death_year) sub.push(`${P.birth_year || "?"}–${P.death_year || "?"}`);
    if (P.roles_titles) sub.push(esc(P.roles_titles));
    else if (P.occupations) sub.push(esc(P.occupations));
    const badges = [];
    if (P.gender === "female") badges.push('<span class="badge female">female</span>');
    if (P.rs_election_date) badges.push(`<span class="badge rs">Royal Society ${esc(P.rs_election_date)}</span>`);
    if (P.wikidata_item) { const wu = SP.wikidataUrl(P.wikidata_item); if (wu) badges.push(`<a class="badge" href="${wu}" target="_blank" rel="noopener">Wikidata</a>`); }
    node.append(el("div.subtitle", { html: sub.join(" · ") + (badges.length ? "  " + badges.join(" ") : "") }));

    if (P.all_names && P.all_names !== P.main_name)
      node.append(el("p.dim", { style: { marginTop: "-14px", fontSize: "13px" }, html: `Also recorded as: ${esc(P.all_names)}` }));

    // stat band
    node.append(el("div.stat-band", { html: `
      <div class="cell"><div class="num tnum">${fmt(P.n_authored)}</div><div class="lbl">letters written</div></div>
      <div class="cell"><div class="num tnum">${fmt(P.n_received)}</div><div class="lbl">letters received</div></div>
      <div class="cell"><div class="num tnum">${fmt(P.top_recipients.length)}</div><div class="lbl">named recipients</div></div>
      <div class="cell"><div class="num tnum">${fmt(P.top_authors.length)}</div><div class="lbl">named correspondents</div></div>` }));

    // sparkline
    if (P.year_hist && P.year_hist.length) {
      const spark = el("div", { style: { margin: "18px 0" } });
      spark.append(el("div.panel-h", { html: "Activity by year <span class='dim' style='text-transform:none;letter-spacing:0'>— <span style='color:var(--slate)'>▬</span> written · <span style='color:var(--rubric)'>▬</span> received · drag to filter</span>" }));
      spark.append(SP.charts.sparkline(P.year_hist, {
        onRange: (a, b) => SP.go("#/search?" + SP.qs({ author: key, year_min: a, year_max: b })),
      }));
      node.append(spark);
    }

    // links to letters
    const links = el("div", { style: { margin: "14px 0" } });
    links.append(el("a.btn", { href: `#/search?${SP.qs({ author: key })}`, text: `All ${fmt(P.n_authored)} written` }));
    links.append(document.createTextNode(" "));
    links.append(el("a.btn", { href: `#/search?${SP.qs({ recipient: key })}`, text: `All ${fmt(P.n_received)} received` }));
    node.append(links);

    node.append(el("hr.rule-faint"));

    // two columns of correspondents
    node.append(el("div.two-col", {},
      corrPanel("Wrote most to", P.top_recipients, key, "out"),
      corrPanel("Received most from", P.top_authors, key, "in")));

    // ego + alter network (interactive force graph)
    if (P.network && P.network.nodes && P.network.nodes.length > 2) {
      const net = el("div", { style: { marginTop: "26px" } });
      net.append(el("div.panel-h", { html: "Correspondence network <span class='dim' style='text-transform:none;letter-spacing:0'>— <span style='color:var(--rubric)'>●</span> wrote to · <span style='color:var(--slate)'>●</span> received from · <span style='color:var(--gold)'>●</span> both · lighter lines are ties among the correspondents · drag nodes, click to open</span>" }));
      net.append(SP.charts.forceNetwork(P.network));
      node.append(net);
    }

    // places mini-map
    const mp = (P.places || []).filter((p) => p.lat != null);
    if (mp.length) {
      node.append(el("hr.rule-faint"));
      node.append(el("div.panel-h", { text: "Places written from" }));
      const m = el("div.map.map-mini");
      node.append(m);
      queueMap(m, mp.map((p) => ({ k: p.k, n: p.n, lat: +p.lat, lon: +p.lon, c: p.c })), {});
    }

    mount(node);

    function corrPanel(title, items, selfKey, dir) {
      const div = el("div");
      div.append(el("div.panel-h", { text: title }));
      const ul = el("ul.corr-list");
      if (!items.length) ul.append(el("li", { html: '<span class="dim">none recorded</span>' }));
      items.forEach((it) => {
        const href = dir === "out" ? `#/pair/${encodeURIComponent(selfKey)}/${encodeURIComponent(it.k)}`
                                   : `#/pair/${encodeURIComponent(it.k)}/${encodeURIComponent(selfKey)}`;
        ul.append(el("li", { html: `${personLink(it)} <a href="${href}" class="c tnum" title="view the exchange">${fmt(it.c)}</a>` }));
      });
      div.append(ul);
      return div;
    }
  };

  // =========================================================================
  // PAIR
  // =========================================================================
  SP.views.pair = async function (params, a, b) {
    SP.setNav(null); loading("Retrieving exchange");
    const d = await api(`/api/pair/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
    SP.title(`${d.a.n} → ${d.b.n}`);
    const node = el("div.entity");
    node.append(el("div.breadcrumb", { html: `<a href="#/person/${encodeURIComponent(a)}">${esc(d.a.n)}</a> › exchange` }));
    node.append(el("h1", { html: `${esc(d.a.n)} <span style="color:var(--rubric)">→</span> ${esc(d.b.n)}` }));
    node.append(el("div.subtitle", { html: `${fmt(d.letters.length)} letters from ${personLink(d.a)} to ${personLink(d.b)}. <a href="#/pair/${encodeURIComponent(b)}/${encodeURIComponent(a)}">See the reverse →</a>` }));
    if (!d.letters.length) node.append(el("div.empty", { text: "No letters recorded in this direction." }));
    else { const ul = el("ul.ledger"); d.letters.forEach((L) => ul.append(entryRow(L))); node.append(ul); }
    mount(node);
  };

  // =========================================================================
  // PLACE
  // =========================================================================
  SP.views.place = async function (params, key) {
    SP.setNav("map"); loading("Retrieving place");
    let P;
    try { P = await api("/api/place/" + encodeURIComponent(key)); } catch { return notFound("place"); }
    if (!P || P.error) return notFound("place");
    SP.title(P.place_name);
    const node = el("div.entity");
    node.append(el("div.breadcrumb", { html: `<a href="#/map">Places</a> › Place` }));
    node.append(el("h1", { text: P.place_name }));
    const sub = [];
    if (P.lat) sub.push(`${(+P.lat).toFixed(2)}°, ${(+P.lon).toFixed(2)}°`);
    const wu = SP.wikidataUrl(P.wikidata_id);
    if (wu) sub.push(`<a href="${wu}" target="_blank" rel="noopener">Wikidata</a>`);
    node.append(el("div.subtitle", { html: sub.join(" · ") || '<span class="dim">no coordinates recorded</span>' }));

    node.append(el("div.stat-band", { html:
      `<div class="cell"><div class="num tnum">${fmt(P.n_letters)}</div><div class="lbl">letters sent from here</div></div>
       <div class="cell"><div class="num tnum">${fmt(P.top_authors.length)}</div><div class="lbl">named authors</div></div>` }));

    if (P.lat) { const m = el("div.map.map-mini"); node.append(m); queueMap(m, [{ k: key, lat: +P.lat, lon: +P.lon, c: P.n_letters, n: P.place_name }], {}); }

    if (P.year_hist && P.year_hist.length) {
      node.append(el("div.panel-h", { html: "Letters over time <span class='dim' style='text-transform:none;letter-spacing:0'>— drag to filter</span>", style: { marginTop: "18px" } }));
      node.append(SP.charts.yearRibbon(P.year_hist.map((d) => ({ year: d.y, n: d.n })), {
        onRange: (a, b) => SP.go("#/search?" + SP.qs({ place: key, year_min: a, year_max: b })),
      }));
    }

    node.append(el("a.btn", { href: `#/search?${SP.qs({ place: key })}`, text: `Browse all ${fmt(P.n_letters)} letters →`, style: { margin: "14px 0", display: "inline-block" } }));

    node.append(el("hr.rule-faint"));
    node.append(el("div.panel-h", { text: "Wrote most from here" }));
    const ul = el("ul.corr-list");
    P.top_authors.forEach((p) => ul.append(el("li", { html: `${personLink(p)}<span class="c tnum">${fmt(p.c)}</span>` })));
    node.append(ul);
    mount(node);
  };

  // =========================================================================
  // SHIP
  // =========================================================================
  SP.views.ship = async function (params, key) {
    SP.setNav("ships"); loading("Retrieving ship");
    let S;
    try { S = await api("/api/ship/" + encodeURIComponent(key)); } catch { return notFound("ship"); }
    if (!S || S.error) return notFound("ship");
    SP.title(S.master_name);
    const node = el("div.entity");
    node.append(el("div.breadcrumb", { html: `<a href="#/ships">Ships</a> › Vessel` }));
    node.append(el("h1", { html: `The <span style="font-style:italic">${esc(S.master_name)}</span>` }));
    node.append(el("div.subtitle", { html: `${fmt(S.n_letters)} letters written aboard` }));

    if (S.labels) {
      node.append(el("div.panel-h", { text: "As written in the papers" }));
      const ul = el("ul.corr-list");
      S.labels.split(" | ").slice(0, 20).forEach((l) => ul.append(el("li", { html: `<span>“${esc(l)}”</span>` })));
      node.append(ul);
    }

    const itin = (S.itinerary || []).filter((p) => p.lat != null);
    if (itin.length) {
      node.append(el("div.panel-h", { html: "Places written from <span class='dim' style='text-transform:none;letter-spacing:0'>— in dated order</span>", style: { marginTop: "18px" } }));
      const m = el("div.map.map-mini");
      node.append(m);
      queueMap(m, itin.map((p) => ({ k: p.k, n: p.n, lat: +p.lat, lon: +p.lon, c: p.c, y0: p.y0, y1: p.y1 })), { line: true });
    }

    node.append(el("a.btn", { href: `#/search?${SP.qs({ ship: key })}`, text: `Browse all ${fmt(S.n_letters)} letters →`, style: { margin: "14px 0", display: "inline-block" } }));

    node.append(el("p.map-note", { html: "Note: ships of the same name are not disambiguated in the source data — a single name may conflate more than one vessel." }));
    mount(node);
  };

  SP.views.ships = async function () {
    SP.setNav("ships"); loading("Loading ships");
    const ships = await api("/static/data/ships.json");
    SP.title("Ships");
    const node = el("div.entity.wide");
    node.append(el("h1", { text: "Ships" }));
    node.append(el("div.subtitle", { html: `${fmt(ships.length)} vessels from which letters were written` }));
    const ul = el("ul.ledger");
    ships.forEach((s) => ul.append(el("li.entry", { style: { gridTemplateColumns: "1fr auto" }, html:
      `<div class="corr"><a href="#/ship/${encodeURIComponent(s.k)}" style="font-style:italic">${esc(s.n)}</a></div>
       <div class="col-mark tnum">${fmt(s.c)} letters</div>` })));
    node.append(ul);
    mount(node);
  };

  // =========================================================================
  // MAP (all places)
  // =========================================================================
  SP.views.map = async function () {
    SP.setNav("map"); loading("Plotting places");
    const [places, stats] = await Promise.all([api("/static/data/places.json"), statsCache()]);
    SP.title("Places");
    const node = el("div.entity.wide");
    node.append(el("h1", { text: "Places of sending" }));
    node.append(el("div.subtitle", { html: `${fmt(places.length)} places with coordinates. ${fmt(stats.no_place)} letters (${Math.round(100 * stats.no_place / stats.letters)}%) record no place and are not shown.` }));
    const m = el("div.map");
    node.append(m);
    // Most places cluster in Europe; a handful of distant outliers (colonial and
    // trade destinations) would otherwise drag fitBounds out to a whole-world
    // view. Start centred on Europe instead — still freely zoomable/pannable.
    queueMap(m, places.map((p) => ({ k: p.k, n: p.n, lat: p.lat, lon: p.lon, c: p.c })), { initialCenter: [50, 15], initialZoom: 4 });
    node.append(el("p.map-note", { text: "Marker size is proportional to the number of letters sent from a place. Zoom and pan freely; click a marker to open the place." }));
    // top places table
    node.append(el("div.panel-h", { text: "Most-used places", style: { marginTop: "24px" } }));
    const ul = el("ul.corr-list");
    places.slice().sort((a, b) => b.c - a.c).slice(0, 24).forEach((p) =>
      ul.append(el("li", { html: `<a href="#/place/${encodeURIComponent(p.k)}">${esc(p.n)}</a><span class="c tnum">${fmt(p.c)}</span>` })));
    node.append(ul);
    mount(node);
  };

  // =========================================================================
  // BROWSE (series tree)
  // =========================================================================
  SP.views.browse = async function () {
    SP.setNav("browse"); loading("Loading archive tree");
    const tree = await api("/static/data/series-tree.json");
    SP.title("Browse");
    const node = el("div.entity.wide");
    node.append(el("h1", { text: "Browse the archive" }));
    node.append(el("div.subtitle", { text: "The State Papers series hierarchy, with letter counts at every level. This is the table of contents of the corpus." }));
    const root = el("ul.tree");
    tree.forEach((l1) => root.append(treeNode(l1, 1)));
    node.append(root);
    mount(node);

    function treeNode(n, depth) {
      const li = el("li");
      const hasKids = n.children && n.children.length;
      const row = el("div.node" + (hasKids ? "" : ".leaf"));
      const caret = el("span.caret", { text: hasKids ? "▸" : "" });
      const label = el("span", { html: `${esc(n.name)}` });
      // filter by the level this node sits at: 1=division, 2=series, 3=class
      const param = depth === 1 ? "series" : depth === 2 ? "series2" : "series3";
      const cnt = el("span.c tnum", { text: fmt(n.count), title: `Show all ${fmt(n.count)} letters in “${n.name}”`, style: { cursor: "pointer" } });
      cnt.addEventListener("click", (e) => { e.stopPropagation(); SP.go("#/search?" + SP.qs({ [param]: n.name })); });
      const left = el("span", { style: { display: "flex", gap: "6px" } }, caret, label);
      row.append(left, cnt);
      li.append(row);
      if (hasKids) {
        const sub = el("ul", { style: { display: "none" } });
        let built = false;
        row.addEventListener("click", () => {
          if (!built) { n.children.forEach((c) => sub.append(treeNode(c, depth + 1))); built = true; }
          const open = sub.style.display === "none";
          sub.style.display = open ? "block" : "none";
          caret.textContent = open ? "▾" : "▸";
        });
        li.append(sub);
      } else {
        row.style.cursor = "pointer";
        row.addEventListener("click", () => SP.go("#/search?" + SP.qs({ [param]: n.name })));
      }
      return li;
    }
  };

  // =========================================================================
  // ABOUT
  // =========================================================================
  SP.views.about = async function () {
    SP.setNav("about"); loading("Loading");
    const s = await statsCache();
    SP.title("About the data");
    const node = el("div.prose");
    node.innerHTML = `
      <h1 style="font-size:34px">About this data</h1>
      <p>This interface presents the <b>Stuart State Papers</b> portion of the
      <i>Networking Archives</i> dataset — correspondence metadata and abstracts derived
      from Gale’s <i>State Papers Online</i>, enriched by the Networking Archives project.
      It presents the data as it is: abstracts, shelfmarks, dates with their uncertainty,
      and the people, places, and ships the records name. It offers no interpretation.</p>

      <h2>What is in the corpus</h2>
      <table>
        <tr><th>Correspondence records</th><td class="num">${fmt(s.records)}</td></tr>
        <tr><th>Unique letters</th><td class="num">${fmt(s.letters)}</td></tr>
        <tr><th>Letters with an abstract</th><td class="num">${fmt(s.with_abstract)}</td></tr>
        <tr><th>People</th><td class="num">${fmt(s.people)}</td></tr>
        <tr><th>Places used</th><td class="num">${fmt(s.places_used)}</td></tr>
        <tr><th>Places with coordinates</th><td class="num">${fmt(s.places_mappable)}</td></tr>
        <tr><th>Ships</th><td class="num">${fmt(s.ships)}</td></tr>
        <tr><th>Date range</th><td class="num">${s.year_min}–${s.year_max}</td></tr>
      </table>

      <h2>Records versus letters</h2>
      <p>The source file lists ${fmt(s.records)} author–recipient <em>rows</em>. A letter with
      two recipients appears as two rows. Collapsing rows that share a manuscript identifier and
      date yields <b>${fmt(s.letters)} distinct letters</b> — the difference of
      ${fmt(s.records - s.letters)} is these multi-correspondent rows. The letter is this app’s
      primary record, so an abstract is shown once, not once per recipient.</p>

      <h2>How the data was transformed</h2>
      <h3>Missing values</h3>
      <p>The source encodes absence as the string <code>NA</code> throughout. Every such value is
      treated as genuinely absent. Notably, ${fmt(s.no_place)} letters
      (${Math.round(100 * s.no_place / s.letters)}%) record no place of sending, and
      ${fmt(s.undated)} are undated; the interface always shows these gaps.</p>
      <h3>Abstracts</h3>
      <p>Abstract text is decoded from HTML entities and the trailing Gale calendar boilerplate
      (<code>Date. From. To. Subject. References…</code>) is truncated. The raw extracted text is
      preserved and can be viewed on each letter page via “view raw extracted text”, so the
      cleaning is inspectable and reversible.</p>
      <h3>Dates</h3>
      <p>Each record carries a start and end date. These are parsed into an interval and a
      certainty class, shown as a glyph beside every date:</p>
      <table>
        <tr><th>Glyph</th><th>Class</th><th>Meaning</th></tr>
        <tr><td>${certGlyph("day")}</td><td>day</td><td>a single day is known</td></tr>
        <tr><td>${certGlyph("dual_calendar")}</td><td>dual calendar</td><td>Old Style / New Style pair, ~10 days apart</td></tr>
        <tr><td>${certGlyph("month")}</td><td>month</td><td>the month is known, not the day</td></tr>
        <tr><td>${certGlyph("year")}</td><td>year</td><td>only the year is known</td></tr>
        <tr><td>${certGlyph("range")}</td><td>range</td><td>a span of more than a year</td></tr>
        <tr><td>${certGlyph("unknown")}</td><td>unknown</td><td>no usable date</td></tr>
      </table>

      <h2>Known limitations</h2>
      <p>These are inherited from the source and quoted in spirit from its documentation:
      warrants and passes are not fully separated from correspondence; some Council records are
      not cleanly distinguished; ships of the same name are not disambiguated, so one name may
      conflate several vessels; and person and place identity is only as good as the source’s
      reconciliation.</p>

      <h2>Citing</h2>
      <p>Cite the underlying dataset (the Networking Archives project and Gale <i>State Papers
      Online</i>) as its own documentation directs. This interface is a presentation layer over
      that data and adds no new scholarly claims.</p>

      <p class="dim" style="margin-top:30px">The full build report — every count and anomaly from the
      last run of the pipeline — is in <code>web/build_report.md</code> in the repository.</p>
    `;
    mount(node);
  };

  // =========================================================================
  function notFound(what) {
    mount(el("div.empty", { html: `That ${what} was not found. <a href="#/search">Return to search</a>.` }));
  }
})(window.SP);
