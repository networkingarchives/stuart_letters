// Password gate for the static site. Regenerate with tools/set_password.py.
// This hides the interface; it does NOT make the database files private on a
// public host. See the README for real access control (Cloudflare Access).
window.STUART_GATE = {
  salt: "2a77a221708c4eb1c39c885af405b577",
  iterations: 200000,
  hash: "a7b4bf4f0a31d3ef3321f6cfd92d956e0eed9e0e6f5b79575e31de64089b419b"
};
