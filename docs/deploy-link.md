# The deploy link

How the setup page puts a whole program into a URL, why that URL is shaped the
way it is, and what to re-check when it stops working.

`worker/tools/playground.js` is the implementation and the setup page inlines it
unchanged. This is the reasoning behind it.

## What it is for

The setup page has a program with your credentials written into it, and it needs
to get that program into your Cloudflare account. The alternatives are a copy
button and a paste into a code editor — which is the one step that is genuinely
bad on a phone — or a link.

Cloudflare's Workers playground keeps whatever it is showing in the URL
**fragment**, the `#…` part, which a browser never sends to a server. So a link
built in your browser carries the program *and* the credentials in it without
either reaching Cloudflare on page load. That is the whole trick.

It is also why the README says not to forward that link to anyone. The fragment
is not sent to a server; it is still in the URL, in your history, and in
anything you paste it into.

## The format

Undocumented, and read off a real playground link rather than guessed:

```
#<lz-string compressToEncodedURIComponent of>
    "multipart/form-data; boundary=----WebKitFormBoundary<16 random>"
    ":"
    <that multipart body>
```

The body is the same shape as Cloudflare's Workers upload API: one part per
module, then a `metadata` part naming `main_module`.

Two destinations share one fragment:

```
https://workers.cloudflare.com/playground#<fragment>
https://dash.cloudflare.com/workers-and-pages/deploy/playground/<name>#<fragment>
```

The first is an editor with a live preview, which is what "Run it before you
deploy it" opens. The second is the screen that editor's Deploy button goes to,
so linking straight there removes a step and a whole surface that can fail — and
it has failed, blank-paging for reasons that turned out to live in one browser
profile rather than in the payload.

What the deploy link loses is the preview. That is a real trade, and it is why
the page offers both.

## The things copied rather than chosen

Every avoidable difference from a link the playground made itself is one
avoidable way to be wrong. So:

- **The boundary is shaped like WebKit's**, because that is what the playground
  sends.
- **`compatibility_flags: ["nodejs_compat"]`**, because that is what the
  playground's own Deploy button sends. This program needs none of it.
- **`compatibility_date` is pinned**, currently `2026-08-18`, read off a live
  playground link on that date. It is **not** taken from `Date.now()`: a
  compatibility date exists to hold runtime behaviour still, and a date from the
  reader's browser would give two people deploying the same file two different
  runtimes, and a device with a wrong clock one Cloudflare rejects. Move it by
  re-checking a live link, not by editing it hopefully.
- **The module is called `index.js`**, for the same reason.

## The compressor

LZ-String 1.5.0's `compressToEncodedURIComponent`, reimplemented rather than
vendored because this repository carries no third-party code. LZW with a
variable code width, packed six bits to a character into a URL-safe alphabet.

It is pinned to the reference library's own output by eight vectors:

```sh
node worker/tools/playground-link.mjs --self-test
```

CI runs that on every push, and the offline page test checks three of the same
vectors. If this drifts, every deploy link is silently rubbish, and nothing else
in the project would notice.

## Size

The whole artifact, with credentials spliced in, compresses to roughly 66,000
characters of link. Safari's URL ceiling is the lowest of the major browsers at
around 80,000; Chrome, Firefox and Edge are far above it.

- The setup page warns above **78,000** and points at the copy-and-paste route.
- `worker/tests/setup-page.test.mjs` fails the build above **78,000**, with
  every blank line filled in with a realistic value, so a reader never meets
  that warning.

If the file grows past that, the deploy button stops being the primary route and
the copy button takes over. That is the moment to split something out, not to
raise the number.

## When it breaks

In the order worth checking:

1. **`--self-test` fails.** The compressor drifted. Nothing else matters until
   this passes.
2. **Cloudflare shows a login page.** The reader was signed out. Step 2 of the
   setup page exists to prevent exactly this, and the page says so.
3. **The deploy screen is blank or errors.** Compare a link this project builds
   against one the playground builds for the same program — open the playground,
   paste the file, press Deploy, and read the URL. Differences in the metadata
   block are the usual cause, and the compatibility date is the usual difference.
4. **The link is longer than 78,000 characters.** See above.

`node worker/tools/playground-link.mjs worker/src/worker.js [--deploy]` prints a
link for the committed file, which is the quickest way to look at one.


## The one field that was never observed: `bindings`

Everything above is copied from a link the playground made itself. The
`bindings` array in the metadata part is not: no playground link was ever seen
to carry one, because the playground has no bindings to offer. It is in the
link anyway, only when a UTSI on `workers.dev` was given in step 1, because the
Workers upload API documents the field in exactly this shape:

```json
{ "type": "service", "name": "UTSI", "service": "utsi-abc123-some-words" }
```

and the deploy screen hands the metadata part on to that API. **Whether it
hands this field on untouched is unverified.** Three outcomes are possible and
the page is written for all of them: the binding arrives and the combined
search works in one press; the field is dropped and the test in step 5 says
UTSI answered 404, with the dashboard steps in the message; or the screen
refuses the payload, which would show up as a blank page, and the "Deploy
without the sign-in" route below the steps sends a link with no binding in
it. The first person to deploy with a UTSI will find out which, and the
README should then say.
