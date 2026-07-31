#!/usr/bin/env python3
"""
Set (or change) the password for the static site's login screen.

    python3 tools/set_password.py                 # prompts for the password
    python3 tools/set_password.py --password abc  # non-interactive

This writes static/js/gate-config.js with a PBKDF2-SHA256 salt + hash. The
plaintext password is never stored — only the derived hash, which the browser
recomputes from what the visitor types (via WebCrypto PBKDF2, identical
parameters) and compares.

IMPORTANT — read the README section "What the password does and doesn't do".
On a public static host the database files remain directly fetchable; this
login gates the interface, not the raw files. For real access control, put the
site behind Cloudflare Access (see the README).
"""
import argparse, getpass, hashlib, os, secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ITERATIONS = 200_000

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--password", help="the password (omit to be prompted)")
    ap.add_argument("--off", action="store_true", help="disable the login screen")
    a = ap.parse_args()

    cfg = ROOT / "static" / "js" / "gate-config.js"
    if a.off:
        cfg.write_text("// Login screen disabled.\nwindow.STUART_GATE = null;\n")
        print("Login disabled — the site will open without a password.")
        return

    pw = a.password
    if not pw:
        pw = getpass.getpass("New password: ")
        if pw != getpass.getpass("Confirm password: "):
            raise SystemExit("Passwords did not match.")
    if not pw:
        raise SystemExit("Empty password. Use --off to disable protection instead.")

    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, ITERATIONS, dklen=32)
    cfg.write_text(
        "// Password gate for the static site. Regenerate with tools/set_password.py.\n"
        "// This hides the interface; it does NOT make the database files private on a\n"
        "// public host. See the README for real access control (Cloudflare Access).\n"
        "window.STUART_GATE = {\n"
        f'  salt: "{salt.hex()}",\n'
        f"  iterations: {ITERATIONS},\n"
        f'  hash: "{dk.hex()}"\n'
        "};\n"
    )
    print(f"Password set. Wrote {cfg.relative_to(ROOT)}")
    print("Commit and push to update the live site.")

if __name__ == "__main__":
    main()
