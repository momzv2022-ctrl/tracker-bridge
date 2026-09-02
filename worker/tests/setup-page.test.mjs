/**
 * The setup page, checked without a browser.
 *
 * `worker/tools/check-page.mjs` opens the built page in a real Chromium and
 * presses every button; it is the better test and it needs a browser. This is
 * the half that does not, so it runs on every push, on every Node, in a second:
 * the page's claims about itself, and the joins between the three files that
 * have to agree — the artifact, the build, and the page.
 *
 * The joins matter more than they look. The page rewrites ten exact lines of
 * a 3,000-line file by string match. If any of them is renamed and only two of
 * the three files hear about it, the page deploys a Worker with a credential
 * silently missing, and the first sign of it is a search that returns nothing.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bothLinks, compressToEncodedURIComponent, suggestedName } from "../tools/playground.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const WORKER = readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8");
const PAGE = readFileSync(join(REPO, "worker", "tools", "setup-page.html"), "utf8");
const BUILD = readFileSync(join(REPO, "worker", "tools", "build.mjs"), "utf8");
const PLAYGROUND = readFileSync(join(REPO, "worker", "tools", "playground.js"), "utf8");

/**
 * The ten lines the whole scheme rests on.
 *
 * Named here, and then each of the three files is checked against this list
 * rather than against each other, so a rename fails in one obvious place.
 */
const BLANKS = [
  ['const BRIDGE_KEY = "";', "the client's own key"],
  ['const TL_COOKIE = "";', "a pasted TorrentLeech session"],
  ['const TL_RSSKEY = "";', "the RSS key that fetches .torrent files"],
  ['const TL_USERNAME = "";', "a username, for the route that logs in"],
  ['const TL_PASSWORD = "";', "and its password"],
  ['const TL_2FA = "";', "the alt 2FA token, when the account has 2FA"],
  ['const UTSI_URL = "";', "a UTSI of your own, for the public indexes"],
  ['const UTSI_KEY = "";', "and its key"],
  ["const ANNOUNCE_HTTP = 0;", "whether to announce over http, for clients that cannot do TLS"],
  ["const SETUP_UNTIL = 0;", "how long the bridge assumes setup is in progress"],
];

test("the committed artifact carries every setting empty", () => {
  for (const [line, why] of BLANKS) {
    const found = WORKER.split("\n").filter((one) => one === line).length;
    assert.equal(found, 1, `${line} (${why}) appears ${found} times in worker.js, not once`);
  }
});

