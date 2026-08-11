// Password gate for the static site. Regenerate with tools/set_password.py.
// This hides the interface; it does NOT make the database files private on a
// public host. See the README for real access control (Cloudflare Access).
window.STUART_GATE = {
  salt: "a84dd6d017bcc265da06fb80d0decfa0",
  iterations: 200000,
  hash: "c124799576a5cd962f5233c0fe2e8327cd32cdad673d5fa887e0d5ab836f3044"
};
