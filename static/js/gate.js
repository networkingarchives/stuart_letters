/* Client-side password gate for the static site.

   IMPORTANT: on a public static host this hides the interface and stops the
   app (and the database) from loading until the right password is entered — it
   does NOT prevent someone who knows the URLs from fetching the raw .db chunks
   directly. There is no server to enforce access. For real access control, put
   the whole site behind Cloudflare Access (see the README).

   The password is verified with PBKDF2-SHA256 against a salt+hash baked into
   gate-config.js by tools/set_password.py; the plaintext is never stored. A
   correct entry is remembered for the browser session. Nothing else in the app
   starts until SP._unlock resolves. */
(function () {
  "use strict";
  const SP = (window.SP = window.SP || {});
  let done;
  SP._unlock = new Promise((r) => { done = r; });

  const G = window.STUART_GATE;
  if (!G || !G.hash) { done(); return; }             // no password configured
  if (!(window.crypto && crypto.subtle)) { done(); return; }  // very old browser: fail open

  const SKEY = "stuart_gate:" + G.hash.slice(0, 16);
  const hexToBuf = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
  const bufToHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

  async function derive(pw) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: hexToBuf(G.salt), iterations: G.iterations || 200000, hash: "SHA-256" }, key, 256);
    return bufToHex(bits);
  }

  try { if (sessionStorage.getItem(SKEY) === "1") { done(); return; } } catch (e) {}

  function mount() {
    if (document.getElementById("gate")) return;
    const ov = document.createElement("div");
    ov.id = "gate";
    ov.innerHTML =
      '<form id="gate-form" autocomplete="off">' +
      '<div class="gate-title"><span class="rubric-drop">S</span>tuart Letters</div>' +
      '<div class="gate-sub">State Papers correspondence — enter the password to continue.</div>' +
      '<input id="gate-pw" type="password" placeholder="Password" aria-label="Password" autocomplete="off">' +
      '<button type="submit">Enter</button>' +
      '<div id="gate-msg" class="gate-msg" role="alert"></div>' +
      "</form>";
    document.body.appendChild(ov);
    const form = ov.querySelector("#gate-form");
    const pw = ov.querySelector("#gate-pw");
    const msg = ov.querySelector("#gate-msg");
    setTimeout(() => pw.focus(), 30);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.textContent = "Checking…";
      let ok = false;
      try { ok = (await derive(pw.value)) === G.hash; } catch (err) { ok = false; }
      if (ok) {
        try { sessionStorage.setItem(SKEY, "1"); } catch (e) {}
        ov.classList.add("gate-out");
        setTimeout(() => ov.remove(), 250);
        done();
      } else {
        msg.textContent = "Incorrect password.";
        pw.value = ""; pw.focus();
      }
    });
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
