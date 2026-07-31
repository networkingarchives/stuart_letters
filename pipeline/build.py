#!/usr/bin/env python3
"""
Stuart State Papers Correspondence Explorer — build pipeline.

Reads the raw Networking Archives CSVs, filters to the Stuart State Papers,
cleans and normalises them, derives a deduplicated `letter` entity, and writes:

  - stuart.db          a SQLite database (metadata + FTS5 over abstracts)
  - static/data/*.json pre-computed indexes and aggregates for the frontend
  - build_report.md    row counts and every anomaly encountered

Run:  python -m pipeline.build --src <dir-with-csvs> --out <output-dir>

The build is idempotent and fully reproducible: same inputs -> same outputs.
Every transformation is logged to build_report.md so a data update produces a
reviewable diff.
"""
from __future__ import annotations
import argparse, csv, html, json, os, re, sqlite3, sys, time
from collections import defaultdict, Counter
from pathlib import Path

csv.field_size_limit(10_000_000)

# ---------------------------------------------------------------------------
# Source file locations (relative to --src)
# ---------------------------------------------------------------------------
F_NETWORK   = "universal_network_unique_id.csv"
F_ABSTRACTS = "abstracts.csv"
F_PEOPLE    = "networking-archives-data-master/na-people/universal_people.csv"
F_PEOPLE_X  = "networking-archives-data-master/na-people/universal_people_extra.csv"
F_PLACES    = "networking-archives-data-master/na-places/universal_places.csv"
F_SHIPS     = "networking-archives-data-master/na-ships/universal_ship_codes.csv"
F_SERIES    = "networking-archives-data-master/na-source-info/spo_stuart_series_info.csv"

report_lines: list[str] = []
def log(msg: str = ""):
    print(msg)
    report_lines.append(msg)

_NULLS = {"", "NA", "NaN", "nan", "NULL", "null", "-", "–"}
def nn(v):
    """Normalise R's NA sentinels (and blanks) to None."""
    if v is None:
        return None
    v = v.strip()
    return None if v in _NULLS else v

# ---------------------------------------------------------------------------
# Date parsing -> interval + certainty class
# ---------------------------------------------------------------------------
BOILERPLATE_RE = re.compile(r"Date\.?\s*From\s*To\s*Subject\.?\s*References", re.IGNORECASE)

def clean_abstract(raw: str):
    """Decode HTML entities and truncate the Gale calendar boilerplate.
    Returns (clean, raw_decoded)."""
    if raw is None or raw.strip() in _NULLS:
        return "", ""
    decoded = html.unescape(raw)
    decoded = decoded.replace("\xad", "").strip()
    m = BOILERPLATE_RE.search(decoded)
    if m:
        clean = decoded[:m.start()].strip()
        # If truncation left almost nothing, keep the fuller text instead.
        if len(clean) < 20:
            clean = decoded
    else:
        clean = decoded
    return clean, decoded


def _valid_ymd(y, mo, d):
    if not (1 <= mo <= 12):
        return False
    if not (1 <= d <= 31):
        return False
    return True


def parse_date(v: str):
    """Parse a YYYYMMDD-ish string. Returns dict with iso start, or Nones.
    Handles the 7-digit malformed values and 00000000 unknowns."""
    if v is None:
        return None
    v = v.strip()
    if v in ("", "0", "00000000"):
        return None
    digits = re.sub(r"\D", "", v)
    if len(digits) == 7:            # e.g. 1680301 -> 1680-03-01 (pad month)
        digits = digits[:4] + "0" + digits[4:]
    if len(digits) != 8:
        return {"iso": None, "malformed": True, "y": None}
    y, mo, d = int(digits[:4]), int(digits[4:6]), int(digits[6:8])
    if y < 1000 or y > 1800:        # outside plausible corpus range -> flag
        return {"iso": None, "malformed": True, "y": y if 1000 <= y <= 1800 else None}
    mo = min(max(mo, 1), 12)
    d = min(max(d, 1), 28) if d == 0 else min(d, 28)
    iso = f"{y:04d}-{mo:02d}-{d:02d}"
    return {"iso": iso, "malformed": False, "y": y}


