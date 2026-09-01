# TorrentLeech, as this bridge sees it

Everything section 5 of `worker/src/worker.js` believes about TorrentLeech, and
where each belief came from. None of it is documented by the tracker; all of it
is read off the indexer definitions that Jackett and Prowlarr both ship, or off
`autodl-irssi`'s tracker file.

Keep this in step with the code. When a request stops working, the first
question is whether one of these is still true.

## Sources

| | |
|---|---|
| `torrentleech.yml` in Jackett | https://raw.githubusercontent.com/Jackett/Jackett/master/src/Jackett.Common/Definitions/torrentleech.yml |
| the same file in Prowlarr | https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/v11/torrentleech.yml |
| `TorrentLeech.tracker` in autodl-trackers | https://raw.githubusercontent.com/autodl-community/autodl-trackers/master/trackers/TorrentLeech.tracker |

The first two were byte-identical in every part this project uses, at the time
of writing, but for one search mode Prowlarr does not offer.

## Hosts

`links:` in the definition, in its own order of preference:

```
https://www.torrentleech.org/     ← TL_HOST default
https://www.torrentleech.cc/
https://www.torrentleech.me/
https://www.tleechreload.org/
https://www.tlgetin.cc/
https://rss.torrentleech.cc/
```

`TL_HOST` exists so one of the others can be used when the first is blocked.

## Signing in

**The form, as it actually is.** Fetched from
`https://www.torrentleech.org/user/account/login/` on **2026-09-01**, the whole
form is three elements:

```html
<form name="login-form" method="post" action="/user/account/login/">
  <input type="text"     name="username" ...>
  <input type="password" name="password" ...>
  <button type="submit" ...>Log in</button>
</form>
```

No hidden field, no CSRF token, and **no remember-me checkbox**. The page loads
`https://www.google.com/recaptcha/api.js`, but neither of its two script bundles
mentions `grecaptcha` and there is no widget in the form, so it is a leftover
tag rather than a gate — as of that date.

**The form, as the definition describes it.** `login:`:

```yaml
path: user/account/login/
method: form
form: form[name="login-form"]
inputs:
  username, password, alt2FAToken
```

`method: form` means Cardigann fetches the page, takes *every* input in that
form, overrides those three, and posts the lot. `tlLogin()` does the same, which
is why `formInputs()` exists: today it finds nothing but the two boxes, and the
day the form grows a token that is the difference between a login that works and
one that silently does not.

`alt2FAToken` is the **Alt 2FA Token** from Site Profile, not a rolling code
from an authenticator app. The definition's own error selector for a wrong or
missing one matches `h2:contains("One Time Password")`, which is what
`tlLogin()` looks for before it says anything about 2FA.

**What a session is: do not answer this question.** The login page sets
`PHPSESSID`, twice, and nothing else. Community documentation describes a
`tluid`/`tlpass` pair issued by a remember-me login, and the form has no
remember-me control on it any more — so both may be true at different times, and
neither is a name to depend on.

The first version of this file depended on one anyway: it accepted a login only
if the response set **both** `tluid` and `tlpass`, and so reported a working
sign-in as `tracker_rejected_login`. `tlVerify()` replaced that. It runs a
one-row browse with whatever cookies came back and asks whether JSON arrives.
The site decides what a session is; this file finds out.

`TL_COOKIES_KEPT` — `PHPSESSID`, `tluid`, `tlpass`, `cf_clearance` — is
therefore an allowlist of what is *worth carrying*, not a claim about which one
authenticates. It exists so that a cookie jar pasted out of a browser does not
carry analytics along with it.

It is also reported that the persistent pair can be tied to the browser and
address it was made at. That is why `tracker_rejected_session` says what it says,
and it is unverified.

**Logging out ends them.** That is the revocation story for a pasted cookie, and
it is worth knowing before you paste one.

## Searching

`search.paths` in the definition, with the template unrolled:

```
{host}/torrents/browse/list
      [ /categories/{ids, comma separated} ]
      [ /facets/tags:FREELEECH[,nonscene] ]
      ( /exact/1/query/{keywords}  |  /newfilter/2 )
      /orderby/{added|seeders|size|nameSort}
      /order/{desc|asc}
```

Two deliberate departures in `tlSearchUrl()`:

- **No empty query segment.** With no keywords the template still emits
  `exact/1/query//`. That is a double slash where a segment should be, and
  `newfilter/2` alone is what the tracker's own front page browses with, so the
  pair is dropped instead.
- **`order` is always `desc`.** TSP's `sort` has no direction, and every one of
  its three values wants the largest first.

**Keywords.** `keywordsfilters` strips a leading `-` from any word, because to
this tracker's search a leading dash means "not this". Without it a pasted
release name — `Some.Movie.2019-GROUP` — excludes half of itself.
`tlKeywords()` is that rule.

**Paging: there is none.** No page number and no page size appears anywhere in
the template. The endpoint serves however many rows the *Torrents per page*
setting on your own profile says, which the definition itself recommends setting
to 100. So `limit` and `offset` page over what came back, and `total_found`
carries `numFound` so a client can tell there was more.

## The answer

