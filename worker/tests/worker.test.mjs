/**
 * The bridge, run rather than read.
 *
 * Nothing here touches the network. TorrentLeech is a table: a captured
 * `torrentList` and a stub `http` client that hands it back, mints a `.torrent`
 * for any row asked for, and records every request — the URL, the headers, and
 * the cookie that carried the session. UTSI is a second table, in the shape
 * its own API document describes, behind the same stub.
 *
 * Two things are worth pinning above all others, and both are here. The URL
 * that goes out, because it is a path a tracker either understands or does not.
 * And the JSON that comes back, frozen in `golden/search.json`, because that
 * shape is shared with two sibling projects: a change here that a person did
 * not deliberately make is a change that would show up as duplicate rows in an
 * app holding results from more than one of them.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { __testing } from "../src/worker.js";

const {
  BridgeError,
  RESOLVED,
  SESSIONS,
  TL_CATEGORY,
  TL_CATEGORY_IDS,
  applyFilters,
  classifyName,
  cookiesFrom,
  formInputs,
  handle,
  healthz,
  landingPage,
  magnetFor,
  merge,
  normalizeInfohash,
  parseCookie,
  parseName,
  probe,
  readQuery,
  readSettings,
  render,
  search,
  seal,
  timingSafeEqual,
  tlKeywords,
  tlRow,
  tlSearchUrl,
  tlStamp,
  toTorrent,
  torrentfile,
  unseal,
} = __testing;

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST = JSON.parse(readFileSync(join(HERE, "fixtures", "torrentleech-list.json"), "utf8"));
const GOLDEN_PATH = join(HERE, "golden", "search.json");
const COMBINED_PATH = join(HERE, "golden", "combined.json");

const KEY = "abcd-efgh-jkmn-pqrs-tuvw-xyz2";
const COOKIE = "tluid=987654; tlpass=abcdef0123456789abcdef0123456789";
const RSSKEY = "9f8e7d6c5b4a39281706";
const HOST = "https://www.torrentleech.org";

const ENV = { BRIDGE_API_KEY: KEY, TL_COOKIE: COOKIE, TL_RSSKEY: RSSKEY };

/** Fresh settings, and a clean isolate: no cached session, no cached hashes. */
function settingsFrom(extra = {}) {
  RESOLVED.clear();
  SESSIONS.clear();
  return readSettings({ ...ENV, BRIDGE_REQUEST_GAP_MS: "0", ...extra });
}

const headersOf = (entries = {}) => new Headers(entries);

// --- a .torrent, built rather than captured -----------------------------------

/** Minimal bencoder, so a test .torrent's infohash is a fact not a fixture. */
function bencode(value) {
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (typeof value === "string") value = Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  }
  const keys = Object.keys(value).sort();
  return Buffer.concat([
    Buffer.from("d"), ...keys.flatMap((k) => [bencode(k), bencode(value[k])]), Buffer.from("e"),
  ]);
}

/** The passkey a real TorrentLeech announce URL carries, and this one does too. */
const PASSKEY = "pk-0123456789abcdef0123456789abcdef";
const ANNOUNCE = `https://tracker.torrentleech.org/a/${PASSKEY}/announce`;

/**
 * A `.torrent` of the shape this whole project exists for: `private: 1`, so DHT
 * and peer exchange are off, and a passkey in the announce URL that no magnet
 * built from public trackers could ever carry.
 */
function torrentFor(name, { length = 2147483648, files = null, isPrivate = 1 } = {}) {
  const info = { name, "piece length": 262144, pieces: Buffer.alloc(20), private: isPrivate };
  if (files) info.files = files.map((size, index) => ({ length: size, path: [`part${index}.bin`] }));
  else info.length = length;
  const bytes = bencode({ announce: ANNOUNCE, "announce-list": [[ANNOUNCE]], info });
  return { bytes: new Uint8Array(bytes), infohash: createHash("sha1").update(bencode(info)).digest("hex") };
}

/**
 * The infohash each fixture row resolves to, by `fid`.
 *
 * Keyed on the *filename*, not the title, because that is what makes two
 * listings of one file two listings of one file: the tracker shows them under
 * different titles, and the merge has to collapse them anyway.
 */
const releaseName = (entry) => entry.filename.replace(/\.torrent$/i, "");
const HASHES = Object.fromEntries(
  LIST.torrentList.map((entry) => [entry.fid, torrentFor(releaseName(entry)).infohash]),
);

// --- a UTSI, as a table -------------------------------------------------------

const UTSI_URL = "https://utsi-abc123.someone.workers.dev";
const UTSI_KEY = "utsi-key-0123456789abcdef0123456789";
/** The pair as somebody would paste it: with the trailing slash, on purpose. */
const WITH_UTSI = { UTSI_URL: `${UTSI_URL}/`, UTSI_API_KEY: UTSI_KEY };

const UTSI_RAW = readFileSync(join(HERE, "fixtures", "utsi-search.json"), "utf8");
/** A public `.torrent`, for the one row whose file is served through the bridge. */
const UBUNTU = torrentFor("Ubuntu 24.04 Desktop amd64", { isPrivate: 0 });

/**
 * What UTSI answers, with its two placeholders filled in: one row shares an
 * infohash with a TorrentLeech row, which is the cross-tracker merge, and one
 * carries a `torrent_url` on UTSI's own origin, which is the sealed route.
 */
function utsiAnswer({ collide = true } = {}) {
  const answer = JSON.parse(
    UTSI_RAW.replace(/__BUNNY__/g, HASHES["1000001"])
      .replace(/__UBUNTU__/g, UBUNTU.infohash)
      .replace(/__UTSI__/g, UTSI_URL),
  );
  if (!collide) {
    answer.torrents = answer.torrents.filter((row) => !(row && row.infohash === HASHES["1000001"]));
  }
  return answer;
}

// --- TorrentLeech, as a table -------------------------------------------------

/**
 * The tracker, stubbed.
 *
 * *options.list* replaces the JSON answer; *options.file* replaces the
 * `.torrent` answer; *options.login* supplies a login page and its cookies.
 * Every request is recorded, which is how the tests assert that the session
 * travels in a header and never in a URL.
 */
function stubHttp(options = {}) {
  const asked = [];
  const reply = (status, body, extra = {}) => ({
    status,
    location: extra.location || "",
    cookies: extra.cookies || [],
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    bytes: async () => (body instanceof Uint8Array ? body : new Uint8Array()),
  });

  return {
    asked,
    async send(url, request = {}) {
      asked.push({ url, ...request });
      if (options.throws) throw new TypeError("fetch failed");

      // UTSI. *options.utsi* replaces its search answer, or throws; the
      // default is the table. *options.utsiFile* replaces its `.torrent`.
      if (url.startsWith(UTSI_URL)) {
        if (url.includes("/api/v1/torrentfile/")) {
          const made = typeof options.utsiFile === "function" ? options.utsiFile(url, request) : options.utsiFile;
          if (made === null) return reply(404, "");
          return made ? reply(made.status ?? 200, made.body) : reply(200, UBUNTU.bytes);
        }
        const answer = typeof options.utsi === "function" ? options.utsi(url, request) : options.utsi;
        if (answer === undefined) return reply(200, utsiAnswer());
        if (answer && answer.status !== undefined) return reply(answer.status, answer.body, answer);
        return reply(200, answer);
      }

      if (url.includes("/user/account/login")) {
        const answer = typeof options.login === "function" ? options.login(request, asked) : options.login;
        if (!answer) return reply(200, "<html><body>no form here</body></html>");
        return reply(answer.status ?? 200, answer.body ?? "", { cookies: answer.cookies || [] });
      }

      if (url.includes("/download/")) {
        const fid = /\/(?:rss\/)?download\/(\d+)\//.exec(url);
        if (typeof options.file === "function") {
          const made = options.file(url, fid && fid[1]);
          return made ? reply(made.status ?? 200, made.body) : reply(404, "");
        }
        if (options.file === null) return reply(404, "");
        const entry = LIST.torrentList.find((row) => String(row.fid) === (fid && fid[1]));
        if (!entry) return reply(404, "");
        return reply(200, torrentFor(releaseName(entry)).bytes);
      }

      const answer = typeof options.list === "function" ? options.list(url, asked.length) : options.list;
      if (answer && answer.status !== undefined) return reply(answer.status, answer.body, answer);
      return reply(200, answer === undefined ? LIST : answer);
    },
  };
}


/** A `.torrent` with no announce and no announce-list: nothing to announce to. */
function bencodeNoTrackers(name) {
  const info = { name, "piece length": 262144, pieces: Buffer.alloc(20), length: 1024, private: 1 };
  return new Uint8Array(bencode({ info }));
}

const queryOf = (extra = {}) => ({
  q: "", cat: "", year: "", res: "", minSeeders: 0, sort: "", limit: 50, offset: 0, terms: "",
  ...extra,
});

// ══ the URL that goes out ═══════════════════════════════════════════════════

