/**
 * Tracker bridge — one file, no dependencies, two runtimes.
 *
 * A private tracker is a website with a login, not an API. It answers a search
 * with its own JSON, in its own shape, behind its own session, and it publishes
 * no magnet and no infohash at all — the `.torrent` is behind your passkey, so
 * there is nothing in a search result that identifies the content. No streaming
 * client can read any of that.
 *
 * This translates. Your app asks it for a search, it asks the tracker as you,
 * and it hands back the Torrent Stream Protocol: an ordinary JSON list of
 * names, sizes, seeders, and a `magnet` and an `infohash` on every row.
 *
 *   Run it on your own machine:  node worker.js
 *   Run it at Cloudflare:        wrangler deploy worker.js
 *
 * **What it is for.** Your tracker session opens your whole account: your
 * profile, your passkey, your ratio, your invites. This holds that session
 * server-side and never sends it anywhere but the tracker, so the thing on your
 * phone gets a read-only search URL and a key of its own that you can change
 * without touching the tracker. Nothing else here matters as much as that
 * sentence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. settings   — every environment variable, read once
 *   2. helpers    — text, numbers, infohashes, magnets, bencode, sealed tokens
 *   3. names      — the six fields a release name carries, and its category
 *   4. rows       — merge, filter, sort, and the wire shape
 *   5. trackers   — the registry, TorrentLeech, and your own UTSI
 *   6. routes     — auth, /api/v1/search, /api/v1/torrentfile, /healthz
 *   7. entry      — Cloudflare, Node, and the test seam
 *
 * Sections 2 to 4 are lifted from the Prowlarr bridge and from the Unified
 * Torrent Search Interface unchanged, deliberately: they are what makes a row
 * here and a row there byte-identical, so a client can hold results from all
 * three without seeing two of everything.
 *
 * Section 5 is the only part that knows what a tracker is. It has two entries,
 * TorrentLeech and a Unified Torrent Search Interface of your own — the public
 * indexes, in one list with the tracker, from the one URL and key a client can
 * hold. A third is one more entry in `TRACKERS`, and nothing else changes.
 */

const VERSION = "0.2.0";

// ── the settings the setup page bakes in, and where they come from ──────────
//
// Each is empty in the published file and each is filled in one of two ways:
// an environment variable, which always wins, or these lines, which the setup
// page rewrites in your browser before it hands you a deploy link.
//
// **The published artifact must ship with all of them empty**, and the build
// refuses otherwise. A session committed here by accident would be one person's
// tracker account handed to everybody who ever used the page.

// What a client sends here, as `X-API-Key`. `BRIDGE_API_KEY` wins over it, and
// is how you change this key later without pasting the file again.
const BRIDGE_KEY = "";

// TorrentLeech's session cookie, as the browser holds it: `tluid=…; tlpass=…`.
// `TL_COOKIE` wins over it. This is what a search is made with.
const TL_COOKIE = "";

// TorrentLeech's RSS key, 20 hex characters, from the RSS link on your profile.
// `TL_RSSKEY` wins. This is what a `.torrent` is fetched with, and it is the
// one credential here that does not expire on its own.
const TL_RSSKEY = "";

// Optional, and the only way this keeps working when the cookie lapses: with a
// username and password it can log in again by itself. `TL_USERNAME`,
// `TL_PASSWORD` and `TL_2FA` win over these three.
const TL_USERNAME = "";
const TL_PASSWORD = "";
const TL_2FA = "";

// Optional: a Unified Torrent Search Interface of your own, and its key. With
// both set every search asks it too, and the public indexes land in the same
// list. `UTSI_URL` and `UTSI_API_KEY` win over these. The key is held like the
// rest: here, sent to that one origin, never to a client.
const UTSI_URL = "";
const UTSI_KEY = "";

// Whether to announce over http rather than https. `1` for yes, `0` for no,
// and `BRIDGE_ANNOUNCE_HTTP` wins over it.
//
// Baked in rather than left to the dashboard because the people this page is
// for do not open dashboards, and on the commonest client this is the
// difference between a bridge that works and one that finds nobody at all. The
// setup page asks, ticked, and says what it costs. See the setting itself.
const ANNOUNCE_HTTP = 0;

// How long this bridge should assume it is still being set up, as a millisecond
// timestamp. The setup page writes it at the same moment it writes the values
// above; the committed file ships with 0, which means never.
//
// Inside the window, a browser opening `/` is almost certainly the person who
// deployed it a minute ago with one instruction left, so the page takes them
// back to finish rather than asking them to press a button that does the same.
// Outside it, opening your own bridge months later gets a page that stays put.
//
// No storage and no cookie: the deadline is a constant in the file, so it
// answers the same for every visitor and expires on its own.
const SETUP_UNTIL = 0;

// Where the setup page lives. A deployed bridge knows its own URL and the setup
// page does not, and cannot: Cloudflare invents the account part of the name.
// That is the whole gap this closes. The page served at `/` links back here
// with `#url=<this host>` on the end, and a fragment is the part of a URL a
// browser never sends to a server, so it reaches that page and nowhere else.
const SETUP_PAGE = "https://momzv2022-ctrl.github.io/tracker-bridge/";

// The one origin this bridge answers cross-origin requests from without being
// configured to, so the setup page can run a real search against your bridge
// the moment you deploy it and show you the answer, rather than asking you to
// take "it works" on faith.
//
// Narrow on purpose: an origin is a scheme and a host and nothing else, and a
// `github.io` origin belongs to one account. A caller from it still needs your
// key. BRIDGE_CORS_ORIGINS adds more; nothing removes this one short of
// editing the line.
const SETUP_ORIGIN = new URL(SETUP_PAGE).origin;

// The client's key. Anything shorter is guessable against a URL that answers all
// day, and a bridge is often published on a hostname that exists the moment it
// is made, so this refuses rather than warns.
const MIN_KEY_LENGTH = 16;

// A .torrent is a file fetched to read four fields out of it. Real ones are
// kilobytes; this is the point past which it is not worth knowing.
const TORRENT_MAX_BYTES = 5 * 1024 * 1024;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** The `cat` enum, minus the empty string that means "no filter". */
const CATEGORIES = ["video", "audio", "software", "archive", "document", "image"];

/** The `res` enum. */
const RESOLUTIONS = ["2160p", "1080p", "720p", "480p"];

const SORTS = ["", "seeders", "size", "recent"];

const META_FIELDS = ["year", "resolution", "codec", "source", "season", "episode"];

/**
 * Trackers written into every synthesised magnet.
 *
 * A magnet built from an infohash alone has nowhere to look. These are the same
 * five the sibling projects use, so all three produce identical magnet strings
 * for the same release and a client deduplicates them for free.
 *
 * They are a fallback and almost never used here: a private tracker's torrent
 * sets `private: 1`, and once the `.torrent` has been read its own announce URL
 * is what goes into the magnet instead. See magnetFor().
 */
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.demonii.com:1337/announce",
];

/**
 * A browser's User-Agent, not this program's name.
 *
 * Everywhere else in this project a request says what it is. A private tracker
 * is the exception: it is a website with a login, its front door is behind a
 * bot filter, and a string nobody has ever seen before is the fastest way to be
 * shown a challenge page instead of a search result. `BRIDGE_USER_AGENT` replaces
 * it, and matching the browser you copied the cookie from is the best answer.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const WHERE =
  "Set it in the Cloudflare dashboard under Settings, Variables and Secrets, or in the " +
  "environment of the process, and redeploy.";

// ═══════════════════════════════════════════════════════════════════════════
// 1. SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

function envText(env, name, fallback = "") {
  const value = env && env[name];
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function envInt(env, name, fallback, low, high) {
  const text = envText(env, name, String(fallback));
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  return Math.max(low, Math.min(Number(text), high));
}

function envFlag(env, name, fallback) {
  const raw = envText(env, name, fallback ? "1" : "0").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envList(env, name, fallback = []) {
  const raw = envText(env, name);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** An origin with any trailing path and slash taken off, or "" if unusable. */
function envOrigin(env, name, fallback = "") {
  const raw = envText(env, name, fallback).replace(/\/+$/, "");
  const lower = raw.toLowerCase();
  if (!lower.startsWith("https://") && !lower.startsWith("http://")) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

/**
 * Every setting this file has, read once per request.
 *
 * Two kinds of secret, and keeping them apart is the whole point of the bridge:
 * `BRIDGE_API_KEY` is what a client sends here, and everything under `trackers`
 * is what this sends to a tracker. The second kind never leaves the server.
 */
function readSettings(env) {
  const settings = {
    apiKey: envText(env, "BRIDGE_API_KEY") || String(BRIDGE_KEY || "").trim(),
    allowAnonymous: envFlag(env, "BRIDGE_ALLOW_ANONYMOUS", false),
    // See SETUP_ORIGIN: the setup page can test this bridge, nothing else can.
    corsOrigins: [SETUP_ORIGIN, ...envList(env, "BRIDGE_CORS_ORIGINS")],

    // A tracker search is one request to a website that is often slow and
    // sometimes behind a challenge. This is the ceiling on the whole answer.
    timeoutS: envInt(env, "BRIDGE_TIMEOUT_S", 45, 5, 120),

    // How many rows of a page may be resolved by fetching their `.torrent`.
    //
    // This is not a tuning knob, it is the cost of the whole endeavour. A
    // private tracker publishes no magnet and no infohash — the only way to
    // learn the infohash TSP requires on every row is to read the file — so
    // this is one extra request per row the client can actually see. Rows past
    // it come back counted as `unresolved` rather than silently missing.
    //
    // Twenty, because Cloudflare's free plan allows fifty subrequests per
    // request and one of those is the search itself. Raising it makes a longer
    // page and a heavier search, in that order.
    maxResolve: envInt(env, "BRIDGE_MAX_RESOLVE", 20, 0, 100),

    // How many of those may be in flight at once. A private tracker is a
    // website with a ratio attached to your name, and twelve simultaneous
    // requests is not what a browser looks like. Jackett spaces its own
    // requests 4.1 seconds apart for this tracker; this is the same caution in
    // the shape a Worker can express.
    resolveConcurrency: envInt(env, "BRIDGE_RESOLVE_CONCURRENCY", 3, 1, 12),

    // The smallest gap between two requests to the same tracker, in
    // milliseconds. Best effort: it holds within one isolate and cannot hold
    // across the several an edge network may run at once.
    //
    // **This, not the concurrency above, is the rate limit.** The gap is
    // enforced across every request to one tracker, so 120 ms is eight a
    // second however many are allowed in flight — which is a burst the size of
    // a browser loading a page, for the length of one search, rather than the
    // steady crawl Jackett's 4.1 seconds is pacing. Raise it if you would
    // rather be slower than that.
    requestGapMs: envInt(env, "BRIDGE_REQUEST_GAP_MS", 120, 0, 10000),

    // Keep learned infohashes in Cloudflare's edge cache as well as in
    // memory, so a cold isolate starts warm.
    //
    // Measured on a real deployment: a five-row search costs 7.4s the first
    // time and 0.4s the second, and the whole difference is reading five
    // `.torrent` files. In-memory that saving lasts as long as one isolate,
    // which is not long. This makes it last a week.
    //
    // **What is stored is the file's announce list, and your passkey is in
    // it.** It is the same secret this bridge already writes into every magnet
    // it hands your client, held in a cache scoped to your own Worker — but it
    // is a copy in one more place, so there is a switch for it.
    edgeCache: envFlag(env, "BRIDGE_EDGE_CACHE", true),

    // How long one of those entries lives. An infohash is a hash of the file's
    // own contents and never changes, so this is long by default; it is a
    // ceiling on how stale a size or a file count can be.
    cacheTtlS: envInt(env, "BRIDGE_CACHE_TTL_S", 604800, 60, 2592000),

    // Announce over http rather than https, in the magnet only.
    //
    // **Off, and think before turning it on: your passkey is in that URL and
    // http sends it in the clear**, to every network between the device and the
    // tracker. It is here because some clients cannot make an https announce at
    // all — a libtorrent built without a CA bundle, which is the usual state of
    // affairs on Android, fails every https tracker with "unspecified system
    // error" and finds no peers, while the same announce over http works. When
    // that is the choice, a working private tracker on http may beat a broken
    // one on https; it is not this file's decision to make quietly.
    //
    // TorrentLeech's tracker serves both, and does not redirect http to https,
    // so the rewrite reaches it. Checked 2026-09-01.
    announceHttp: envFlag(env, "BRIDGE_ANNOUNCE_HTTP", ANNOUNCE_HTTP === 1),

    // Whether to advertise `torrent_url` at all.
    //
    // **Off, and that is not the obvious default.** A client reads a promise
    // into the field: a public catalogue's file carries web seeds, so peers
    // are off the critical path, and a client that has it stops reporting a
    // swarm. A private tracker's file has none — checked, on a real one — so
    // it takes only the metadata fetch off the critical path, and a client
    // told "direct source" hides the seeder count on the one kind of row where
    // it matters most. On, a start is quicker and surer; worth having if your
    // client treats the field as what it is.
    torrentUrls: envFlag(env, "BRIDGE_TORRENT_URLS", false),

    // How long a `torrent_url` stays valid. The URL carries a sealed token
    // naming the file to fetch, and the seal expires so a link copied out of a
    // response cannot be replayed indefinitely. Long enough to open a search,
    // read it and press download; short enough not to be a standing grant.
    torrentfileTtlS: envInt(env, "BRIDGE_TORRENTFILE_TTL_S", 3600, 60, 86400),

    // An empty search browses the tracker's front page. Zero switches that off,
    // and then an empty search answers instantly without asking anything, which
    // is the right setting if your client opens on an empty search box.
    browseRows: envInt(env, "BRIDGE_BROWSE_ROWS", 25, 0, 200),

    userAgent: envText(env, "BRIDGE_USER_AGENT", BROWSER_UA),
  };

  // Which trackers are switched on. Empty means every one that is configured.
  // `BRIDGE_TRACKERS=torrentleech` keeps a configured UTSI out of every search
  // without unsetting it, and the same seam is where a third tracker arrives.
  const wanted = envList(env, "BRIDGE_TRACKERS").map((id) => id.toLowerCase());

  settings.trackers = [];
  for (const tracker of Object.values(TRACKERS)) {
    if (wanted.length && !wanted.includes(tracker.id)) continue;
    const configured = tracker.read(env, settings);
    // Settings and behaviour, in one object: everything downstream is handed a
    // tracker and calls it, rather than looking the adapter up again by id.
    if (configured) {
      settings.trackers.push({
        ...configured,
        search: tracker.search,
        probe: tracker.probe,
        fileRequest: tracker.fileRequest,
      });
    }
  }
  settings.selected = wanted;
  return settings;
}

/** Why the key is unusable, or "" when it is fine. */
function keyProblem(settings) {
  if (settings.allowAnonymous) return "";
  if (!settings.apiKey) return "missing";
  return settings.apiKey.length < MIN_KEY_LENGTH ? "short" : "";
}

function isConfigured(settings) {
  return !keyProblem(settings);
}

/** Why no tracker can be searched, or "" when at least one can. */
function upstreamProblem(settings) {
  if (!settings.trackers.length) return "no_tracker";
  return settings.trackers.some((tracker) => !tracker.problem) ? "" : "tracker_unconfigured";
}
// ═══════════════════════════════════════════════════════════════════════════
// 2. HELPERS
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything from here to the end of section 4 is a copy of the corresponding
// code in the Unified Torrent Search Interface Worker, and the few additions
// say so where they are. It is what makes a row produced here and a row
// produced there the same bytes, down to the percent-encoding in the magnet.

function quote(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function quotePlus(text) {
  return quote(text).replace(/%20/g, "+");
}

/** `{a: "1", b: "x y"}` into `a=1&b=x+y`, in insertion order. */
function urlencode(params) {
  return Object.entries(params)
    .map(([key, value]) => quotePlus(key) + "=" + quotePlus(value))
    .join("&");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

function htmlUnescape(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    const named = ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    }
    return whole;
  });
}