test("the build refuses an artifact that does not, and the page agrees with the build", () => {
  for (const [line] of BLANKS) {
    const name = /^const (\w+)/.exec(line)[1];
    // build.mjs names them in BLANK_LINES; the page names them in BLANKS.
    assert.match(BUILD, new RegExp(`\\["${name}",`), `build.mjs does not guard ${name}`);
    assert.ok(PAGE.includes(line), `the setup page does not rewrite ${name}`);
  }
  // And nothing rewrites a line that is not on the list, which is the other
  // half of the same guarantee.
  const rewritten = [...PAGE.matchAll(/^\s+(\w+): ["']const (\w+) = /gmu)].map((one) => one[2]);
  assert.deepEqual(
    [...new Set(rewritten)].sort(),
    BLANKS.map(([line]) => /^const (\w+)/.exec(line)[1]).sort(),
  );
});

test("the build refuses a filled-in artifact rather than publishing one", () => {
  // The one check worth running for real rather than reading: a published page
  // carrying somebody's session would be that session handed to everyone who
  // ever opened it.
  const node = process.execPath;
  const dirty = WORKER.replace('const TL_COOKIE = "";', 'const TL_COOKIE = "tluid=1; tlpass=leaked";');
  assert.notEqual(dirty, WORKER);
  const script = `
    import { writeFileSync, mkdtempSync, cpSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const room = mkdtempSync(join(tmpdir(), "tb-"));
    cpSync(${JSON.stringify(REPO)}, room, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes("/.git") });
    writeFileSync(join(room, "worker/src/worker.js"), ${JSON.stringify(dirty)});
    try {
      await import(new URL("file://" + join(room, "worker/tools/build.mjs")).href);
      console.log("BUILT");
    } catch (thrown) {
      console.log("REFUSED: " + thrown.message);
    }
  `;
  const out = execFileSync(node, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.match(out, /^REFUSED: /m, `the build published a file with a session in it:\n${out}`);
  assert.match(out, /TL_COOKIE/);
});

test("the page carries the placeholders the build fills in, and no others", () => {
  for (const placeholder of ["__PLAYGROUND_LIB__", "__WORKER_SOURCE__", "__SHA256__", "__VERSION__"]) {
    assert.ok(PAGE.includes(placeholder), `the page has no ${placeholder}`);
    assert.ok(BUILD.includes(placeholder), `the build does not fill in ${placeholder}`);
  }
  const leftovers = [...PAGE.matchAll(/__[A-Z0-9_]+__/gu)].map((one) => one[0]);
  assert.deepEqual(
    [...new Set(leftovers)].sort(),
    ["__PLAYGROUND_LIB__", "__SHA256__", "__VERSION__", "__WORKER_SOURCE__"],
  );
});

test("the page loads nothing from anywhere", () => {
  // The claim the page makes about itself, held to the markup. check-page.mjs
  // proves the running page makes no request; this proves there is nothing in
  // the source that could.
  const html = PAGE.replace(/<script>[\s\S]*?<\/script>/gu, "");
  assert.equal(/<script[^>]+\bsrc=/iu.test(html), false, "the page loads a script");
  assert.equal(/<link[^>]+\brel=["']?stylesheet/iu.test(html), false, "the page loads a stylesheet");
  assert.equal(/<img\b/iu.test(html), false, "the page loads an image");
  assert.equal(/<iframe\b/iu.test(html), false, "the page embeds a frame");
  assert.equal(/@import|url\(\s*https?:/iu.test(html), false, "the stylesheet fetches something");
});

test("the page never writes a tracker credential to storage", () => {
  // It stores exactly one thing, and it is the key it minted itself. A session
  // or a password left in localStorage would outlive the tab it was typed in.
  const stored = [...PAGE.matchAll(/localStorage\.setItem\(([^,]+),/gu)].map((one) => one[1].trim());
  assert.deepEqual(stored, ["STORE"]);
  assert.match(PAGE, /var STORE = "tracker-bridge\.key\.v1";/);
  for (const name of ["tl-cookie", "tl-username", "tl-password", "tl-2fa", "tl-rsskey", "utsi-url", "utsi-key"]) {
    assert.equal(
      new RegExp(`setItem\\([^)]*${name}`, "u").test(PAGE), false,
      `the page stores ${name}`,
    );
  }
});

test("every element the page's script reaches for is in the page", () => {
  const markup = PAGE.replace(/<script>[\s\S]*?<\/script>/gu, "");
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/gu)].map((one) => one[1]));
  const wanted = [...PAGE.matchAll(/byId\("([^"]+)"\)/gu)].map((one) => one[1]);
  const missing = [...new Set(wanted)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `the script reads ids that do not exist: ${missing.join(", ")}`);
});

test("the page inlines playground.js rather than keeping a second copy", () => {
  // The build strips `export` and splices the file in. A page with its own copy
  // would drift from the module the tests and the command line use, and the
  // first sign of it would be a deploy link Cloudflare rejects.
  assert.ok(PAGE.includes("__PLAYGROUND_LIB__"));
  assert.equal(/\bfunction compressToEncodedURIComponent\b/u.test(PAGE), false);
  assert.equal(/\bimport\b|\brequire\(/u.test(PLAYGROUND), false, "playground.js gained a dependency");
});

test("a deploy link and a playground link carry the same program to two places", () => {
  const links = bothLinks("export default { fetch() {} }", { boundary: "----WebKitFormBoundaryFixed0000" });
  assert.ok(links.deploy.startsWith("https://dash.cloudflare.com/workers-and-pages/deploy/playground/"));
  assert.ok(links.playground.startsWith("https://workers.cloudflare.com/playground#"));
  assert.equal(links.deploy.split("#")[1], links.playground.split("#")[1]);
  assert.match(links.name, /^tracker-bridge-[a-z0-9]{6}$/);
});

test("the whole artifact still fits in a link every browser will follow", () => {
  // Safari's ceiling is around 80,000 characters, and it is the lowest. The
  // page warns above 78,000; this fails the build long before a reader meets it.
  const filled = BLANKS.reduce(
    (text, [line]) => text.replace(line, line.replace(/(""|0);$/, (m) => (m === "0;" ? "1755000000000;" : '"a-realistic-looking-value-here";'))),
    WORKER,
  );
  const link = bothLinks(filled).deploy;
  assert.ok(link.length < 78000, `the deploy link is ${link.length.toLocaleString()} characters`);
});

test("a suggested name is a name, and two of them differ", () => {
  assert.match(suggestedName(), /^tracker-bridge-[a-z0-9]{6}$/);
  assert.notEqual(suggestedName(), suggestedName());
});

test("the compressor still agrees with lz-string", () => {
  // The one piece of this project that reimplements somebody else's format. If
  // it drifts, every deploy link is silently rubbish.
  assert.equal(compressToEncodedURIComponent(""), "Q");
  assert.equal(compressToEncodedURIComponent("Hello, World!"), "BIUwNmD2A0AEDqkBOYAmBCIA");
  assert.equal(compressToEncodedURIComponent("export default { fetch() {} }"), "KYDwDg9gTgLgBAE2AMwIYFcA28DednAwDGAFgBQCUcOAvnDUA");
});

test("the page and the artifact agree on where the other one lives", () => {
  const setupPage = /^const SETUP_PAGE = "([^"]+)";$/m.exec(WORKER);
  assert.ok(setupPage, "worker.js has no SETUP_PAGE line");
  // The artifact answers CORS for that origin and nothing else by default, and
  // the page tests a bridge by calling it from exactly there. If the two ever
  // disagree, the test button fails in a way that looks like a broken deploy.
  assert.ok(setupPage[1].endsWith("/"), "SETUP_PAGE should end in a slash");
  assert.equal(new URL(setupPage[1]).origin, "https://momzv2022-ctrl.github.io");
});