test("the search URL is the path TorrentLeech understands", () => {
  const tl = settingsFrom().trackers[0];

  assert.equal(
    tlSearchUrl(queryOf({ terms: "big buck bunny" }), tl),
    `${HOST}/torrents/browse/list/exact/1/query/big%20buck%20bunny/orderby/added/order/desc`,
  );

  // No terms is a browse, and the tracker's own front page browses with
  // `newfilter/2`. There is nothing to be `exact` about, so that pair is gone.
  assert.equal(
    tlSearchUrl(queryOf(), tl),
    `${HOST}/torrents/browse/list/newfilter/2/orderby/added/order/desc`,
  );

  // A category becomes the tracker's own numeric ids, comma separated, before
  // everything else in the path.
  const video = tlSearchUrl(queryOf({ terms: "x", cat: "video" }), tl);
  assert.match(video, /\/torrents\/browse\/list\/categories\/8,9,11,12,13,14,15,16,26,27,29,32,34,35,36,37,43,44,47\/exact\/1\//);

  // `recent` is the tracker's `added`; the other two carry their own names.
  assert.match(tlSearchUrl(queryOf({ terms: "x", sort: "recent" }), tl), /orderby\/added\/order\/desc$/);
  assert.match(tlSearchUrl(queryOf({ terms: "x", sort: "seeders" }), tl), /orderby\/seeders\/order\/desc$/);
  assert.match(tlSearchUrl(queryOf({ terms: "x", sort: "size" }), tl), /orderby\/size\/order\/desc$/);
});

test("freeleech and no-scene are facets, and off by default", () => {
  assert.doesNotMatch(tlSearchUrl(queryOf({ terms: "x" }), settingsFrom().trackers[0]), /facets/);

  const both = settingsFrom({ TL_FREELEECH: "1", TL_EXCLUDE_SCENE: "1" }).trackers[0];
  assert.match(tlSearchUrl(queryOf({ terms: "x" }), both), /\/facets\/tags:FREELEECH,nonscene\//);

  const free = settingsFrom({ TL_FREELEECH: "yes" }).trackers[0];
  assert.match(tlSearchUrl(queryOf({ terms: "x" }), free), /\/facets\/tags:FREELEECH\/exact\//);
});

test("a leading dash is a search term here, not an exclusion", () => {
  // `Some.Movie.2019-GROUP` normalises to `Some Movie 2019 -GROUP`, and to this
  // tracker a leading dash means "not this word" — so the release name would
  // exclude half of itself.
  assert.equal(tlKeywords("Some Movie 2019 -GROUP"), "Some Movie 2019 GROUP");
  assert.equal(tlKeywords("--weird  spacing"), "weird spacing");
  assert.equal(tlKeywords("nothing to do"), "nothing to do");
});

test("a query with a slash in it cannot escape its path segment", () => {
  const url = tlSearchUrl(queryOf({ terms: "ac/dc ../../admin" }), settingsFrom().trackers[0]);
  assert.match(url, /query\/ac%2Fdc%20\.\.%2F\.\.%2Fadmin\//);
  // The same number of segments as a query with no punctuation in it at all:
  // the slashes are inside one segment rather than making three more.
  const plain = tlSearchUrl(queryOf({ terms: "acdc admin" }), settingsFrom().trackers[0]);
  const segments = (one) => new URL(one).pathname.split("/").filter(Boolean).length;
  assert.equal(segments(url), segments(plain));
});

// ══ rows ════════════════════════════════════════════════════════════════════

test("a torrentList entry becomes a row, or says why it cannot", async () => {
  const settings = settingsFrom();
  const answer = await search(queryOf({ q: "bunny", limit: 50 }), stubHttp(), settings, "https://b.example");
  const rows = answer.body.torrents;

  const bunny = rows.find((row) => row.name.startsWith("Big Buck Bunny 2008 1080p"));
  assert.equal(bunny.size_bytes, 8589934592);
  assert.equal(bunny.files, 3);
  assert.equal(bunny.seeders, 412);
  assert.equal(bunny.leechers, 17);
  assert.equal(bunny.category, "video");
  assert.equal(bunny.year, "2008");
  assert.equal(bunny.resolution, "1080p");
  assert.equal(bunny.codec, "x264");
  assert.equal(bunny.source, "bluray");
  assert.equal(bunny.first_seen, "2021-10-25T02:18:31Z");

  // `size: 0` and `numfiles: 0` are how this tracker says "not measured", so
  // they are absences rather than zeroes — and then the `.torrent` says what
  // the listing would not, which is half the reason the file is read at all.
  const tl = settingsFrom().trackers[0];
  const raw = tlRow(LIST.torrentList.find((one) => one.fid === "1000005"), tl);
  assert.equal(raw.sizeBytes, null);
  assert.equal(raw.files, null);
  const app = rows.find((row) => row.name.startsWith("Some Application"));
  assert.equal(app.size_bytes, 2147483648);
  assert.equal(app.files, 1);

  // A real zero-seeder row keeps its zero.
  const sintel = rows.find((row) => row.name.startsWith("Sintel"));
  assert.equal(sintel.seeders, 0);
  assert.equal(sintel.season, "01");
  assert.equal(sintel.episode, "02");

  // The title is nullable on this tracker. The filename is what is left.
  assert.ok(rows.some((row) => row.name === "An.Unnamed.Release.2019.1080p.WEB-DL"));

  // A row with no numeric id cannot be fetched and so cannot become anything.
  assert.equal(rows.some((row) => row.name === "Broken Row"), false);
});

test("every category id the tracker has maps somewhere, and back again", () => {
  for (const [id, category] of Object.entries(TL_CATEGORY)) {
    assert.ok(
      ["video", "audio", "software", "document"].includes(category),
      `category id ${id} maps to ${category}`,
    );
    assert.ok(TL_CATEGORY_IDS[category].includes(Number(id)), `id ${id} is not asked for by ${category}`);
  }
  // The two TSP categories the tracker has no id for go out unfiltered and are
  // narrowed by reading names instead. The README says so; this holds it true.
  assert.deepEqual(TL_CATEGORY_IDS.image, []);
  assert.deepEqual(TL_CATEGORY_IDS.archive, []);
});

test("a timestamp is read the same way on every runtime", () => {
  assert.equal(tlStamp("2021-10-25 02:18:31"), "2021-10-25T02:18:31Z");
  assert.equal(tlStamp("2021-10-25T02:18:31Z"), "2021-10-25T02:18:31Z");
  assert.equal(tlStamp(""), null);
  assert.equal(tlStamp("not a date"), null);
});

test("the same release listed twice is one row, with the best of each field", async () => {
  const settings = settingsFrom();
  const answer = await search(queryOf({ q: "bunny" }), stubHttp(), settings, "https://b.example");
  const bunnies = answer.body.torrents.filter((row) => row.name.startsWith("Big Buck Bunny 2008 1080p"));

  // Two fids, one file, therefore one infohash, therefore one row.
  assert.equal(bunnies.length, 1);
  // The longest name wins, the seeder counts are max-ed.
  assert.equal(bunnies[0].name, "Big Buck Bunny 2008 1080p BluRay x264-GROUP [REPOST]");
  assert.equal(bunnies[0].seeders, 412);
  // The earliest sighting is kept.
  assert.equal(bunnies[0].first_seen, "2021-10-25T02:18:31Z");
});

// ══ the part that costs something: reading the file ═════════════════════════

test("an infohash can only come from the file, and does", async () => {
  const http = stubHttp();
  const settings = settingsFrom();
  const answer = await search(queryOf({ q: "bunny", limit: 3 }), http, settings, "https://b.example");

  for (const row of answer.body.torrents) {
    assert.match(row.infohash, /^[0-9a-f]{40}$/);
  }
  const bunny = answer.body.torrents.find((row) => row.name.startsWith("Big Buck Bunny 2008 1080p"));
  assert.equal(bunny.infohash, HASHES["1000001"]);

  // One request for the list, and then one per row of the page. Nothing is
  // fetched for a row nobody is being shown.
  const files = http.asked.filter((one) => one.url.includes("/download/"));
  assert.ok(files.length <= 3 + 1, `${files.length} files fetched for a three-row page`);
});

test("the magnet announces where the swarm actually is", async () => {
  const settings = settingsFrom();
  const answer = await search(queryOf({ q: "bunny", limit: 2 }), stubHttp(), settings, "https://b.example");
  const row = answer.body.torrents[0];

  // `private: 1` turns off DHT and peer exchange, so a magnet carrying the
  // public trackers would name a swarm it can never reach. The file's own
  // announce URL is the only one that works — and it has the passkey in it,
  // which is why the README says not to paste one of these anywhere.
  assert.ok(row.magnet.includes(encodeURIComponent(ANNOUNCE)));
  assert.equal(row.magnet.includes("opentrackr"), false);
  assert.notEqual(magnetFor(row.infohash, row.name), row.magnet);
});

test("a private row never announces to a public tracker, even with nothing to announce to", async () => {
  // Announcing a private tracker's infohash to a public one publishes its swarm,
  // and is the sort of thing accounts are closed over. The fallback to the
  // public five is for a row that does not know its own trackers; a private row
  // that could not read any must carry none rather than borrow those.
  const http = stubHttp({
    file: () => ({ status: 200, body: bencodeNoTrackers("Nothing To Announce To") }),
    list: {
      status: 200,
      body: JSON.stringify({
        numFound: 1,
        torrentList: [{ ...LIST.torrentList[0], name: "Nothing To Announce To", fid: "2000001" }],
      }),
    },
  });
  const answer = await search(queryOf({ q: "nothing", limit: 1 }), http, settingsFrom(), "https://b.example");
  const row = answer.body.torrents[0];
  assert.match(row.infohash, /^[0-9a-f]{40}$/);
  assert.equal(row.magnet.includes("&tr="), false, row.magnet);
  assert.equal(row.magnet.includes("opentrackr"), false);
});

test("BRIDGE_ANNOUNCE_HTTP rewrites the magnet's announce, and only the scheme", async () => {
  // Some clients cannot make an https announce at all. This is the escape
  // hatch, and it puts the passkey in the clear, so it is off by default and
  // /healthz says which way it is set.
  const plain = await search(
    queryOf({ q: "bunny", limit: 1 }), stubHttp(), settingsFrom(), "https://b.example",
  );
  assert.ok(plain.body.torrents[0].magnet.includes(encodeURIComponent(ANNOUNCE)));

  const rewritten = await search(
    queryOf({ q: "bunny", limit: 1 }), stubHttp(), settingsFrom({ BRIDGE_ANNOUNCE_HTTP: "1" }), "https://b.example",
  );
  const magnet = rewritten.body.torrents[0].magnet;
  assert.ok(magnet.includes(encodeURIComponent(ANNOUNCE.replace("https://", "http://"))), magnet);
  assert.equal(magnet.includes(encodeURIComponent(ANNOUNCE)), false);
  // The infohash is a fact about the file and does not move with the scheme.
  assert.equal(rewritten.body.torrents[0].infohash, plain.body.torrents[0].infohash);

  assert.equal(healthz(settingsFrom()).announce_http, false);
  assert.equal(healthz(settingsFrom({ BRIDGE_ANNOUNCE_HTTP: "1" })).announce_http, true);
});

test("a cold isolate reads the edge cache before it reads a tracker", async () => {
  // The measured difference on a real deployment is 7.4 seconds against 0.4 for
  // the same five rows, and all of it is reading .torrent files. In memory that
  // saving lasts as long as one isolate. This is the same saving, kept.
  const shelf = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        const held = shelf.get(request.url);
        return held ? new Response(held, { headers: { "Content-Type": "application/json" } }) : undefined;
      },
      async put(request, response) {
        shelf.set(request.url, await response.text());
      },
    },
  };
  try {
    const first = stubHttp();
    await search(queryOf({ q: "bunny", limit: 3 }), first, settingsFrom(), "https://b.example");
    const read = first.asked.filter((one) => one.url.includes("/download/")).length;
    assert.ok(read > 0, "the first search had to read the files");
    assert.equal(shelf.size, read, "and wrote every one it read to the edge");

    // A cold isolate: memory empty, edge warm.
    RESOLVED.clear();
    const second = stubHttp();
    const answer = await search(queryOf({ q: "bunny", limit: 3 }), second, settingsFrom(), "https://b.example");
    assert.equal(second.asked.filter((one) => one.url.includes("/download/")).length, 0);
    assert.equal(answer.body.torrents.length, 3);
    // And the rows are whole, not a cache-shaped imitation of one.
    for (const row of answer.body.torrents) {
      assert.match(row.infohash, /^[0-9a-f]{40}$/);
      assert.ok(row.magnet.includes(encodeURIComponent(ANNOUNCE)));
    }

    // Switched off, it is not consulted and not written to.
    RESOLVED.clear();
    shelf.clear();
    const third = stubHttp();
    await search(queryOf({ q: "bunny", limit: 1 }), third, settingsFrom({ BRIDGE_EDGE_CACHE: "0" }), "https://b.example");
    assert.equal(shelf.size, 0);
  } finally {
    delete globalThis.caches;
  }
});

test("a cache that throws costs a request, never an answer", async () => {
  globalThis.caches = {
    default: {
      async match() { throw new Error("cache is having a day"); },
      async put() { throw new Error("cache is having a day"); },
    },
  };
  try {
    RESOLVED.clear();
    const answer = await search(queryOf({ q: "bunny", limit: 2 }), stubHttp(), settingsFrom(), "https://b.example");
    assert.equal(answer.body.torrents.length, 2);
  } finally {
    delete globalThis.caches;
  }
});

test("under Node there is no edge cache, and nothing pretends otherwise", async () => {
  assert.equal(typeof globalThis.caches, "undefined");
  assert.equal(await __testing.cachedMeta("anything", settingsFrom()), null);
  await __testing.rememberEdge("anything", { infohash: "x" }, settingsFrom());
  assert.equal(healthz(settingsFrom()).edge_cache, true);
  assert.equal(healthz(settingsFrom({ BRIDGE_EDGE_CACHE: "0" })).edge_cache, false);
});

test("resolving is bounded, and never runs past the page", async () => {
  const http = stubHttp();
  const settings = settingsFrom({ BRIDGE_MAX_RESOLVE: "2" });
  const answer = await search(queryOf({ q: "bunny", limit: 50 }), http, settings, "https://b.example");

  assert.equal(http.asked.filter((one) => one.url.includes("/download/")).length, 2);
  assert.equal(answer.body.torrents.length, 2);
  // The rest are not missing silently: they are counted.
  assert.ok(answer.body.unresolved >= 1);
});

test("an infohash is remembered, so the second search is free", async () => {
  const settings = settingsFrom();
  const first = stubHttp();
  await search(queryOf({ q: "bunny", limit: 3 }), first, settings, "https://b.example");
  const fetched = first.asked.filter((one) => one.url.includes("/download/")).length;
  assert.ok(fetched > 0);

  const second = stubHttp();
  const answer = await search(queryOf({ q: "bunny", limit: 3 }), second, settings, "https://b.example");
  assert.equal(second.asked.filter((one) => one.url.includes("/download/")).length, 0);
  assert.equal(answer.body.torrents.length, 3);
});

test("a file that will not parse leaves the row out rather than wrong", async () => {
  const settings = settingsFrom({ BRIDGE_MAX_RESOLVE: "3" });
  const http = stubHttp({ file: () => ({ status: 200, body: new Uint8Array([1, 2, 3]) }) });
  const answer = await search(queryOf({ q: "bunny", limit: 3 }), http, settings, "https://b.example");

  assert.deepEqual(answer.body.torrents, []);
  assert.equal(answer.body.unresolved, 3);
  // `count` is what matched, not what could be served. Six rows matched and
  // none of them could be handed over; a count of nought would have said the
  // search found nothing, which is a different and untrue thing.
  assert.equal(answer.body.count, 6);
});

test("BRIDGE_MAX_RESOLVE=0 makes this bridge useless, honestly and at no cost", async () => {
  const http = stubHttp();
  const settings = settingsFrom({ BRIDGE_MAX_RESOLVE: "0" });
  const answer = await search(queryOf({ q: "bunny" }), http, settings, "https://b.example");

  // No magnet and no infohash means no TSP row. A private tracker publishes
  // neither, so switching off the one way to learn them empties the answer.
  assert.deepEqual(answer.body.torrents, []);
  assert.equal(http.asked.filter((one) => one.url.includes("/download/")).length, 0);
});

test("the .torrent is fetched with the RSS key and no session at all", async () => {
  const http = stubHttp();
  await search(queryOf({ q: "bunny", limit: 1 }), settingsFrom(), http, "https://b.example").catch(() => {});
  const withSettings = stubHttp();
  await search(queryOf({ q: "bunny", limit: 1 }), withSettings, settingsFrom(), "https://b.example");

  const file = withSettings.asked.find((one) => one.url.includes("/download/"));
  assert.match(file.url, new RegExp(`^${HOST}/rss/download/\\d+/${RSSKEY}/`));
  assert.equal(file.headers.Cookie, undefined);
});

test("without an RSS key the session fetches the file instead", async () => {
  const http = stubHttp();
  const settings = settingsFrom({ TL_RSSKEY: "" });
  await search(queryOf({ q: "bunny", limit: 1 }), http, settings, "https://b.example");

  const file = http.asked.find((one) => one.url.includes("/download/"));
  assert.match(file.url, new RegExp(`^${HOST}/download/\\d+/`));
  assert.equal(file.headers.Cookie, COOKIE);
});

test("an RSS key that is not one is refused rather than put in a URL", () => {
  const settings = settingsFrom({ TL_RSSKEY: "paste-went-wrong" });
  assert.equal(settings.trackers[0].rssKey, "");
  // And said out loud, because the fallback — fetching files with the session
  // instead — works, so a bad key is otherwise invisible until it is not.
  assert.equal(healthz(settings).trackers[0].torrentfile, "unusable rss key");
});

// ══ the session ═════════════════════════════════════════════════════════════

test("the session travels in a header and never in a URL", async () => {
  const http = stubHttp();
  await search(queryOf({ q: "bunny", limit: 2 }), http, settingsFrom(), "https://b.example");

  for (const request of http.asked) {
    assert.equal(request.url.includes("tlpass"), false, request.url);
    assert.equal(request.url.includes("tluid"), false, request.url);
  }
  const list = http.asked.find((one) => one.url.includes("/browse/list"));
  assert.equal(list.headers.Cookie, COOKIE);
});

test("only the cookies that could be a session are carried, and always in one order", () => {
  // A jar copied out of a browser is full of things that are not ours to
  // forward. Which of the kept ones *is* the session is the site's business:
  // its login page sets PHPSESSID today, and tluid/tlpass are the pair a
  // remember-me login used to add.
  const settings = settingsFrom({
    TL_COOKIE: "_ga=GA1.2.9; tluid=987654; consent=yes; tlpass=abcdef0123456789abcdef0123456789; cf_clearance=cf1",
  });
  assert.equal(settings.trackers[0].cookie, `${COOKIE}; cf_clearance=cf1`);

  // Pasted in any order, out in one order, so the same jar always writes the
  // same file.
  const jumbled = settingsFrom({ TL_COOKIE: "tlpass=bbb; cf_clearance=cf1; PHPSESSID=aaa; tluid=1" });
  assert.equal(jumbled.trackers[0].cookie, "PHPSESSID=aaa; tluid=1; tlpass=bbb; cf_clearance=cf1");
});

test("a login is judged by whether it works, not by which cookies it set", async () => {
  // The first version of this file looked for cookies called tluid and tlpass.
  // The login form has no remember-me control on it, so a good login sets
  // PHPSESSID and neither of those — and a working sign-in was reported as a
  // rejected one. This is that bug, held down.
  const http = stubHttp({ login: { status: 302, cookies: ["PHPSESSID=live-session; path=/; secure"] } });
  const settings = settingsFrom({ TL_COOKIE: "", TL_USERNAME: "someone", TL_PASSWORD: "secret" });

  const answer = await search(queryOf({ q: "bunny", limit: 1 }), http, settings, "https://b.example");
  assert.equal(answer.status, 200);
  assert.ok(answer.body.torrents.length);

  // Everything after the login carries what the login actually returned.
  const carried = http.asked.filter((one) => one.headers && one.headers.Cookie);
  assert.ok(carried.length);
  for (const request of carried) assert.equal(request.headers.Cookie, "PHPSESSID=live-session");
});

test("a login that did not take says what the tracker said, and never a value", async () => {
  const http = stubHttp({
    // Every read comes back as the login page, so the session proves useless.
    list: { status: 200, body: '<html><form name="login-form"></form></html>' },
    login: {
      status: 200,
      body: '<html><p class="text-danger">Invalid username or password.</p></html>',
      cookies: ["PHPSESSID=dead-session; path=/"],
    },
  });
  const settings = settingsFrom({ TL_COOKIE: "", TL_USERNAME: "someone", TL_PASSWORD: "wrong" });

  await assert.rejects(search(queryOf({ q: "x" }), http, settings, "https://b.example"), (thrown) => {
    assert.equal(thrown.code, "tracker_rejected_login");
    assert.match(thrown.detail, /HTTP 200/);
    assert.match(thrown.detail, /Invalid username or password/);
    // The cookie names, so a reader can see what came back — and never their
    // values, which are the session this file exists to keep to itself.
    assert.match(thrown.detail, /PHPSESSID/);
    assert.equal(thrown.detail.includes("dead-session"), false);
    return true;
  });
});

test("a cookie pasted in any of the usual shapes still reads", () => {
  assert.deepEqual(parseCookie("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookie("a=1\nb=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookie("  a = 1 ;b=2  "), { a: "1", b: "2" });
  assert.deepEqual(parseCookie("rubbish"), {});
});

test("Set-Cookie lines become a jar, attributes and all discarded", () => {
  assert.deepEqual(
    cookiesFrom([
      "tluid=987654; Path=/; HttpOnly; Secure",
      "tlpass=deadbeef; Expires=Wed, 21 Oct 2026 07:28:00 GMT; SameSite=Lax",
      "gone=; Max-Age=0",
    ]),
    { tluid: "987654", tlpass: "deadbeef", gone: "" },
  );
});

test("the whole login form is posted, not just the two boxes", () => {
  const html = `
    <form name="login-form" method="post">
      <input type="hidden" name="csrf" value="tok&amp;en">
      <input type="text" name="username" value="">
      <input type="password" name="password">
      <input type="checkbox" name="remember_me" value="1">
      <input type="checkbox" name="newsletter" value="1">
      <input type="submit" name="submit" value="Log in">
    </form>`;
  const fields = formInputs(html, "login-form");

  assert.equal(fields.csrf, "tok&en");
  // Without "remember me" the tracker issues a session that dies with the
  // browser, and there is no browser here.
  assert.equal(fields.remember_me, "1");
  // A checkbox nobody asked to tick is not ticked.
  assert.equal("newsletter" in fields, false);
  // A submit button is not a field.
  assert.equal("submit" in fields, false);
});

test("a lapsed cookie logs in again, once, and retries", async () => {
  let listCalls = 0;
  const http = stubHttp({
    list: () => {
      listCalls += 1;
      // The first ask gets a login page, which is how this tracker says no.
      return listCalls === 1
        ? { status: 200, body: '<html><form name="login-form"></form></html>' }
        : { status: 200, body: JSON.stringify(LIST) };
    },
    login: { status: 302, cookies: ["tluid=111; Path=/", "tlpass=222; Path=/"] },
  });

  const settings = settingsFrom({ TL_USERNAME: "someone", TL_PASSWORD: "secret" });
  const answer = await search(queryOf({ q: "bunny", limit: 1 }), http, settings, "https://b.example");
  assert.equal(answer.status, 200);
  assert.ok(answer.body.torrents.length);

  const posted = http.asked.find((one) => one.method === "POST");
  assert.match(posted.url, /\/user\/account\/login\//);
  assert.equal(posted.redirect, "manual");
  assert.match(posted.body, /username=someone/);
  assert.match(posted.body, /alt2FAToken=/);
  // The retry carries the cookies the login just handed back.
  assert.equal(http.asked.at(-1).headers.Cookie ?? http.asked.filter((o) => o.headers?.Cookie).at(-1).headers.Cookie, "tluid=111; tlpass=222");
  // Exactly one login. A second failure is a wrong password, not an expiry.
  assert.equal(http.asked.filter((one) => one.method === "POST").length, 1);
});

test("a lapsed cookie with nothing to log in with says exactly that", async () => {
  const http = stubHttp({ list: { status: 200, body: '<html><form name="login-form"></form></html>' } });
  await assert.rejects(
    search(queryOf({ q: "bunny" }), http, settingsFrom(), "https://b.example"),
    (thrown) => {
      assert.ok(thrown instanceof BridgeError);
      assert.equal(thrown.code, "not_configured");
      assert.match(thrown.detail, /TL_COOKIE/);
      assert.match(thrown.detail, /TL_USERNAME/);
      return true;
    },
  );
});

test("a login the tracker refuses is not reported as the client's fault", async () => {
  const http = stubHttp({
    list: { status: 200, body: '<html><form name="login-form"></form></html>' },
    login: { status: 200, body: '<html><p class="text-danger">Wrong</p></html>', cookies: [] },
  });
  const settings = settingsFrom({ TL_COOKIE: "", TL_USERNAME: "someone", TL_PASSWORD: "wrong" });

  await assert.rejects(search(queryOf({ q: "x" }), http, settings, "https://b.example"), (thrown) => {
    assert.equal(thrown.status, 502);
    assert.equal(thrown.code, "tracker_rejected_login");
    return true;
  });
});

test("a 2FA prompt names the setting that fixes it", async () => {
  const http = stubHttp({
    login: {
      status: 200,
      body: '<html><div class="login-container"><h2>One Time Password</h2></div></html>',
      cookies: [],
    },
  });
  const settings = settingsFrom({ TL_COOKIE: "", TL_USERNAME: "someone", TL_PASSWORD: "right" });

  await assert.rejects(search(queryOf({ q: "x" }), http, settings, "https://b.example"), (thrown) => {
    assert.equal(thrown.code, "tracker_rejected_login");
    assert.match(thrown.detail, /TL_2FA/);
    return true;
  });
});

test("a Cloudflare challenge is named as one, and says what to do about it", async () => {
  const http = stubHttp({
    list: { status: 403, body: "<html><title>Just a moment...</title><div id=\"challenge-platform\"></div></html>" },
  });
  await assert.rejects(search(queryOf({ q: "x" }), http, settingsFrom(), "https://b.example"), (thrown) => {
    assert.equal(thrown.code, "tracker_challenged");
    assert.match(thrown.detail, /no browser here/);
    return true;
  });
});

test("an unreachable tracker says which, and says it is a server fault", async () => {
  await assert.rejects(
    search(queryOf({ q: "x" }), stubHttp({ throws: true }), settingsFrom(), "https://b.example"),
    (thrown) => {
      assert.equal(thrown.status, 502);
      assert.equal(thrown.code, "tracker_unreachable");
      return true;
    },
  );
});

// ══ what the client is handed ═══════════════════════════════════════════════

test("the envelope is the shape a client expects", async () => {
  const answer = await search(queryOf({ q: "bunny", limit: 2 }), stubHttp(), settingsFrom(), "https://b.example");
  const body = answer.body;

  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(body).slice(0, 7), [
    "query", "count", "limit", "offset", "took_ms", "torrents", "engines",
  ]);
  assert.equal(body.query, "bunny");
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 0);
  assert.deepEqual(body.engines, ["TorrentLeech"]);
  // The tracker said it had more than this bridge can serve in one page, and
  // saying so is the difference between "no more" and "more, over there".
  assert.equal(body.total_found, LIST.numFound);
});

test("no answer ever carries a session, a passkey, or an RSS key", async () => {
  const settings = settingsFrom();
  const answer = await search(queryOf({ q: "bunny", limit: 3 }), stubHttp(), settings, "https://b.example");
  const text = JSON.stringify(answer.body);

  assert.equal(text.includes("tlpass"), false);
  assert.equal(text.includes("abcdef0123456789abcdef0123456789"), false);
  assert.equal(text.includes(RSSKEY), false);

  // The magnet is the one exception, and it is a deliberate one: a private
  // torrent's announce URL is the only tracker it can use, and the passkey is
  // in it. The README says not to paste one anywhere.
  assert.ok(text.includes(encodeURIComponent(ANNOUNCE)));
});

test("torrent_url points back here, and its token is opaque", async () => {
  const settings = settingsFrom({ BRIDGE_TORRENT_URLS: "1" });
  const answer = await search(queryOf({ q: "bunny", limit: 1 }), stubHttp(), settings, "https://b.example");
  const row = answer.body.torrents[0];

  assert.match(row.torrent_url, new RegExp(`^https://b\\.example/api/v1/torrentfile/${row.infohash}\\?t=`));
  const token = new URL(row.torrent_url).searchParams.get("t");
  assert.equal(token.includes(RSSKEY), false);
  assert.equal(token.includes("torrentleech"), false);

  // Sealed, not signed: it opens only with this bridge's own key.
  const opened = await unseal(settings, token);
  assert.match(opened.u, new RegExp(`^${HOST}/rss/download/`));
  assert.equal(await unseal(readSettings({ ...ENV, BRIDGE_API_KEY: "a-different-key-entirely" }), token), null);
});

test("the file behind torrent_url can actually be fetched", async () => {
  const settings = settingsFrom({ BRIDGE_TORRENT_URLS: "1" });
  const http = stubHttp();
  const answer = await search(queryOf({ q: "bunny", limit: 1 }), http, settings, "https://b.example");
  const row = answer.body.torrents[0];
  const url = new URL(row.torrent_url);

  const file = await torrentfile(row.infohash, url.searchParams, http, settings, {});
  assert.equal(file.status, 200);
  assert.equal(file.headers["Content-Type"], "application/x-bittorrent");
  // A file with a passkey in it is not something to leave in a shared cache.
  assert.equal(file.headers["Cache-Control"], "private, no-store");
  assert.ok(file.bytes.length > 0);
});

test("the torrentfile route refuses everything it should", async () => {
  const settings = settingsFrom({ BRIDGE_TORRENT_URLS: "1" });
  const http = stubHttp();
  const params = (token) => new URLSearchParams(token ? { t: token } : {});
  const hash = HASHES["1000001"];

  assert.equal((await torrentfile("nope", params("x"), http, settings, {})).status, 400);
  assert.equal((await torrentfile(hash, params(), http, settings, {})).status, 403);
  assert.equal((await torrentfile(hash, params("forged"), http, settings, {})).status, 403);

  // Expired.
  const stale = await seal(settings, { u: `${HOST}/rss/download/1000001/x/a.torrent`, e: Date.now() - 1 });
  assert.equal((await torrentfile(hash, params(stale), http, settings, {})).status, 403);

  // Minted for a host this bridge does not have, which is what stops this
  // becoming an open proxy for whatever a token happens to name.
  const elsewhere = await seal(settings, { u: "https://evil.example/x.torrent", e: Date.now() + 60000 });
  const refused = await torrentfile(hash, params(elsewhere), http, settings, {});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "bad_token");

  // The right token, the wrong infohash: the file is not the release the URL
  // claims, and a client that trusted the path would seed something else.
  const good = await seal(settings, {
    u: `${HOST}/rss/download/1000001/${RSSKEY}/a.torrent`,
    e: Date.now() + 60000,
  });
  const mismatch = await torrentfile(HASHES["1000004"], params(good), http, settings, {});
  assert.equal(mismatch.status, 409);
});