def date_interval(x3: str, x4: str):
    """Return (start_iso, end_iso, certainty, display, year, malformed_flag)."""
    a = parse_date(x3)
    b = parse_date(x4)
    malformed = bool((a and a.get("malformed")) or (b and b.get("malformed")))

    # both unknown
    if not a and not b:
        return (None, None, "unknown", "date unknown", None, malformed)

    # only one side present
    if a and not b:
        b = a
    if b and not a:
        a = b

    sa, sb = a.get("iso"), b.get("iso")
    ya, yb = a.get("y"), b.get("y")

    if sa is None or sb is None:
        yr = ya or yb
        disp = f"c. {yr}" if yr else "date uncertain"
        return (sa, sb, "unknown", disp, yr, True)

    # day precision
    if sa == sb:
        return (sa, sb, "day", human_date(sa), ya, malformed)

    from datetime import date
    da = date.fromisoformat(sa)
    db = date.fromisoformat(sb)
    span = (db - da).days

    # dual calendar (Julian/Gregorian ~10 days apart)
    if 8 <= span <= 12 and da.month == db.month:
        disp = f"{da.day}/{db.day} {da.strftime('%B %Y')} (O.S./N.S.)"
        return (sa, sb, "dual_calendar", disp, ya, malformed)

    # whole month
    if da.day == 1 and da.year == db.year and da.month == db.month:
        return (sa, sb, "month", da.strftime("%B %Y"), ya, malformed)

    # whole year
    if da.month == 1 and da.day == 1 and db.month == 12 and da.year == db.year:
        return (sa, sb, "year", str(da.year), ya, malformed)

    # multi-year / other range
    if ya == yb:
        disp = f"{human_date(sa)} – {human_date(sb)}"
    else:
        disp = f"{ya}–{yb}"
    return (sa, sb, "range", disp, ya, malformed)


MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
def human_date(iso: str):
    y, m, d = iso.split("-")
    return f"{int(d)} {MONTHS[int(m)]} {y}"


# ---------------------------------------------------------------------------
# Load helpers
# ---------------------------------------------------------------------------
def read_csv(path: Path):
    with open(path, newline="", encoding="utf-8") as fh:
        yield from csv.DictReader(fh)