/** A release name as a client should see it. */
function cleanName(value) {
  return htmlUnescape(String(value ?? "")).trim();
}

/**
 * A whole number, or null.
 *
 * Anything that is not a plain non-negative integer is "no value", not zero: a
 * missing seeder count and a count of nought are different facts, and the wire
 * format omits the first rather than lying with the second.
 */
function intOrNone(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return number;
}

/**
 * The same, but zero also means "no value".
 *
 * A tracker sends `size: 0` and `numfiles: 0` for a row it did not measure,
 * rather than omitting the field, so here a nought really is an absence.
 * Seeders and leechers are genuinely nullable, so they keep intOrNone and a
 * real zero-seeder row still reports zero.
 */
function positiveOrNone(value) {
  const number = intOrNone(value);
  return number ? number : null;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A tracker's publish date as `2019-01-01T00:00:00Z`, or null.
 *
 * Trackers write whatever their database hands them: ISO 8601 with an offset, a
 * bare `yyyy-MM-dd HH:mm:ss`, a unix stamp. Round-tripping through Date
 * normalises all of it, so the field matches what the sibling projects emit for
 * the same release.
 */
function isoStamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms) || ms < 0 || ms > 253402300799000) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- infohashes and magnets --------------------------------------------------

const HEX40 = /^[0-9a-fA-F]{40}$/;
const BASE32_32 = /^[A-Za-z2-7]{32}$/;
const BTIH = /urn:btih:([0-9A-Za-z]{32,40})/i;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * A lowercase 40-character hex infohash, or null.
 *
 * Accepts hex and base32, the two encodings BEP-9 magnets use in the wild.
 */
function normalizeInfohash(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (HEX40.test(value)) return value.toLowerCase();
  if (!BASE32_32.test(value)) return null;

  let bits = 0;
  let accumulator = 0;
  let hex = "";
  for (const character of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return null;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((accumulator >> bits) & 0xff).toString(16).padStart(2, "0");
      accumulator &= (1 << bits) - 1;
    }
  }
  return hex.length === 40 ? hex : null;
}

function infohashFromMagnet(magnet) {
  if (!magnet) return null;
  const match = BTIH.exec(magnet);
  return match ? normalizeInfohash(match[1]) : null;
}

/** The tracker tail never changes, so it is encoded once rather than per row. */
const TRACKER_SUFFIX = DEFAULT_TRACKERS.map((tracker) => "&tr=" + quote(tracker)).join("");

function magnetFor(infohash, name, trackers = null) {
  // A private torrent announces to one tracker and one only — `private: 1` turns
  // off DHT and PEX, so the public suffix below is not merely useless there, it
  // is the whole reason a magnet built from it would never find a peer. When the
  // `.torrent` has been read, its own announce list is what goes in.
  //
  // `null` means "this row does not know its own trackers", and gets the public
  // five. An **array** — including an empty one — means "use exactly these",
  // which is how a private torrent says it has its own tracker and no business
  // announcing anywhere else. Announcing a private tracker's infohash to a
  // public tracker publishes its swarm, and is the sort of thing accounts are
  // closed over. The sibling projects only ever pass null or a non-empty list,
  // so this branch is dead there and the three still agree row for row.
  const suffix = trackers === null
    ? TRACKER_SUFFIX
    : trackers.map((tracker) => "&tr=" + quote(tracker)).join("");
  if (name) return `magnet:?xt=urn:btih:${infohash}&dn=${quote(name)}${suffix}`;
  return `magnet:?xt=urn:btih:${infohash}${suffix}`;
}

// --- bencode ---------------------------------------------------------------
//
// Just enough to read a `.torrent`, for the case that needs it: a private
// tracker, which publishes neither a magnet nor an infohash because the file
// itself is behind the passkey. Reading the file is the only way to learn what
// TSP requires on every row, so here — unlike in the sibling projects, where it
// is a fallback — this is the main path. Off when BRIDGE_MAX_RESOLVE is 0.
//
// This is the sibling Worker's decoder, unchanged except for the two fields a
// private torrent needs and a public one does not: the announce list and the
// `private` flag.

function bdecode(data, index, depth = 0) {
  if (depth > 32) throw new Error("nesting too deep");
  if (index >= data.length) throw new Error("truncated");
  const marker = data[index];

  if (marker === 0x69) {
    // "i" — an integer, terminated by "e"
    const end = data.indexOf(0x65, index);
    if (end === -1) throw new Error("unterminated integer");
    return [Number(latin1(data, index + 1, end)), end + 1];
  }
  if (marker === 0x6c) {
    // "l" — a list
    const items = [];
    index += 1;
    while (data[index] !== 0x65) {
      const [value, next] = bdecode(data, index, depth + 1);
      items.push(value);
      index = next;
    }
    return [items, index + 1];
  }
  if (marker === 0x64) {
    // "d" — a dictionary, keys are byte strings
    const mapping = new Map();
    index += 1;
    while (data[index] !== 0x65) {
      const [key, afterKey] = bdecode(data, index, depth + 1);
      const [value, afterValue] = bdecode(data, afterKey, depth + 1);
      if (key instanceof Uint8Array) mapping.set(latin1(key, 0, key.length), value);
      index = afterValue;
    }
    return [mapping, index + 1];
  }
  if (marker >= 0x30 && marker <= 0x39) {
    // a byte string, "<length>:<bytes>"
    const colon = data.indexOf(0x3a, index);
    if (colon === -1) throw new Error("unterminated string");
    const length = Number(latin1(data, index, colon));
    const start = colon + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > data.length) {
      throw new Error("bad string length");
    }
    return [data.subarray(start, end), end];
  }
  throw new Error(`unexpected byte ${marker} at ${index}`);
}

function latin1(bytes, start, end) {
  let out = "";
  for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

function utf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Every announce URL in the file, `announce-list` first, deduplicated. */
function trackersFrom(root) {
  const found = [];
  const add = (value) => {
    if (!(value instanceof Uint8Array)) return;
    const url = utf8(value).trim();
    // http, https and udp only. A `.torrent` is a file from a stranger, and the
    // announce list is the part of it that ends up somewhere else entirely.
    if (/^(?:https?|udp):\/\/[^\s]+$/i.test(url) && !found.includes(url)) found.push(url);
  };
  const tiers = root.get("announce-list");
  if (Array.isArray(tiers)) for (const tier of tiers) if (Array.isArray(tier)) tier.forEach(add);
  add(root.get("announce"));
  return found.slice(0, 12);
}

/**
 * Read a `.torrent`: v1 infohash, display name, total size, file count, the
 * announce list, and whether it is a private torrent.
 *
 * The infohash is `sha1(bencode(info dict))`, taken over the *original* bytes of
 * the info dict rather than a re-encoding, so a file that round-trips
 * imperfectly still hashes correctly.
 */
async function parseTorrent(data) {
  if (!data.length || data[0] !== 0x64) return null;

  let index = 1;
  let infoSpan = null;
  const root = new Map();
  try {
    while (data[index] !== 0x65) {
      const [key, afterKey] = bdecode(data, index);
      const start = afterKey;
      const [value, afterValue] = bdecode(data, afterKey);
      if (key instanceof Uint8Array) {
        const name = latin1(key, 0, key.length);
        root.set(name, value);
        if (name === "info") infoSpan = [start, afterValue];
      }
      index = afterValue;
    }
  } catch {
    return null;
  }

  const info = root.get("info");
  if (!infoSpan || !(info instanceof Map)) return null;

  const digest = await crypto.subtle.digest("SHA-1", data.subarray(infoSpan[0], infoSpan[1]));
  const infohash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  let size = null;
  let files = null;
  const length = info.get("length");
  if (typeof length === "number") {
    size = length;
    files = 1;
  } else {
    const entries = info.get("files");
    if (Array.isArray(entries)) {
      const sizes = entries
        .filter((entry) => entry instanceof Map && typeof entry.get("length") === "number")
        .map((entry) => entry.get("length"));
      if (sizes.length) {
        size = sizes.reduce((total, one) => total + one, 0);
        files = entries.length;
      }
    }
  }

  const name = info.get("name");
  return {
    infohash,
    name: name instanceof Uint8Array ? utf8(name) : null,
    sizeBytes: size,
    files,
    trackers: trackersFrom(root),
    private: info.get("private") === 1,
  };
}

// --- sealed tokens -----------------------------------------------------------
//
// A `torrent_url` has to name the file it will fetch, and this bridge exists in
// part to keep your tracker session off the phone — so the name is sealed rather
// than signed. AES-GCM, keyed by SHA-256 of the bridge's own key: the client
// gets an opaque string it cannot read, and the seal is authenticated, so a
// token that decrypts at all is one this bridge minted. Nothing is stored; a
// Worker has nowhere to store it and no need to.

const SEAL_CACHE = new Map();

async function sealKey(settings) {
  const secret = settings.apiKey;
  if (!secret) return null;
  let key = SEAL_CACHE.get(secret);
  if (!key) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
    // One entry: the key does not change inside an isolate, and an unbounded
    // map keyed by a secret is a leak waiting for a reason.
    SEAL_CACHE.clear();
    SEAL_CACHE.set(secret, key);
  }
  return key;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function unbase64url(text) {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Seal *payload* into a URL-safe token, or null when there is no key to seal with. */
async function seal(settings, payload) {
  const key = await sealKey(settings);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return base64url(out);
}

/** The payload back, or null if the token is not one of ours or has expired. */
async function unseal(settings, token) {
  const key = await sealKey(settings);
  if (!key || !token || token.length > 4096) return null;
  let payload;
  try {
    const raw = unbase64url(token);
    if (raw.length <= 12) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12) }, key, raw.subarray(12),
    );
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    // Forged, truncated, or minted under a key that has since been rotated.
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.e !== "number") return null;
  return payload.e < Date.now() ? null : payload;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. NAMES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A word character, as a regular expression sees it *in Python*: letters,
 * numbers and underscore from every script, not just ASCII.
 *
 * JavaScript's own `\b` stops at ASCII, so `\bx264\b` would match inside a
 * Japanese title where Python's would not. Every pattern below is written with
 * `\b` and compiled through `pattern()`, which expands it into a boundary that
 * behaves the same way — so this file, the sibling Worker and its Python server
 * all classify a given name identically.
 */
const WORD = "[\\p{L}\\p{N}_]";
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

function pattern(source, flags = "") {
  return new RegExp(source.split("\\b").join(BOUNDARY), flags + "u");
}

/** Separator characters the query rules call out, plus scene bracketing. */
const SEPARATORS = /[._\-+()[\]{},]+/gu;

const RESOLUTION_PATTERNS = [
  ["2160p", pattern("\\b(2160p|4k|uhd|3840\\s?x\\s?2160)\\b", "i")],
  ["1080p", pattern("\\b(1080[pi]|fhd|1920\\s?x\\s?1080)\\b", "i")],
  ["720p", pattern("\\b(720p|hd\\s?ready|1280\\s?x\\s?720)\\b", "i")],
  ["480p", pattern("\\b(480[pi]|sd|640\\s?x\\s?480|854\\s?x\\s?480)\\b", "i")],
];

const CODEC_PATTERNS = [
  ["x265", pattern("\\b(x265|h\\s?265|hevc)\\b", "i")],
  ["x264", pattern("\\b(x264|h\\s?264|avc)\\b", "i")],
  ["av1", pattern("\\bav1\\b", "i")],
  ["vp9", pattern("\\bvp9\\b", "i")],
  ["xvid", pattern("\\bxvid\\b", "i")],
  ["divx", pattern("\\bdivx\\b", "i")],
  ["mpeg2", pattern("\\b(mpeg\\s?2|mpeg2video)\\b", "i")],
];

// Longest/most specific first: "bdremux" must win over "bdrip", "web-dl" over
// "web".
const SOURCE_PATTERNS = [
  ["remux", pattern("\\b(remux|bd\\s?remux|bdmux)\\b", "i")],
  ["bluray", pattern("\\b(blu\\s?ray|bluray|bd\\s?rip|bdrip|br\\s?rip|brrip|bd\\s?25|bd\\s?50)\\b", "i")],
  ["web-dl", pattern("\\b(web\\s?dl|webdl)\\b", "i")],
  ["webrip", pattern("\\b(web\\s?rip|webrip|web)\\b", "i")],
  ["hdtv", pattern("\\b(hd\\s?tv|hdtv|pdtv|dsr)\\b", "i")],
  ["dvd", pattern("\\b(dvd\\s?rip|dvdrip|dvd\\s?r|dvd5|dvd9|dvd)\\b", "i")],
  ["hdrip", pattern("\\b(hd\\s?rip|hdrip)\\b", "i")],
  ["screener", pattern("\\b(dvd\\s?scr|screener|scr)\\b", "i")],
  ["telesync", pattern("\\b(telesync|hd\\s?ts|ts)\\b", "i")],
  ["cam", pattern("\\b(cam\\s?rip|camrip|hd\\s?cam|cam)\\b", "i")],
];

const YEAR = pattern("\\b(19[0-9]{2}|20[0-9]{2})\\b", "g");

const SEASON_EPISODE = pattern("\\bs\\s?(\\d{1,2})\\s?e\\s?(\\d{1,3})(?:\\s?-\\s?e?\\d{1,3})?\\b", "i");
const SEASON_X_EPISODE = pattern("\\b(\\d{1,2})x(\\d{2,3})\\b");
const SEASON_ONLY = pattern("\\b(?:season|series)\\s?(\\d{1,2})\\b|\\bs\\s?(\\d{1,2})\\b(?!\\s?e\\d)", "i");
const EPISODE_ONLY = pattern("\\b(?:episode|ep)\\s?(\\d{1,3})\\b", "i");