test("torrent_url is off unless asked for, because a client reads a promise into it", async () => {
  // A private tracker's .torrent has no web seeds — checked on a real one: no
  // url-list, no httpseeds, private: 1 — so it takes the *metadata* fetch off
  // the critical path and nothing else. Every byte still comes from peers. A
  // client that treats the field as "no peers needed" then hides the seeder
  // count on exactly the rows where it matters most.
  const off = await search(queryOf({ q: "bunny", limit: 2 }), stubHttp(), settingsFrom(), "https://b.example");
  assert.ok(off.body.torrents.length);
  for (const row of off.body.torrents) {
    assert.equal("torrent_url" in row, false);
    // The row is still whole: TSP wants a magnet and an infohash on every one,
    // and those came from reading the file either way.
    assert.match(row.infohash, /^[0-9a-f]{40}$/);
    assert.ok(row.magnet.startsWith("magnet:?xt=urn:btih:"));
    assert.ok(row.seeders !== undefined || row.leechers !== undefined);
  }

  const on = await search(
    queryOf({ q: "bunny", limit: 2 }), stubHttp(), settingsFrom({ BRIDGE_TORRENT_URLS: "1" }), "https://b.example",
  );
  assert.ok(on.body.torrents.every((row) => row.torrent_url));

  // And /healthz says which, because "why does every row say direct download"
  // is answered by that line.
  assert.equal(healthz(settingsFrom()).torrent_urls, false);
  assert.equal(healthz(settingsFrom({ BRIDGE_TORRENT_URLS: "1" })).torrent_urls, true);
});

