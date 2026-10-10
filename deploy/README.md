# Deploying pos.watch

Three transports for the same 456 KB of static files: the clearnet domain, an
IPFS mirror, and a Tor onion service. Nothing here needs a build step.

Everything below was verified against live systems on **2026-09-05**. The IPFS
ecosystem in particular churned hard over the preceding two years — several
gateways and pinning services in older guides are now dead — so re-check before
trusting any of it a year from now.

---

## 0. Before anything: the assets must be committed

The site vendors its own fonts, images and `nes.min.css` so it never reaches a
CDN. That only works if they are actually in the repo:

```bash
git add website/vendor website/fonts website/img
git status --short          # expect no '??' lines under website/
```

A deploy that starts from `git clone` with those missing publishes a page with
no retro skin, no fonts and no logo.

---

## 1. Clearnet — do this first

The site can deploy directly from this repository to **Cloudflare Pages** or
**Netlify**. Both serve the existing `website/_headers` rules, so the same CSP
and security headers apply on either host.

**Recommended: Cloudflare Pages.** The free plan currently allows 500 builds
per month, 20,000 files per site, and up to 100 custom domains per project. It
also keeps Pages hosting and DNS in one dashboard if you later move the domain's
nameservers to Cloudflare. Static site delivery does not need a Worker or any
backend.

```bash
npx wrangler@latest pages project create pos-watch --production-branch main
npx wrangler@latest pages deploy website --project-name=pos-watch --branch main
```

That returns a live `*.pages.dev` URL with no DNS dependency — use it to confirm
the retro skin, fonts and logo all render before touching the domain.

To attach the domain, move `pos.watch` to Cloudflare's nameservers (it is on
Hostinger's `dns-parking.com` today, serving a parking page at `2.57.91.91`),
then Pages → Custom domains → add `pos.watch` and `www.pos.watch`.

For Git integration, import `innova-foundation/pos.watch`, set the production
branch to `main`, the build command to `exit 0`, and the output directory to
`website`. `exit 0` is Cloudflare's documented no-build command for static HTML.

**Netlify is also ready.** The root `netlify.toml` sets `website` as the publish
directory; there is no build command or dependency installation. Import the same
GitHub repository and leave the build command empty. Netlify's current Free plan
has a shared limit of 300 credits per month: production deploys use 15 credits,
bandwidth uses 20 credits per GB, and requests use 2 credits per 10,000. Sites
pause when the team reaches the monthly limit. That is workable for a small
project, though Cloudflare has more predictable headroom for an always-on public
site.

### Response headers

Already present as `website/_headers`. Cloudflare Pages and Netlify both read
this file from the publish directory. The Docker/nginx deployment uses the
matching headers in `deploy/nginx.conf`.

Three things in that CSP are load-bearing:

- `img-src` needs `data:`. `nes.min.css` draws its borders and icons from 21
  inline `data:image/svg+xml` backgrounds plus a few base64 PNGs — without it the
  retro skin loses them silently.
- `script-src` allows the pre-paint skin script in `<head>` by its sha256 hash,
  not `'unsafe-inline'`. Edit that script and the hash must be recomputed in
  `_headers`, `nginx.conf` and `nginx-onion.conf` — the one-liner is in
  `_headers`. A stale hash fails silently: the skin just stops applying.
- `connect-src` is exactly the two endpoints `script.js` calls, and nothing else.

The boot bar sets `el.style.width`, which is CSSOM rather than a markup `style`
attribute, so `style-src 'self'` does not block it.

---

## 2. IPFS

The site is already IPFS-safe: every asset reference is **relative**, so it works
under both path gateways (`/ipfs/<cid>/…`) and subdomain gateways. Verified by
mounting it at a gateway-style subpath — all assets resolved, nothing escaped the
CID root.

### Publish

```bash
brew install kubo && ipfs --version     # v0.43.0 at time of writing
ipfs init
ipfs config profile apply unixfs-v1-2025

cd /path/to/pos.watch
CID=$(ipfs add -rQ --ignore='.DS_Store' website)
echo "$CID"
```

Two rules that will bite otherwise:

- **Pick one chunker profile and never change it.** `vendor/nes.min.css` is
  288 KB, which straddles the 256 KiB boundary, so `--cid-version 1` and
  `unixfs-v1-2025` produce *different* root CIDs for identical content. Switching
  makes an unchanged site look changed.
- `ipfs cid base32 <CIDv0>` is a re-encode, not the same DAG. Pinning one does
  not make the other retrievable.

### Pin it

A CID nobody pins is a CID nobody can fetch. **Filebase** free tier is 5 GB /
500 files / 1 GB egress — the site is 456 KB across 13 files.

```bash
export AWS_REGION=us-east-1
ipfs dag export "$CID" > /tmp/pos-watch.car
aws --endpoint https://s3.filebase.com s3 cp /tmp/pos-watch.car \
  "s3://$FILEBASE_BUCKET/pos-watch-$CID.car" --metadata 'import=car'
```

