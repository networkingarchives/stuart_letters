/* Router + omnisearch + init. Loaded last. */
(function (SP) {
  "use strict";
  SP.views = SP.views || {};

  // ---- router -------------------------------------------------------------
  async function route() {
    const hash = location.hash.slice(1) || "/";
    const [path, query] = hash.split("?");
    const params = SP.parseQs(query || "");
    const seg = path.split("/").filter(Boolean);   // e.g. ["person","S0001"]
    try {
      if (seg.length === 0) return SP.views.home();
      switch (seg[0]) {
        case "search": return SP.views.search(params);
        case "letter": return SP.views.letter(params, seg[1]);
        case "person": return SP.views.person(params, decodeURIComponent(seg.slice(1).join("/")));
        case "pair":   return SP.views.pair(params, decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
        case "place":  return SP.views.place(params, decodeURIComponent(seg.slice(1).join("/")));
        case "ship":   return SP.views.ship(params, decodeURIComponent(seg.slice(1).join("/")));
        case "ships":  return SP.views.ships();
        case "map":    return SP.views.map();
        case "browse": return SP.views.browse();
        case "about":  return SP.views.about();
        default:       return SP.views.home();
      }
    } catch (e) {
      console.error(e);
      document.getElementById("app").replaceChildren(
        SP.el("div.empty", { text: "Something went wrong: " + e.message }));
    }
  }
  window.addEventListener("hashchange", route);

  // ---- omnisearch typeahead ----------------------------------------------
  function setupOmni() {
    const input = document.getElementById("omni-input");
    const drop = document.getElementById("omni-drop");
    if (!input) return;
    let people = null, places = null, ships = null, sel = -1, items = [];

    async function ensure() {
      if (people) return;
      [people, places, ships] = await Promise.all([
        SP.peopleIndex(),
        SP.api("/static/data/places.json").catch(() => []),
        SP.api("/static/data/ships.json").catch(() => []),
      ]);
    }

    const render = (matches) => {
      drop.replaceChildren();
      items = [];
      if (!matches.length) { drop.style.display = "none"; return; }
      const groups = { person: [], place: [], ship: [] };
      matches.forEach((m) => groups[m.type].push(m));
      const order = [["person", "People"], ["place", "Places"], ["ship", "Ships"]];
      order.forEach(([type, label]) => {
        if (!groups[type].length) return;
        drop.append(SP.el("div.omni-group-label", { text: label }));
        groups[type].forEach((m) => {
          const row = SP.el("div.omni-item", { html: `<span class="n">${SP.esc(m.n)}</span><span class="meta">${m.meta}</span>` });
          row.addEventListener("mousedown", (e) => { e.preventDefault(); pick(m); });
          drop.append(row); items.push({ el: row, m });
        });
      });
      drop.style.display = "block"; sel = -1;
    };

    const pick = (m) => {
      input.value = ""; drop.style.display = "none";
      if (m.type === "person") SP.go(`#/person/${encodeURIComponent(m.k)}`);
      else if (m.type === "place") SP.go(`#/place/${encodeURIComponent(m.k)}`);
      else if (m.type === "ship") SP.go(`#/ship/${encodeURIComponent(m.k)}`);
    };

    const search = SP.debounce(async (q) => {
      q = q.trim().toLowerCase();
      if (q.length < 2) { drop.style.display = "none"; return; }
      await ensure();
      const out = [];
      for (const p of people) {
        if (p.n.toLowerCase().includes(q)) { out.push({ type: "person", k: p.k, n: p.n, meta: `${SP.fmt(p.a + p.r)} letters` }); if (out.length > 7) break; }
      }
      let n = 0;
      for (const p of places) { if (p.n.toLowerCase().includes(q)) { out.push({ type: "place", k: p.k, n: p.n, meta: `${SP.fmt(p.c)}` }); if (++n > 4) break; } }
      n = 0;
      for (const s of ships) { if (s.n.toLowerCase().includes(q)) { out.push({ type: "ship", k: s.k, n: s.n, meta: `${SP.fmt(s.c)}` }); if (++n > 4) break; } }
      render(out);
    }, 120);

    input.addEventListener("input", () => search(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (sel >= 0 && items[sel]) { e.preventDefault(); pick(items[sel].m); }
        else { drop.style.display = "none"; SP.go("#/search?" + SP.qs({ q: input.value.trim() })); input.blur(); }
      } else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Escape") { drop.style.display = "none"; }
    });
    function move(d) {
      if (!items.length) return;
      if (sel >= 0) items[sel].el.classList.remove("sel");
      sel = (sel + d + items.length) % items.length;
      items[sel].el.classList.add("sel");
      items[sel].el.scrollIntoView({ block: "nearest" });
    }
    document.addEventListener("click", (e) => { if (!e.target.closest(".omni")) drop.style.display = "none"; });
  }

  // ---- init ---------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    setupOmni();
    (SP._unlock || Promise.resolve()).then(route);
  });
})(window.SP);