test("paging is stable, and offset walks the merged set", async () => {
  const settings = settingsFrom({ BRIDGE_MAX_RESOLVE: "50" });
  const all = await search(queryOf({ q: "bunny", limit: 50 }), stubHttp(), settings, "https://b.example");
  const first = await search(queryOf({ q: "bunny", limit: 2 }), stubHttp(), settings, "https://b.example");
  const second = await search(queryOf({ q: "bunny", limit: 2, offset: 2 }), stubHttp(), settings, "https://b.example");

  assert.deepEqual(
    [...first.body.torrents, ...second.body.torrents].map((row) => row.infohash),
    all.body.torrents.slice(0, 4).map((row) => row.infohash),
  );
  assert.equal(first.body.count, all.body.count);
});

test("the filters the tracker has no parameter for are applied here", async () => {
  const settings = settingsFrom({ BRIDGE_MAX_RESOLVE: "50" });
  const run = (extra) => search(queryOf({ q: "bunny", limit: 50, ...extra }), stubHttp(), settings, "https://b.example");

  const byYear = await run({ year: "2008" });
  assert.ok(byYear.body.torrents.length);
  assert.ok(byYear.body.torrents.every((row) => row.year === "2008"));

  const byRes = await run({ res: "2160p" });
  assert.ok(byRes.body.torrents.every((row) => row.resolution === "2160p"));

  const bySeeders = await run({ minSeeders: 100 });
  assert.ok(bySeeders.body.torrents.every((row) => row.seeders >= 100));

  const audio = await run({ cat: "audio" });
  assert.ok(audio.body.torrents.some((row) => row.name.includes("FLAC")));
  assert.equal(audio.body.torrents.some((row) => row.name.includes("Big Buck Bunny")), false);
});

