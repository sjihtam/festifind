# Festifind

Pick a Dutch festival, get a Spotify playlist of artists on that lineup — weighted
toward music that fits your taste, including artists you've never played.

Also does open-ended discovery: **artists you might like**, straight from your
listening history, with no festival attached.

Runs entirely in your browser. No backend, no client secret, nothing uploaded.

---

## Setup

Done **once**, by whoever runs Festifind. Everyone else just clicks a button.

```bash
npm run setup
```

It walks you through creating a free Spotify app and stores the Client ID in
`src/config.js`. Then:

```bash
npm start
```

Open **http://127.0.0.1:8888**.

If you'd rather not be prompted: `npm run setup -- <clientId> "Your Name"`.

### What other people see

Nothing technical. One **Continue with Spotify** button, Spotify's own permission
screen, and they're in. They never encounter a Client ID, a dashboard, or a
redirect URI.

### The hard limit: 5 people

This is a Spotify restriction, not a design choice, and it tightened in 2026:

- **5 authenticated users per app**, down from 25 in March 2026. Each one has to
  be added by email in the dashboard under **User Management**.
- **The app owner needs Spotify Premium** for a Development Mode app to work at all.
- **Extended Quota** (unlimited users) is only granted to legally registered
  businesses with **250,000+ monthly active users**, an active launched service,
  and commercial viability. It is not available to personal projects.

So Festifind can be shared with a handful of friends, but it cannot be opened to
a general audience. If someone not on the allowlist tries to sign in, the app
detects it and tells them who to ask rather than showing a raw OAuth error.

### One thing that will bite you

**Use `127.0.0.1`, not `localhost`.** Spotify's dashboard rejects `http://localhost`
redirect URIs outright. The server binds the loopback IP for this reason.

---

## Hosting it on GitHub Pages

There's no build step and no backend, so Pages serves it as-is. Free, HTTPS
included — which Spotify requires for any non-loopback redirect URI.

1. Push this folder to a GitHub repo (public or private both work; Pages needs
   public on the free plan).
2. Repo → **Settings** → **Pages** → Source: **Deploy from a branch**, branch
   `main`, folder `/ (root)`. Save.
3. Wait a minute, then note your URL — usually
   `https://YOURNAME.github.io/REPONAME/`.
