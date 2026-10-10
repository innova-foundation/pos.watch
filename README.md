# pos.watch — Innova Staking Calculator

Staking calculator for [Innova](https://innova-foundation.com/) (INN), covering both
the proof-of-stake rules mainnet enforces today and the finality-vote model that
ships in v5.0.0.0 for IDAG.

Not yet deployed — `pos.watch` still resolves to a parked domain. See
[`deploy/`](deploy/) for how to put it live.

IPFS and Tor mirrors are supported but not yet stood up — see
[`deploy/`](deploy/) for the runbook. The site is built to work over all three
transports: every asset is vendored (no CDN calls) and every path is relative,
so it serves correctly from an IPFS gateway, and when served from a `.onion` the
page makes no outbound requests at all.

The IPNS key and `.onion` address this repo carried before were the original
**Denarius** deployment's, not the Innova Foundation's. We hold neither private
key, so they have been removed rather than re-advertised. Generate fresh ones.

## Links

| | |
|---|---|
| Innova | <https://innova-foundation.com/> |
| Docs | <https://innova-foundation.com/docs/> |
| Wallet downloads | <https://innova-foundation.com/downloads/> |
| Collateral nodes | <https://innova-foundation.com/operators/> |
| IDAG architecture | <https://innova-foundation.com/idag/> |
| Block explorer | <https://chainz.cryptoid.info/inn/> |
| Wallet source | <https://github.com/innova-foundation/innova> |
| Discord | <https://discord.gg/mNM59znzNG> |
| Telegram | <https://t.me/innova_foundation> |
| X | <https://x.com/Innova_Fdn> |

All verified reachable on 2026-09-05.

## Why the numbers here differ from the docs

Innova's own documentation quotes **6% a year**, with a worked example of 600 INN
on a 10,000 INN stake. That is the **gross block mint**. A collateral node takes
65% of it in a separate output on the same coinstake transaction, so the staker
actually receives **210 INN — an effective 2.10%**.

Both halves of that are stated on Innova's own site (`PoS Rate 6% / year` and
`Node Reward Share 65%`); only the worked example omits the deduction. This
calculator shows the gross mint *and* the split, so the two reconcile.

Every rate is read out of the wallet source rather than from marketing copy:

| Constant | Value | Source |
|---|---|---|
| `COIN_YEAR_REWARD` | 6% / year on coin-age | `src/main.h:115` |
| `GetCollateralnodePayment` | 65% to the node | `src/main.cpp:10009` |
| Staker remainder | 35% | `src/wallet.cpp:5364` |
| `nStakeMinAge` | 10 hours | `src/main.cpp:186` |
| `nTargetSpacing` | 15 s | `src/main.cpp:185` |
| Wallet maturity | 75 confirmations | `src/main.cpp:2145` |
| `GetMNCollateral()` | 25,000 INN, exact single UTXO | `src/main.h:529` |
| `MAX_MONEY` | 18,000,000 INN | `src/main.h:114` |

The proof-of-stake math is validated against a real mainnet coinstake — block
**8,017,711**, coin-age 1193 — which it reproduces to the satoshi:
mint `0.19610958` → node `0.12747122`, staker `0.06863836`.

## IDAG mode

The IDAG tab models the finality-vote rules in
[v5.0.0.0](https://github.com/innova-foundation/innova/releases). **These are not
active on mainnet** — the chain is past every coded fork height without having
activated them — so the tab is labelled as a preview.

Under those rules PoS block production is abolished. Stakers cast one vote per
300-block epoch and are paid on the same 6% curve with **no collateral node cut**.
The reward truncates to whole coin-days per epoch:

```
coinAge = floor(floor(weightSat * epochInterval / COIN) / 86400)
reward  = floor(coinAge * COIN_YEAR_REWARD / 365)
```

At a 300-second epoch that collapses to `floor(balance / 288)`, which means a
stake under **288 INN earns nothing at all**, and above it the payout steps in
288 INN quanta — 5.18% at 1,000 INN, 5.94% at 25,000, and the full 6% only at
exact multiples of 288. The calculator uses `BigInt` so this is exact rather than
approximated.

## Live data

One request on load to `chainz.cryptoid.info/explorer/api.dws?q=summary`, which
returns height, supply, difficulty and collateral node count together in ~5 KB
gzipped with `access-control-allow-origin: *`. That explorer rate-limits to about
one call per 10 seconds and answers HTTP 429 for five minutes if pushed, so
batching into a single call is deliberate. If it is unreachable the page falls
back to a baked-in snapshot and says so.

A USD quote is fetched from CoinGecko but **only displayed if under 48 hours
old**. INN is effectively delisted and that quote has not moved since 2025-11-07,
so printing it beside live chain data would read as a current price.

## Structure

```
website/
  index.html            one page, two skins, two reward modes
  style/style.css       design tokens shared with innova-foundation.com
  script/script.js      reward engine + live data; no framework, no jQuery
  vendor/nes.min.css    retro skin, loaded disabled until selected
  fonts/                Sora, IBM Plex Mono, Press Start 2P
  img/                  Innova logo, pixel-art mark, favicon
  _headers              CSP + security headers (Cloudflare Pages and Netlify)
netlify.toml            Netlify static publish directory (website/)
deploy/                 runbooks and configs for all three transports
```

No build step, no backend, no external requests for assets — everything is
vendored, which is what makes the IPFS and Tor mirrors possible without reaching
a CDN. The retro skin's stylesheet ships `disabled`, so switching skins neither
re-downloads anything nor flashes.

The page degrades rather than breaking when JavaScript is off (which Tor Browser
does on `http://` onions at its Safer level and above): the boot overlay stays
hidden, `nes.min.css` loads via `<noscript>`, and a notice explains that the
calculator needs JS.

## Deploying

See [`deploy/`](deploy/) — clearnet, IPFS and Tor, with the gateway and pinning
landscape as verified on 2026-09-05. It also ships `torrc.example` and an nginx
config for the onion.
