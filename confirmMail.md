 The confirmation link in the email looks like:
  https://database.insight25.lk/auth/v1/verify?token=...&type=signup&redirect_to=<SITE_URL>
  When clicked, GoTrue verifies the token (so the account does get confirmed — that part worked), then 302-redirects the browser to SITE_URL. Per the self-host
  guide, you set:
  SITE_URL=https://database.insight25.lk
  The root of that subdomain (nginx → Kong/Studio) is what you're landing on. So the redirect is just pointing at the wrong place — the API subdomain instead of
  somewhere meant for humans.

  Key distinction in your .env:
  - API_EXTERNAL_URL=https://database.insight25.lk → keep this. It's the host for the /auth/v1/verify link itself.
  - SITE_URL → this is the post-confirmation landing page. This is the one to change.

  The catch: your client is a desktop Electron app, so there's no web page to "return to" by default. How you want that final step to behave is a product
  decision, and it changes what I do next.

● User answered Claude's questions:
  ⎿  · After a user clicks the email confirmation link, where should they end up? → Simple 'confirmed' web page

● Good choice — that's a server-only change, no app rebuild needed. Since we already own the nginx block for database.insight25.lk, the cleanest path is to serve
  a small static page from that same block and point SITE_URL at it. (Verification still happens at /auth/v1/verify first; this only changes the final landing
  page.)

  1. Create the confirmation page on the VPS

  sudo mkdir -p /var/www/vibe-confirmed
  sudo tee /var/www/vibe-confirmed/confirmed.html > /dev/null <<'HTML'
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Email Confirmed — Vibe Remote</title>
    <style>
      body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        background:#0e0f13;color:#e8e8ec;display:grid;place-items:center;min-height:100vh}
      .card{text-align:center;padding:48px 40px;background:#16181f;border:1px solid #262a35;
        border-radius:16px;max-width:420px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
      .logo{font-size:28px;font-weight:700;letter-spacing:.5px;margin-bottom:8px}
      .logo span{color:#6ea8fe}
      .check{font-size:56px;margin:8px 0 16px}
      h1{font-size:20px;margin:0 0 8px}
      p{color:#9aa0ad;line-height:1.5;margin:0}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="logo"><span>⬡</span> Vibe Remote</div>
      <div class="check">✅</div>
      <h1>Email confirmed</h1>
      <p>Your account is verified. You can close this tab and sign in from the Vibe Remote desktop app.</p>
    </div>
  </body>
  </html>
  HTML

  2. Serve it from the existing nginx block

  Edit the Supabase site config:
  sudo nano /etc/nginx/sites-available/supabase
  Inside the server { listen 443 ssl; server_name database.insight25.lk; ... } block, add this above the existing location / { (an exact-match location takes
  priority over the / proxy, so everything else still goes to Kong):

      location = /confirmed {
          root      /var/www/vibe-confirmed;
          try_files /confirmed.html =404;
          default_type text/html;
      }

  Then reload:
  sudo nginx -t && sudo systemctl reload nginx
  # verify the page serves:
  curl -s -o /dev/null -w "%{http_code}\n" https://database.insight25.lk/confirmed   # want 200

  3. Point the post-confirmation redirect at it

  In /opt/supabase/docker/.env:
  SITE_URL=https://database.insight25.lk/confirmed
  # leave API_EXTERNAL_URL=https://database.insight25.lk unchanged

  Recreate auth (not restart):
  cd /opt/supabase/docker
  docker compose up -d auth

  4. Test

  Sign up with a fresh email, click the link in the message → it should verify and land on the dark "✅ Email confirmed" page instead of the dashboard.

  ---
  A couple of notes:
  - The account gets confirmed regardless of the landing page, so anyone you already "confirmed" by clicking through to the dashboard is fine.
  - If you'd rather host this under your brand at https://insight25.lk/confirmed, that works too — just add the same location = /confirmed block to your Node
  app's nginx config instead, and set SITE_URL accordingly. The only reason I used database.insight25.lk is that it's the block we already control without
  touching your main site.
  - Want me to drop this confirmed.html into the serverside repo (e.g. vibe_remote(serverside)/public/confirmed.html) so it's version-controlled rather than
  living only on the VPS? Say the word and I'll add it.