4. In the [Spotify dashboard](https://developer.spotify.com/dashboard), add that
   URL as a **second redirect URI**, keeping the local one. **Include the
   trailing slash.**

Done. Send people the link.

### Why it works from a subpath

Pages serves projects from `/REPONAME/`, not the domain root, and it has no SPA
fallback — so a `/callback` route would just 404. Two things make this a non-issue:

- **The redirect URI is the app's own base URL**, not a `/callback` route. The
  page that receives the OAuth code is the page that's already there, so no
  server-side routing is needed at all.
- **Every asset path is relative**, and the festival data is fetched relative to
  the module's own URL — so root, subpath and custom domain all behave the same.

`redirectUriFor()` in [`src/auth.js`](src/auth.js) derives this at runtime, and is
covered by a test over all seven hosting shapes. You never edit a base path.

`.nojekyll` is included so Pages skips Jekyll processing.

### Committing `src/config.js` is fine

It holds only the Spotify **Client ID**, which is public by design under PKCE —
it's sent to Spotify in a URL every time anyone signs in. There is no client
secret anywhere in this project. It *must* be committed for the hosted copy to
work.

### Other hosts

Netlify, Vercel and Cloudflare Pages all work the same way and give you a root
domain, which avoids the subpath entirely. Drag the folder in, then add the
resulting URL as a redirect URI. No configuration file needed.

### Hosting does not raise the 5-user cap

Worth being blunt: putting it online does not make it public. The Spotify
allowlist is per-app, not per-host, so it's still 5 accounts you add by hand.
Anyone else who opens the link gets a clear "ask X to add your account" message
rather than a broken page.

---

## What this does, and what Spotify took away

The obvious way to build this is: seed `/recommendations` with the festival's
artists, filter on `/audio-features` for energy and danceability, expand with
`/related-artists`. **All three of those endpoints were deprecated in November 2024**
and return `403` for any app created since. Also gone: `/audio-analysis`,
featured playlists, and category playlists.

So the recommendation engine here is built from scratch on the endpoints that
still work. That turned out to be a better fit for "suggest things I don't already
know" anyway, because the scoring is explicit and tunable rather than a black box.

### The taste profile (`src/taste.js`)

Built from every listening signal the API still exposes: your top artists and
tracks across all three time ranges, artists you follow, up to 500 saved
tracks, your saved albums, recent plays, and the playlists you curate yourself
(followed playlists are ignored — someone else's taste). Explicit acts weigh
more than passive ones: following an artist and saving an album count heavily,
adding a track to your own playlist counts like saving it. Dated signals decay
with a ~18-month half-life, so the profile tracks who you are now — but they
never hit zero, because taste accretes rather than resets. Four axes:

| Axis | What it captures |
|---|---|
| **Genre vector** | What you listen to, weighted by rank and by time range (6-month history counts most; 4-week is mood, long-term is identity) |
| **Token vector** | Genre strings split into words, so `melodic techno` and `melodic house` recognise each other. Spotify's genre taxonomy is so granular that exact-match overlap is nearly always zero — without this, matching barely works |
| **Popularity band** | Whether you sit on chart-toppers or deep in the long tail |
| **Release era** | How old the music you actually play is |

Per-artist signals use diminishing returns, so one album obsession doesn't
drown out everything else.

### Festival matching (`src/recommend.js`)

1. **Resolve** — poster names → Spotify artists, conservatively. A wrong match
   poisons the playlist worse than a missing artist does, so ambiguous names are
   reported back to you rather than guessed at. Diacritics, word order and
   one-letter poster typos are tolerated (edit-distance match with a high
   threshold); anything looser is not.
2. **Score** — genre + token similarity against your profile, plus familiarity,
   novelty and popularity fit. Two pool-level signals make this collaborative
   rather than a flat string comparison:
   - **IDF weighting** — a token the whole lineup carries ("techno" at
     Dekmantel) separates nobody, so it's discounted; a rare token you share
     with two artists is real evidence.
   - **Genre co-occurrence** — genres that keep appearing on the same artists
     are treated as related, which gives partial credit across pairs that share
     no words at all ("shoegaze" ~ "dream pop"). This is the collaborative
     signal Spotify's own recommender leans on, rebuilt from the data that's
     still available.
3. **Select** — which track from each artist, then order the playlist.

The important design rule: **novelty is multiplied by fit, never added to it.** An
artist you've never played only scores well if they already match your taste.
Otherwise "discovery" degrades into randomness, which is the usual failure mode
for this kind of tool. There's a test asserting exactly this.

### Open-ended discovery (`src/discover.js`)

Artists you might like, with no festival involved. Two candidate sources, chosen
because they're what survives the deprecations:

- **Genre search** — `genre:"..."` still works on artist search, so your own top
  genres become queries. Broad reach, noisy.
- **Collaborators** — featured and secondary artists on tracks you already play.
  Much narrower, much higher hit-rate: you've demonstrably already enjoyed their
  work, usually without ever having played them on their own.

Both get scored by the same engine, then anything already in your library is
filtered out. Collaborator finds are score-boosted — and, as above, that boost is
multiplied by fit so it amplifies a good match rather than manufacturing one.

### No knobs

There is exactly one way to build a playlist: the button. The engine still has
familiar↔discovery and deep-cuts↔hits as internal parameters (the tests
exercise both), but the app pins them at the values that maximise how likeable
each song is — anchored on artists you demonstrably play, targeting your own
popularity band, with unknown artists admitted only through the match-gated
novelty bonus. Playlist length is a ceiling, not a quota: track selection
applies a fit floor and would rather come back short than pad the list with
filler from the bottom of the bill.

---

## Festival data

`data/festivals.json` was checked against official sites and press coverage on
**28 July 2026**. Each entry records `lineupStatus`, the `source` it was read
from, and when it was `checked`:

| Status | Meaning |
|---|---|
| `verified` | Full published lineup, taken from the official site |
| `partial` | Only the announced/headline names are public so far |
| `not-announced` | No single lineup list exists to check against |

### What's in, and what got removed

| Festival | Dates | Lineup |
|---|---|---|
| Dekmantel | 29 Jul – 2 Aug | verified, 120 acts |
| Solar Weekend | 30 Jul – 2 Aug | verified, 49 |
| Lowlands | 21 – 23 Aug | partial, 56 (first wave) |
| Into The Great Wide Open | 27 – 30 Aug | partial, 33 |
| Decibel Outdoor | 28 – 30 Aug | verified, 79 |
| Amsterdam Dance Event | 21 – 25 Oct | not announced as one list |
| Best Kept Secret | 12 – 14 Jun | partial, 12 |
| Pinkpop | 19 – 21 Jun | partial, 13 |
| Down The Rabbit Hole | 3 – 5 Jul | partial, 11 |
| Wildeburg | 9 – 12 Jul | verified, 147 |
| Awakenings | 10 – 12 Jul | partial, 15 |
| NN North Sea Jazz | 10 – 12 Jul | partial, 24 |

**Removed:** Mysteryland (on hiatus for 2026, returns 2027) and WOO HAH! (ran
2014–2022, no 2026 edition).

**ADE** has 1,000+ events and 2,500 artists across 200 venues, so there is no
single bill to match against. The app says so and asks you to paste the events
you're actually going to, rather than inventing a lineup.

### Lineups still move

Drop-outs, late additions and day splits happen after publication, so treat the
bundled lineups as a snapshot and check the official site if it matters.

The paste-your-own-lineup control was removed from the cards to keep them clean
for non-technical users. It survives only on festivals with **no published bill**
(currently just ADE), where it appears as **Add the acts you want** — without it
those cards would have nothing to match against. The parser behind it still
handles day headers, stage names, numbered lists, bullets, comma-separated runs,
`(live)` / `(DJ set)` suffixes and duplicates, and pasted lineups are saved
locally. To re-enable it everywhere, drop the `count ?` guard on the `data-act
="paste"` button in `renderFestivals()`.

Anything that can't be matched on Spotify is listed under the playlist rather than
silently dropped.

### Card photos

Nine of the twelve festivals show a photo from **Wikimedia Commons**, stored as an
`image` object in `data/festivals.json` with the photographer and licence. CC BY
and CC BY-SA require attribution, so the app renders a **Photo credits** list under
the festival grid linking each file's Commons page — that's a licence obligation,
not decoration. Dekmantel, Solar Weekend and Wildeburg have no suitable freely
licensed photo and fall back to the generated gradient.

Commons search is noisy (searching "Dekmantel" returns audio pronunciation files),
so these were hand-picked rather than fetched automatically.

---

## Tests

Pure scoring logic, run in the browser (the modules depend on browser globals).
Open the app, then in the DevTools console:

```js
const { runTests } = await import('/src/engine.test.js'); runTests();
```

22 tests covering genre matching, cross-genre token credit, both scoring axes, the
genre-prior fallback, the provenance boost, IDF weighting, co-occurrence
smoothing, fuzzy name matching, recency decay and title normalisation — plus
the guard that max discovery still rejects a poor fit, and the guard that
"known artist" labels use absolute evidence rather than shifting with the
size of your most-played artist.

---

## Tuning the engine on real data

The scoring can be tuned against your actual library without hammering the
Spotify API on every experiment:

1. Start the local server (`npm start`) and open
   **http://127.0.0.1:8888/?record** — then sign in and build a playlist as
   normal. Every Spotify response is captured and written to
   `data-snapshot.json` (gitignored: it's your listening data, it stays on
   your machine, and `?record=off` turns capturing off again).
2. Replay the entire pipeline offline, as often as you like:

```bash
node tools/replay.mjs lowlands
```

   Flags override the app's fixed tuning: `--discovery 0.4`,
   `--mainstream 0.7`, `--tracks 30`, `--top 40`, `--file other-snapshot.json`.
   It prints your taste summary, the ranked lineup with the same percentages
   the app shows, and the exact playlist — so you can edit weights in `src/`,
   re-run, and compare. Replay never calls Spotify and can never write to
   your account.

## Layout

```
setup.mjs               one-time Client ID setup (npm run setup)
server.mjs              static server, binds 127.0.0.1:8888
index.html
data/festivals.json     lineups, with source + status per festival
src/
  config.js             the Client ID, written by setup
  auth.js               OAuth PKCE — no client secret
  spotify.js            API client: batching, 429 back-off, retries
  taste.js              taste profile
  recommend.js          festival matching + track selection + ordering
  discover.js           open-ended artist discovery
  app.js                UI orchestration
  engine.test.js        scoring tests
  logo.svg              app mark
  styles.css
```

## Design

Follows Apple's HIG conventions: system typeface with real weight hierarchy,
neutral greyscale surfaces, a single accent colour used sparingly, hairline
separators, inset grouped lists, pill controls. Light and dark both first-class
via `prefers-color-scheme`. No ambient glows, glassmorphism or gradient text.

The mark (`src/logo.svg`) is three concentric arcs over a baseline — a stage arch
with sound leaving it. Geometric, works monochrome, legible at favicon size.

Playlists are always created **private**, only on an explicit click, in your own
account. Tokens live in `localStorage` and never leave the browser.
