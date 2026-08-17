# Kasembannakij Stock

A book stock and sales tracker for Kasembannakij, built for iPad but usable
from any browser: inventory with click-to-edit cells, multi-book orders,
platform commissions, expense tracking, and a dashboard with income trends,
margin, net profit, and reorder/promotion suggestions.

**Live:** https://maya-buba.github.io/kasembannakij-stock/

## Where your data lives

Primarily in the browser's `localStorage` on whichever device you're using —
the app always reads and writes there first, so it works offline and never
waits on a network round trip. On top of that there are two ways to move data
between devices:

- **Cloud sync** (Settings → Cloud sync) — connects to a small Cloudflare
  Worker you deploy yourself, so every device signed into the same Worker URL
  and passphrase shares one live dataset. See below for setup.
- **Local backup** (Settings → Local backup) — manual JSON export/import, or
  CSV export for sales and expenses. On iPad/iPhone, Export opens the native
  share sheet so you can save straight into Files/iCloud Drive.

## Cloud sync setup (Cloudflare Worker + KV)

This is what makes iPad, iPhone, and Mac all show the same live data. It's
free at normal bookstore volume — see the estimate at the bottom of this
section — and needs no CLI, just the Cloudflare dashboard.

1. **Create a KV namespace.** Cloudflare dashboard → Storage & Databases → KV
   → Create a namespace. Name it anything, e.g. `kasembannakij-kv`.
2. **Create the Worker.** Workers & Pages → Create → Create Worker. Give it a
   name (this becomes part of its URL, e.g. `kasembannakij-sync`). Once
   created, open its editor and paste in the contents of
   `cloudflare-worker/sync-worker.js` from this repo, replacing the default
   code. Deploy.
3. **Bind the KV namespace to the Worker.** On the Worker's page → Settings →
   Variables → KV Namespace Bindings → Add binding. Variable name must be
   exactly `kasembannakij_kv` (lowercase, underscore — not the namespace's own
   name), bound to the namespace from step 1.
4. **Set the sync passphrase.** Same Settings → Variables page → Environment
   Variables → Add → name it `SYNC_TOKEN`, value is a passphrase you make up
   (treat it like a password — anyone with it can read/write your data), and
   tick "Encrypt" so it's stored as a secret. Save and redeploy if prompted.
5. *(Optional, tightens security)* Add another environment variable
   `ALLOWED_ORIGIN` set to `https://maya-buba.github.io` — without this the
   Worker accepts requests from any site, though the passphrase still guards
   the data itself.
6. **Copy the Worker's URL** from the top of its dashboard page (looks like
   `https://kasembannakij-sync.<your-subdomain>.workers.dev`).
7. **On each device**, open the app → Settings → Cloud sync, paste the Worker
   URL and the passphrase from step 4, tap Save, then Connect. The first
   device to connect just pushes its data up; later devices get asked which
   copy to keep if both sides already have data.

After that, every add/edit/sale/expense pushes to the Worker automatically,
and each device also pulls on a timer and whenever you switch back to the
tab/app, so changes from other devices show up without a manual refresh.

**Cost estimate:** at ~15 sales/day and ~10 expenses/month sustained for 5
years, the stored data comes out to roughly 7 MB — a small fraction of KV's
1 GB free-tier storage limit and its 25 MB per-value limit. Request volume
(a write per change, a read every ~45s per open device) sits at a few dozen
writes and a few hundred reads on a busy day, well under the free tier's
1,000 writes/day and 100,000 reads/day. This should stay free indefinitely
at this business's scale.

**On conflicts:** if two devices happen to save within the same few seconds,
the second save is rejected and that device re-syncs to the first save's
data — so the loser's specific edit can be lost and needs redoing. At normal
single-shop write frequency this is rare; a toast tells you when it happens.

## Deploying the site itself

Static site — `index.html` + `style.css` + `app.js`, no build step. Pushing
to `main` on GitHub triggers a Pages rebuild automatically.