def build(src: Path, out: Path, page_size: int = 4096):
    t0 = time.time()
    db_path = out / "stuart.db"
    data_dir = out / "static" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    log("# Stuart State Papers — build report\n")
    log(f"_Generated {time.strftime('%Y-%m-%d %H:%M:%S')}_\n")

    con = sqlite3.connect(db_path)
    con.execute(f"PRAGMA page_size = {int(page_size)}")
    con.executescript(SCHEMA)
    cur = con.cursor()

    # -- People -------------------------------------------------------------
    log("## People")
    extra = {}
    for r in read_csv(src / F_PEOPLE_X):
        extra[r["name"]] = r
    people = {}
    for r in read_csv(src / F_PEOPLE):
        people[r["name"]] = r
    log(f"- people table: {len(people):,} rows; enrichment table: {len(extra):,} rows")

    # -- Places -------------------------------------------------------------
    places = {}
    for r in read_csv(src / F_PLACES):
        places[r["place_id"]] = r
    log(f"- places table: {len(places):,} rows")

    # -- Ships --------------------------------------------------------------
    ship_master = {}      # ship_name_map -> master name
    ship_labels = defaultdict(set)
    for r in read_csv(src / F_SHIPS):
        code = r["ship_name_map"]
        ship_master[code] = r["master_ship_name"]
        if r.get("original_label"):
            ship_labels[code].add(r["original_label"])
    log(f"- ships: {len(ship_master):,} distinct ship codes")

    # -- Series -------------------------------------------------------------
    series = {}
    for r in read_csv(src / F_SERIES):
        series[r["letter_id"]] = r
    log(f"- series info: {len(series):,} letter_ids\n")

    # -- Abstracts ----------------------------------------------------------
    log("## Abstracts")
    abstracts = {}
    n_entities = n_empty = 0
    for r in read_csv(src / F_ABSTRACTS):
        uid = r["unique_id"]
        raw = r.get("ctxt") or ""
        if "&#x" in raw:
            n_entities += 1
        clean, raw_dec = clean_abstract(raw)
        if not clean.strip():
            n_empty += 1
        abstracts[uid] = (clean, raw_dec)
    log(f"- abstract rows: {len(abstracts):,}")
    log(f"- decoded HTML entities in: {n_entities:,}")
    log(f"- empty after cleaning: {n_empty:,}\n")

    # -- Network (Stuart filter + letter dedup) -----------------------------
    log("## Correspondence records")
    net_rows = 0
    stuart_rows = 0
    letters = {}                     # letter_key -> letter dict
    letter_people = set()            # {(letter_key, person_key, role)}
    person_used = set()
    place_used = Counter()
    ship_used = Counter()
    anomalies = Counter()
    place_year = Counter()
    year_hist = Counter()

    for r in read_csv(src / F_NETWORK):
        net_rows += 1
        if r["source"] != "stuart":
            continue
        stuart_rows += 1
        author = nn(r["X1"]); recip = nn(r["X2"])
        letter_id = nn(r["X5"]) or r["X5"]
        place_key = nn(r["X6"])
        ship_code = nn(r["ship_name_map"])
        uid = r["unique_id"]

        s, e, cert, disp, yr, malformed = date_interval(r["X3"], r["X4"])
        if malformed:
            anomalies["malformed_date"] += 1
        if cert == "unknown":
            anomalies["undated"] += 1

        # letter key: identifier + date interval (identifier is not unique when
        # a letter is split into O.S./N.S. or reused, so include the interval)
        lkey = f"{letter_id}|{s}|{e}"
        if lkey not in letters:
            clean, raw_dec = abstracts.get(uid, ("", ""))
            ser = series.get(letter_id, {})
            letters[lkey] = {
                "letter_id": letter_id,
                "date_start": s, "date_end": e, "date_certainty": cert,
                "date_display": disp, "year": yr,
                "place_key": place_key,
                "ship_code": ship_code,
                "abstract": clean, "abstract_raw": raw_dec,
                "has_abstract": 1 if clean.strip() else 0,
                "folio": nn(ser.get("folio")),
                "series_l1": nn(ser.get("series_level_3")),   # top: State Papers Domestic
                "series_l2": nn(ser.get("series_level_2")),   # class: SPD, Civil War...
                "series_l3": nn(ser.get("series_level_1")),   # series: SP 18
                "unique_id": uid,
            }
            if yr:
                year_hist[yr] += 1
                if place_key:
                    place_year[(place_key, yr)] += 1
            if place_key:
                place_used[place_key] += 1
            if ship_code:
                ship_used[ship_code] += 1

        # people links (dedup per letter via set)
        for pk, role in ((author, "author"), (recip, "recipient")):
            if pk:
                letter_people.add((lkey, pk, role))
                person_used.add(pk)

    log(f"- total network rows read: {net_rows:,}")
    log(f"- Stuart rows: {stuart_rows:,}")
    log(f"- deduplicated letters: {len(letters):,}")
    log(f"- distinct people referenced: {len(person_used):,}")
    log(f"- letters with a place of sending: {sum(place_used.values()):,} "
        f"({len(place_used):,} distinct places)")
    log(f"- shipboard letters: {sum(ship_used.values()):,} "
        f"({len(ship_used):,} distinct ships)")
    log(f"- undated letters: {anomalies['undated']:,}")
    log(f"- malformed date values flagged: {anomalies['malformed_date']:,}\n")



    # -- Assign integer letter ids & insert --------------------------------
    log("## Writing database")
    lkey_to_id = {}
    letter_rows = []
    for i, (lkey, L) in enumerate(letters.items(), start=1):
        lkey_to_id[lkey] = i
        letter_rows.append((
            i, L["letter_id"], L["date_start"], L["date_end"],
            L["date_certainty"], L["date_display"], L["year"],
            L["place_key"], L["ship_code"],
            L["has_abstract"], L["folio"],
            L["series_l1"], L["series_l2"], L["series_l3"],
        ))
    cur.executemany(
        "INSERT INTO letter(id,letter_id,date_start,date_end,date_certainty,"
        "date_display,year,place_key,ship_code,has_abstract,folio,"
        "series_l1,series_l2,series_l3) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        letter_rows)

    # abstracts stored separately (FTS external content)
    abs_rows = [(lkey_to_id[k], v["abstract"], v["abstract_raw"])
                for k, v in letters.items()]
    cur.executemany(
        "INSERT INTO abstract(letter_id,text,text_raw) VALUES (?,?,?)", abs_rows)
    # FTS index only over non-empty abstracts
    cur.execute(
        "INSERT INTO letters_fts(rowid,text) "
        "SELECT letter_id,text FROM abstract WHERE text <> ''")

    lp_rows = [(lkey_to_id[lk], pk, role) for (lk, pk, role) in letter_people]
    cur.executemany(
        "INSERT INTO letter_person(letter_id,person_key,role) VALUES (?,?,?)",
        lp_rows)

    # -- People rows (only those used) -------------------------------------
    author_ct = Counter(pk for (_, pk, role) in letter_people if role == "author")
    recip_ct  = Counter(pk for (_, pk, role) in letter_people if role == "recipient")
    prow = []
    n_bio = n_female = n_rs = 0
    for pk in sorted(person_used):
        base = people.get(pk, {})
        ex = extra.get(pk, {})
        by = nn(ex.get("birth_year"));  dy = nn(ex.get("death_year"))
        gender = nn(ex.get("gender"));  rs = nn(ex.get("rs_election_date"))
        roles = nn(ex.get("roles_titles")); occ = nn(ex.get("occupations"))
        wd = nn(ex.get("wikidata_item"))
        if by or dy: n_bio += 1
        if gender == "female": n_female += 1
        if rs: n_rs += 1
        prow.append((
            pk, nn(base.get("main_name")) or pk, nn(base.get("all_names")),
            nn(base.get("links")), by, dy, gender, roles, occ, wd, rs,
            author_ct.get(pk, 0), recip_ct.get(pk, 0),
        ))
    cur.executemany(
        "INSERT INTO person(person_key,main_name,all_names,links,birth_year,"
        "death_year,gender,roles_titles,occupations,wikidata_item,"
        "rs_election_date,n_authored,n_received) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", prow)
    cur.execute("INSERT INTO people_fts(rowid,names) "
                "SELECT rowid,main_name||' '||COALESCE(all_names,'') FROM person")
    log(f"- people written: {len(prow):,} "
        f"(with life dates {n_bio:,}; women {n_female:,}; RS fellows {n_rs:,})")

    # -- Places (only those used) ------------------------------------------
    plrow = []
    n_coord = 0
    for pk, ct in place_used.items():
        p = places.get(pk, {})
        lat = nn(p.get("coordinates_latitude"))
        lon = nn(p.get("coordinates_longitude"))
        if lat and lon:
            n_coord += 1
        else:
            lat = lon = None
        plrow.append((pk, nn(p.get("place_name")) or pk, lat, lon,
                      nn(p.get("wikidata_id")), ct))
    cur.executemany(
        "INSERT INTO place(place_id,place_name,lat,lon,wikidata_id,n_letters) "
        "VALUES (?,?,?,?,?,?)", plrow)
    log(f"- places written: {len(plrow):,} ({n_coord:,} with coordinates)")

    # -- Ships (only those used) -------------------------------------------
    shrow = []
    for code, ct in ship_used.items():
        shrow.append((code, ship_master.get(code) or code,
                      " | ".join(sorted(ship_labels.get(code, []))), ct))
    cur.executemany(
        "INSERT INTO ship(ship_code,master_name,labels,n_letters) "
        "VALUES (?,?,?,?)", shrow)
    log(f"- ships written: {len(shrow):,}\n")

    con.commit()

    # -- Indexes -----------------------------------------------------------
    log("## Indexing & optimising")
    for stmt in INDEXES:
        cur.execute(stmt)
    con.commit()
    cur.execute("PRAGMA optimize")
    cur.execute("VACUUM")
    con.commit()

    # ---------------------------------------------------------------------
    # Pre-computed JSON indexes for the frontend
    # ---------------------------------------------------------------------
    log("## JSON indexes")

    # people index (for typeahead + list)
    ppl_index = [{
        "k": pk, "n": (nn(people.get(pk, {}).get("main_name")) or pk),
        "a": author_ct.get(pk, 0), "r": recip_ct.get(pk, 0),
    } for pk in sorted(person_used, key=lambda k: -(author_ct.get(k,0)+recip_ct.get(k,0)))]
    dump(data_dir / "people-index.json", ppl_index)
    log(f"- people-index.json: {len(ppl_index):,} entries")

    # places (with coords) for the map
    places_json = []
    for pk, ct in place_used.items():
        p = places.get(pk, {})
        lat = nn(p.get("coordinates_latitude"))
        lon = nn(p.get("coordinates_longitude"))
        if lat and lon:
            try:
                places_json.append({"k": pk, "n": nn(p.get("place_name")) or pk,
                                    "lat": float(lat), "lon": float(lon), "c": ct})
            except ValueError:
                pass
    dump(data_dir / "places.json", places_json)
    log(f"- places.json: {len(places_json):,} mappable places")

    # ships list
    ships_json = [{"k": c, "n": ship_master.get(c) or c, "c": ct}
                  for c, ct in sorted(ship_used.items(), key=lambda kv: -kv[1])]
    dump(data_dir / "ships.json", ships_json)

    # series tree
    tree = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    for L in letters.values():
        l1 = L["series_l1"] or "— series unrecorded —"
        l2 = L["series_l2"] or "—"
        l3 = L["series_l3"] or "—"
        tree[l1][l2][l3] += 1
    tree_json = []
    for l1 in sorted(tree):
        kids2 = []
        for l2 in sorted(tree[l1]):
            kids3 = [{"name": l3, "count": tree[l1][l2][l3]}
                     for l3 in sorted(tree[l1][l2])]
            kids2.append({"name": l2, "count": sum(c["count"] for c in kids3),
                          "children": kids3})
        tree_json.append({"name": l1,
                          "count": sum(c["count"] for c in kids2),
                          "children": kids2})
    dump(data_dir / "series-tree.json", tree_json)

    # corpus stats
    stats = {
        "letters": len(letters),
        "records": stuart_rows,
        "people": len(person_used),
        "places_used": len(place_used),
        "places_mappable": len(places_json),
        "ships": len(ship_used),
        "shipboard_letters": sum(ship_used.values()),
        "with_abstract": sum(1 for L in letters.values() if L["has_abstract"]),
        "undated": anomalies["undated"],
        "no_place": len(letters) - sum(1 for L in letters.values() if L["place_key"]),
        "year_min": min(year_hist) if year_hist else None,
        "year_max": max(year_hist) if year_hist else None,
        "year_hist": [{"year": y, "n": n} for y, n in sorted(year_hist.items())],
    }
    dump(data_dir / "stats.json", stats)
    log(f"- series-tree.json, ships.json, stats.json written")

    # place-year for map time slider
    py = defaultdict(list)
    for (pk, yr), n in place_year.items():
        py[pk].append([yr, n])
    dump(data_dir / "place-year.json", {k: sorted(v) for k, v in py.items()})

    # global facets — the whole-corpus top values, so the static build can show
    # facets on the default (unfiltered) view without a corpus-wide range scan.
    def pname(pk): return nn(people.get(pk, {}).get("main_name")) or pk
    l1c, l2c = Counter(), Counter()
    for L in letters.values():
        if L["series_l1"]: l1c[L["series_l1"]] += 1
        if L["series_l2"]: l2c[L["series_l2"]] += 1
    global_facets = {
        "authors":   [{"k": k, "n": pname(k), "c": c} for k, c in author_ct.most_common(10)],
        "recipients":[{"k": k, "n": pname(k), "c": c} for k, c in recip_ct.most_common(10)],
        "places":    [{"k": k, "n": (nn(places.get(k, {}).get("place_name")) or k), "c": c}
                      for k, c in place_used.most_common(10)],
        "series":    [{"k": k, "n": c} for k, c in l1c.most_common(12)],
        "source_series": [{"k": k, "n": c} for k, c in l2c.most_common(12)],
    }
    dump(data_dir / "facets-global.json", global_facets)
    log(f"- facets-global.json written")

    con.close()

    # ---------------------------------------------------------------------
    log("\n## Reconciliation")
    log(f"- {stuart_rows:,} correspondence records collapse to "
        f"{len(letters):,} letters "
        f"(difference {stuart_rows - len(letters):,} = multi-correspondent "
        f"row explosions).")
    size_mb = db_path.stat().st_size / 1e6
    log(f"- database size: {size_mb:,.1f} MB")
    log(f"- build time: {time.time()-t0:,.1f} s")

    (out / "build_report.md").write_text("\n".join(report_lines))
    print(f"\n✓ Wrote {db_path} ({size_mb:.0f} MB) and {out/'build_report.md'}")


def dump(path: Path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


# ---------------------------------------------------------------------------
SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE letter (
  id INTEGER PRIMARY KEY,
  letter_id TEXT,
  date_start TEXT, date_end TEXT,
  date_certainty TEXT, date_display TEXT, year INTEGER,
  place_key TEXT, ship_code TEXT,
  has_abstract INTEGER,
  folio TEXT, series_l1 TEXT, series_l2 TEXT, series_l3 TEXT
);

CREATE TABLE abstract (
  letter_id INTEGER PRIMARY KEY,
  text TEXT, text_raw TEXT
);

CREATE VIRTUAL TABLE letters_fts USING fts5(
  text, content='abstract', content_rowid='letter_id',
  tokenize='porter unicode61'
);

CREATE TABLE letter_person (
  letter_id INTEGER, person_key TEXT, role TEXT
);

CREATE TABLE person (
  person_key TEXT PRIMARY KEY,
  main_name TEXT, all_names TEXT, links TEXT,
  birth_year TEXT, death_year TEXT, gender TEXT,
  roles_titles TEXT, occupations TEXT, wikidata_item TEXT,
  rs_election_date TEXT,
  n_authored INTEGER, n_received INTEGER
);

CREATE VIRTUAL TABLE people_fts USING fts5(
  names, content='', tokenize='porter unicode61'
);

CREATE TABLE place (
  place_id TEXT PRIMARY KEY, place_name TEXT,
  lat TEXT, lon TEXT, wikidata_id TEXT, n_letters INTEGER
);

CREATE TABLE ship (
  ship_code TEXT PRIMARY KEY, master_name TEXT, labels TEXT, n_letters INTEGER
);
"""

INDEXES = [
    "CREATE INDEX idx_lp_letter ON letter_person(letter_id)",
    "CREATE INDEX idx_lp_person ON letter_person(person_key, role)",
    "CREATE INDEX idx_letter_year ON letter(year)",
    "CREATE INDEX idx_letter_place ON letter(place_key)",
    "CREATE INDEX idx_letter_ship ON letter(ship_code)",
    "CREATE INDEX idx_letter_series ON letter(series_l1, series_l2, series_l3)",
    "CREATE INDEX idx_letter_lid ON letter(letter_id)",
]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="dir containing the CSVs")
    ap.add_argument("--out", required=True, help="output dir")
    ap.add_argument("--page-size", type=int, default=4096,
                    help="SQLite page size (use 1024 for httpvfs/static build)")
    a = ap.parse_args()
    build(Path(a.src), Path(a.out), page_size=a.page_size)