test("a browse is cheap, and can be switched off entirely", async () => {
  const small = stubHttp();
  const answer = await search(queryOf({ q: "" }), small, settingsFrom({ BRIDGE_BROWSE_ROWS: "2" }), "https://b.example");
  assert.ok(answer.body.torrents.length <= 2);

  const none = stubHttp();
  const empty = await search(queryOf({ q: "" }), none, settingsFrom({ BRIDGE_BROWSE_ROWS: "0" }), "https://b.example");
  assert.deepEqual(empty.body.torrents, []);
  assert.equal(none.asked.length, 0, "an empty search asked the tracker nothing");
});

// ══ the frozen answer ═══════════════════════════════════════════════════════

test("the frozen answer has not moved", async () => {
  const settings = settingsFrom({ BRIDGE_MAX_RESOLVE: "50" });
  const answer = await search(queryOf({ q: "", limit: 50 }), stubHttp(), settings, "https://bridge.example");

  const frozen = JSON.parse(JSON.stringify(answer.body));
  // Two fields are the clock rather than the answer.
  delete frozen.took_ms;
  for (const row of frozen.torrents) delete row.scraped_at;
  // The sealed token carries a random nonce, so it differs every run. That it
  // is there, and where it points, is asserted above.
  for (const row of frozen.torrents) {
    if (row.torrent_url) row.torrent_url = row.torrent_url.replace(/\?t=.*$/, "?t=<sealed>");
  }
  const text = JSON.stringify(frozen, null, 2) + "\n";

  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN_PATH, text);
    return;
  }
  assert.equal(text, readFileSync(GOLDEN_PATH, "utf8"));
});

// ══ the routes ══════════════════════════════════════════════════════════════

test("a missing key is 401, a wrong one is 403, and neither reaches the tracker", async () => {
  const http = stubHttp();
  const settings = settingsFrom();

  const missing = await handle("GET", "https://b.example/api/v1/search?q=x", headersOf(), http, settings);
  assert.equal(missing.status, 401);
  const wrong = await handle(
    "GET", "https://b.example/api/v1/search?q=x", headersOf({ "X-API-Key": "no" }), http, settings,
  );
  assert.equal(wrong.status, 403);
  assert.equal(http.asked.length, 0);

  // Bearer is accepted too, because a generic HTTP client reaches for it.
  const bearer = await handle(
    "GET", "https://b.example/api/v1/search?q=bunny&limit=1",
    headersOf({ Authorization: `Bearer ${KEY}` }), http, settings,
  );
  assert.equal(bearer.status, 200);
});

test("a key too short to be safe refuses to serve at all", async () => {
  const settings = settingsFrom({ BRIDGE_API_KEY: "short" });
  const answer = await handle(
    "GET", "https://b.example/api/v1/search?q=x", headersOf({ "X-API-Key": "short" }), stubHttp(), settings,
  );
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, "api_key_too_short");
});

test("a key is compared in constant time", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

test("/healthz needs no key, asks nothing, and names no credential", async () => {
  const http = stubHttp();
  const answer = await handle("GET", "https://b.example/healthz", headersOf(), http, settingsFrom());

  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, "ok");
  assert.deepEqual(answer.body.trackers, [
    { id: "torrentleech", auth: "cookie", torrentfile: "rss key", status: "ok" },
  ]);
  assert.equal(http.asked.length, 0);
  assert.equal(JSON.stringify(answer.body).includes(RSSKEY), false);
  assert.equal(JSON.stringify(answer.body).includes("tlpass"), false);
});

test("/healthz names what is missing before anything is deployed", () => {
  assert.equal(healthz(readSettings({})).status, "not_configured");
  assert.equal(healthz(readSettings({})).api_key, "missing");
  assert.deepEqual(healthz(readSettings({})).trackers, []);

  const noSession = healthz(readSettings({ BRIDGE_API_KEY: KEY, TL_RSSKEY: RSSKEY }));
  assert.equal(noSession.status, "not_configured");
  assert.deepEqual(noSession.trackers, [
    { id: "torrentleech", auth: "none", torrentfile: "rss key", status: "no_session" },
  ]);
});

