/* Shared utilities. Loaded first; attaches helpers to window.SP. */
window.SP = window.SP || {};
(function (SP) {
  "use strict";

  // Mini DOM builder: el("div.klass#id", {attr:val}, child, child…)
  SP.el = function (spec, attrs, ...kids) {
    let tag = "div", id = null, cls = [];
    spec.replace(/([.#]?[^.#]+)/g, (m) => {
      if (m[0] === ".") cls.push(m.slice(1));
      else if (m[0] === "#") id = m.slice(1);
      else tag = m;
    });
    const n = document.createElement(tag);
    if (id) n.id = id;
    if (cls.length) n.className = cls.join(" ");
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "html") n.innerHTML = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) {
      if (k == null || k === false) continue;
      n.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return n;
  };

  SP.esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  SP.fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-GB"));

  SP.api = async function (path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(r.status + " " + path);
    return r.json();
  };

  // ---- date-certainty glyphs (9×9 SVG) ------------------------------------
  const G = {
    day:          '<circle cx="4.5" cy="4.5" r="3" fill="currentColor"/>',
    dual_calendar:'<circle cx="4.5" cy="4.5" r="3" fill="currentColor"/><circle cx="4.5" cy="4.5" r="4" fill="none" stroke="currentColor" stroke-width=".7"/>',
    month:        '<path d="M4.5 1.5a3 3 0 000 6z" fill="currentColor"/><circle cx="4.5" cy="4.5" r="3" fill="none" stroke="currentColor" stroke-width=".8"/>',
    year:         '<circle cx="4.5" cy="4.5" r="3" fill="none" stroke="currentColor" stroke-width="1"/>',
    range:        '<circle cx="4.5" cy="4.5" r="3" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="1.4 1.2"/>',
    unknown:      '<circle cx="4.5" cy="4.5" r="3" fill="none" stroke="currentColor" stroke-width=".8" stroke-dasharray="1 1.4" opacity=".7"/>',
  };
  const CERT_LABEL = {
    day: "exact day", dual_calendar: "dual calendar (O.S./N.S.)",
    month: "month known", year: "year known only",
    range: "date range", unknown: "date unknown",
  };
  SP.certGlyph = function (cert) {
    const g = G[cert] || G.unknown;
    return `<span class="cert" title="${CERT_LABEL[cert] || cert}" aria-label="${CERT_LABEL[cert]||cert}"><svg viewBox="0 0 9 9" width="9" height="9">${g}</svg></span>`;
  };
  SP.CERT_LABEL = CERT_LABEL;

  // ---- links --------------------------------------------------------------
  SP.personLink = (p) => p && p.k
    ? `<a href="#/person/${encodeURIComponent(p.k)}">${SP.esc(p.n || p.k)}</a>`
    : '<span class="noname">unknown</span>';
  SP.placeLink = (p) => p && p.k
    ? `<a href="#/place/${encodeURIComponent(p.k)}">${SP.esc(p.n || p.k)}</a>` : "";
  SP.shipLink = (s) => s && s.k
    ? `<a href="#/ship/${encodeURIComponent(s.k)}">${SP.esc(s.n || s.k)}</a>` : "";

  // Wikidata values come in two shapes: a bare "Q42" (places) or a full
  // "http://www.wikidata.org/entity/Q42" (people). Extract the Q-id and build
  // one clean canonical link.
  SP.wikidataUrl = (v) => {
    if (!v) return null;
    const m = String(v).match(/Q\d+/);
    return m ? `https://www.wikidata.org/wiki/${m[0]}` : null;
  };

  SP.corr = (arr, kind) => {
    if (!arr || !arr.length) return `<span class="noname">${kind === "author" ? "unknown author" : "unknown recipient"}</span>`;
    return arr.map(SP.personLink).join(" &amp; ");
  };

  // navigate helper
  SP.go = (hash) => { location.hash = hash; };

  // debounce
  SP.debounce = (fn, ms) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  // query-string builder from an object
  SP.qs = (obj) => {
    const p = new URLSearchParams();
    for (const k in obj) if (obj[k] != null && obj[k] !== "") p.set(k, obj[k]);
    return p.toString();
  };
  SP.parseQs = (str) => Object.fromEntries(new URLSearchParams(str));

  // set the document title
  SP.title = (t) => { document.title = t ? `${t} · Stuart Letters` : "Stuart Letters"; };

  // set active nav
  SP.setNav = (name) => {
    document.querySelectorAll(".mainnav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.nav === name));
  };

  // scroll to top on view change
  SP.top = () => window.scrollTo(0, 0);
})(window.SP);