`rows.selector: torrentList`, `count.selector: $.numFound`. Every field
`tlRow()` reads, and the definition line it came from:

| field | used as | from |
|---|---|---|
| `fid` | the row id, and the download URL | `_id` |
| `filename` | the download URL, and the name when `name` is null | `_filename` |
| `name` | the release name | `title_test`, marked `optional: true` |
| `categoryID` | the TSP category | `category` |
| `size` | `size_bytes` | `size` |
| `seeders`, `leechers` | as they are | `seeders`, `leechers` |
| `addedTimestamp` | `first_seen` | `date`, parsed `yyyy-MM-dd HH:mm:ss` |
| `numfiles` | `files` | not in the definition; absent is read as absent |

`title` being nullable is not a guess — the definition carries a comment and an
issue number for it, and falls back to a placeholder string. This bridge falls
back to the filename instead, which at least says what the release is.

`addedTimestamp` has no timezone and the definition notes it is "auto adjusted
by site account profile". `tlStamp()` reads it as UTC: at worst hours out on a
field used for ordering, and at least the same answer on every runtime.

**There is no infohash and there is no magnet.** The definition constructs
`download` from the id and the filename and reads no such field, because there
is none. That single fact is what the rest of this project is shaped around.

## Getting the file

Two routes, and this bridge prefers the second:

```
{host}/download/{fid}/{filename}                     needs the session cookie
{host}/rss/download/{fid}/{rsskey}/{name}.torrent    needs nothing but the key
```

The first is the definition's `download` field. The second is from
`TorrentLeech.tracker`, which builds exactly that URL from an announce line and
an `rsskey` it validates as `[\da-fA-F]{20}` — which is where the 20-hex check
in `read()` comes from, and where the instruction to take it from the RSS link
on your profile comes from.

**What is inside one.** Fetched through this bridge on **2026-09-01**:

```
keys at root:        announce, announce-list, info
private flag:        1
announce:            https://tracker.torrentleech.org/a/<PASSKEY>/announce
announce-list:       [[ …/a/<PASSKEY>/announce, https://tracker.tleechreload.org/a/<PASSKEY>/announce ]]
url-list (webseed):  absent
httpseeds:           absent
```

Three things follow. `private: 1` disables DHT and peer exchange, so the
announce list is the only way to find a peer — which is why magnetFor() uses the
file's own trackers rather than the public five. The passkey is in every one of
those URLs, which is why a magnet from this bridge is not a thing to paste
anywhere. And **there are no web seeds**, which is why `BRIDGE_TORRENT_URLS`
defaults to off: handing a client the `.torrent` removes the metadata fetch from
the critical path and nothing else, and a client that reads the field as "no
peers needed" will stop reporting the swarm on rows whose whole risk is the
swarm.

The RSS route is preferred because it cannot be broken by a session expiring
mid-search, and because it keeps a `.torrent` fetch from depending on a login.

## The tracker itself

`tracker.torrentleech.org` resolves to Cloudflare addresses (`172.66.x`), and
serves **both** http and https on the announce paths, with no redirect from one
to the other. Checked 2026-09-01:

```
http  /a/<bad-passkey>/announce -> 404
https /a/<bad-passkey>/announce -> 404          cert: Google Trust Services, verifies
```

That is what `BRIDGE_ANNOUNCE_HTTP` relies on. It exists because a libtorrent
without a CA bundle — the usual state of affairs on Android — fails every https
tracker with `unspecified system error` and finds no peers at all, while the
same announce over http works. The passkey then travels in the clear, so it is
off by default and `/healthz` reports which way it is set.

## Categories

The full id list is in `TL_CATEGORY`, copied from `caps.categorymappings`. Two
notes on the mapping onto TSP's six:

- **38, Education**, is left unmapped. The definition calls it `Other`, its name
  does not decide whether it is a video or a document, and an absent mapping
  sends the row to `classifyName()` rather than asserting something false.
- **16, Music videos**, is `video` here where the definition says `Audio/Video`.
  It is a video file, and a client filtering `cat=video` should see it.

TSP's `image` and `archive` have no id to ask for, so those searches go out
unfiltered and are narrowed by reading names. `TL_CATEGORY_IDS` empties them
explicitly, and a test holds it.

## Rate and politeness

The definition sets `requestDelay: 4.1` seconds. Jackett polls all day; a bridge
makes a burst per search, so `BRIDGE_REQUEST_GAP_MS` defaults to 300 rather than
4,100, with `BRIDGE_RESOLVE_CONCURRENCY` at 3 and `BRIDGE_MAX_RESOLVE` at 20.
That is at most 21 requests for a page of results, spaced.

`spaced()` holds the gap **within one isolate only**. An edge network may run
several at once and they do not share it. It smooths a burst; it is not a quota.

The definition also ships `info_flaresolverr`, which is how it says the site can
answer with a Cloudflare challenge. FlareSolverr drives a real browser to solve
one. There is no browser in a Worker, so `tlChallenged()` detects it and says so
plainly rather than returning an empty list.

Also worth knowing, from the definition: `minimumratio: 1.0` and
`minimumseedtime: 864000` — ten days. This bridge downloads no data, but the
files it hands you are yours to seed.