/**
 * A year is only a *release* year if it precedes one of these markers; that is
 * what separates `2012.2009.1080p` (a film called "2012", released 2009) from a
 * title that merely contains a number.
 */
const QUALITY_MARKER = pattern(
  "\\b(2160p|1080[pi]|720p|480[pi]|4k|uhd|x26[45]|h\\s?26[45]|hevc|avc|xvid|divx|av1" +
    "|blu\\s?ray|bluray|bd\\s?rip|bdrip|br\\s?rip|web\\s?dl|webdl|web\\s?rip|webrip|hd\\s?tv|hdtv" +
    "|dvd\\s?rip|dvdrip|remux|complete|multi|proper|repack|extended|unrated|imax)\\b",
  "i",
);

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Turn scene punctuation into spaces so the word boundaries behave. */
function normalizeSeparators(name) {
  return name.replace(SEPARATORS, " ");
}

/**
 * The canonical token whose pattern matches earliest in *text*.
 *
 * Scanning by position rather than by rule order keeps `WEB-DL` from losing to a
 * stray `TS` later in the name, while the ordering within equal positions still
 * favours the more specific rule.
 */
function firstMatch(text, patterns) {
  let bestAt = -1;
  let bestToken = "";
  for (const [token, regexp] of patterns) {
    const match = regexp.exec(text);
    if (match && (bestAt === -1 || match.index < bestAt)) {
      bestAt = match.index;
      bestToken = token;
    }
  }
  return bestToken;
}

function pickYear(text) {
  const horizon = new Date().getUTCFullYear() + 1;
  const plausible = [];
  YEAR.lastIndex = 0;
  let match;
  while ((match = YEAR.exec(text))) {
    const value = Number(match[1]);
    if (value >= 1900 && value <= horizon) {
      plausible.push({ value: match[1], start: match.index, end: match.index + match[1].length });
    }
  }
  if (!plausible.length) return "";
  if (plausible.length === 1) return plausible[0].value;

  const marker = QUALITY_MARKER.exec(text);
  if (marker) {
    const before = plausible.filter((candidate) => candidate.end <= marker.index);
    if (before.length) return before[before.length - 1].value;
  }
  return plausible[plausible.length - 1].value;
}

function pickSeasonEpisode(text) {
  const paired = SEASON_EPISODE.exec(text) || SEASON_X_EPISODE.exec(text);
  if (paired) return [pad2(Number(paired[1])), pad2(Number(paired[2]))];

  let season = "";
  const seasonMatch = SEASON_ONLY.exec(text);
  if (seasonMatch) {
    const raw = seasonMatch[1] || seasonMatch[2];
    if (raw) season = pad2(Number(raw));
  }

  let episode = "";
  const episodeMatch = EPISODE_ONLY.exec(text);
  if (episodeMatch) episode = pad2(Number(episodeMatch[1]));

  return [season, episode];
}

/** The six metadata fields a release name can carry. Absent ones omitted. */
function parseName(name) {
  if (!name) return {};
  const text = normalizeSeparators(name);
  const [season, episode] = pickSeasonEpisode(text);
  const found = {
    year: pickYear(text),
    resolution: firstMatch(text, RESOLUTION_PATTERNS),
    codec: firstMatch(text, CODEC_PATTERNS),
    source: firstMatch(text, SOURCE_PATTERNS),
    season,
    episode,
  };
  const meta = {};
  for (const field of META_FIELDS) if (found[field]) meta[field] = found[field];
  return meta;
}

/**
 * The query rules: `.`, `_` and `-` are separators.
 *
 * Word order is irrelevant, so this only collapses separators and whitespace;
 * The tracker decides how to match the terms.
 */
function normalizeQuery(query) {
  return normalizeSeparators(query).split(/\s+/u).filter(Boolean).join(" ");
}

// --- categories --------------------------------------------------------------

const EXTENSION = /\.([a-z0-9]{2,5})$/iu;

const EXTENSION_CATEGORY = {
  mkv: "video", mp4: "video", avi: "video", mov: "video", m4v: "video",
  wmv: "video", mpg: "video", mpeg: "video", flv: "video", webm: "video",
  mp3: "audio", flac: "audio", wav: "audio", aac: "audio", ogg: "audio",
  m4a: "audio", opus: "audio", alac: "audio", wma: "audio", ape: "audio",
  pdf: "document", epub: "document", mobi: "document", azw3: "document",
  djvu: "document", cbr: "document", cbz: "document", chm: "document",
  jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image",
  tiff: "image", webp: "image", psd: "image", svg: "image",
  exe: "software", msi: "software", dmg: "software", apk: "software",
  deb: "software", rpm: "software", pkg: "software", appimage: "software",
  rar: "archive", zip: "archive", "7z": "archive", tar: "archive",
  gz: "archive", bz2: "archive", xz: "archive", tgz: "archive",
};

/**
 * Ordered rules: the first family with a hit wins. Video markers come first
 * because scene video names are the most distinctive, and because a game or an
 * application essentially never carries a resolution or an SxxEyy tag.
 */
const CLASSIFY_RULES = [
  [
    "video",
    pattern(
      "\\b(" +
        "2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|dolby[. _-]?vision" +
        "|x26[45]|h[. _-]?26[45]|hevc|avc|xvid|divx|av1" +
        "|blu[. _-]?ray|bd(?:rip|remux|mux)|br[. _-]?rip|web[. _-]?(?:dl|rip)" +
        "|hd(?:tv|rip|cam)|dvd(?:rip|scr|r)?|remux|telesync|cam[. _-]?rip" +
        "|s\\d{1,2}[. _-]?e\\d{1,3}|\\d{1,2}x\\d{2}|season[. _-]?\\d{1,2}" +
        "|complete[. _-]series|episode[. _-]?\\d{1,3}" +
        "|dts(?:[. _-]?hd)?|ddp?\\d[. _-]?\\d|aac\\d[. _-]?\\d|truehd|atmos" +
        ")\\b",
      "i",
    ),
  ],
  [
    "audio",
    pattern(
      "\\b(" +
        "flac|mp3|aac|alac|ogg|opus|wav|ape|dsd" +
        "|\\d{2,3}\\s?kbps|v0|v2|cbr|vbr" +
        "|discography|anthology|album|ep|single|soundtrack|ost|bootleg" +
        "|audiobook|audio[. _-]?book|vinyl|cd[. _-]?(?:rip|q|da)|web[. _-]?flac" +
        ")\\b",
      "i",
    ),
  ],
  [
    "software",
    pattern(
      "\\b(" +
        "x64|x86|win(?:32|64|dows)?|macos|osx|linux|ubuntu|debian|fedora|arch" +
        "|v\\d+(?:\\.\\d+)+|build[. _-]?\\d+|portable|multilingual|activated" +
        "|crack(?:ed|fix)?|keygen|patch|repack|pre[. _-]?activated|iso" +
        "|fitgirl|dodi|codex|plaza|skidrow|reloaded|empress|razor1911|tenoke" +
        "|gog|steam|denuvo|update[. _-]?only|dlc" +
        ")\\b",
      "i",
    ),
  ],
  [
    "document",
    pattern(
      "\\b(" +
        "ebook|e[. _-]?book|epub|pdf|mobi|azw3|retail|magazine|comics?|manga" +
        "|\\d(?:st|nd|rd|th)[. _-]?edition|textbook|novel|paperback" +
        ")\\b",
      "i",
    ),
  ],
  [
    "image",
    pattern(
      "\\b(wallpapers?|imageset|image[. _-]?pack|photos?|pics|pictures|artwork" +
        "|hi[. _-]?res[. _-]?scans)\\b",
      "i",
    ),
  ],
  ["archive", pattern("\\b(rar|zip|7z|tar|tgz|gz|bz2|xz)\\b", "i")],
];

/**
 * Best-effort category for a release name, or null if unreadable.
 *
 * Null means "no idea", which is not the same as "no". Every rule here keys off
 * a technical marker — a resolution, a codec, a format — and a great many real
 * releases carry none. Callers filtering by category must keep those, because
 * dropping them makes a filter delete correct answers rather than narrow them.
 */