The `--metadata 'import=car'` is what makes Filebase unpack and pin the root.
Without it the object is opaque bytes. Add a second pinning service for
redundancy — the ecosystem has proven it can vanish.

### Point the domain at it

One TXT record, and exactly one — tooling aborts on duplicates:

```
_dnslink.pos.watch.   300   IN   TXT   "dnslink=/ipfs/<CID>"
```

Use `/ipfs/<cid>`, **not** `/ipns/<key>`. The IPNS form means DNS never changes,
but it adds a DHT lookup to every cold resolve and needs a node online forever —
and it is the shape that made the inherited Denarius key dangerous (see below).

Then this works, free, with no custom-domain plan:

```
https://ipfs.filebase.io/ipns/pos.watch/
```

### Gateways: what is actually alive

| Gateway | State on 2026-09-05 |
|---|---|
| `ipfs.filebase.io` | **works** — resolves third-party DNSLink, 200 |
| `4everland.io` | works |
| `ipfs.io` / `gateway.ipfs.io` | **403 to browser user-agents** (Cloudflare challenge); fine for curl. Do not advertise. |
| `cf-ipfs.com`, `cloudflare-ipfs.com` | **NXDOMAIN** |
| `up.storacha.network` | **NXDOMAIN** |

Shipyard announced they stop operating ipfs.io, dweb.link and the public
bootstrap nodes on **2026-09-30**. Do not build on those.

Cloudflare's own Web3 gateway still exists but is a **paid add-on**, DNSLink-only,
and must be a subdomain (`ipfs.pos.watch`, never the apex). Skip it unless you
want the branded hostname.

### Ongoing cost

$0 in money. The cost is discipline: every content change means recompute the
CID, re-pin, and update the TXT. Miss the pin and the CID silently stops
resolving. This is the leg that rots quietly.

---

## 3. Tor onion

Mechanically simple. The page has already been adapted for it: served from a
`.onion`, `script.js` detects the hostname and makes **zero** outbound requests,
falling back to the baked-in chain snapshot. Without that, every visitor would
leak the onion address to `chainz.cryptoid.info` and `api.coingecko.com` via the
`Origin` header, which CORS requires and which cannot be suppressed.

Use `torrc.example` and `nginx-onion.conf` in this directory.

```bash
sudo install -d -m 700 -o debian-tor -g debian-tor /var/lib/tor/pos-watch
sudo cp torrc.example /etc/tor/torrc          # review it first
sudo systemctl restart tor@default
sudo cat /var/lib/tor/pos-watch/hostname      # -> <56 chars>.onion
```

**Back up `/var/lib/tor/pos-watch/hs_ed25519_secret_key` offline and encrypted
before publishing the address anywhere.** Lose it and the address is gone
permanently; leak it and anyone can impersonate the site.

Do **not** set `HiddenServiceSingleHopMode` or `HiddenServiceNonAnonymousMode` —
one-hop circuits make the server locatable, and a `HiddenServiceDir` once used
that way can never serve a normal onion again.

### Advertise it from clearnet

Add to the Pages `_headers` file, on the HTTPS site only:

```
/*
  Onion-Location: http://<your-onion>.onion/
```

Tor Browser then offers the onion automatically. The header must name a `.onion`
host, must be served over HTTPS, and must not itself be on an onion.

### Serve it over plain HTTP

No TLS on an onion — the hidden service protocol already authenticates and
encrypts, and a cert buys nothing. Note the consequence: Tor Browser disables
JavaScript on non-HTTPS sites at the **Safer** level, not just Safest. The page
degrades rather than breaking (the boot overlay stays hidden, `nes.min.css` loads
via `<noscript>`, and a notice explains the calculator needs JS), but **test it in
Tor Browser at all three security levels before publishing the address.**

### Ongoing cost

€0 on a Raspberry Pi, ~€4/mo on a small VPS. It needs a machine that will still
be running in a year — an onion that is intermittently up is worse than none.

---

## Inherited identity — do not reuse

This repo is a fork of `buzzkillb/pos.watch`, the Denarius calculator. Its README
advertised:

```
/ipns/k51qzi5uqu5dg7fkiet37k5jvb81ou2u01k2wvl4namtby5lrp8lvro8wp9oi9
tiljhkmti5r6mpfjq4zlruizzgbb6rhdplcllhzyh4caff7xjyerphyd.onion
```

Both belong to that deployment. We hold neither private key. The IPNS name is
currently unpublished (`routing: not found`) — but dormant is not dead: whoever
holds that ed25519 key can publish a record to it at any time. Pointing
`_dnslink.pos.watch` at it would hand a third party live publish rights over the
domain's content with no DNS change on their side.

Generate fresh keys for both. Do not attempt to reclaim the old ones.
