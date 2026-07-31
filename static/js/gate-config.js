// Password gate for the static site. Regenerate with tools/set_password.py.
// This hides the interface; it does NOT make the database files private on a
// public host. See the README for real access control (Cloudflare Access).
window.STUART_GATE = {
  salt: "c5045aa0dd0a5a6552b3db3a9b2681c7",
  iterations: 200000,
  hash: "41970b72a45f104ea0c3e89d2bf55acdcdebb56b744443122f4b6c7e5d6481f4"
};
