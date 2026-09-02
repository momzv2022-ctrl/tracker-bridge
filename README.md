# Tracker bridge

Search your private tracker from an app, without giving that app your tracker
account.

A private tracker is a website with a login, not an API. It answers a search
with its own JSON, in its own shape, behind its own session — and it publishes
no magnet and no infohash at all, because the `.torrent` is behind your passkey.
No streaming client can read any of that.

This translates. Your app asks it for a search, it asks the tracker as you, and
it hands back the
[Torrent Stream Protocol](https://github.com/raul2hot/torrent-stream-protocol):
an ordinary JSON list of names, sizes, seeders, and a `magnet` and an `infohash`
on every row.

One file, no dependencies, and short enough to read in a sitting.

**It speaks one tracker, TorrentLeech, and one sibling:** a
[Unified Torrent Search Interface](https://github.com/momzv2022-ctrl/unified-torrent-search-interface)
of your own, which brings the public indexes into the same list — [see
below](#the-public-indexes-too-through-your-own-utsi). Adding another tracker
is one entry in `TRACKERS` and nothing else.

**Why not point the app straight at the tracker?** Two reasons. Your session
opens your whole account: your profile, your passkey, your ratio, your invites.
And a tracker's search takes path segments no client sends, returns a shape no
client reads, and — the part that matters most — gives you nothing that
identifies the content. This fixes all three: your app gets a key of its own
that only searches, and an answer it understands.

## The part that costs something

Read this before anything else, because it decides what this can and cannot do.

TorrentLeech's search returns a title, a size, seeder counts and a numeric id.
It does **not** return a magnet and it does **not** return an infohash — those
live in the `.torrent`, which is behind your passkey. TSP requires both on every
row.

So the file is read. For the rows on the page you asked for, the bridge fetches
the `.torrent` and takes the infohash from the file itself — `sha1` of its info
dict, so it is the real one rather than a guess. That also fills in the size and
the file count when the listing did not say.

Three things follow from that, and none of them are optional:

- **One extra request per row shown.** `BRIDGE_MAX_RESOLVE` caps it, at 20 by
  default. Ask for `limit=50` and you get the first 20 with the rest reported as
  `unresolved`. Raising it makes a longer page and a heavier search, in that
  order, and Cloudflare's free plan allows 50 subrequests per request.
- **`count` is what matched, not what you were handed.** A count of servable
  rows would be roughly `limit` every time, and you could never tell a full page
  from the last one. Page against `count`; read `unresolved` for the shortfall.
- **Infohashes are remembered** for as long as the process lives, keyed by
  tracker and row id. A second search that turns up the same row costs nothing.
  It is a cache, not storage: an empty one is slower, never wrong.

## Set it up in your browser

Paste your TorrentLeech details, press a button, and Cloudflare hosts the bridge
for you. Free, no card, nothing installed, and it works on a phone.

**→ https://momzv2022-ctrl.github.io/tracker-bridge/**

Five short steps: your TorrentLeech details, sign in to Cloudflare, press
Deploy, open your new bridge and press Finish setup, and your URL and key are
shown together with a button that tests them. Step 1 also has two optional
boxes for a UTSI of your own; fill them in and the public indexes come along.

**Everything the bridge needs is in that one press.** There is no second visit
to a dashboard to set a variable, which matters because the one setting most
deployments need — the announce workaround below — is the difference between a
bridge that works on a phone and one that finds nobody, and nobody who needs
this page is going to go and set it afterwards. Step 1 asks, in a sentence, with
the box already ticked.

Everything you type stays in your browser. Your details are written into your
copy of the file and travel inside the deploy link, after the `#`, which
browsers never send to a server. They are not saved in your browser, and the
page makes no network request at all. **Do not forward that deploy link to
anyone**, and if you would rather your sign-in never sat in a link, the page has
a route that adds it in the Cloudflare dashboard instead.

## What TorrentLeech needs from you

Two different things, and they do two different jobs.

| | |
|---|---|
| **An RSS key** | Fetches the `.torrent`. 20 hex characters, from the RSS link on your TorrentLeech profile. It does not expire. |
| **A session** | Searches. Either the cookies you paste out of a browser you are logged in with, or a username and password it can log in with. |

The RSS key cannot search and a session alone can still fetch files, so
strictly you need one of the two — but set both. With an RSS key, fetching files
never depends on a session that may lapse mid-search.

### The session, and which of the two to give it

**Cookies** are the lighter secret. Nothing in them can be turned back into
your password, logging out of TorrentLeech ends them, and there is no login
request for a bot filter to inspect. Log in in your browser, then copy the
cookies for `torrentleech.org` out of developer tools as `name=value` pairs.

Paste all of them if it is easier. Only four names are ever kept —
`PHPSESSID`, `tluid`, `tlpass`, `cf_clearance` — and the rest are dropped
before anything is written down. **Which of them is the session is
TorrentLeech's business and it changes**: its login page sets `PHPSESSID`
today, and `tluid`/`tlpass` are the pair a remember-me login used to add,
back when the form had a remember-me box on it. The bridge carries all of
them and finds out by asking rather than by guessing which name matters.

**A username and password** is the heavier secret and the one that keeps
working. The bridge logs in by itself when the session lapses: it fetches the
login form, posts every field on it — including any hidden ones, in case the
form grows some — and then **proves the result by running a search with it**
rather than by looking for a cookie of a particular name. If that fails you get
the HTTP status, whatever TorrentLeech itself said, and the names of the cookies
it handed back, so the next move is obvious. Set `TL_2FA` to your **Alt 2FA
Token** (Site Profile) if your account has two-factor on; a one-time code from
an app will not work, because there is nobody to type it.

Set both if you like. The cookie is used while it works and the login renews it
when it stops.

### Two things that can go wrong, and what they look like

**A session may be tied to the address it was made at.** A Cloudflare Worker
calls from Cloudflare, not from your house, so a pasted cookie can be refused for
that reason alone. You get `tracker_rejected_session`, which says so. The
username and password route usually works instead; running the file on your own
machine always does.

**TorrentLeech sits behind a bot filter.** Most of the time a plain request goes
through. When it does not, the answer is a browser test that a Worker cannot
take, and you get `tracker_challenged` rather than an empty list. Jackett's own
indexer definition for this tracker ships a FlareSolverr hint for the same
reason. There is no way around this from a Worker; run it at home instead.

`/healthz?probe=1` tells you which of the two is happening, if either is.

## Or run it yourself

Both recipes need Node 20 or newer, which is the only thing they need.

### Recipe A: on your own machine

The one that always works: the request comes from your own address, which is
also the address the cookie was made at.

```sh
curl -fsSLO https://raw.githubusercontent.com/momzv2022-ctrl/tracker-bridge/main/worker/src/worker.js
BRIDGE_API_KEY=$(openssl rand -hex 16) \
TL_COOKIE='PHPSESSID=…; tluid=…; tlpass=…' \
TL_RSSKEY=your20charrsskeyhere \
node worker.js
```

It prints the URL it is serving on and whether it is ready. Point your app at
that URL and that key.

To reach it from outside the house, put a Cloudflare Tunnel in front of the
bridge. To keep it running, use whatever already runs things on that machine. A
systemd unit:

```ini
[Service]
Environment=BRIDGE_API_KEY=your-bridge-key
Environment=TL_COOKIE=PHPSESSID=…; tluid=…; tlpass=…
Environment=TL_RSSKEY=your20charrsskeyhere
ExecStart=/usr/bin/node /opt/tracker-bridge/worker.js
Restart=always
```

### Recipe B: at Cloudflare

Free, and the URL stays up when your machine sleeps.

```sh
curl -fsSLO https://raw.githubusercontent.com/momzv2022-ctrl/tracker-bridge/main/worker/src/worker.js
npx wrangler deploy worker.js --name tracker-bridge --compatibility-date 2026-08-18
npx wrangler secret put BRIDGE_API_KEY
npx wrangler secret put TL_COOKIE
npx wrangler secret put TL_RSSKEY
```

`wrangler` opens your browser once to sign in, then prints your URL. Put all
three in as secrets rather than variables: every one of them is a credential.

Cloudflare's free plan covers 100,000 requests a day and needs no card.

## Settings

Only the first two matter, and the second is really "one of these".

| | |
|---|---|
| `BRIDGE_API_KEY` | What your app sends here, as `X-API-Key`. At least 16 characters, or the bridge refuses to serve. |
| `TL_COOKIE` | Cookies from a logged-in browser, as `name=value` pairs. Only `PHPSESSID`, `tluid`, `tlpass` and `cf_clearance` are kept; everything else is dropped. |
| `TL_USERNAME`, `TL_PASSWORD` | Instead of, or alongside, the cookie. Lets it log in again when the session lapses. |
| `TL_2FA` | The Alt 2FA Token from Site Profile. Only if your account has 2FA. |
| `TL_RSSKEY` | 20 hex characters, from your profile's RSS link. Fetches `.torrent` files without a session. |
| `TL_HOST` | Default `https://www.torrentleech.org`. The alternates exist for when that name is blocked. |
| `TL_FREELEECH` | Only return freeleech releases. Default off. |
| `TL_EXCLUDE_SCENE` | Leave scene releases out. Default off. |
| `UTSI_URL`, `UTSI_API_KEY` | A [Unified Torrent Search Interface](https://github.com/momzv2022-ctrl/unified-torrent-search-interface) of your own, and its key. Optional. With both set, every search asks it as well and its rows go into the same list. On Cloudflare it also needs a Service binding named `UTSI`. [See below.](#the-public-indexes-too-through-your-own-utsi) |
| `UTSI_ROWS` | How many rows to ask it for on every search. Default `100`, ceiling `200`. Fixed rather than page-sized, so that paging over the merged list is stable. |
| `UTSI_TIMEOUT_S` | How long to wait for it before answering without it. Default `10`. |
| `BRIDGE_TRACKERS` | Which to switch on, comma separated: `torrentleech`, `utsi`. Empty means every configured one. |
| `BRIDGE_MAX_RESOLVE` | Most rows per page whose `.torrent` is read. Default `20`. **This is the length of your results.** `0` empties every answer. |
| `BRIDGE_RESOLVE_CONCURRENCY` | How many of those may be in flight at once. Default `3`. |
| `BRIDGE_REQUEST_GAP_MS` | Smallest gap between two requests to one tracker. Default `300`. Lower it and searches get faster; see below. |
| `BRIDGE_EDGE_CACHE` | Keep learned infohashes in Cloudflare's edge cache, not only in memory. Default **on**. Stores the file's announce list, passkey included. |
| `BRIDGE_CACHE_TTL_S` | How long one of those lives. Default `604800`, a week. |
| `BRIDGE_TIMEOUT_S` | How long to wait. Default `45`. |
| `BRIDGE_BROWSE_ROWS` | Rows for a search with no words in it. Default `25`. `0` answers those instantly without asking the tracker. |
| `BRIDGE_TORRENT_URLS` | Advertise `torrent_url` on every row. Default **off** — see below, it changes what a client believes about peers. |
| `BRIDGE_ANNOUNCE_HTTP` | Rewrite the magnet's announce URLs from https to http. **The setup page asks, and ticks it.** Default off when deploying by hand. **Your passkey travels in the clear.** See below. |
| `BRIDGE_TORRENTFILE_TTL_S` | How long a `torrent_url` stays valid. Default `3600`. |
| `BRIDGE_USER_AGENT` | What to call itself. Defaults to a browser's, on purpose — see the file. |
| `BRIDGE_CORS_ORIGINS` | Web pages allowed to call this, comma separated. Empty means none but the setup page. |
| `BRIDGE_ALLOW_ANONYMOUS` | Serve with no key at all. On a public URL this hands your tracker account to anyone who finds it. |
| `BRIDGE_PORT`, `BRIDGE_HOST` | Node only. Default `8788` and `127.0.0.1`. Set `0.0.0.0` to accept from the LAN. |

## Changing a setting after the setup page deployed it

Worth knowing before you need it, because the error is opaque.

The setup page deploys through Cloudflare's **versions** flow, which leaves the
Worker with a latest version that is not the deployed one. Adding a variable
then fails in two different ways depending on where you try it:

- In the dashboard, **Settings → Variables and Secrets → Add** stages the row
  and does nothing until you press **Deploy** on that card. Navigate away first
  and the change is silently dropped — `/healthz` still reports the old value,
  which is the quickest way to tell.
- `wrangler secret put` refuses outright: *"the latest version of your Worker
  isn't currently deployed"*.

The command that works:

```sh
npx wrangler versions secret put BRIDGE_ANNOUNCE_HTTP --name your-worker-name
npx wrangler versions deploy --name your-worker-name   # if it did not offer
```

**`/healthz` is the check.** It reports every setting that changes what a
client sees — `torrent_urls`, `announce_http` — and needs no key, so
confirming a change took is one request:

```sh
curl -s https://your-worker.workers.dev/healthz
```

## What your app gets

Four routes, one header, JSON out.

```sh
curl -H "X-API-Key: YOUR-BRIDGE-KEY" \
  "http://127.0.0.1:8788/api/v1/search?q=big+buck+bunny&limit=5"
```

`/api/v1/search` takes `q`, and optionally `cat`, `year`, `res`, `min_seeders`,
`sort`, `limit` and `offset`. It answers with `torrents`, each carrying a
`magnet`, an `infohash`, a name, a size, seeder and leecher counts, and whatever
the release name gives up: year, resolution, codec, source, season, episode.

Some fields are not in the contract, and a client that does not know them
ignores them: `total_found` is what the trackers said they had, `unresolved` is
how many rows on this page could not be read, `degraded` names a tracker that
failed while another answered, and `partial` is passed along from a UTSI that
stopped waiting for its slowest engines. Two more are for a client holding
private and public rows in one list: `private` is the file's own flag, and
`indexer` is who had the row — `TorrentLeech` or `UTSI`.

### `torrent_url`, and why it is off by default

With `BRIDGE_TORRENT_URLS=1`, every row also carries a **`torrent_url` pointing
at this bridge**, never at the tracker:

```
https://your-bridge.example/api/v1/torrentfile/<infohash>?t=<token>
```

It is off unless you ask, and that is not the obvious default. TSP calls the
field the `.torrent` "if the index knows one", and this bridge always does — it
has just read the file to get the infohash.

**But a client reads a promise into it, and reasonably.** For a public
catalogue the `.torrent` carries `url-list` web seeds, so having it really does
take peers off the critical path, and a client holding one stops reporting a
swarm at all. A private tracker's file has none. Checked, on a real one:

```
private flag:        1
announce-list:       https://tracker.torrentleech.org/a/<PASSKEY>/announce
url-list (webseed):  absent
httpseeds:           absent
```

So the file takes the *metadata* fetch off the critical path and nothing else.
Every byte still comes from peers. A client told there is a direct source here
will hide the seeder count on exactly the rows where it matters most, and will
not warn you about a row nobody is on.

Turn it on when your client treats the field as what it is — the info dict
arrives over HTTPS rather than out of the swarm, so a start is quicker and
surer. `/healthz` reports `torrent_urls` either way, which is the answer to
"why does every row say direct download".

The token is **sealed, not signed**: AES-GCM under your own `BRIDGE_API_KEY`, so
what your app holds is an opaque string it cannot read. Your RSS key and your
session stay on the server, which is the point of the whole bridge. The route
still requires your key, refuses a token it did not mint, refuses one that has
expired, refuses one aimed at a host no configured tracker owns, and refuses a
file whose infohash is not the one in the URL.

Because the route needs the key, a client fetching that URL has to send it —
TSP says the key goes to the index's own origin, and this URL is on it. A client
that fetches it unauthenticated gets a 401 and, if it is well written, falls
back to the swarm.

`/healthz` needs no key and reports configuration only — whether each credential
is set, never what it is — so it makes no request of its own. `/healthz?probe=1`
needs the key and asks each tracker: whether it answers, whether it still accepts
your session or your key, and how much it says it has.

That last one matters more than it sounds. **A dead session and a search with no
results look identical** from a client. `?probe=1` is where the difference
shows.

The answer is the same shape the
[Prowlarr bridge](https://github.com/momzv2022-ctrl/prowlarr-bridge) and the
[Unified Torrent Search Interface](https://github.com/momzv2022-ctrl/unified-torrent-search-interface)
produce, down to the percent-encoding in the magnet, so an app can hold results
from all three without seeing two of everything.

## The public indexes too, through your own UTSI

A client holds one URL and one key. If you also want the public indexes, the
place to combine them is here, not in the app — and the
[Unified Torrent Search Interface](https://github.com/momzv2022-ctrl/unified-torrent-search-interface)
is the sibling project that searches them, in the same protocol this bridge
speaks. Deploy one of your own from its setup page, then give this bridge its
URL and its key: the two boxes in step 1 of the setup page, or `UTSI_URL` and
`UTSI_API_KEY` by hand.

Every search then asks both, at the same time, and answers with one list.

**Two Workers on one account need a Service binding.** Cloudflare refuses a
Worker's call to another Worker's `workers.dev` address on the same account
(its error 1042), and from the bridge that refusal looks like a 404. The way
past it is a Service binding named `UTSI` on the bridge, pointing at your UTSI,
and the bridge uses it whenever it is there: `/healthz` says `via: "binding"`
rather than `via: "url"`. The setup page writes the binding into the deploy
link; whether Cloudflare's deploy screen keeps it is not yet verified, so if
the test in step 5 says UTSI answered 404, add it by hand: open the bridge in
Cloudflare, then *Settings*, *Bindings*, *Add*, *Service binding*, variable
name `UTSI`, service: your UTSI, and press *Deploy*. Deploying by hand it is
three lines of `wrangler.toml`, with the first label of the UTSI's
`workers.dev` address as the service:

```toml
[[services]]
binding = "UTSI"
service = "utsi-abc123-some-words"
```

`UTSI_URL` is still worth setting beside it: the binding is how UTSI is
reached, and the URL is how a `torrent_url` on its origin is recognised.
Running under Node there is no Cloudflare in between, and the URL alone is
enough.

**It is the cheap half.** A UTSI row arrives with its infohash and its magnet,
so it costs no `.torrent` fetch and does not count against `BRIDGE_MAX_RESOLVE`.
A page that is half public rows reads half as many files, and a page that is
all public rows is answered as soon as the tracker's own list request is. UTSI
is asked in parallel, so it adds nothing to the wall clock unless it is slower
than that request; `UTSI_TIMEOUT_S` caps how much slower it may be before the
answer goes out without it, marked `degraded`.

**The same release on both sides is one row, and the private copy wins.** One
infohash is one info dict, `private` flag included, so a private tracker's
release that also turns up on a public index is a private swarm from either
side. The merged row carries the file's own announce, `private: true` and
`indexer: "TorrentLeech"`; a magnet with the public five on it would name a
swarm it can never reach, and publish it in the trying. `count` still counts
both copies, which is what keeps paging stable; the row is handed over once.

**Paging stays stable.** UTSI is asked the same question on every page —
`UTSI_ROWS` of its best-ranked rows, with the filters and the sort along for
the ride and never an offset — and the bridge sorts and pages over the merged
set. So `count` and the order are the same answer on page one and page four,
which a client that fans out over pages depends on. Past `UTSI_ROWS`, only
TorrentLeech has more to page.

**Its key stays here.** It is the lesser secret — it opens a search of public
sites, not an account — and it is held the same way as the tracker's: sent to
that one origin, never to a client, never in a URL, and `/healthz` shows
neither it nor the URL. `/healthz?probe=1` runs a real search against it and
says whether the key fits.

**`torrent_url` on a public row**, with `BRIDGE_TORRENT_URLS=1`, is passed
through when it points at a public host, and served from here, sealed, when it
points at UTSI's own origin — that one needs UTSI's key, which your app does
not have. With the setting off no row carries one, whichever side it came from.

`BRIDGE_TRACKERS=torrentleech` keeps a configured UTSI out of every search
without unsetting it, and `BRIDGE_TRACKERS=utsi` is a bridge with no tracker
session at all — one URL for the public indexes alone. Rows from UTSI carry
`sources` such as `UTSI/piratebay`, so a surprising row is easy to trace back.

## Why a search takes as long as it does

Measured against a real deployment, five rows:

| | wall clock | `took_ms` |
|---|---|---|
| cold | 8.4 s | 7,369 |
| the same five again | 1.1 s | 410 |

The whole difference is reading five `.torrent` files. Roughly, a search costs:

```
~2s   one list request to the tracker, which is its own latency and cannot be helped
~1.1s per row whose file has to be read, and that is what the knobs move
```

Three things make the second number smaller, and a fourth makes it apply to
fewer rows: a public row from your UTSI is never read at all.

**The edge cache**, on by default. An infohash is a hash of the file's own
contents and never changes, so once a row has been read the answer is good for a
week. In memory that saving lasts as long as one isolate, which is not long;
`BRIDGE_EDGE_CACHE` makes it survive a cold start. The entry holds the file's
announce list, and **your passkey is in that** — the same secret already written
into every magnet this bridge hands your client, now also in a cache scoped to
your own Worker. `BRIDGE_EDGE_CACHE=0` if you would rather it were not.

**The gap between requests.** `BRIDGE_REQUEST_GAP_MS` is enforced across all
requests to one tracker, so at the default 300 it largely defeats
`BRIDGE_RESOLVE_CONCURRENCY`: twenty rows means six seconds of deliberate
waiting whatever the concurrency is. Lowering it to 60 and raising concurrency
to 6 is roughly three times quicker on a cold page. That is load you are putting
on a tracker that counts requests against your name — Jackett spaces its own
4,100 ms apart — so it is a judgement call and the defaults are the cautious
end of it.

**`BRIDGE_MAX_RESOLVE`** is the ceiling on how many rows are read at all.
Twenty rows is twenty requests; ten is ten, and a shorter page.

## If nothing ever finds a peer

A row with hundreds of seeders that sits at "no one connected" is almost always
the announce, and there are two ways it goes wrong. Both leave the same
symptom, and your client's own diagnostics tell them apart.

**The announce fails at the TLS layer.** TorrentLeech's tracker is https only in
its `.torrent`, and a libtorrent built without a CA bundle — which is the usual
state of affairs on Android — cannot verify any certificate and fails every
https tracker with `unspecified system error` before it sends a byte. Nothing
about the swarm is wrong; the client simply never asked.

`BRIDGE_ANNOUNCE_HTTP=1` is the escape hatch. TorrentLeech's tracker serves
plain http on the same paths and does not redirect, so the announce lands. The
price is blunt: **your passkey is in that URL, and http sends it in the clear**
to every network between the device and the tracker. It identifies your account.

The setup page asks about this in step 1, with the box **ticked**, because for
the client this exists to serve the alternative is a bridge that returns healthy
rows and plays none of them — and a default that does not work is not a safe
default, it is one that gets worked around less carefully. The sentence next to
the box says what it costs, and unticking it is one tap. Deploying by hand it is
off unless you ask, and `/healthz` reports `announce_http` either way.

The real fix is in the client: a libtorrent with a CA bundle can announce over
https and none of this is needed. Until then this is the honest trade.

**The client added its own trackers.** Some clients append a list of public
trackers to every torrent they open. On a private torrent that does not merely
fail — it announces your tracker's infohash to a public tracker, which publishes
that swarm, and is the sort of thing accounts are closed over. It also fills the
diagnostics with `udp://…` timeouts that look like the problem and are not.

This bridge never contributes to that. A row whose `.torrent` has been read
carries **only that file's announce list**, and a private row that could not
read one carries no trackers at all rather than borrowing the public five. If
you see public trackers on a private row, they came from your client, and that
is worth turning off.

## Adding another tracker

Section 5 of the file is the only part that knows what a tracker is. An entry in
`TRACKERS` is six things:

```js
{
  id, label,        // what it is called, in a setting and on a screen
  read(env),        // its settings, or null when it is not configured at all
  search(...),      // a query in, rows out
  probe(...),       // a live answer for /healthz?probe=1
  fileRequest(...), // a row's .torrent URL in, the headers to fetch it with out
}
```

There are two to copy from: `torrentleech`, for a website with a login, and
`utsi`, for anything that already speaks TSP.

Sections 2 to 4 — the name parser, the merge, the filters, the wire shape — do
not change, and neither do the routes. `BRIDGE_TRACKERS` then selects which
combination is live, and a search fans out across all of them and merges the
answers.

## Check it before you trust it

- **It is one file.** [`worker/src/worker.js`](worker/src/worker.js). No
  dependencies, no build step, no minifier. What you run is what you read.
- **Search it for `fetch(`.** There is one, and it goes to `TL_HOST` — and to
  `UTSI_URL`, if you set one. Nothing else is contacted, ever, and there is no
  telemetry.
- **Your credentials go into headers, on requests to the tracker.** Never into a
  query string, where they would land in access logs. CI asserts that no
  keyless route ever returns one.
- **Your app's key is compared in constant time**, so it cannot be guessed one
  character at a time.
- **The published file is this file.** A public GitHub Actions run copies it to
  the setup page and prints its SHA-256, which the page shows and
  [`worker.js.sha256`](https://momzv2022-ctrl.github.io/tracker-bridge/worker.js.sha256)
  publishes. Download it and run `shasum -a 256 worker.js`.
- **The setup page fetches nothing.** It mints your key with
  `crypto.getRandomValues`, writes your settings into your copy of the file, and
  never makes a request. A browser check opens it at five screen sizes on every
  push and fails the build if it ever reaches the network.
- **The tests run offline**, on Node 20, 22 and 24, on every push. TorrentLeech
  is a table of recorded rows and so is UTSI, and the whole answer is frozen in
  [`worker/tests/golden/search.json`](worker/tests/golden/search.json) — the
  combined one in [`combined.json`](worker/tests/golden/combined.json) beside
  it — so any change to what a client receives shows up as a diff a person has
  to approve.

```sh
npm test
```

## What it does not do

- **It does not fetch a `.torrent` for a row nobody looked at.** Only rows on
  the page being answered, up to `BRIDGE_MAX_RESOLVE`. The rest are reported as
  `unresolved` rather than silently missing.
- **It pages over one page of the tracker's own.** TorrentLeech's list endpoint
  has no page size in the URL — it serves however many rows your profile's
  *Torrents per page* is set to. Set that to 100 on your own profile and there
  is more to page through. `total_found` says how much it had in total.
- **`cat=image` and `cat=archive` are best effort.** TorrentLeech has no image
  category and no archive category, so those two searches go out unfiltered and
  are narrowed by reading release names. The other four are filtered by the
  tracker itself.
- **`/api/v1/stats` is deliberately absent.** Counting a catalogue would mean a
  request per category on every call, and TSP says a client that cannot read it
  offers every category — which is the right answer here.
- **It searches nothing itself.** What the tracker has, how fast it answers, and
  anything that goes wrong with your account is between you and them.

## Privacy

It **keeps no log**. Nothing is written anywhere: there is no database, no file
and no state between requests. The two things it holds in memory — infohashes it
has learned, and a session it has logged in for — die with the process.

It is not anonymity. The tracker sees the query, so do your UTSI and the public
indexes behind it, and on the Cloudflare path Cloudflare carries it. What it does do is keep your session, your password and
your passkey on the server side of the line.

There is **no public instance of this and no list of other people's**. The only
one that exists is the one you run.

**One thing to know, and it is the important one.** A magnet built from a
private tracker's `.torrent` carries that file's announce URL, and **your
passkey is in it**. That is what makes it work in your own client, and it is
also why a magnet from one of these rows is not a thing to paste anywhere: it
identifies your account, and on most trackers sharing it is what ends one. The
same is true of the `.torrent` itself, which is why the route that serves it
wants your key and is served `no-store`.

## Your responsibility

This searches a site you have an account on, using your own account. Laws about
what you may download differ from country to country, and so do TorrentLeech's
own rules — about ratio, about seeding time, and about where your passkey may
go. Complying with both is yours to do. Nothing here is legal advice.

MIT licence, and it is provided **without warranty of any kind**, with the
authors **not liable** for any claim or damages arising from it or from its use.