function classifyName(name) {
  if (!name) return null;
  const extension = EXTENSION.exec(name.trim());
  if (extension) {
    const category = EXTENSION_CATEGORY[extension[1].toLowerCase()];
    if (category) return category;
  }
  for (const [category, regexp] of CLASSIFY_RULES) {
    if (regexp.test(name)) return category;
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// 4. ROWS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The key a row deduplicates on: its infohash, or failing that its name and
 * size. The `h:`/`n:` prefix is also the sort's final tie-break, which is what
 * makes paging stable across requests.
 */
function dedupeKey(row) {
  if (row.infohash) return `h:${row.infohash}`;
  // A tracker that lists one file twice gives both listings the same filename
  // and the same size, and two different titles. Without this they collapse
  // only once their `.torrent` has been read, which would make the answer
  // depend on how far the client had paged. Section 5 sets it; the sibling
  // projects have no equivalent and never set it, so this branch is dead there
  // and the two files still agree row for row.
  if (row.dupeKey) return `d:${row.dupeKey}`;
  const slug = [...row.name.toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");
  return `n:${slug}:${row.sizeBytes === null ? "?" : row.sizeBytes}`;
}

function maxOrNull(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/**
 * Collapse duplicates, keeping the best of each field.
 *
 * Two trackers carrying the same release is the normal case once there is more
 * than one, and without this the client sees the same film twice. The longest
 * name wins
 * because it is the most descriptive release string, swarm counts are `max`-ed
 * because a stale indexer under-reports, and every contributing indexer is
 * recorded in `sources`.
 */
function merge(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = dedupeKey(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, row);
      continue;
    }
    if (row.name.length > existing.name.length) existing.name = row.name;
    existing.seeders = maxOrNull(existing.seeders, row.seeders);
    existing.leechers = maxOrNull(existing.leechers, row.leechers);
    if (existing.sizeBytes === null) existing.sizeBytes = row.sizeBytes;
    if (existing.files === null) existing.files = row.files;
    existing.category = existing.category || row.category;
    existing.descriptionUrl = existing.descriptionUrl || row.descriptionUrl;
    existing.torrentUrl = existing.torrentUrl || row.torrentUrl;
    existing.infohash = existing.infohash || row.infohash;
    existing.sources = existing.sources.concat(row.sources);
    if (row.firstSeen && (existing.firstSeen === null || row.firstSeen < existing.firstSeen)) {
      existing.firstSeen = row.firstSeen;
    }
    // The copy whose `.torrent` was read knows where the swarm is: one infohash
    // is one info dict, `private` flag included, so a private release on a
    // public index too is a private swarm from either side. Its announce, URL
    // and tracker move over. Only section 5 sets `trackers`.
    if (Array.isArray(row.trackers) && !Array.isArray(existing.trackers)) {
      existing.trackers = row.trackers;
      existing.magnet = row.magnet;
      existing.private = row.private;
      existing.downloadUrl = row.downloadUrl;
      existing.torrentUrl = null;
      existing.indexer = row.indexer;
    }
  }
  return [...merged.values()];
}

/** The parsed name for *row*, computed at most once. */
function parsedMeta(row) {
  if (row.meta === null) row.meta = parseName(row.name);
  return row.meta;
}

/**
 * Every spelling the name parser normalises to a given `res` token. Keep in step
 * with RESOLUTION_PATTERNS; the tests prove they agree.
 */
const RESOLUTION_SPELLINGS = {
  "2160p": ["2160p", "4k", "uhd", "3840"],
  "1080p": ["1080p", "1080i", "fhd", "1920"],
  "720p": ["720p", "hdready", "hd ready", "1280"],
  "480p": ["480p", "480i", "sd", "640x480", "854x480"],
};

/**
 * The query filters a tracker's own search cannot apply, cheapest test first.
 *
 * A tracker search takes a query, some categories and a sort order, and nothing
 * else: no year, no resolution, no seeder floor. So those three are applied
 * here, over the merged set, which is also the only place they could be applied
 * correctly — a seeder floor per tracker would throw away the row a second
 * tracker was about to report better numbers for.
 */
function applyFilters(rows, { category = "", year = "", resolution = "", minSeeders = 0 } = {}) {
  const resTokens = resolution ? RESOLUTION_SPELLINGS[resolution] || [resolution] : [];
  const kept = [];
  for (const row of rows) {
    if (minSeeders && (row.seeders || 0) < minSeeders) continue;
    if (category) {
      // Only a category we can read and that disagrees is grounds to drop. An
      // unreadable name means "no idea", and treating that as "not video" makes
      // the video filter hide rows the unfiltered search had just shown.
      const found = row.category || classifyName(row.name);
      if (found && found !== category) continue;
    }
    if (year && (!row.name.includes(year) || parsedMeta(row).year !== year)) continue;
    if (resTokens.length) {
      const lowered = row.name.toLowerCase();
      if (!resTokens.some((token) => lowered.includes(token))) continue;
      if (parsedMeta(row).resolution !== resolution) continue;
    }
    kept.push(row);
  }
  return kept;
}

/** Order by *sort*, descending, with a total tie-break for stable paging. */
function sortRows(rows, sort) {
  const decorated = rows.map((row) => {
    const key = dedupeKey(row);
    if (sort === "size") return { row, primary: [row.sizeBytes || 0, row.seeders || 0], key };
    if (sort === "recent") return { row, primary: [row.firstSeen || "", row.seeders || 0], key };
    return { row, primary: [row.seeders || 0, row.sizeBytes || 0], key };
  });

  decorated.sort((left, right) => {
    for (let index = 0; index < left.primary.length; index += 1) {
      const a = left.primary[index];
      const b = right.primary[index];
      if (a !== b) return a < b ? 1 : -1; // descending
    }
    if (left.key !== right.key) return left.key < right.key ? 1 : -1;
    return 0;
  });

  return decorated.map((entry) => entry.row);
}

/**
 * The wire row, or null when it has no magnet to offer.
 *
 * Absent fields are omitted rather than sent as null: a client reads an absent
 * numeric as zero, and this is the shape the sibling project emits.
 *
 * **A tracker's `torrent_url` points back here**, never at the tracker: TSP
 * sends a key only to the index's own origin, so a tracker URL would arrive
 * unusable *and* carry your passkey to the phone. It names this bridge and a
 * sealed token only this bridge can read, and `/api/v1/torrentfile/` opens it.
 */
async function toTorrent(row, scrapedAt, settings = null, origin = "") {
  if (!row.infohash) return null;

  const torrent = {
    magnet: row.magnet || magnetFor(row.infohash, row.name, row.trackers),
    infohash: row.infohash,
    name: row.name,
  };
  if (settings && settings.torrentUrls) {
    if (row.torrentUrl) {
      // A public host's file needs nothing to fetch, and is passed through.
      torrent.torrent_url = row.torrentUrl;
    } else if (origin && row.downloadUrl && settings.maxResolve) {
      const token = await seal(settings, {
        u: row.downloadUrl,
        e: Date.now() + settings.torrentfileTtlS * 1000,
      });
      if (token) torrent.torrent_url = `${origin}/api/v1/torrentfile/${row.infohash}?t=${token}`;
    }
  }
  if (row.sizeBytes !== null) torrent.size_bytes = row.sizeBytes;
  if (row.files !== null) torrent.files = row.files;
  const category = row.category || classifyName(row.name);
  if (category) torrent.category = category;
  if (row.seeders !== null) torrent.seeders = row.seeders;
  if (row.leechers !== null) torrent.leechers = row.leechers;
  Object.assign(torrent, parsedMeta(row));
  if (row.firstSeen) torrent.first_seen = row.firstSeen;
  torrent.scraped_at = scrapedAt;
  if (row.descriptionUrl) torrent.description_url = row.descriptionUrl;
  if (row.sources.length) torrent.sources = [...new Set(row.sources)].sort();
  // Two more the contract does not name, for a client holding private and
  // public rows in one list: the file's own flag, and who had it.
  if (row.private) torrent.private = true;
  if (row.indexer) torrent.indexer = row.indexer;
  return torrent;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. TRACKERS
// ═══════════════════════════════════════════════════════════════════════════
//
// The only section that knows what a tracker is. Everything above it works on
// rows and everything below it works on routes, so a second tracker is one more
// entry in `TRACKERS` and no change anywhere else.
//
// An entry is an object with:
//
//   id, label         what it is called, in a setting and on a screen
//   read(env)         its settings, or null when it is not configured at all,
//                     with `auth` and `torrentfile` in its own words for /healthz
//   search(...)       a query in, rows out
//   probe(...)        a live answer for /healthz?probe=1
//   fileRequest(...)  a row's `.torrent` URL in, the headers to fetch it with out

/** Something went wrong upstream. *status* is what the client should be told. */
class BridgeError extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The smallest gap between two requests to one host, held per isolate.
 *
 * A private tracker is a website with your ratio attached to your name, and the
 * fastest way to be rate-limited — or noticed — is to look like a crawler.
 * Jackett spaces its requests to this tracker 4.1 seconds apart; a Worker
 * cannot afford that inside one search and does not need to, because it makes a
 * handful of requests rather than polling all day. This is the same caution in
 * the shape this runtime can express.
 *
 * **Best effort, and it says so.** An edge network may run several isolates at
 * once and they do not share this map. It smooths a burst; it is not a quota.
 */
const LAST_REQUEST = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spaced(host, gapMs) {
  if (!gapMs) return;
  const previous = LAST_REQUEST.get(host) || 0;
  const wait = previous + gapMs - Date.now();
  // Claim the slot before waiting, so two callers queue behind each other
  // rather than both reading the same stale timestamp and going together.
  LAST_REQUEST.set(host, Math.max(Date.now(), previous + gapMs));
  if (wait > 0) await sleep(wait);
}

/**
 * Infohashes already learned, keyed by tracker and row id.
 *
 * Reading a `.torrent` is the expensive half of every search here, and the
 * answer never changes: a torrent's infohash is a hash of its own contents. So
 * the second search that turns up the same row costs nothing, and paging back
 * to page one is free.
 *
 * In memory, in one isolate, and deliberately not in KV or a Durable Object:
 * this project has no storage, no binding to configure and nothing to bill, and
 * an empty cache is only ever slower rather than wrong. Bounded, because an
 * isolate that lived for a week should not grow for a week.
 */
const RESOLVED = new Map();
const RESOLVED_MAX = 2000;

function remember(key, meta) {
  if (RESOLVED.size >= RESOLVED_MAX) {
    // Oldest first: a Map iterates in insertion order.
    for (const stale of RESOLVED.keys()) {
      RESOLVED.delete(stale);
      if (RESOLVED.size < RESOLVED_MAX) break;
    }
  }
  RESOLVED.set(key, meta);
}

/**
 * The same thing again, in Cloudflare's edge cache.
 *
 * RESOLVED above dies with its isolate, which is the difference between a
 * search that takes 0.4 seconds and one that takes 7. This survives that, needs
 * no binding to configure and nothing to bill, and is absent under Node — where
 * there is one long-lived process and RESOLVED is enough on its own.
 *
 * Failure is always "not cached": every call is wrapped, because a cache that
 * throws must cost a request rather than an answer.
 */
const CACHE_ROOT = "https://tracker-bridge.invalid/meta/";

function edgeStore(settings) {
  if (!settings.edgeCache) return null;
  return typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
}

async function cachedMeta(key, settings) {
  const store = edgeStore(settings);
  if (!store || !key) return null;
  try {
    const hit = await store.match(new Request(CACHE_ROOT + encodeURIComponent(key)));
    if (!hit) return null;
    const meta = await hit.json();
    return meta && typeof meta.infohash === "string" ? meta : null;
  } catch {
    return null;
  }
}

async function rememberEdge(key, meta, settings) {
  const store = edgeStore(settings);
  if (!store || !key) return;
  try {
    await store.put(
      new Request(CACHE_ROOT + encodeURIComponent(key)),
      new Response(JSON.stringify(meta), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${settings.cacheTtlS}`,
        },
      }),
    );
  } catch {
    // A cache that will not take a write is a cache that will not be read.
  }
}

/**
 * Sessions this isolate has logged in for, keyed by tracker.
 *
 * Same reasoning as the cache above, and the same caveat: a cold isolate logs
 * in again. That is one extra request at the front of one search, and it is why
 * a cookie is the better setting when you have one — with a cookie there is no
 * login at all.
 */
const SESSIONS = new Map();

// --- cookies -----------------------------------------------------------------

/** `Set-Cookie` lines into `{name: value}`, ignoring the attributes. */
function cookiesFrom(lines) {
  const jar = {};
  for (const line of lines || []) {
    const pair = String(line).split(";", 1)[0];
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    // A cookie being deleted arrives as an empty value. Honour that rather than
    // carrying a blank one forward and wondering why the session is refused.
    if (name) jar[name] = value;
  }
  return jar;
}

/** `{name: value}` into a `Cookie` header, or "". */
function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** A `Cookie` header, however it was typed, into `{name: value}`. */
function parseCookie(text) {
  const jar = {};
  for (const part of String(text || "").split(/[;\n]/u)) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

// --- TorrentLeech ------------------------------------------------------------

const TL_HOST = "https://www.torrentleech.org";

/**
 * TorrentLeech's own numeric categories, mapped onto the six TSP speaks.
 *
 * Copied from the indexer definition Jackett and Prowlarr both ship
 * (`torrentleech.yml`), which is the only written-down list of these ids there
 * is. Ids absent here — 38, Education — are ones whose own name does not decide
 * the question, and an absent mapping sends the row to classifyName rather than
 * asserting something false about it.
 */
const TL_CATEGORY = {
  8: "video",     // Movies Cam
  9: "video",     // Movies TS/TC
  11: "video",    // Movies DVDRip/DVDScreener
  12: "video",    // Movies DVD-R
  13: "video",    // Movies Bluray
  14: "video",    // Movies BlurayRip
  15: "video",    // Movies Boxsets
  16: "video",    // Music videos — a video file, whatever it is of
  17: "software", // Games PC
  18: "software", // Games XBOX
  19: "software", // Games XBOX360
  20: "software", // Games PS2
  21: "software", // Games PS3
  22: "software", // Games PSP
  23: "software", // PC ISO
  24: "software", // PC Mac
  25: "software", // PC Mobile
  26: "video",    // TV Episodes
  27: "video",    // TV Boxsets
  28: "software", // Games Wii
  29: "video",    // Documentaries
  30: "software", // Games Nintendo DS
  31: "audio",    // Audio
  32: "video",    // TV Episodes HD
  33: "software", // PC 0-day
  34: "video",    // TV Anime
  35: "video",    // TV Cartoons
  36: "video",    // Movies Foreign
  37: "video",    // Movies WEBRip
  39: "software", // Games PS4
  40: "software", // Games XBOXONE
  42: "software", // Games Mac
  43: "video",    // Movies HDRip
  44: "video",    // TV Foreign
  45: "document", // Books EBooks
  46: "document", // Books Comics
  47: "video",    // Movies 4K
  48: "software", // Games Nintendo Switch
  49: "software", // Games PS5
};

/**
 * The ids to ask TorrentLeech for, given a TSP category. Empty means "do not
 * filter", exactly as in the sibling projects.
 *
 * `image` and `archive` are deliberately empty: TorrentLeech has no image
 * category and no archive category, so asking for either would be narrower and
 * stranger than the reader meant. Those two searches go out unfiltered and are
 * narrowed here by classifyName instead, which is best effort and says so in
 * the README.
 */
const TL_CATEGORY_IDS = (() => {
  const byCategory = { video: [], audio: [], software: [], document: [], image: [], archive: [] };
  for (const [id, category] of Object.entries(TL_CATEGORY)) byCategory[category].push(Number(id));
  for (const list of Object.values(byCategory)) list.sort((a, b) => a - b);
  byCategory.image = [];
  byCategory.archive = [];
  return byCategory;
})();

/** TSP's `sort` in TorrentLeech's spelling. Its default is `added`. */
const TL_SORT = { "": "added", seeders: "seeders", size: "size", recent: "added" };

/**
 * The cookies worth carrying to TorrentLeech, by name.
 *
 * An allowlist rather than "everything the browser had", because a cookie jar
 * copied out of a browser is full of things that are not ours to forward.
 *
 * **Which of these is the session is the site's business, not this file's.**
 * `PHPSESSID` is what its login page sets today; `tluid` and `tlpass` are the
 * persistent pair a remember-me login used to add, and the login form has no
 * remember-me control on it any more. So all three are carried and none of them
 * is treated as proof of anything — see tlVerify, which asks instead.
 *
 * `cf_clearance` is the token that gets past a Cloudflare challenge. It is tied
 * to the address and the browser it was issued to, so it is of no use to a
 * Worker; it is here for the case where this runs on the same machine the
 * cookie came from.
 */
const TL_COOKIES_KEPT = ["PHPSESSID", "tluid", "tlpass", "cf_clearance"];

/**
 * Just the ones above, out of a bigger jar, always in the order above.
 *
 * The order is not something a server cares about. It is here so that a cookie
 * header this file builds does not depend on the order somebody happened to
 * paste in, which is what makes the setup page and this file produce the same
 * bytes from the same jar.
 */
function tlKeep(jar) {
  const lowered = new Map(Object.entries(jar).map(([name, value]) => [name.toLowerCase(), value]));
  const kept = {};
  for (const name of TL_COOKIES_KEPT) {
    const value = lowered.get(name.toLowerCase());
    if (value) kept[name] = value;
  }
  return kept;
}

/**
 * A keyword string TorrentLeech will read as terms rather than as exclusions.
 *
 * A leading `-` on a word means "not this" to its search, so a release name
 * pasted straight in — `Some.Movie.2019-GROUP` — quietly excludes half of
 * itself. Jackett strips them for the same reason; this is that rule.
 */
function tlKeywords(terms) {
  return terms.replace(/(^|\s)-+/gu, "$1").replace(/\s+/gu, " ").trim();
}

/**
 * `2021-10-25 02:18:31` as an instant.
 *
 * TorrentLeech writes this already shifted into the timezone on your profile
 * and does not say which one that is, so there is no exactly right answer. It
 * is read as UTC, which is at worst hours out on a field clients use to order
 * "recent" — and is at least the same answer on every runtime, rather than
 * "whatever timezone the server happened to be in".
 */
function tlStamp(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const plain = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/u.exec(text);
  return isoStamp(plain ? `${plain[1]}T${plain[2]}Z` : text);
}

/** Where a row's `.torrent` is, and what has to be sent to get it. */
function tlFileUrl(tl, id, filename) {
  const name = filename || `${id}.torrent`;
  if (tl.rssKey) {
    // The RSS route needs no session at all: the key in the path is the
    // authorisation. It is also the only credential here that does not lapse,
    // which is why it is preferred whenever it is set.
    const suffix = /\.torrent$/iu.test(name) ? name : `${name}.torrent`;
    return `${tl.host}/rss/download/${id}/${tl.rssKey}/${quote(suffix)}`;
  }
  return `${tl.host}/download/${id}/${quote(name)}`;
}

/** Every field of one `torrentList` entry that becomes part of a row. */
function tlRow(entry, tl) {
  if (!entry || typeof entry !== "object") return null;

  const id = intOrNone(entry.fid);
  if (id === null) return null;

  const filename = cleanName(entry.filename);
  // The title is nullable on this tracker, and a row with neither a title nor a
  // filename has nothing a person could read. `.torrent` is trimmed off the
  // filename so the name parser sees a release string rather than a path.
  const name = cleanName(entry.name) || filename.replace(/\.torrent$/iu, "");
  if (!name) return null;

  return {
    name,
    // Nothing here identifies the content: TorrentLeech publishes no magnet and
    // no infohash, because the file is behind your passkey. This row is a
    // candidate until resolveWindow() has read its `.torrent`.
    infohash: null,
    downloadUrl: tlFileUrl(tl, id, filename),
    torrentUrl: null,
    trackers: null,
    magnet: null,
    private: null,
    sizeBytes: positiveOrNone(entry.size),
    files: positiveOrNone(entry.numfiles),
    seeders: intOrNone(entry.seeders),
    leechers: intOrNone(entry.leechers),
    category: TL_CATEGORY[intOrNone(entry.categoryID)] || null,
    firstSeen: tlStamp(entry.addedTimestamp),
    // The tracker's own page for the release. It carries no passkey and no
    // session; it is the same URL the site's own search would link to.
    descriptionUrl: `${tl.host}/torrent/${id}`,
    sources: [tl.label],
    indexer: tl.label,
    trackerId: tl.id,
    // Two listings of one file, before either has been read. See dedupeKey.
    dupeKey: `${tl.id}:${filename.toLowerCase()}:${positiveOrNone(entry.size) ?? "?"}`,
    // The cache key: a row's infohash is a fact about the file, so it is worth
    // remembering across searches. See RESOLVED.
    cacheKey: `${tl.id}:${id}`,
    meta: null,
  };
}

/**
 * The inputs of a named `<form>`, as `{name: value}`.
 *
 * A login form carries fields nobody typed — a token, a redirect target — and
 * posting without them is how a login silently fails. Cardigann submits the
 * whole form for that reason and so does this. Regular expressions over HTML
 * are a poor tool in general; here the alternative is a parser this file will
 * not carry, and the failure mode is a login that does not work rather than
 * anything unsafe.
 */
function formInputs(html, formName) {
  const form = new RegExp(
    `<form[^>]*name=["']${formName}["'][^>]*>([\\s\\S]*?)</form>`,
    "iu",
  ).exec(html || "");
  const body = form ? form[1] : "";
  const fields = {};
  for (const tag of body.match(/<input\b[^>]*>/giu) || []) {
    const name = /\bname=["']([^"']+)["']/iu.exec(tag);
    if (!name) continue;
    const type = (/\btype=["']([^"']+)["']/iu.exec(tag) || [, "text"])[1].toLowerCase();
    if (type === "submit" || type === "button" || type === "image") continue;
    const value = /\bvalue=["']([^"']*)["']/iu.exec(tag);
    // A checkbox contributes only when it is meant to be ticked. The one that
    // matters is "remember me": without it the tracker issues a session that
    // dies with the browser, and there is no browser here.
    if (type === "checkbox" || type === "radio") {
      if (/remember/iu.test(name[1])) fields[name[1]] = value ? value[1] : "1";
      continue;
    }
    fields[name[1]] = value ? htmlUnescape(value[1]) : "";
  }
  return fields;
}

/** The session cookie to send, or "" when there is none to send. */
function tlCookie(tl) {
  const live = SESSIONS.get(tl.id);
  if (live && live.cookie) return live.cookie;
  return tl.cookie;
}

/** True when what came back is a login page rather than an answer. */
function tlLoggedOut(status, body) {
  if (status === 302 || status === 303) return true;
  if (status !== 200) return false;
  const head = String(body || "").slice(0, 4000);
  return /name=["']login-form["']|\/user\/account\/login/iu.test(head);
}

/** True when Cloudflare, rather than the tracker, is answering. */
function tlChallenged(status, body) {
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return /cf-browser-verification|challenge-platform|__cf_chl|Just a moment/iu.test(
    String(body || "").slice(0, 4000),
  );
}

/**
 * Whether these cookies can actually read a search.
 *
 * **This is what "logged in" means here.** The first version of this file
 * decided by looking for cookies called `tluid` and `tlpass`, which is a guess
 * about somebody else's site — and a wrong one: the login form has no
 * remember-me control on it, so a good login sets `PHPSESSID` and nothing that
 * was being looked for. It reported a working sign-in as a rejected one.
 *
 * Asking costs one request and cannot be wrong in that way. It deliberately
 * does not go through tlFetch, which would call back into the login it is
 * checking.
 */
async function tlVerify(cookie, http, tl, settings) {
  const url = tlSearchUrl({ terms: "", cat: "", sort: "" }, tl);
  await spaced(tl.host, settings.requestGapMs);
  let response;
  try {
    response = await http.send(url, {
      timeout: Math.min(settings.timeoutS, 30),
      headers: {
        "User-Agent": settings.userAgent,
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: `${tl.host}/`,
        Cookie: cookie,
      },
    });
  } catch {
    return { ok: false, status: 0 };
  }
  const body = await response.text();
  if (tlChallenged(response.status, body)) return { ok: false, status: response.status, challenged: true };
  if (response.status !== 200 || tlLoggedOut(response.status, body)) {
    return { ok: false, status: response.status };
  }
  try {
    const payload = JSON.parse(body);
    return { ok: Array.isArray(payload && payload.torrentList), status: 200 };
  } catch {
    return { ok: false, status: 200 };
  }
}

/**
 * What the tracker itself said went wrong, or "".
 *
 * Its login page puts the reason in `p.text-danger`, which the indexer
 * definitions use as their error selector too. Passing it through turns "that
 * did not work" into whatever the site actually said.
 */
function tlComplaint(html) {
  const found = /<p[^>]*class=["'][^"']*text-danger[^"']*["'][^>]*>([\s\S]{0,400}?)<\/p>/iu.exec(html || "");
  if (!found) return "";
  return htmlUnescape(found[1].replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim().slice(0, 160);
}

/**
 * Log in, and keep the cookies for as long as this isolate lives.
 *
 * Two requests: the form, for whatever hidden fields it carries and for the
 * cookie it sets while you are filling it in, then the post. Returns the
 * `Cookie` header to use, or throws a BridgeError saying which part failed.
 *
 * **This is the fallback, not the main path.** A cookie you copied out of your
 * own browser costs nothing and cannot be turned into a password; a username
 * and password sitting in a Worker can. It is here because a cookie lapses and
 * this does not, and the README is blunt about the trade.
 */
async function tlLogin(http, tl, settings) {
  if (!tl.username || !tl.password) {
    throw new BridgeError(
      503,
      "not_configured",
      "TorrentLeech refused this session and there is no username and password to log in with. " +
        `Copy a fresh tluid/tlpass cookie into TL_COOKIE, or set TL_USERNAME and TL_PASSWORD. ${WHERE}`,
    );
  }

  const loginUrl = `${tl.host}/user/account/login/`;
  const common = {
    timeout: Math.min(settings.timeoutS, 30),
    headers: {
      "User-Agent": settings.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
  };

  await spaced(tl.host, settings.requestGapMs);
  let page;
  try {
    page = await http.send(loginUrl, common);
  } catch (thrown) {
    throw new BridgeError(502, "tracker_unreachable", `Could not reach ${tl.host}: ${message(thrown)}.`);
  }
  const html = await page.text();
  if (tlChallenged(page.status, html)) {
    throw new BridgeError(502, "tracker_challenged", TL_CHALLENGE);
  }

  const jar = cookiesFrom(page.cookies);
  const fields = formInputs(html, "login-form");
  fields.username = tl.username;
  fields.password = tl.password;
  // Always sent, empty when there is no 2FA, which is what the indexer
  // definitions do. A field the form did not ask for is ignored; a field it did
  // ask for and did not get is a login that fails without saying why.
  fields.alt2FAToken = tl.twoFa;

  await spaced(tl.host, settings.requestGapMs);
  let posted;
  try {
    posted = await http.send(loginUrl, {
      ...common,
      method: "POST",
      // Manual, because the answer to a good login is a redirect and the
      // cookies are on the redirect itself. Following it would fetch a page
      // nobody wants and, on some runtimes, lose the Set-Cookie headers.
      redirect: "manual",
      headers: {
        ...common.headers,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: loginUrl,
        Origin: tl.host,
        ...(cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {}),
      },
      body: urlencode(fields),
    });
  } catch (thrown) {
    throw new BridgeError(502, "tracker_unreachable", `Could not reach ${tl.host}: ${message(thrown)}.`);
  }

  Object.assign(jar, tlKeep(cookiesFrom(posted.cookies)));
  const cookie = cookieHeader(jar);
  const body = await posted.text();

  if (tlChallenged(posted.status, body)) {
    throw new BridgeError(502, "tracker_challenged", TL_CHALLENGE);
  }

  // Whether this worked is decided by trying it, not by reading cookie names.
  if (cookie) {
    const check = await tlVerify(cookie, http, tl, settings);
    if (check.challenged) throw new BridgeError(502, "tracker_challenged", TL_CHALLENGE);
    if (check.ok) {
      SESSIONS.set(tl.id, { cookie, at: Date.now() });
      return cookie;
    }
  }

  if (/One Time Password|alt2FAToken/iu.test(body)) {
    throw new BridgeError(
      502,
      "tracker_rejected_login",
      "TorrentLeech asked for a one-time password. Your account has 2FA switched on, so it " +
        "needs the Alt 2FA Token from Site Profile in TL_2FA.",
    );
  }

  // Everything known about the failure, because the alternative is a reader
  // changing a password that was never wrong. Cookie **names** only: their
  // values are the session this whole file exists to keep to itself.
  const complaint = tlComplaint(body);
  const names = Object.keys(jar).join(", ");
  throw new BridgeError(
    502,
    "tracker_rejected_login",
    `TorrentLeech did not accept that sign-in. It answered HTTP ${posted.status}` +
      (complaint ? `, said "${complaint}"` : "") +
      `, and the session it handed back (${names || "no cookies at all"}) could not read a search. ` +
      "Check the username and password first. If the account has two-factor on, TL_2FA must be " +
      "the Alt 2FA Token from Site Profile — a rolling code from an app cannot work here.",
  );
}

const TL_CHALLENGE =
  "TorrentLeech answered with a Cloudflare challenge rather than a page. A challenge is a " +
  "browser test, and there is no browser here, so it cannot be solved from a Worker. Running " +
  "this bridge on your own machine instead usually gets past it; see README.md.";

function message(thrown) {
  if (thrown && thrown.name === "TimeoutError") return "it did not answer in time";
  return String(thrown && thrown.message ? thrown.message : thrown);
}

/** One authenticated request to TorrentLeech, logging in again if it has to. */
async function tlFetch(url, http, tl, settings, { accept = "json", retry = true } = {}) {
  const cookie = tlCookie(tl);
  if (!cookie && !(tl.username && tl.password)) {
    throw new BridgeError(
      503,
      "not_configured",
      `TorrentLeech has no session. Set TL_COOKIE, or TL_USERNAME and TL_PASSWORD. ${WHERE}`,
    );
  }
  const live = cookie || (await tlLogin(http, tl, settings));

  await spaced(tl.host, settings.requestGapMs);
  let response;
  try {
    response = await http.send(url, {
      timeout: Math.min(settings.timeoutS, 45),
      headers: {
        "User-Agent": settings.userAgent,
        Accept:
          accept === "json"
            ? "application/json, text/javascript, */*; q=0.01"
            : "application/x-bittorrent, application/octet-stream, */*",
        "Accept-Language": "en-GB,en;q=0.9",
        Referer: `${tl.host}/`,
        Cookie: live,
      },
    });
  } catch (thrown) {
    throw new BridgeError(502, "tracker_unreachable", `Could not reach ${tl.host}: ${message(thrown)}.`);
  }

  if (accept !== "json") return response;

  const body = await response.text();
  if (tlChallenged(response.status, body)) {
    throw new BridgeError(502, "tracker_challenged", TL_CHALLENGE);
  }
  if (tlLoggedOut(response.status, body)) {
    // The session has lapsed. One retry, and only one: a second failure is a
    // wrong password rather than an expired cookie, and looping on it would
    // hammer a login form with somebody's account name.
    SESSIONS.delete(tl.id);
    if (!retry) {
      throw new BridgeError(
        502,
        "tracker_rejected_session",
        "TorrentLeech showed a login page instead of results. The cookie in TL_COOKIE has " +
          "expired, or it is tied to the browser and address it was made in — a Worker calls " +
          "from Cloudflare, not from your house. Copy a fresh one, or set TL_USERNAME and " +
          "TL_PASSWORD so this can log in by itself.",
      );
    }
    await tlLogin(http, tl, settings);
    return tlFetch(url, http, tl, settings, { accept, retry: false });
  }
  if (response.status !== 200) {
    throw new BridgeError(502, "tracker_error", `TorrentLeech answered HTTP ${response.status}.`);
  }
  return { status: 200, body };
}

/** The URL for a search. Path segments, in the order the tracker wants them. */
function tlSearchUrl(query, tl) {
  const parts = ["torrents", "browse", "list"];

  const ids = query.cat ? TL_CATEGORY_IDS[query.cat] : [];
  if (ids.length) parts.push("categories", ids.join(","));

  const facets = [];
  if (tl.freeleech) facets.push("FREELEECH");
  if (tl.excludeScene) facets.push("nonscene");
  if (facets.length) parts.push("facets", `tags:${facets.join(",")}`);

  const terms = tlKeywords(query.terms);
  // `exact/1` is the tracker's own "all of these words" mode. Without terms
  // there is nothing to be exact about, and `newfilter/2` is what its front
  // page browses with.
  if (terms) parts.push("exact", "1", "query", quote(terms));
  else parts.push("newfilter", "2");

  parts.push("orderby", TL_SORT[query.sort] || "added", "order", "desc");
  return `${tl.host}/${parts.join("/")}`;
}

/**
 * TorrentLeech, as rows.
 *
 * **One request, and one page of results.** The tracker's list endpoint has no
 * page size in the URL: it serves however many rows your profile's *Torrents
 * per page* is set to. So paging happens here, over what came back, and the way
 * to have more to page through is to set that to 100 on your own profile. The
 * answer says how many it found, so a client is never guessing.
 */
async function tlSearch(query, http, tl, settings) {
  if (!query.terms && !settings.browseRows) return { rows: [], found: 0 };

  const { body } = await tlFetch(tlSearchUrl(query, tl), http, tl, settings);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BridgeError(
      502,
      "tracker_error",
      "TorrentLeech's answer was not JSON. That usually means a page was served instead of the " +
        "list — a notice to acknowledge, or maintenance.",
    );
  }
  const list = payload && Array.isArray(payload.torrentList) ? payload.torrentList : null;
  if (!list) {
    throw new BridgeError(502, "tracker_error", "TorrentLeech's answer had no torrentList in it.");
  }

  const rows = [];
  let dropped = 0;
  for (const entry of list) {
    const row = tlRow(entry, tl);
    if (row) rows.push(row);
    else dropped += 1;
  }
  // Browsing is a shopfront rather than a result set, so it is cut short here
  // rather than fetched in full and then thrown away.
  const kept = query.terms ? rows : rows.slice(0, settings.browseRows);
  return { rows: kept, found: intOrNone(payload.numFound) ?? rows.length, dropped };
}

/** A live answer for /healthz?probe=1: can this actually search right now? */
async function tlProbe(http, tl, settings) {
  const report = { tracker: tl.id, label: tl.label, host: tl.host, reachable: false, authenticated: false };
  report.auth = tl.auth;
  report.torrentfile = tl.torrentfile;
  if (tl.problem) {
    report.detail = "No session and no login: set TL_COOKIE, or TL_USERNAME and TL_PASSWORD.";
    return report;
  }
  try {
    const answer = await tlSearch(
      { terms: "", cat: "", sort: "", q: "" },
      http,
      tl,
      { ...settings, browseRows: Math.max(1, Math.min(settings.browseRows, 5)) },
    );
    report.reachable = true;
    report.authenticated = true;
    report.rows = answer.rows.length;
    report.catalogue = answer.found;
  } catch (thrown) {
    if (!(thrown instanceof BridgeError)) throw thrown;
    report.reachable = thrown.code !== "tracker_unreachable";
    report.detail = thrown.detail;
    report.code = thrown.code;
  }
  return report;
}

// --- your own UTSI -----------------------------------------------------------
//
// The sibling project: a Worker of your own that asks the public indexes and
// answers in TSP, so its rows arrive with an infohash and a magnet and cost no
// `.torrent` fetch. Asked in parallel with TorrentLeech; UTSI_TIMEOUT_S caps it.

/** Whether *url* is on *origin*. */
function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** One TSP row from UTSI as a row here, or null when it is not one. */
function utsiRow(item, utsi) {
  if (!item || typeof item !== "object") return null;
  const infohash = normalizeInfohash(item.infohash) || infohashFromMagnet(String(item.magnet || ""));
  const name = cleanName(item.name);
  if (!infohash || !name) return null;

  // Its file, if it said. On UTSI's own origin it needs UTSI's key, which a
  // client does not have, so it is served from here, sealed; on a public host
  // it needs nothing, and passes through.
  const file = String(item.torrent_url || "");
  const url = /^https?:\/\//iu.test(file) ? file : "";
  const onUtsi = sameOrigin(url, utsi.host);
  const category = String(item.category || "");
  // Prefixed, so an engine over there never reads as a tracker of this
  // bridge's own.
  const sources = (Array.isArray(item.sources) ? item.sources : [])
    .filter(Boolean)
    .map((one) => `${utsi.label}/${one}`);
  return {
    name,
    infohash,
    downloadUrl: onUtsi ? url : null,
    torrentUrl: url && !onUtsi ? url : null,
    // Built by toTorrent, not copied: the same function and public five give
    // the magnet UTSI made, even after a merge has renamed the row.
    trackers: null,
    magnet: null,
    private: false,
    sizeBytes: positiveOrNone(item.size_bytes),
    files: positiveOrNone(item.files),
    seeders: intOrNone(item.seeders),
    leechers: intOrNone(item.leechers),
    category: CATEGORIES.includes(category) ? category : null,
    firstSeen: isoStamp(item.first_seen),
    descriptionUrl: String(item.description_url || "") || null,
    sources: sources.length ? sources : [utsi.label],
    indexer: utsi.label,
    trackerId: utsi.id,
    meta: null,
  };
}

/** The URL for a search: TSP's own route, with the filters travelling along. */
function utsiSearchUrl(query, utsi, settings) {
  const params = { q: query.terms };
  // With the filters, so what comes back is the best *qualifying* rows.
  const wanted = { cat: query.cat, year: query.year, res: query.res, min_seeders: query.minSeeders, sort: query.sort };
  for (const [name, value] of Object.entries(wanted)) if (value) params[name] = String(value);
  // **A fixed number of rows, never the page asked for**: paging happens here,
  // and the order is the same on every page only if UTSI is asked the same.
  params.limit = String(query.terms ? utsi.rows : Math.min(settings.browseRows, utsi.rows));
  return `${utsi.host}/api/v1/search?${urlencode(params)}`;
}

/**
 * UTSI, as rows. One request, no session, no spacing. Every failure names the
 * setting to look at, because from a client a dead UTSI and a search that
 * found nothing on the public indexes look identical.
 */
async function utsiSearch(query, http, utsi, settings) {
  if (!query.terms && !settings.browseRows) return { rows: [], found: 0, engines: [] };

  let response;
  try {
    response = await http.send(utsiSearchUrl(query, utsi, settings), {
      timeout: Math.min(utsi.timeoutS, settings.timeoutS),
      fetcher: utsi.fetcher,
      headers: {
        "User-Agent": `tracker-bridge/${VERSION}`,
        Accept: "application/json",
        ...(utsi.apiKey ? { "X-API-Key": utsi.apiKey } : {}),
      },
    });
  } catch (thrown) {
    throw new BridgeError(502, "utsi_unreachable", `Could not reach ${utsi.host}: ${message(thrown)}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new BridgeError(
      502,
      "utsi_rejected_key",
      response.status === 403
        ? "Your UTSI rejected the key: UTSI_API_KEY is not the key that Worker was deployed with."
        : utsi.apiKey
          ? "This bridge sent a key and your UTSI saw none: something between them is dropping the X-API-Key header."
          : "Your UTSI needs a key and UTSI_API_KEY is not set.",
    );
  }
  if (response.status !== 200) {
    // Over the public URL, a 404 is usually Cloudflare refusing the call
    // between two of its own Workers, which looks like a 404 from here.
    let detail = `Your UTSI answered HTTP ${response.status}.`;
    if (response.status === 404) {
      detail = utsi.via === "url"
        ? `HTTP 404 from ${utsi.host}: Cloudflare refusing a call between two Workers on one account (error 1042), which a Service binding named UTSI on this Worker fixes; or UTSI_URL is not the Worker itself.`
        : "HTTP 404 through the UTSI binding: it does not point at a UTSI.";
    }
    throw new BridgeError(502, "utsi_error", detail);
  }

  let payload = null;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    // Not JSON: the wrong shape, below.
  }
  if (!payload || !Array.isArray(payload.torrents)) {
    throw new BridgeError(
      502,
      "utsi_error",
      "Your UTSI's answer was not a TSP search result. UTSI_URL should be the Worker itself, not a page in front of it.",
    );
  }
  const rows = payload.torrents.map((item) => utsiRow(item, utsi)).filter(Boolean);
  return {
    rows,
    found: intOrNone(payload.count) ?? rows.length,
    engines: Array.isArray(payload.engines) ? payload.engines.filter((one) => typeof one === "string") : [],
    partial: payload.partial === true,
  };
}

/** A live answer for /healthz?probe=1: does it answer, and does the key fit? */
async function utsiProbe(http, utsi, settings) {
  const report = {
    tracker: utsi.id, label: utsi.label, host: utsi.host, via: utsi.via, reachable: false,
    authenticated: false, auth: utsi.auth, torrentfile: utsi.torrentfile,
  };
  if (utsi.problem) return { ...report, detail: "UTSI_URL is not an https:// address." };
  try {
    // A real search, because nothing else proves the key. One row is enough.
    const query = { terms: "big buck bunny", cat: "", year: "", res: "", minSeeders: 0, sort: "" };
    const answer = await utsiSearch(query, http, { ...utsi, rows: 1 }, settings);
    Object.assign(report, { reachable: true, authenticated: true, matches: answer.found, engines: answer.engines });
  } catch (thrown) {
    if (!(thrown instanceof BridgeError)) throw thrown;
    Object.assign(report, { reachable: thrown.code !== "utsi_unreachable", detail: thrown.detail, code: thrown.code });
  }
  return report;
}

const TRACKERS = {
  torrentleech: {
    id: "torrentleech",
    label: "TorrentLeech",

    read(env) {
      const host = envOrigin(env, "TL_HOST", TL_HOST) || TL_HOST;
      const cookieText = envText(env, "TL_COOKIE") || String(TL_COOKIE || "").trim();
      const jar = parseCookie(cookieText);
      const rssKey = (envText(env, "TL_RSSKEY") || String(TL_RSSKEY || "").trim()).toLowerCase();
      const username = envText(env, "TL_USERNAME") || String(TL_USERNAME || "").trim();
      const password = envText(env, "TL_PASSWORD") || String(TL_PASSWORD || "").trim();

      const tracker = {
        id: "torrentleech",
        label: "TorrentLeech",
        host,
        // Only the cookies that could be a session. Everything else a browser
        // had — consent banners, analytics, whatever else the site sets — is
        // not ours to carry and not ours to store. See TL_COOKIES_KEPT.
        cookie: cookieHeader(tlKeep(jar)),
        // 20 hex characters, from the RSS link on your profile. Anything else
        // is a paste that went wrong, and a bad key in a URL is a `.torrent`
        // route that 404s on every row.
        rssKey: /^[0-9a-f]{20}$/u.test(rssKey) ? rssKey : "",
        rssKeyGiven: Boolean(rssKey),
        username,
        password,
        twoFa: envText(env, "TL_2FA") || String(TL_2FA || "").trim(),
        freeleech: envFlag(env, "TL_FREELEECH", false),
        excludeScene: envFlag(env, "TL_EXCLUDE_SCENE", false),
        problem: "",
      };

      // For /healthz: what it searches with, and what it fetches a `.torrent`
      // with. An RSS key does not expire and a session does, which is why a
      // search can start failing on its own.
      tracker.auth = tracker.cookie ? "cookie" : tracker.username && tracker.password ? "login" : "none";
      tracker.torrentfile = tracker.rssKeyGiven && !tracker.rssKey
        ? "unusable rss key"
        : tracker.rssKey
          ? "rss key"
          : tracker.cookie || tracker.username
            ? "session"
            : "none";

      // Nothing configured at all is not a fault, it is a tracker that is
      // switched off, and it is left out of the list entirely.
      if (!tracker.cookie && !tracker.username && !tracker.rssKey) return null;
      if (!tracker.cookie && !(tracker.username && tracker.password)) tracker.problem = "no_session";
      return tracker;
    },

    search: tlSearch,
    probe: tlProbe,

    /** The headers a `.torrent` fetch needs, or null when it cannot be made. */
    async fileRequest(url, http, tracker, settings) {
      // The RSS route carries its own authorisation in the path, so it needs no
      // session and cannot be broken by one expiring.
      if (url.includes("/rss/download/")) return { url, headers: {} };
      const cookie = tlCookie(tracker) || (await tlLogin(http, tracker, settings));
      return { url, headers: cookie ? { Cookie: cookie } : {} };
    },
  },

  utsi: {
    id: "utsi",
    label: "UTSI",

    read(env) {
      const given = envText(env, "UTSI_URL") || String(UTSI_URL || "").trim();
      const apiKey = envText(env, "UTSI_API_KEY") || String(UTSI_KEY || "").trim();
      // Cloudflare refuses a Worker's call to another Worker on the same account
      // (its error 1042); a Service binding named UTSI is the door it leaves.
      const fetcher = env && env.UTSI && typeof env.UTSI.fetch === "function" ? env.UTSI : null;
      if (!given && !apiKey && !fetcher) return null;
      // An origin and nothing more; a binding ignores it, but the URL must be whole.
      const host = envOrigin(env, "UTSI_URL", given) || (fetcher && !given ? "https://utsi" : "");
      return {
        id: "utsi",
        label: "UTSI",
        host,
        apiKey,
        fetcher,
        via: fetcher ? "binding" : "url",
        // Rows to ask for on every search: fixed, not the page size, so that
        // paging over the merged set is stable. See utsiSearchUrl.
        rows: envInt(env, "UTSI_ROWS", 100, 1, MAX_LIMIT),
        // How long to wait for it before answering without it.
        timeoutS: envInt(env, "UTSI_TIMEOUT_S", 10, 1, 60),
        auth: apiKey ? "key" : "none",
        // Its rows arrive with their infohash, so nothing is fetched to serve
        // them; the key is used again only for a `torrent_url` on its origin.
        torrentfile: "not needed",
        problem: host ? "" : "bad_url",
      };
    },

    search: utsiSearch,
    probe: utsiProbe,

    /** A file on its own origin is fetched with its key; see trackerFor. */
    async fileRequest(url, http, tracker) {
      return { url, headers: tracker.apiKey ? { "X-API-Key": tracker.apiKey } : {} };
    },
  },
};

/** The tracker a sealed `torrent_url` names, or null if no configured one owns it. */
function trackerFor(settings, url) {
  return settings.trackers.find((tracker) => tracker.host && sameOrigin(url, tracker.host)) || null;
}

// --- resolving ---------------------------------------------------------------

/**
 * Fetch one row's `.torrent` and read what it says.
 *
 * This is the request the whole design turns on. A private tracker publishes no
 * magnet and no infohash — the file is behind your passkey — so the only way to
 * produce the infohash TSP requires on every row is to read the file and hash
 * its info dict. That also fills in the size and the file count, and hands back
 * the announce URL, which is the only tracker a `private: 1` torrent can use.
 */
async function fetchTorrent(row, http, tracker, settings) {
  const request = await tracker.fileRequest(row.downloadUrl, http, tracker, settings);
  if (!request) return null;

  await spaced(tracker.host, settings.requestGapMs);
  let response;
  try {
    response = await http.send(request.url, {
      timeout: Math.min(settings.timeoutS, 25),
      headers: {
        "User-Agent": settings.userAgent,
        Accept: "application/x-bittorrent, application/octet-stream, */*",
        Referer: `${tracker.host}/`,
        ...(request.headers || {}),
      },
    });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;

  const data = await response.bytes();
  if (!data || !data.length || data.length > TORRENT_MAX_BYTES) return null;
  return parseTorrent(data);
}

/** Run *jobs* with at most *width* in flight. */
async function pooled(jobs, width) {
  let next = 0;
  const workers = Array.from({ length: Math.min(width, jobs.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      await jobs[index]();
    }
  });
  await Promise.all(workers);
}

/**
 * Read the `.torrent` for the rows a client is about to see.
 *
 * Only that page, and only up to `maxResolve` of it. Every row here costs one
 * request to a tracker that counts them, so resolving a hundred candidates to
 * serve twenty would be fetching eighty files nobody asked for. Rows that still
 * have no infohash afterwards are dropped by `toTorrent`, and counted in the
 * answer as `unresolved` rather than vanishing.
 */
async function resolveWindow(rows, http, settings) {
  if (!settings.maxResolve) return 0;

  // Three places to look, cheapest first. Memory is free, the edge cache is
  // one local read, and only what neither has costs a request to the tracker.
  const missing = [];
  for (const row of rows) {
    if (row.infohash) continue;
    const known = row.cacheKey ? RESOLVED.get(row.cacheKey) : null;
    if (known) applyTorrent(row, known, settings);
    else missing.push(row);
  }

  const cached = await Promise.all(
    missing.map((row) => cachedMeta(row.cacheKey, settings)),
  );

  // Indexed rather than filtered, so `maxResolve` still cuts the page in the
  // order the client will see it.
  const pending = [];
  missing.forEach((row, index) => {
    const known = cached[index];
    if (known) {
      applyTorrent(row, known, settings);
      remember(row.cacheKey, known);
    } else if (pending.length < settings.maxResolve) {
      pending.push(row);
    }
  });
  if (!pending.length) return 0;

  let resolved = 0;
  await pooled(
    pending.map((row) => async () => {
      const tracker = settings.trackers.find((one) => one.id === row.trackerId);
      if (!tracker) return;
      let meta = null;
      try {
        meta = await fetchTorrent(row, http, tracker, settings);
      } catch {
        // A login that failed mid-resolve is one row missing, not a whole
        // search that 502s after the rest of it worked.
        meta = null;
      }
      if (!meta) return;
      applyTorrent(row, meta, settings);
      if (row.cacheKey) {
        remember(row.cacheKey, meta);
        await rememberEdge(row.cacheKey, meta, settings);
      }
      resolved += 1;
    }),
    settings.resolveConcurrency,
  );
  return resolved;
}

/** What reading a `.torrent` taught, written onto the row. */
function applyTorrent(row, meta, settings) {
  row.infohash = meta.infohash;
  row.private = meta.private;
  // The announce list is the point. `private: 1` turns off DHT and peer
  // exchange, so a magnet carrying the public trackers would name a swarm it
  // can never reach — and would publish a private tracker's swarm while failing
  // to reach it.
  //
  // Set even when empty, which is what closes that door: an empty array tells
  // magnetFor "these and no others", where null would have meant "you decide",
  // and it decides on the public five.
  row.trackers = (meta.trackers || []).map((url) =>
    settings && settings.announceHttp ? url.replace(/^https:\/\//iu, "http://") : url,
  );
  if (row.sizeBytes === null) row.sizeBytes = meta.sizeBytes;
  if (row.files === null) row.files = meta.files;
  if (!row.name && meta.name) row.name = meta.name;
}

/**
 * A search, start to finish.
 *
 * Ask every switched-on tracker, collapse the same release reported by more
 * than one, apply the filters none of them have a parameter for, order the
 * result, read the files for the page that was asked for, and cut it out.
 */
async function search(query, http, settings, origin = "") {
  const started = Date.now();
  query.terms = normalizeQuery(query.q);

  // A browse nobody wants is a browse worth not doing. With BRIDGE_BROWSE_ROWS
  // at zero this answers an empty search without asking anything, which matters
  // because a client that opens on an empty search box would otherwise fire a
  // request at a private tracker before the reader has typed a character.
  if (!query.terms && !settings.browseRows) {
    return reply(200, {
      query: query.q,
      count: 0,
      limit: query.limit,
      offset: query.offset,
      took_ms: Date.now() - started,
      torrents: [],
      engines: [],
    });
  }

  const usable = settings.trackers.filter((tracker) => !tracker.problem);
  if (!usable.length) {
    throw new BridgeError(
      503,
      "not_configured",
      `No tracker on this bridge has anything to search with. ${WHERE}`,
    );
  }

  const answers = await Promise.all(
    usable.map(async (tracker) => {
      try {
        return { tracker, ...(await tracker.search(query, http, tracker, settings)) };
      } catch (thrown) {
        if (!(thrown instanceof BridgeError)) throw thrown;
        // One tracker being down is not the whole answer being down — once
        // there are two of them. With one, there is nothing else to report and
        // the error is the answer.
        return { tracker, rows: [], found: 0, failed: thrown };
      }
    }),
  );

  const failures = answers.filter((answer) => answer.failed);
  if (failures.length === answers.length) throw failures[0].failed;

  const collected = answers.flatMap((answer) => answer.rows);
  const found = answers.reduce((total, answer) => total + (answer.found || 0), 0);

  const shape = (rows) =>
    sortRows(
      applyFilters(merge(rows), {
        category: query.cat,
        year: query.year,
        resolution: query.res,
        minSeeders: query.minSeeders,
      }),
      query.sort,
    );

  // The candidate set: everything that matched, in the order it will always be
  // in. Nothing below this line reorders it, and that is deliberate — see the
  // note on `count`.
  const ordered = shape(collected);

  // Only the page. Reading a `.torrent` is one request to a tracker that counts
  // them, so the rows nobody is being shown are not read.
  const window = ordered.slice(query.offset, query.offset + query.limit);
  await resolveWindow(window, http, settings);

  // A row whose file could not be read has no infohash, so it cannot be a TSP
  // row, so it is left out of this page and counted instead.
  //
  // Merged once more, over the page alone: an infohash learned just now can
  // collapse this row against another tracker's copy of the same release. Doing
  // it over the page rather than the whole set is what keeps `count` and the
  // ordering the same answer on every page.
  const resolved = merge(window.filter((row) => row.infohash));
  // Counted before that merge, not as a difference after it: a row that
  // collapsed into another tracker's copy was read, not lost.
  const unresolved = window.filter((row) => !row.infohash).length;

  const scrapedAt = nowIso();
  const page = [];
  for (const row of resolved) {
    const torrent = await toTorrent(row, scrapedAt, settings, origin);
    if (torrent !== null) page.push(torrent);
  }

  const body = {
    query: query.q,
    // **Everything that matched, not everything that could be served.** A row
    // becomes servable only once its `.torrent` has been read, and only the
    // rows on the page being answered are read — so a `count` of servable rows
    // would be roughly `limit`, every time, and a client could never tell a
    // full page from the last one. This is the number to page against.
    count: ordered.length,
    limit: query.limit,
    offset: query.offset,
    took_ms: Date.now() - started,
    torrents: page,
    engines: [...new Set(ordered.flatMap((row) => row.sources))].sort(),
  };

  // Not part of the contract, and clients ignore fields they do not know.
  //
  // `total_found` is what the trackers said they had, which is almost always
  // larger than `count`: TorrentLeech serves one page of its own, sized by the
  // *Torrents per page* setting on your profile, and UTSI serves UTSI_ROWS.
  if (found > ordered.length) body.total_found = found;
  // Rows on this page whose `.torrent` could not be read, or that came after
  // BRIDGE_MAX_RESOLVE stopped short. These are rows you asked for and did not
  // get, and the difference between `count`, `limit` and this is the whole
  // story of a short page.
  if (unresolved) body.unresolved = unresolved;
  if (failures.length) {
    body.degraded = failures.map((answer) => `${answer.tracker.label}: ${answer.failed.detail}`);
  }
  // A UTSI that stopped waiting for its slowest engines says so; passed along.
  if (answers.some((answer) => answer.partial)) body.partial = true;

  return reply(200, body);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. ROUTES
// ═══════════════════════════════════════════════════════════════════════════

function keyComplaint(settings) {
  if (keyProblem(settings) === "short") {
    return [
      "api_key_too_short",
      `BRIDGE_API_KEY is ${settings.apiKey.length} characters and needs at least ${MIN_KEY_LENGTH}. ` +
        `This key is the only thing between the internet and your tracker account, so a short one ` +
        `is a guessable one. Four random words is plenty. ${WHERE}`,
    ];
  }
  return [
    "not_configured",
    `This bridge has no API key, so it refuses every request rather than serving without one. ` +
      `${WHERE} Or set BRIDGE_ALLOW_ANONYMOUS=1 to serve with no key at all, which on a public ` +
      `URL hands your tracker account to anyone who finds it.`,
  ];
}

/**
 * Compare two keys without letting the time taken say how much of one matched.
 *
 * The length is allowed to leak — it always does, over HTTP — but the content is
 * not, which is what stops a caller guessing the key one character at a time.
 */
function timingSafeEqual(presented, expected) {
  let difference = presented.length ^ expected.length;
  const length = Math.max(presented.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (presented.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Null when the caller may proceed, otherwise the refusal to send.
 *
 * Both spellings are accepted because clients differ: `X-API-Key` is what the
 * contract documents, `Authorization: Bearer` is what a generic HTTP client
 * reaches for. The key never travels in the query string.
 */
function authorize(settings, headers) {
  if (!isConfigured(settings)) return error(503, ...keyComplaint(settings));
  if (settings.allowAnonymous) return null;

  let presented = headers.get("x-api-key") || "";
  if (!presented) {
    const authorization = headers.get("authorization") || "";
    if (authorization.slice(0, 7).toLowerCase() === "bearer ") {
      presented = authorization.slice(7).trim();
    }
  }
  if (!presented) return error(401, "missing_api_key", "Send the key in the X-API-Key header.");
  if (!timingSafeEqual(presented, settings.apiKey)) {
    return error(403, "invalid_api_key", "The X-API-Key header did not match.");
  }
  return null;
}

// --- replies -----------------------------------------------------------------

function reply(status, body, headers = null, text = null) {
  return { status, body, headers, text, bytes: null };
}

function error(status, name, detail = null, headers = null) {
  const body = { error: name };
  if (detail) body.detail = detail;
  return reply(status, body, headers);
}

/** Named origins only. A wildcard would let any page spend this bridge. */
function corsHeaders(settings, origin) {
  if (!origin || !settings.corsOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-API-Key, Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// --- query -------------------------------------------------------------------

/** Validate a query string, or say exactly what was wrong with it. */
function readQuery(params) {
  const one = (name) => (params.get(name) || "").trim();

  const cat = one("cat");
  if (cat && !CATEGORIES.includes(cat)) {
    return error(400, "invalid_cat", `cat must be one of ${CATEGORIES.join(", ")}`);
  }
  const sort = one("sort");
  if (sort && !SORTS.includes(sort)) {
    return error(400, "invalid_sort", "sort must be one of seeders, size, recent");
  }
  const res = one("res");
  if (res && !RESOLUTIONS.includes(res)) {
    return error(400, "invalid_res", `res must be one of ${RESOLUTIONS.join(", ")}`);
  }
  const year = one("year");
  if (year && !/^\d{4}$/.test(year)) {
    return error(400, "invalid_year", "year must be four digits");
  }

  const number = (name, fallbackValue) => {
    const raw = one(name);
    if (!raw) return fallbackValue;
    return /^[+-]?\d+$/.test(raw) ? Number(raw) : fallbackValue;
  };

  // Clamped rather than rejected: a 422 is not in the client's retry contract.
  return {
    q: one("q"),
    cat,
    year,
    res,
    minSeeders: Math.max(0, number("min_seeders", 0)),
    sort,
    limit: Math.max(1, Math.min(number("limit", DEFAULT_LIMIT), MAX_LIMIT)),
    offset: Math.max(0, number("offset", 0)),
    terms: "",
  };
}

// --- health ------------------------------------------------------------------

/**
 * What this bridge knows about itself, without asking anything.
 *
 * No key and no outbound request, so it is safe to leave open and cannot be
 * turned into an amplifier by somebody who does not have the key. It reports
 * configuration only: whether the client key is set, which trackers are
 * switched on, and what each of them has to authenticate with. It never reports
 * a credential, only whether there is one.
 */
function healthz(settings) {
  const upstream = upstreamProblem(settings);
  return {
    status: isConfigured(settings) && !upstream ? "ok" : "not_configured",
    api_key: isConfigured(settings) ? "ok" : keyProblem(settings),
    trackers: settings.trackers.map((tracker) => ({
      id: tracker.id,
      // What it searches with and fetches with, in its own words, and never
      // the credential itself.
      auth: tracker.auth,
      torrentfile: tracker.torrentfile,
      ...(tracker.via ? { via: tracker.via } : {}),
      status: tracker.problem || "ok",
    })),
    // Whether rows carry a `torrent_url`. Here because a client that branches
    // on that field behaves visibly differently, and "why does every row say
    // direct download" is answered by this line.
    torrent_urls: settings.torrentUrls,
    // Same reason: a client finding no peers on every row wants to know whether
    // its announce URLs were rewritten, and this is the only place that says.
    announce_http: settings.announceHttp,
    edge_cache: settings.edgeCache,
    version: VERSION,
    runtime: RUNTIME,
    // The one thing worth saying out loud, because it is the reason to run this
    // at all rather than pointing the client at the tracker.
    note: "Your tracker session stays on this server and is never sent to a client.",
  };
}

/** Ask each tracker whether it is actually usable right now. Needs the key. */
async function probe(http, settings) {
  const report = { ...healthz(settings) };
  if (!settings.trackers.length) {
    report.status = "not_configured";
    report.detail = `No tracker is configured. ${WHERE}`;
    return report;
  }

  report.trackers = await Promise.all(
    settings.trackers.map((tracker) => tracker.probe(http, tracker, settings)),
  );
  const working = report.trackers.filter((one) => one.authenticated);
  if (!working.length) {
    report.status = "degraded";
    report.detail =
      report.trackers.map((one) => one.detail).find(Boolean) ||
      "No tracker answered with results, so every search will be empty.";
  } else if (working.length < report.trackers.length) {
    report.status = "degraded";
    report.detail = "Some trackers answered and some did not.";
  }
  return report;
}

/**
 * The auto-return, inlined into the page only while setup is still in progress.
 *
 * A short pause rather than an instant jump, so "Your bridge is live" is read
 * before the page moves: the reassurance is half the point of showing it.
 * `replace` rather than `assign`, so the back button does not land on a page
 * that would immediately bounce again.
 */
const RETURN_SCRIPT = `
var going = setTimeout(function () {
  location.replace(document.getElementById("finish").href);
}, 2500);
document.getElementById("lede").innerHTML =
  "<strong>All set. Taking you back to finish.<\\/strong> " +
  "Your URL is on its way to the page that has your key, so you get both together.";
var stay = document.getElementById("stay");
stay.hidden = false;
stay.addEventListener("click", function () {
  clearTimeout(going);
  stay.hidden = true;
  document.getElementById("lede").innerHTML =
    "<strong>Staying here.<\\/strong> Press Finish setup whenever you are ready.";
});
`;

/** Escape for HTML text and double-quoted attributes. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * The one page this bridge serves, and the reason it serves any.
 *
 * A deployed bridge knows its own URL; the setup page that minted the key does
 * not, and cannot, because Cloudflare invents the account part of the name. So
 * the last step of setup used to be "read the URL off Cloudflare's screen and
 * type it back into the other tab", which is the step people got wrong. This
 * page removes it: it *is* the URL, and it carries a link back with the URL in
 * the fragment.
 *
 * **It never shows a key.** This page needs none to read, so anybody who ever
 * ended up with the URL would end up with the key too, permanently: a
 * screenshot, a shared link, a synced history. The URL is not the secret.
 */
function landingPage(host, returning) {
  const url = escapeHtml(host);
  const back = escapeHtml(SETUP_PAGE + "#url=" + encodeURIComponent(host));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<title>Your bridge is live</title>
<style>
:root { --bg:#fff; --ink:#111; --muted:#666; --line:#e5e5e5; --code:#f6f6f6; --accent:#ba5a08; }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
body { margin:0; padding:2rem 1.15rem 5rem; background:var(--bg); color:var(--ink);
  font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  overflow-wrap:break-word; -webkit-font-smoothing:antialiased; }
main { max-width:34rem; margin:0 auto; }
h1 { font-size:1.6rem; line-height:1.2; letter-spacing:-.022em; margin:0 0 .5rem; font-weight:700; }
h2 { font-size:1rem; margin:2rem 0 .3rem; font-weight:650; letter-spacing:-.008em; }
p { margin:.7rem 0; }
a { color:var(--ink); text-underline-offset:2px; }
.lede { color:var(--muted); margin-bottom:1.4rem; }
.note { color:var(--muted); font-size:.935rem; }
.card { border:1px solid var(--line); border-radius:10px; padding:1rem; margin:1.1rem 0; }
label { display:block; font-size:.82rem; font-weight:650; letter-spacing:.01em;
  text-transform:uppercase; color:var(--muted); margin-bottom:.3rem; }
.value { font:500 .98rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--code); border:1px solid var(--line); border-radius:8px; padding:.7rem .75rem;
  user-select:all; -webkit-user-select:all; margin-bottom:.9rem; }
a.btn, button { display:flex; align-items:center; justify-content:center; width:100%;
  min-height:3.15rem; padding:.8rem 1rem; font:inherit; font-weight:600; letter-spacing:-.005em;
  text-align:center; text-decoration:none; border:1px solid var(--accent); border-radius:8px;
  background:var(--accent); color:#fff; cursor:pointer; font-size:1.05rem; }
button.ghost { background:var(--bg); color:var(--ink); border-color:var(--line); margin-top:.5rem; }
a.btn:active, button:active { transform:translateY(1px); }
code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em;
  background:var(--code); padding:.1em .32em; border-radius:4px; }
.status { min-height:1.35rem; margin-top:.5rem; font-size:.9rem; font-weight:600; text-align:center; }
footer { margin-top:2.8rem; padding-top:1.2rem; border-top:1px solid var(--line);
  color:var(--muted); font-size:.89rem; }
</style>
</head>
<body>
<main>

<h1>Your bridge is live</h1>
<p class="lede" id="lede">
  <strong>One tap left. Press Finish setup below.</strong> That is the only
  thing this page is for: it hands your URL back to the page that made your key,
  so you get both together, ready to copy.
</p>

<div class="card">
  <label>Your URL</label>
  <div class="value" id="url">${url}</div>
  <a class="btn" id="finish" href="${back}">Finish setup &nearr;</a>
  <button class="ghost" id="stay" type="button" hidden>Stay on this page</button>
  <button class="ghost" id="copy" type="button">Copy the URL</button>
  <div class="status" id="status" role="status" aria-live="polite"></div>
  <p class="note" style="margin-bottom:0">
    Finish setup opens the page you started on, with this URL already in it, so
    it can show you the URL and the key together and test them. The URL travels
    after the <code>#</code>, which your browser never sends to a server.
  </p>
</div>

<h2>Is it working?</h2>
<p class="note">
  <a href="/healthz">/healthz</a> says whether this bridge is configured. It
  needs no key and reports no credential. Add <code>?probe=1</code>, with your
  key, and it asks your tracker as well: whether it answers, whether it still
  accepts your session, and how much it says it has.
</p>

<h2>If that page no longer has your key</h2>
<p class="note">
  It is not lost. Open this Worker in the Cloudflare dashboard, press
  <strong>Edit code</strong>, and read the line near the top that starts
  <code>const BRIDGE_KEY</code>. You can also replace it from Settings,
  Variables and Secrets, as <code>BRIDGE_API_KEY</code>, which wins over the
  line in the file.
</p>

<footer>
  Tracker bridge ${VERSION} &middot;
  <a href="https://github.com/momzv2022-ctrl/tracker-bridge" rel="noopener">source and documentation</a>
  <p style="margin:.5rem 0 0">
    This URL is yours alone. There is no public instance of this and no list of
    other people's. MIT licence, no warranty, no liability.
  </p>
</footer>

</main>
<script>
${returning ? RETURN_SCRIPT : ""}
document.getElementById("copy").addEventListener("click", function () {
  var status = document.getElementById("status");
  var text = location.protocol + "//" + location.host;
  function done() { status.textContent = "URL copied."; setTimeout(function () { status.textContent = ""; }, 4000); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { status.textContent = "Could not copy. Select it by hand."; });
    return;
  }
  status.textContent = "Could not copy. Select it by hand.";
});
</script>
</body>
</html>
`;
}

const BANNER = `Tracker bridge ${VERSION}

  GET /api/v1/search?q=...   send the key as the X-API-Key header
  GET /healthz               configuration, no key needed
  GET /healthz?probe=1       asks your tracker; needs the key

https://github.com/momzv2022-ctrl/tracker-bridge
`;

/** Route one request. Everything above this is reachable from tests alone. */
async function handle(method, url, headers, http, settings) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const cors = corsHeaders(settings, headers.get("origin") || "");

  if (method === "OPTIONS") return reply(204, null, cors);
  if (method !== "GET" && method !== "HEAD") {
    return error(405, "method_not_allowed", "This API is read-only.", { ...cors, Allow: "GET, OPTIONS" });
  }

  if (path === "/healthz") {
    if (!["1", "true", "yes"].includes((parsed.searchParams.get("probe") || "").trim())) {
      return reply(200, healthz(settings), cors);
    }
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    return reply(200, await probe(http, settings), cors);
  }

  // A bridge into somebody's private tracker account is the one thing that
  // should never turn up in a search engine.
  if (path === "/robots.txt") return reply(200, null, cors, "User-agent: *\nDisallow: /\n");

  if (path === "/") {
    // A browser gets the page that closes the setup loop; anything else, a
    // client or a monitor or curl, gets plain text.
    if (!(headers.get("accept") || "").includes("text/html")) {
      return reply(200, null, { ...cors, "X-Robots-Tag": "noindex" }, BANNER);
    }
    return reply(
      200, null,
      { ...cors, "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
      landingPage(parsed.host, SETUP_UNTIL > Date.now()),
    );
  }

  if (path === "/api/v1/search") {
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    const query = readQuery(parsed.searchParams);
    if (query.status) return reply(query.status, query.body, cors);
    try {
      const answer = await search(query, http, settings, parsed.origin);
      return reply(answer.status, answer.body, { ...cors, ...(answer.headers || {}) });
    } catch (thrown) {
      if (thrown instanceof BridgeError) return error(thrown.status, thrown.code, thrown.detail, cors);
      throw thrown;
    }
  }

  if (path.startsWith("/api/v1/torrentfile/")) {
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    return torrentfile(path.slice("/api/v1/torrentfile/".length), parsed.searchParams, http, settings, cors);
  }

  return error(404, "not_found", "No route here. Try /api/v1/search.", cors);
}

/**
 * `GET /api/v1/torrentfile/<infohash>?t=<token>` — the file itself.
 *
 * TSP names this route and calls `torrent_url` decisive for thin swarms. For a
 * private tracker it is decisive for every swarm: `private: 1` turns off DHT
 * and peer exchange, so the magnet — which TSP requires on every row and which
 * is therefore still sent — cannot reach the swarm on its own. The `.torrent`,
 * with your passkey in its announce URL, can.
 *
 * The token is sealed, not signed: AES-GCM under your own `BRIDGE_API_KEY`, so
 * what the client holds is an opaque string it cannot read. Three things are
 * checked before anything is fetched, and the last is the one that matters: the
 * sealed URL must still belong to a configured tracker, so a token minted when
 * `TL_HOST` pointed somewhere else cannot turn this route into an open proxy
 * for whatever it named.
 */
async function torrentfile(wanted, params, http, settings, cors) {
  const infohash = normalizeInfohash(wanted);
  if (!infohash) return error(400, "invalid_infohash", "Expected 40 hex characters.", cors);

  if (upstreamProblem(settings)) {
    return error(503, "not_configured", `No tracker is configured. ${WHERE}`, cors);
  }
  if (!settings.maxResolve) {
    return error(404, "not_found", "Serving .torrent files is off: BRIDGE_MAX_RESOLVE is 0.", cors);
  }

  const payload = await unseal(settings, (params.get("t") || "").trim());
  // One answer for forged, expired and malformed alike. Which of the three it
  // was is not the client's business, and saying would be an oracle.
  if (!payload) {
    return error(403, "bad_token", "This link is not valid, or has expired. Search again.", cors);
  }

  const tracker = trackerFor(settings, payload.u);
  if (!tracker) {
    return error(403, "bad_token", "This link was minted for a tracker this bridge no longer has.", cors);
  }

  let data;
  try {
    const request = await tracker.fileRequest(payload.u, http, tracker, settings);
    await spaced(tracker.host, settings.requestGapMs);
    const response = await http.send(request.url, {
      timeout: Math.min(settings.timeoutS, 25),
      fetcher: tracker.fetcher || null,
      headers: {
        "User-Agent": settings.userAgent,
        Accept: "application/x-bittorrent, application/octet-stream, */*",
        Referer: `${tracker.host}/`,
        ...(request.headers || {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      return error(
        502,
        "tracker_rejected_session",
        `${tracker.label} refused this bridge's ${tracker.auth === "key" ? "key" : "session"}.`,
        cors,
      );
    }
    if (response.status !== 200) {
      return error(502, "tracker_error", `${tracker.label} answered HTTP ${response.status} for that file.`, cors);
    }
    data = await response.bytes();
  } catch (thrown) {
    if (thrown instanceof BridgeError) return error(thrown.status, thrown.code, thrown.detail, cors);
    return error(502, "tracker_unreachable", `Could not reach ${tracker.label}: ${message(thrown)}.`, cors);
  }

  if (!data || !data.length) return error(502, "tracker_error", "That file came back empty.", cors);
  if (data.length > TORRENT_MAX_BYTES) {
    return error(502, "tracker_error", "That .torrent is implausibly large.", cors);
  }

  // The file must be the one that was asked for. Without this the infohash in
  // the path would be decoration, and a client that trusted it would be seeding
  // something it never chose.
  const meta = await parseTorrent(data);
  if (!meta) return error(502, "tracker_error", "That answer was not a .torrent.", cors);
  if (meta.infohash !== infohash) {
    return error(409, "infohash_mismatch", "That file is no longer the release it was.", cors);
  }

  return {
    status: 200,
    body: null,
    text: null,
    bytes: data,
    headers: {
      ...cors,
      "Content-Type": "application/x-bittorrent",
      "Content-Disposition": `attachment; filename="${infohash}.torrent"`,
      // Sealed and expiring, so it is cacheable by the client that asked and by
      // nothing in between. This file carries a passkey.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. ENTRY
// ═══════════════════════════════════════════════════════════════════════════

/** Which of the two runtimes this is, for /healthz and for the entry below. */
const RUNTIME =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers"
    ? "cloudflare-worker"
    : typeof process !== "undefined" && process.versions && process.versions.node
      ? "node"
      : "unknown";

/**
 * A reply as (status, body, headers), ready for either runtime.
 *
 * The body is null, not `""`, when there is nothing to send: 204 and 304 are
 * "null body" statuses and the `Response` constructor rejects a string body.
 */
function render(answer) {
  const headers = { ...(answer.headers || {}) };
  // A .torrent is bytes and must not go near a string: re-encoding through
  // UTF-8 would corrupt the info dict, and with it the infohash the client is
  // about to trust.
  if (answer.bytes !== null && answer.bytes !== undefined) {
    return [answer.status, answer.bytes, headers];
  }
  if (answer.text !== null && answer.text !== undefined) {
    if (!("Content-Type" in headers)) headers["Content-Type"] = "text/plain; charset=utf-8";
    return [answer.status, answer.text, headers];
  }
  if (answer.body === null || answer.body === undefined) return [answer.status, null, headers];
  if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  return [answer.status, JSON.stringify(answer.body), headers];
}

/**
 * `fetch()` reduced to the one shape this file needs.
 *
 * One method rather than two, because a tracker is a website: a login posts a
 * form, reads `Set-Cookie` off a redirect it must not follow, and only then
 * asks for JSON. The body is read lazily, so a caller that only wanted the
 * status never pays for it.
 */
function httpClient() {
  return {
    async send(url, { method = "GET", headers = null, body = null, timeout = 30, redirect = "follow", fetcher = null } = {}) {
      const init = {
        method,
        headers: headers || {},
        body,
        redirect,
        signal: AbortSignal.timeout(Math.round(timeout * 1000)),
      };
      // A Service binding is another Worker's front door, with no internet between.
      const response = fetcher ? await fetcher.fetch(url, init) : await fetch(url, init);
      return {
        status: response.status,
        location: response.headers.get("location") || "",
        // `getSetCookie` is the only way to see more than one of them; the
        // single-header fallback is for a runtime old enough not to have it,
        // where a multi-cookie login will simply not work rather than work
        // wrongly.
        cookies:
          typeof response.headers.getSetCookie === "function"
            ? response.headers.getSetCookie()
            : [response.headers.get("set-cookie")].filter(Boolean),
        text: () => response.text(),
        bytes: async () => new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

/** The Cloudflare entry. Ignored entirely when this runs under Node. */
export default {
  async fetch(request, env) {
    const settings = readSettings(env || {});
    const answer = await handle(request.method, request.url, request.headers, httpClient(), settings);
    const [status, body, headers] = render(answer);
    return new Response(body, { status, headers });
  },
};

// --- node --------------------------------------------------------------------
//
// `node worker.js` serves the same handler on a port. Prefer this when your
// tracker is behind a bot filter that a Worker cannot get past: from your own
// machine the request comes from your own address, which is also the address
// the cookie was made at.

/** True only when this file is the program, not when a test imported it. */
function startedDirectly() {
  if (RUNTIME !== "node") return false;
  if (!Array.isArray(process.argv) || !process.argv[1]) return false;
  const entry = process.argv[1].replace(/\\/g, "/");
  return import.meta.url.endsWith(entry) || import.meta.url.endsWith(entry.replace(/^[A-Za-z]:/, ""));
}

async function serve() {
  // The specifier is built rather than written, so that a bundler aimed at
  // Cloudflare cannot try to resolve `node:http` while packing a file that will
  // never reach this line there.
  const { createServer } = await import("node:" + "http");

  const settings = readSettings(process.env);
  const port = Number(process.env.BRIDGE_PORT || 8788);
  const host = process.env.BRIDGE_HOST || "127.0.0.1";
  const http = httpClient();

  const server = createServer(async (incoming, outgoing) => {
    const origin = `http://${incoming.headers.host || `${host}:${port}`}`;
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method,
      headers: incoming.headers,
    });
    try {
      const answer = await handle(request.method, request.url, request.headers, http, settings);
      const [status, body, headers] = render(answer);
      outgoing.writeHead(status, headers);
      outgoing.end(body === null ? undefined : body);
    } catch (thrown) {
      outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "internal", detail: String(thrown && thrown.message) }));
    }
  });

  server.listen(port, host, () => {
    const problem = keyProblem(settings) || upstreamProblem(settings);
    process.stdout.write(`\n  tracker-bridge ${VERSION}\n`);
    process.stdout.write(`  URL       http://${host}:${port}\n`);
    process.stdout.write(
      `  Trackers  ${settings.trackers.map((one) => one.label).join(", ") || "(none configured)"}\n`,
    );
    if (problem) {
      process.stdout.write(`\n  Not ready: ${problem}. Open /healthz for what is missing.\n`);
    } else {
      process.stdout.write(`\n  Ready. Open /healthz?probe=1 with your key to check your tracker.\n`);
    }
    process.stdout.write("\n");
  });
}

if (startedDirectly()) await serve();

/**
 * The seam the test suite reaches through, and the only thing in this file that
 * is not part of serving a request.
 *
 * Both runtimes ignore it. It is here so the tests can drive the pipeline
 * directly, with the tracker replaced by a fixture, rather than only through
 * `fetch()`.
 */
export const __testing = {
  BridgeError,
  MIN_KEY_LENGTH,
  RESOLVED,
  SESSIONS,
  cachedMeta,
  rememberEdge,
  TL_CATEGORY,
  TL_CATEGORY_IDS,
  TRACKERS,
  VERSION,
  applyFilters,
  classifyName,
  cookieHeader,
  cookiesFrom,
  dedupeKey,
  formInputs,
  handle,
  healthz,
  httpClient,
  landingPage,
  magnetFor,
  merge,
  normalizeInfohash,
  normalizeQuery,
  parseCookie,
  parseName,
  parseTorrent,
  probe,
  readQuery,
  readSettings,
  render,
  resolveWindow,
  sameOrigin,
  seal,
  search,
  sortRows,
  timingSafeEqual,
  tlKeywords,
  tlRow,
  tlSearch,
  tlSearchUrl,
  tlStamp,
  toTorrent,
  torrentfile,
  unseal,
  utsiProbe,
  utsiRow,
  utsiSearch,
  utsiSearchUrl,
};
