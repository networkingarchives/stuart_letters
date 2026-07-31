/* Zoomable maps via Leaflet. window.SP.map
   Replaces the earlier hand-drawn SVG plot. Circle markers sized by letter
   volume, click-through to place pages, and an optional dated route line for
   ship itineraries. Basemap tiles come from CARTO (needs internet); the vector
   markers still render if tiles fail to load. */
(function (SP) {
  "use strict";
  const isDark = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  const TILE = () => isDark()
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

  const cssVar = (name, fallback) => {
    try { return (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim() || fallback; }
    catch (e) { return fallback; }
  };

  function render(container, points, opts = {}) {
    if (typeof L === "undefined") { container.textContent = "Map library unavailable."; return null; }
    const RUBRIC = cssVar("--rubric", "#A11E1E");
    const SLATE = cssVar("--slate", "#2E4B57");
    const valid = (points || []).filter((p) => p.lat != null && p.lon != null && !isNaN(+p.lat) && !isNaN(+p.lon));
    // reset any previous map on this element
    if (container._leaflet_map) { container._leaflet_map.remove(); container._leaflet_map = null; }
    container.innerHTML = "";

    const map = L.map(container, { scrollWheelZoom: true, worldCopyJump: true, attributionControl: true });
    container._leaflet_map = map;
    L.tileLayer(TILE(), { attribution: ATTR, subdomains: "abcd", maxZoom: 18, detectRetina: true }).addTo(map);

    if (!valid.length) { map.setView([50, 4], 4); return map; }

    const maxc = Math.max(1, ...valid.map((p) => +p.c || 1));
    const line = [];
    const latlngs = [];
    valid.forEach((p) => {
      const ll = [+p.lat, +p.lon];
      latlngs.push(ll);
      if (opts.line) line.push(ll);
      const r = 4 + 16 * Math.sqrt((+p.c || 1) / maxc);
      const m = L.circleMarker(ll, {
        radius: r, color: opts.color || RUBRIC, weight: 1,
        fillColor: opts.color || RUBRIC, fillOpacity: 0.4,
      }).addTo(map);
      const link = p.k ? `<a href="#/place/${encodeURIComponent(p.k)}">open place →</a>` : "";
      const range = (p.y0 && p.y1) ? `<br><span style="color:#888">${p.y0}${p.y1 !== p.y0 ? "–" + p.y1 : ""}</span>` : "";
      m.bindPopup(
        `<div style="font-family:var(--sans);font-size:13px"><b>${SP.esc(p.n || "")}</b>` +
        `<br>${SP.fmt(p.c || 0)} letter${(+p.c === 1) ? "" : "s"}${range}<br>${link}</div>`);
      if (p.k) m.on("click", (e) => { /* popup opens; link inside navigates */ });
    });

    if (opts.line && line.length > 1) {
      L.polyline(line, { color: opts.color || SLATE, weight: 1.5, opacity: 0.45, dashArray: "4 4" }).addTo(map);
    }

    if (valid.length === 1) map.setView(latlngs[0], 6);
    else map.fitBounds(L.latLngBounds(latlngs).pad(0.15));

    // Leaflet needs a size recalculation once the container is laid out
    setTimeout(() => map.invalidateSize(), 60);
    return map;
  }

  SP.map = { render };
})(window.SP);
