/* Hand-rolled SVG visualisations — no external libraries. window.SP.charts
   Year charts are clamped to the Stuart span and are clickable + brushable;
   the ego network is an animated, draggable force graph that includes ties
   among the alters, not just spokes from the centre. */
(function (SP) {
  "use strict";
  const svgNS = "http://www.w3.org/2000/svg";
  const S = (tag, attrs) => {
    const n = document.createElementNS(svgNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const Y0 = 1603, Y1 = 1714;           // Stuart span — all year charts clamp here
  SP.YEAR_MIN = Y0; SP.YEAR_MAX = Y1;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const charts = {};

  // ---- brush/click behaviour shared by the year charts -------------------
  // Maps pointer x → year over [Y0,Y1]; drag selects a range, a plain click
  // selects a single year. Calls opts.onRange(minYear, maxYear).
  function makeInteractive(svg, W, H, opts) {
    if (!opts || !opts.onRange) return;
    const yearAt = (clientX) => {
      const r = svg.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round(Y0 + f * (Y1 - Y0));
    };
    const xOf = (year) => ((year - Y0) / (Y1 - Y0)) * W;
    const sel = S("rect", { fill: "var(--rubric)", opacity: 0.18, y: 0, height: H, x: 0, width: 0,
      "pointer-events": "none", stroke: "var(--rubric)", "stroke-width": 0.7, "stroke-opacity": 0.5 });
    svg.append(sel);
    svg.style.cursor = "crosshair";
    let dragging = false, startYear = null, moved = false;
    const draw = (y1, y2) => {
      const a = Math.min(y1, y2), b = Math.max(y1, y2);
      const x = xOf(a), w = Math.max(1.5, xOf(b) - xOf(a));
      sel.setAttribute("x", x.toFixed(1)); sel.setAttribute("width", w.toFixed(1));
    };
    svg.addEventListener("pointerdown", (e) => {
      dragging = true; moved = false; startYear = yearAt(e.clientX);
      draw(startYear, startYear); svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) return; moved = true; draw(startYear, yearAt(e.clientX));
    });
    const finish = (e) => {
      if (!dragging) return; dragging = false;
      const endYear = yearAt(e.clientX);
      if (!moved || Math.abs(endYear - startYear) < 1) opts.onRange(startYear, startYear);
      else opts.onRange(Math.min(startYear, endYear), Math.max(startYear, endYear));
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointerleave", (e) => { if (dragging) finish(e); });
    // pre-highlight an existing selection
    if (opts.selMin != null && opts.selMax != null) draw(opts.selMin, opts.selMax);
  }

  // ---- sparkline of authored/received by year (person) -------------------
  charts.sparkline = function (hist, opts = {}) {
    const w = 640, h = 54, pad = 2;
    const svg = S("svg", { viewBox: `0 0 ${w} ${h}`, class: "spark", preserveAspectRatio: "none" });
    const data = (hist || []).filter((d) => d.y >= Y0 && d.y <= Y1);
    if (!data.length) return svg;
    const span = Y1 - Y0;
    const max = Math.max(1, ...data.map((d) => (d.a || 0) + (d.r || 0)));
    const bw = Math.max(1, (w / (span + 1)) - 0.5);
    data.forEach((d) => {
      const x = ((d.y - Y0) / (span + 1)) * w;
      const ha = ((d.a || 0) / max) * (h - pad * 2);
      const hr = ((d.r || 0) / max) * (h - pad * 2);
      svg.append(S("rect", { class: "a", x: x.toFixed(1), y: (h - pad - ha).toFixed(1), width: bw.toFixed(1), height: ha.toFixed(1) }));
      svg.append(S("rect", { class: "r", x: x.toFixed(1), y: (h - pad - ha - hr).toFixed(1), width: bw.toFixed(1), height: hr.toFixed(1) }));
    });
    makeInteractive(svg, w, h, opts);
    return svg;
  };

  // ---- big year histogram (home / place) ---------------------------------
  charts.yearRibbon = function (hist, opts = {}) {
    const w = 1000, h = 120, padB = 18;
    const svg = S("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" });
    const data = (hist || []).filter((d) => d.year >= Y0 && d.year <= Y1);
    const span = Y1 - Y0;
    const max = Math.max(1, ...data.map((d) => d.n));
    const bw = w / (span + 1);
    data.forEach((d) => {
      const x = ((d.year - Y0) / (span + 1)) * w;
      const bh = (d.n / max) * (h - padB);
      svg.append(S("rect", { x: x.toFixed(1), y: (h - padB - bh).toFixed(1), width: Math.max(0.6, bw - 0.4).toFixed(1), height: bh.toFixed(1), fill: "var(--slate)", opacity: 0.72, "pointer-events": "none" }));
    });
    for (let y = Math.ceil(Y0 / 25) * 25; y <= Y1; y += 25) {
      const x = ((y - Y0) / (span + 1)) * w;
      const t = S("text", { x: x.toFixed(1), y: h - 4, "font-size": 9, fill: "var(--ink-3)", "font-family": "var(--mono)", "pointer-events": "none" });
      t.textContent = y; svg.append(t);
      svg.append(S("line", { x1: x, y1: 0, x2: x, y2: h - padB, stroke: "var(--rule-2)", "stroke-width": 0.5, "pointer-events": "none" }));
    }
    makeInteractive(svg, w, h, opts);
    return svg;
  };

  // ---- interactive force-directed ego + alter network --------------------
  charts.forceNetwork = function (network, opts = {}) {
    const W = 640, H = 460;
    const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", style: "max-width:660px;display:block;margin:0 auto;touch-action:none" });
    const nodes = (network.nodes || []).map((n) => ({ ...n }));
    const edges = (network.edges || []).map((e) => ({ ...e }));
    if (!nodes.length) return svg;
    const byKey = new Map(nodes.map((n) => [n.k, n]));
    edges.forEach((e) => { e.s = byKey.get(e.a); e.t = byKey.get(e.b); });
    const links = edges.filter((e) => e.s && e.t);

    const maxw = Math.max(1, ...nodes.map((n) => n.w || 1));
    const rOf = (n) => n.dir === "ego" ? 15 : 5 + 11 * Math.sqrt((n.w || 1) / maxw);
    const colOf = (n) => n.dir === "ego" ? "var(--ink)" : n.dir === "out" ? "var(--rubric)" : n.dir === "in" ? "var(--slate)" : "var(--gold)";
    const maxc = Math.max(1, ...links.map((e) => e.c || 1));

    // seed positions: ego centre, alters on a ring
    const alters = nodes.filter((n) => n.dir !== "ego");
    const ego = nodes.find((n) => n.dir === "ego");
    if (ego) { ego.x = W / 2; ego.y = H / 2; }
    alters.forEach((n, i) => {
      const a = (i / alters.length) * Math.PI * 2 - Math.PI / 2;
      n.x = W / 2 + Math.cos(a) * 150; n.y = H / 2 + Math.sin(a) * 150;
      n.vx = 0; n.vy = 0;
    });

    // edge + node elements
    const gEdges = S("g", { stroke: "var(--ink-3)" });
    const edgeEls = links.map((e) => {
      const ln = S("line", {
        stroke: e.alter ? "var(--ink-3)" : colOf(e.t),
        "stroke-width": (0.5 + 3 * (e.c / maxc)).toFixed(1),
        "stroke-opacity": e.alter ? 0.28 : 0.5,
      });
      gEdges.append(ln); return ln;
    });
    svg.append(gEdges);

    // decide which nodes get labels: ego + the strongest alters (by weight)
    const labelled = new Set();
    labelled.add(ego && ego.k);
    alters.slice().sort((a, b) => (b.w || 0) - (a.w || 0)).slice(0, 8).forEach((n) => labelled.add(n.k));

    const gNodes = S("g", {});
    const nodeEls = nodes.map((n) => {
      const g = S("g", { style: "cursor:grab" });
      const c = S("circle", { r: rOf(n).toFixed(1), fill: colOf(n), "fill-opacity": n.dir === "ego" ? 1 : 0.9, stroke: "var(--paper)", "stroke-width": 1.2 });
      const ttl = S("title"); ttl.textContent = `${n.n}${n.w ? " — " + SP.fmt(n.w) + " letters" : ""}`; c.append(ttl);
      g.append(c);
      if (labelled.has(n.k)) {
        const t = S("text", { "font-size": n.dir === "ego" ? 11 : 9.5, fill: "var(--ink-2)", "font-family": "var(--sans)", "text-anchor": "middle", "pointer-events": "none" });
        t.textContent = n.n.length > 20 ? n.n.slice(0, 19) + "…" : n.n;
        g.append(t); n._label = t;
      }
      // navigate on click (unless it was a drag)
      g.addEventListener("click", () => { if (!n._dragged && n.dir !== "ego") SP.go(`#/person/${encodeURIComponent(n.k)}`); });
      // hover highlight
      g.addEventListener("pointerenter", () => highlight(n));
      g.addEventListener("pointerleave", () => highlight(null));
      gNodes.append(g); n._g = g; n._c = c;
      return g;
    });
    svg.append(gNodes);

    const neigh = new Map(nodes.map((n) => [n.k, new Set([n.k])]));
    links.forEach((e) => { neigh.get(e.a).add(e.b); neigh.get(e.b).add(e.a); });
    function highlight(n) {
      const on = n ? neigh.get(n.k) : null;
      nodes.forEach((m) => { m._g.style.opacity = !on || on.has(m.k) ? 1 : 0.18; });
      links.forEach((e, i) => { edgeEls[i].style.opacity = !on ? 1 : (on.has(e.a) && on.has(e.b) && (e.a === n.k || e.b === n.k) ? 1 : 0.08); });
    }

    // drag
    let drag = null;
    const ptXY = (e) => { const r = svg.getBoundingClientRect(); return [ (e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H ]; };
    svg.addEventListener("pointerdown", (e) => {
      const t = e.target.closest("g"); if (!t) return;
      const n = nodes[nodeEls.indexOf(t)]; if (!n) return;
      drag = n; n._dragged = false; n._g.style.cursor = "grabbing";
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return; drag._dragged = true;
      const [x, y] = ptXY(e); drag.fx = x; drag.fy = y; drag.x = x; drag.y = y;
      if (reduced) tick(); render();
    });
    svg.addEventListener("pointerup", () => { if (drag) { drag._g.style.cursor = "grab"; drag.fx = drag.fy = null; drag = null; } });

    // simple force simulation
    function tick() {
      const k = 0.02;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (a.dir === "ego") { a.x = W / 2; a.y = H / 2; continue; }
        a.vx = (a.vx || 0) * 0.85; a.vy = (a.vy || 0) * 0.85;
        // repulsion
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue; const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy || 0.01;
          const f = 1400 / d2; const d = Math.sqrt(d2);
          a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        }
        // centering
        a.vx += (W / 2 - a.x) * 0.008; a.vy += (H / 2 - a.y) * 0.008;
      }
      // springs
      links.forEach((e) => {
        const s = e.s, t = e.t; if (s.dir === "ego" && t.dir === "ego") return;
        const target = e.alter ? 90 : 120;
        let dx = t.x - s.x, dy = t.y - s.y; let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - target) * k; const ux = dx / d, uy = dy / d;
        if (s.dir !== "ego") { s.vx += ux * f; s.vy += uy * f; }
        if (t.dir !== "ego") { t.vx -= ux * f; t.vy -= uy * f; }
      });
      nodes.forEach((n) => {
        if (n.dir === "ego") return;
        if (n.fx != null) { n.x = n.fx; n.y = n.fy; return; }
        n.x += Math.max(-8, Math.min(8, n.vx)); n.y += Math.max(-8, Math.min(8, n.vy));
        n.x = Math.max(20, Math.min(W - 20, n.x)); n.y = Math.max(16, Math.min(H - 16, n.y));
      });
    }
    function render() {
      links.forEach((e, i) => {
        edgeEls[i].setAttribute("x1", e.s.x.toFixed(1)); edgeEls[i].setAttribute("y1", e.s.y.toFixed(1));
        edgeEls[i].setAttribute("x2", e.t.x.toFixed(1)); edgeEls[i].setAttribute("y2", e.t.y.toFixed(1));
      });
      nodes.forEach((n) => {
        n._g.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
        if (n._label) n._label.setAttribute("y", (rOf(n) + 11).toFixed(1));
      });
    }
    if (reduced) { for (let i = 0; i < 220; i++) tick(); render(); }
    else {
      let frame = 0;
      (function loop() {
        tick(); render();
        if (++frame < 260 || drag) requestAnimationFrame(loop);
      })();
    }
    return svg;
  };

  SP.charts = charts;
})(window.SP);