test("/healthz?probe=1 needs the key, and asks the tracker for real", async () => {
  const settings = settingsFrom();
  const refused = await handle("GET", "https://b.example/healthz?probe=1", headersOf(), stubHttp(), settings);
  assert.equal(refused.status, 401);

  const http = stubHttp();
  const answer = await handle(
    "GET", "https://b.example/healthz?probe=1", headersOf({ "X-API-Key": KEY }), http, settings,
  );
  assert.equal(answer.body.status, "ok");
  assert.equal(answer.body.trackers[0].authenticated, true);
  assert.equal(answer.body.trackers[0].catalogue, LIST.numFound);
  assert.ok(http.asked.length >= 1);
});

test("/healthz?probe=1 is where a dead session actually shows up", async () => {
  const http = stubHttp({ list: { status: 200, body: '<html><form name="login-form"></form></html>' } });
  const report = await probe(http, settingsFrom());

  assert.equal(report.status, "degraded");
  assert.equal(report.trackers[0].authenticated, false);
  assert.equal(report.trackers[0].code, "not_configured");
  assert.match(report.detail, /TL_COOKIE|TL_USERNAME/);
});

test("a query the contract does not allow is refused before the tracker is asked", async () => {
  const http = stubHttp();
  const settings = settingsFrom();
  const ask = (qs) => handle("GET", `https://b.example/api/v1/search?${qs}`, headersOf({ "X-API-Key": KEY }), http, settings);

  assert.equal((await ask("q=x&cat=nonsense")).body.error, "invalid_cat");
  assert.equal((await ask("q=x&sort=nonsense")).body.error, "invalid_sort");
  assert.equal((await ask("q=x&res=9000p")).body.error, "invalid_res");
  assert.equal((await ask("q=x&year=99")).body.error, "invalid_year");
  assert.equal(http.asked.length, 0);

  // Numbers are clamped rather than rejected: a 422 is not in the retry contract.
  assert.equal(readQuery(new URLSearchParams("limit=9999")).limit, 200);
  assert.equal(readQuery(new URLSearchParams("limit=0")).limit, 1);
  assert.equal(readQuery(new URLSearchParams("offset=-5")).offset, 0);
  assert.equal(readQuery(new URLSearchParams("limit=abc")).limit, 50);
});

test("the odd routes behave", async () => {
  const settings = settingsFrom();
  const http = stubHttp();
  const get = (path, headers = {}) => handle("GET", `https://b.example${path}`, headersOf(headers), http, settings);

  assert.equal((await get("/nowhere")).status, 404);
  assert.equal((await handle("POST", "https://b.example/api/v1/search", headersOf(), http, settings)).status, 405);
  assert.equal((await handle("OPTIONS", "https://b.example/api/v1/search", headersOf(), http, settings)).status, 204);

  // A bridge into somebody's tracker account should never be indexed.
  const robots = await get("/robots.txt");
  assert.match(robots.text, /Disallow: \//);

  // A browser gets the page that closes the setup loop; curl gets plain text.
  const page = await get("/", { accept: "text/html" });
  assert.match(page.headers["Content-Type"], /text\/html/);
  assert.equal(page.headers["X-Robots-Tag"], "noindex");
  const plain = await get("/");
  assert.match(plain.text, /Tracker bridge/);

  // Trailing slashes are the same route.
  assert.equal((await get("/healthz/")).status, 200);
});

test("the landing page shows a URL and never a key", () => {
  const page = landingPage("bridge.example", false);
  assert.ok(page.includes("bridge.example"));
  assert.equal(page.includes(KEY), false);
  assert.equal(page.includes(RSSKEY), false);
  // Only inside the setup window does it take you back by itself.
  assert.equal(page.includes("location.replace"), false);
  assert.ok(landingPage("bridge.example", true).includes("location.replace"));
});

test("CORS is granted to named origins and to nobody else", async () => {
  const settings = settingsFrom({ BRIDGE_CORS_ORIGINS: "https://app.example" });
  const http = stubHttp();
  const from = (origin) =>
    handle("OPTIONS", "https://b.example/api/v1/search", headersOf({ origin }), http, settings);

  assert.equal((await from("https://app.example")).headers["Access-Control-Allow-Origin"], "https://app.example");
  // The setup page, always, so it can test a bridge the moment it is deployed.
  assert.equal(
    (await from("https://momzv2022-ctrl.github.io")).headers["Access-Control-Allow-Origin"],
    "https://momzv2022-ctrl.github.io",
  );
  assert.equal((await from("https://elsewhere.example")).headers["Access-Control-Allow-Origin"], undefined);
});

test("a tracker with nothing configured is switched off rather than broken", () => {
  assert.deepEqual(readSettings({ BRIDGE_API_KEY: KEY }).trackers, []);
  // And one can be switched off by name, which is the seam the next tracker
  // arrives through.
  assert.deepEqual(readSettings({ ...ENV, BRIDGE_TRACKERS: "somethingelse" }).trackers, []);
  assert.equal(readSettings({ ...ENV, BRIDGE_TRACKERS: "torrentleech" }).trackers.length, 1);
});

test("a reply renders for either runtime", () => {
  assert.deepEqual(render({ status: 204, body: null, headers: {}, text: null, bytes: null }), [204, null, {}]);
  const [status, body, headers] = render({ status: 200, body: { a: 1 }, headers: {}, text: null, bytes: null });
  assert.equal(status, 200);
  assert.equal(body, '{"a":1}');
  assert.equal(headers["Content-Type"], "application/json");
  // Bytes never go near a string: re-encoding would corrupt the info dict, and
  // with it the infohash the client is about to trust.
  const raw = new Uint8Array([1, 2, 3]);
  assert.equal(render({ status: 200, body: null, headers: {}, text: null, bytes: raw })[1], raw);
});

// ══ the row shape, shared with the sibling projects ═════════════════════════

test("the name parser reads the six fields the contract carries", () => {
  assert.deepEqual(parseName("Some.Show.S02E07.1080p.WEB-DL.x265-GRP"), {
    resolution: "1080p", codec: "x265", source: "web-dl", season: "02", episode: "07",
  });
  // A film called 2012, released in 2009: the year is the one before the first
  // quality marker, not the one in the title.
  assert.equal(parseName("2012.2009.1080p.BluRay.x264").year, "2009");
});

test("a name that says nothing is kept by a category filter, not dropped", () => {
  assert.equal(classifyName("Some Release Nobody Tagged"), null);
  const rows = [{ name: "Some Release Nobody Tagged", seeders: 5, category: null, meta: null }];
  assert.equal(applyFilters(rows, { category: "video" }).length, 1);
});

test("a synthesised magnet is the one the sibling projects would have made", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const magnet = magnetFor(hash, "Some Name");
  assert.ok(magnet.startsWith(`magnet:?xt=urn:btih:${hash}&dn=Some%20Name&tr=`));
  assert.equal((magnet.match(/&tr=/g) || []).length, 5);
});

test("a row with no infohash is not a row", async () => {
  assert.equal(await toTorrent({ infohash: null, name: "x", sources: [], meta: null }, "now"), null);
});

test("merge keeps the earliest sighting and every contributing source", () => {
  const row = (extra) => ({
    name: "Same Release", infohash: "a".repeat(40), sizeBytes: 1, files: null, seeders: null,
    leechers: null, category: null, descriptionUrl: null, sources: [], meta: null, ...extra,
  });
  const [merged] = merge([
    row({ seeders: 3, firstSeen: "2024-01-02T00:00:00Z", sources: ["A"] }),
    row({ seeders: 9, firstSeen: "2023-01-02T00:00:00Z", sources: ["B"] }),
  ]);
  assert.equal(merged.seeders, 9);
  assert.equal(merged.firstSeen, "2023-01-02T00:00:00Z");
  assert.deepEqual(merged.sources, ["A", "B"]);
});

// ══ your own UTSI: the public indexes, in the same list ══════════════════════

test("UTSI is asked in TSP, with the key in a header and the filters along for the ride", async () => {
  const http = stubHttp();
  await search(
    queryOf({ q: "big.buck.bunny", cat: "video", year: "2008", res: "1080p", minSeeders: 5, sort: "size", limit: 10, offset: 20 }),
    http, settingsFrom(WITH_UTSI), "https://b.example",
  );
  const asked = http.asked.find((one) => one.url.startsWith(UTSI_URL));
  assert.ok(asked, "UTSI was not asked");
  const url = new URL(asked.url);
  // The trailing slash on the setting did not double up the path.
  assert.equal(url.pathname, "/api/v1/search");
  assert.equal(url.searchParams.get("q"), "big buck bunny");
  assert.equal(url.searchParams.get("cat"), "video");
  assert.equal(url.searchParams.get("year"), "2008");
  assert.equal(url.searchParams.get("res"), "1080p");
  assert.equal(url.searchParams.get("min_seeders"), "5");
  assert.equal(url.searchParams.get("sort"), "size");
  // A fixed number of rows whatever page was asked for, and never an offset:
  // paging happens here, over the merged set. See utsiSearchUrl.
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("offset"), null);
  // The key travels in a header, and TorrentLeech's session does not travel.
  assert.equal(asked.headers["X-API-Key"], UTSI_KEY);
  assert.equal(asked.headers.Cookie, undefined);
  assert.equal(asked.url.includes(UTSI_KEY), false);

  const fewer = stubHttp();
  await search(queryOf({ q: "x" }), fewer, settingsFrom({ ...WITH_UTSI, UTSI_ROWS: "30" }), "https://b.example");
  const again = fewer.asked.find((one) => one.url.startsWith(UTSI_URL));
  assert.equal(new URL(again.url).searchParams.get("limit"), "30");
});

