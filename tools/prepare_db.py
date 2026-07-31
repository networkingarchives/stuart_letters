#!/usr/bin/env python3
"""
Prepare the database for static hosting.

Rebuilds the SQLite database from the source CSVs at the page size the browser
needs (1024), splits it into chunk files under db/, refreshes the pre-computed
JSON in static/data/, and patches the geometry constants in
static/js/dbclient.js so everything stays in sync.

    python3 tools/prepare_db.py --src /path/to/networking-archives-data

Run this whenever the source data changes. Then commit and push — the site
redeploys automatically.
"""
import argparse, os, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 41943040          # 40 MiB — a multiple of the 1024 page size
SUFFIX = 3

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="directory containing the source CSVs")
    a = ap.parse_args()

    build_out = ROOT                     # writes web-static-style layout into ROOT/static/data + a temp db
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        print("Building database at page_size=1024 …")
        subprocess.run([sys.executable, str(ROOT / "pipeline" / "build.py"),
                        "--src", a.src, "--out", str(tmp), "--page-size", "1024"],
                       check=True)
        db = tmp / "stuart.db"
        total = db.stat().st_size

        # refresh JSON indexes in the site
        data_dst = ROOT / "static" / "data"
        data_dst.mkdir(parents=True, exist_ok=True)
        for f in (tmp / "static" / "data").glob("*.json"):
            (data_dst / f.name).write_bytes(f.read_bytes())
        (ROOT / "build_report.md").write_bytes((tmp / "build_report.md").read_bytes())

        # (re)chunk
        db_dir = ROOT / "db"
        for old in db_dir.glob("stuart.db.*"):
            old.unlink()
        db_dir.mkdir(exist_ok=True)
        print(f"Splitting {total:,} bytes into {CHUNK:,}-byte chunks …")
        with open(db, "rb") as f:
            i = 0
            while True:
                buf = f.read(CHUNK)
                if not buf:
                    break
                (db_dir / f"stuart.db.{i:0{SUFFIX}d}").write_bytes(buf)
                i += 1
        print(f"Wrote {i} chunk(s).")

    # patch dbclient.js geometry
    client = ROOT / "static" / "js" / "dbclient.js"
    txt = client.read_text()
    txt = re.sub(r"databaseLengthBytes:\s*\d+", f"databaseLengthBytes: {total}", txt)
    txt = re.sub(r"serverChunkSize:\s*\d+", f"serverChunkSize: {CHUNK}", txt)
    txt = re.sub(r"suffixLength:\s*\d+", f"suffixLength: {SUFFIX}", txt)
    client.write_text(txt)
    print(f"Patched dbclient.js: databaseLengthBytes={total:,}, serverChunkSize={CHUNK:,}")
    print("\nDone. Review the diff, then commit and push.")


if __name__ == "__main__":
    main()