test("both are asked at once, and a public row costs no request at all", async () => {
  const http = stubHttp();
  const answer = await search(
    queryOf({ q: "sintel", limit: 50 }), http, settingsFrom({ ...WITH_UTSI, BRIDGE_MAX_RESOLVE: "50" }), "https://b.example",
  );
  const rows = answer.body.torrents;

  const sintel = rows.find((row) => row.name === "Sintel 2010 1080p WEB-DL x264-PUBLIC");
  assert.ok(sintel, "the public row is missing");
  // Its magnet is the one UTSI made: the same function, the same public five.
  assert.equal(sintel.magnet, magnetFor(sintel.infohash, sintel.name));
  assert.equal(sintel.infohash, "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
  assert.equal(sintel.private, undefined);
  assert.equal(sintel.indexer, "UTSI");
  assert.deepEqual(sintel.sources, ["UTSI/yts"]);
  assert.equal(sintel.seeders, 3200);
  assert.equal(sintel.year, "2010");
  assert.equal(sintel.description_url, "https://public.example/torrent/sintel-1080p");

  // A base32 magnet with no infohash field is still a row, its noughts are
  // absences, and it has no engine to name. A row with nothing is not a row.
  const cosmos = rows.find((row) => row.name === "Cosmos Laundromat 2015 2160p");
  assert.equal(cosmos.infohash, normalizeInfohash("XKCD2WKWSYQMH7ZNKRWN2TVTYQOQMBAK"));
  assert.equal(cosmos.size_bytes, undefined);
  assert.equal(cosmos.files, undefined);
  assert.deepEqual(cosmos.sources, ["UTSI"]);
  assert.equal(rows.some((row) => row.name === "A Row With Nothing To Identify It"), false);

  // Every file that was read was TorrentLeech's. Nothing was fetched for a
  // public row, and nothing counted against BRIDGE_MAX_RESOLVE for one.
  const files = http.asked.filter((one) => one.url.includes("/download/"));
  assert.ok(files.length);
  assert.ok(files.every((one) => one.url.startsWith(HOST)));
  assert.equal(answer.body.unresolved, undefined);

  // And a TorrentLeech row says what it is.
  const tl = rows.find((row) => row.indexer === "TorrentLeech");
  assert.equal(tl.private, true);
  assert.ok(tl.magnet.includes(encodeURIComponent(ANNOUNCE)));

  assert.deepEqual(answer.body.engines, [
    "TorrentLeech", "UTSI", "UTSI/knaben", "UTSI/piratebay", "UTSI/torrentscsv", "UTSI/yts",
  ]);
  // What each side said it had, added up.
  assert.equal(answer.body.total_found, LIST.numFound + 214);
});

test("the same release on both sides is one row, and the private copy says where the swarm is", async () => {
  const answer = await search(
    queryOf({ q: "bunny", limit: 50 }), stubHttp(), settingsFrom({ ...WITH_UTSI, BRIDGE_MAX_RESOLVE: "50" }), "https://b.example",
  );
  const bunnies = answer.body.torrents.filter((row) => row.infohash === HASHES["1000001"]);
  assert.equal(bunnies.length, 1);
  const [bunny] = bunnies;

  // One infohash is one info dict, `private` flag included: the swarm is the
  // tracker's, and the magnet announces there and nowhere else.
  assert.equal(bunny.private, true);
  assert.equal(bunny.indexer, "TorrentLeech");
  assert.ok(bunny.magnet.includes(encodeURIComponent(ANNOUNCE)));
  assert.equal((bunny.magnet.match(/&tr=/g) || []).length, 1);
  // The best of each field, and everyone who had it.
  assert.equal(bunny.seeders, 1500);
  assert.equal(bunny.name, "Big Buck Bunny 2008 1080p BluRay x264-GROUP [REPOST]");
  assert.deepEqual(bunny.sources, ["TorrentLeech", "UTSI/knaben", "UTSI/piratebay"]);
  assert.equal(bunny.first_seen, "2020-06-01T00:00:00Z");
});

test("one side failing degrades the answer rather than failing it", async () => {
  const query = () => queryOf({ q: "bunny", limit: 5 });

  const utsiDown = await search(query(), stubHttp({ utsi: { status: 500, body: "boom" } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.equal(utsiDown.status, 200);
  assert.ok(utsiDown.body.torrents.length);
  assert.ok(utsiDown.body.torrents.every((row) => row.indexer === "TorrentLeech"));
  assert.deepEqual(utsiDown.body.degraded, ["UTSI: Your UTSI answered HTTP 500."]);

  const tlDown = await search(query(), stubHttp({ list: { status: 500, body: "" } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.equal(tlDown.status, 200);
  assert.ok(tlDown.body.torrents.length);
  assert.ok(tlDown.body.torrents.every((row) => row.indexer === "UTSI"));
  assert.match(tlDown.body.degraded[0], /^TorrentLeech: /);

  const gone = stubHttp({ utsi: () => { throw new TypeError("fetch failed"); } });
  const unreachable = await search(query(), gone, settingsFrom(WITH_UTSI), "https://b.example");
  assert.equal(unreachable.status, 200);
  assert.match(unreachable.body.degraded[0], /^UTSI: Could not reach https:\/\/utsi-abc123/);

  // Both down is the error, and it is a server fault.
  await assert.rejects(
    search(query(), stubHttp({ list: { status: 500, body: "" }, utsi: { status: 500, body: "" } }), settingsFrom(WITH_UTSI), "https://b.example"),
    (thrown) => thrown instanceof BridgeError && thrown.status === 502,
  );
});

test("a UTSI key that does not fit is named after the setting, and never shown", async () => {
  const query = () => queryOf({ q: "bunny", limit: 2 });

  const wrong = await search(query(), stubHttp({ utsi: { status: 403, body: '{"error":"invalid_api_key"}' } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.match(wrong.body.degraded[0], /^UTSI: Your UTSI rejected the key: UTSI_API_KEY /);
  assert.equal(JSON.stringify(wrong.body).includes(UTSI_KEY), false);

  const unset = await search(query(), stubHttp({ utsi: { status: 401, body: "{}" } }), settingsFrom({ UTSI_URL }), "https://b.example");
  assert.match(unset.body.degraded[0], /UTSI_API_KEY is not set/);

  const lost = await search(query(), stubHttp({ utsi: { status: 401, body: "{}" } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.match(lost.body.degraded[0], /saw none/);

  const throttled = await search(query(), stubHttp({ utsi: { status: 429, body: "" } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.match(throttled.body.degraded[0], /HTTP 429/);
});

test("a UTSI that is not one is refused rather than read", async () => {
  const query = () => queryOf({ q: "bunny", limit: 2 });
  const page = await search(query(), stubHttp({ utsi: { status: 200, body: "<html>a page</html>" } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.match(page.body.degraded[0], /was not a TSP search result/);
  const shape = await search(query(), stubHttp({ utsi: { status: 200, body: '{"hello":"world"}' } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.match(shape.body.degraded[0], /was not a TSP search result/);

  // A 404 is an origin with no such route, which is the page that made the
  // UTSI rather than the UTSI. It says so, and names the Worker's own address.
  const wrongPlace = await search(query(), stubHttp({ utsi: { status: 404, body: '{"error":"not_found"}' } }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.match(wrongPlace.body.degraded[0], /^UTSI: Your UTSI answered HTTP 404: there is no \/api\/v1\/search at https:\/\/utsi-abc123/);
  assert.match(wrongPlace.body.degraded[0], /workers\.dev address its setup page showed you, not that page/);
});

test("torrent_url from UTSI: sealed on its own origin, passed through from a public host, gone when off", async () => {
  const settings = settingsFrom({ ...WITH_UTSI, BRIDGE_TORRENT_URLS: "1", BRIDGE_MAX_RESOLVE: "50" });
  const on = await search(queryOf({ q: "x", limit: 50 }), stubHttp(), settings, "https://b.example");

  // On UTSI's origin the file needs UTSI's key, which the client does not
  // have, so it is served from here, sealed, the way a TorrentLeech file is.
  const ubuntu = on.body.torrents.find((row) => row.name === "Ubuntu 24.04 Desktop amd64");
  assert.match(ubuntu.torrent_url, new RegExp(`^https://b\\.example/api/v1/torrentfile/${UBUNTU.infohash}\\?t=`));
  const token = new URL(ubuntu.torrent_url).searchParams.get("t");
  assert.equal(token.includes(UTSI_KEY), false);
  assert.equal(token.includes("utsi-abc123"), false);
  assert.equal((await unseal(settings, token)).u, `${UTSI_URL}/api/v1/torrentfile/${UBUNTU.infohash}?t=sealed-by-utsi`);

  // On a public host it needs nothing, and goes through as it came.
  const sintel = on.body.torrents.find((row) => row.name === "Sintel 2010 1080p WEB-DL x264-PUBLIC");
  assert.equal(sintel.torrent_url, "https://cdn.public.example/sintel-1080p.torrent");

  // A TorrentLeech row's is still sealed, and still points here.
  const tl = on.body.torrents.find((row) => row.indexer === "TorrentLeech");
  assert.match(tl.torrent_url, /^https:\/\/b\.example\/api\/v1\/torrentfile\//);

  const off = await search(queryOf({ q: "x", limit: 50 }), stubHttp(), settingsFrom(WITH_UTSI), "https://b.example");
  assert.ok(off.body.torrents.every((row) => row.torrent_url === undefined));
});

test("the file behind a sealed UTSI torrent_url is fetched with its key, and checked", async () => {
  const settings = settingsFrom({ ...WITH_UTSI, BRIDGE_TORRENT_URLS: "1", BRIDGE_MAX_RESOLVE: "50" });
  const found = await search(queryOf({ q: "x", limit: 50 }), stubHttp(), settings, "https://b.example");
  const ubuntu = found.body.torrents.find((row) => row.name === "Ubuntu 24.04 Desktop amd64");

  const http = stubHttp();
  const answer = await handle("GET", ubuntu.torrent_url, headersOf({ "X-API-Key": KEY }), http, settings);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["Content-Type"], "application/x-bittorrent");
  assert.deepEqual(answer.bytes, UBUNTU.bytes);
  const fetched = http.asked.find((one) => one.url.includes("/api/v1/torrentfile/"));
  assert.equal(fetched.url, `${UTSI_URL}/api/v1/torrentfile/${UBUNTU.infohash}?t=sealed-by-utsi`);
  assert.equal(fetched.headers["X-API-Key"], UTSI_KEY);
  assert.equal(fetched.headers.Cookie, undefined);

  // A file that is not the one asked for is refused.
  const other = stubHttp({ utsiFile: { body: torrentFor("Something Else").bytes } });
  const mismatch = await handle("GET", ubuntu.torrent_url, headersOf({ "X-API-Key": KEY }), other, settings);
  assert.equal(mismatch.status, 409);

  // UTSI refusing its key is named as that, not as a session.
  const refused = stubHttp({ utsiFile: { status: 403, body: "" } });
  const rejected = await handle("GET", ubuntu.torrent_url, headersOf({ "X-API-Key": KEY }), refused, settings);
  assert.equal(rejected.status, 502);
  assert.equal(rejected.body.detail, "UTSI refused this bridge's key.");
});

test("paging with UTSI in the mix is stable, and count is the same on every page", async () => {
  const settings = settingsFrom({ ...WITH_UTSI, BRIDGE_MAX_RESOLVE: "50" });
  // Without the row that collides, so that the page-local merge does not make
  // page one and the whole set disagree by design. See search().
  const options = { utsi: utsiAnswer({ collide: false }) };
  const all = await search(queryOf({ q: "bunny", limit: 50 }), stubHttp(options), settings, "https://b.example");
  const first = await search(queryOf({ q: "bunny", limit: 3 }), stubHttp(options), settings, "https://b.example");
  const second = await search(queryOf({ q: "bunny", limit: 3, offset: 3 }), stubHttp(options), settings, "https://b.example");

  assert.deepEqual(
    [...first.body.torrents, ...second.body.torrents].map((row) => row.infohash),
    all.body.torrents.slice(0, 6).map((row) => row.infohash),
  );
  assert.equal(first.body.count, all.body.count);
  assert.equal(second.body.count, all.body.count);
  // Both kinds of row are in those six, in one order.
  const kinds = new Set([...first.body.torrents, ...second.body.torrents].map((row) => row.indexer));
  assert.deepEqual([...kinds].sort(), ["TorrentLeech", "UTSI"]);
});

test("/healthz names UTSI without its URL or its key, and ?probe=1 asks it for real", async () => {
  const settings = settingsFrom(WITH_UTSI);
  const health = healthz(settings);
  assert.equal(health.status, "ok");
  assert.deepEqual(health.trackers.map((one) => one.id), ["torrentleech", "utsi"]);
  assert.deepEqual(health.trackers[1], { id: "utsi", auth: "key", torrentfile: "not needed", status: "ok" });
  const text = JSON.stringify(health);
  assert.equal(text.includes(UTSI_KEY), false);
  assert.equal(text.includes("utsi-abc123"), false);

  const http = stubHttp();
  const report = await probe(http, settings);
  assert.equal(report.status, "ok");
  const utsi = report.trackers.find((one) => one.tracker === "utsi");
  assert.equal(utsi.reachable, true);
  assert.equal(utsi.authenticated, true);
  assert.equal(utsi.host, UTSI_URL);
  assert.deepEqual(utsi.engines, ["knaben", "piratebay", "torrentscsv", "yts"]);
  assert.equal(utsi.matches, 214);
  const asked = http.asked.find((one) => one.url.startsWith(UTSI_URL));
  assert.equal(new URL(asked.url).searchParams.get("limit"), "1");
  assert.equal(asked.headers["X-API-Key"], UTSI_KEY);
  assert.equal(JSON.stringify(report).includes(UTSI_KEY), false);

  // A wrong key shows up here, and the whole bridge is "degraded", not "ok".
  const rejected = await probe(stubHttp({ utsi: { status: 403, body: "{}" } }), settings);
  assert.equal(rejected.status, "degraded");
  const bad = rejected.trackers.find((one) => one.tracker === "utsi");
  assert.equal(bad.reachable, true);
  assert.equal(bad.authenticated, false);
  assert.equal(bad.code, "utsi_rejected_key");
});

test("a UTSI URL that is not one is a fault it names, and TorrentLeech still searches", async () => {
  const settings = readSettings({
    ...ENV, BRIDGE_REQUEST_GAP_MS: "0", UTSI_URL: "utsi-abc123.someone.workers.dev", UTSI_API_KEY: UTSI_KEY,
  });
  const utsi = settings.trackers.find((one) => one.id === "utsi");
  assert.equal(utsi.problem, "bad_url");
  assert.equal(healthz(settings).trackers[1].status, "bad_url");

  const http = stubHttp();
  const answer = await search(queryOf({ q: "bunny", limit: 2 }), http, settings, "https://b.example");
  assert.equal(answer.status, 200);
  assert.equal(http.asked.some((one) => one.url.includes("utsi-abc123")), false);

  const report = await probe(stubHttp(), settings);
  assert.equal(report.trackers[1].detail, "UTSI_URL is not an https:// address.");
});

test("UTSI alone is a bridge with no tracker session at all, and never touches TorrentLeech", async () => {
  const settings = readSettings({ BRIDGE_API_KEY: KEY, BRIDGE_REQUEST_GAP_MS: "0", ...WITH_UTSI });
  assert.deepEqual(settings.trackers.map((one) => one.id), ["utsi"]);
  assert.equal(healthz(settings).status, "ok");

  const http = stubHttp();
  const answer = await search(queryOf({ q: "sintel", limit: 50 }), http, settings, "https://b.example");
  assert.ok(answer.body.torrents.length);
  assert.ok(http.asked.every((one) => one.url.startsWith(UTSI_URL)));
  assert.ok(answer.body.torrents.every((row) => row.indexer === "UTSI"));

  // And the other way round: BRIDGE_TRACKERS keeps a configured UTSI out.
  const only = settingsFrom({ ...WITH_UTSI, BRIDGE_TRACKERS: "torrentleech" });
  assert.deepEqual(only.trackers.map((one) => one.id), ["torrentleech"]);
});

test("a browse asks UTSI for the browse rows, and nothing when browsing is off", async () => {
  const some = stubHttp();
  await search(queryOf({ q: "" }), some, settingsFrom({ ...WITH_UTSI, BRIDGE_BROWSE_ROWS: "2" }), "https://b.example");
  const asked = some.asked.find((one) => one.url.startsWith(UTSI_URL));
  assert.equal(new URL(asked.url).searchParams.get("q"), "");
  assert.equal(new URL(asked.url).searchParams.get("limit"), "2");

  const none = stubHttp();
  await search(queryOf({ q: "" }), none, settingsFrom({ ...WITH_UTSI, BRIDGE_BROWSE_ROWS: "0" }), "https://b.example");
  assert.equal(none.asked.length, 0);
});

test("a partial answer from UTSI is passed along as one", async () => {
  const cut = utsiAnswer();
  cut.partial = true;
  const partial = await search(queryOf({ q: "bunny", limit: 5 }), stubHttp({ utsi: cut }), settingsFrom(WITH_UTSI), "https://b.example");
  assert.equal(partial.body.partial, true);
  const whole = await search(queryOf({ q: "bunny", limit: 5 }), stubHttp(), settingsFrom(WITH_UTSI), "https://b.example");
  assert.equal(whole.body.partial, undefined);
});

test("no answer with UTSI in it carries its key, its URL, or a session", async () => {
  const settings = settingsFrom({ ...WITH_UTSI, BRIDGE_TORRENT_URLS: "1", BRIDGE_MAX_RESOLVE: "50" });
  const answer = await search(queryOf({ q: "bunny", limit: 50 }), stubHttp(), settings, "https://b.example");
  const text = JSON.stringify(answer.body);
  assert.equal(text.includes(UTSI_KEY), false);
  assert.equal(text.includes("utsi-abc123"), false);
  assert.equal(text.includes("tlpass"), false);
  assert.equal(text.includes(RSSKEY), false);
});

// ══ the frozen combined answer ═════════════════════════════════════════════

test("the frozen combined answer has not moved", async () => {
  const settings = settingsFrom({ ...WITH_UTSI, BRIDGE_MAX_RESOLVE: "50", BRIDGE_TORRENT_URLS: "1" });
  const answer = await search(queryOf({ q: "bunny", limit: 50 }), stubHttp(), settings, "https://bridge.example");

  const frozen = JSON.parse(JSON.stringify(answer.body));
  delete frozen.took_ms;
  for (const row of frozen.torrents) delete row.scraped_at;
  for (const row of frozen.torrents) {
    if (row.torrent_url) row.torrent_url = row.torrent_url.replace(/\?t=.*$/, "?t=<sealed>");
  }
  const text = JSON.stringify(frozen, null, 2) + "\n";

  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(COMBINED_PATH, text);
    return;
  }
  assert.equal(text, readFileSync(COMBINED_PATH, "utf8"));
});
