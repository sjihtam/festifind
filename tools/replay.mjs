// Replay the whole recommendation pipeline offline, from a recorded snapshot.
//
// Record once:  open the app with ?record, sign in, build a playlist —
//               data-snapshot.json appears in the project root.
// Replay:       node tools/replay.mjs [festivalId] [flags]
//
// Every Spotify call is answered from the snapshot, so scoring weights in
// src/ can be edited and re-run instantly against the user's real data —
// that's the tuning loop. Flags override the app's fixed TUNING:
//
//   --discovery 0.25    0 = favourites only, 1 = all new
//   --mainstream 0.5    0 = deep cuts, 1 = hits
//   --tracks 40         playlist length ceiling
//   --top 25            how many ranked artists to print
//   --file path         snapshot to use (default ./data-snapshot.json)

import { readFile } from 'node:fs/promises';

// The src modules expect browser globals; give them inert ones.
globalThis.location = { origin: 'http://127.0.0.1:8888', pathname: '/', href: 'http://127.0.0.1:8888/', search: '' };
const memStore = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};
globalThis.localStorage = memStore();
globalThis.sessionStorage = memStore();

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1]?.startsWith('--') !== true);

const file = flag('file', new URL('../data-snapshot.json', import.meta.url));
const discovery = Number(flag('discovery', 0.25));
const mainstream = Number(flag('mainstream', 0.5));
const targetTracks = Number(flag('tracks', 40));
const topN = Number(flag('top', 25));

// ── snapshot-backed API ────────────────────────────────────────────────────

let snapshot;
try {
  snapshot = JSON.parse(await readFile(file, 'utf8'));
} catch {
  console.error('No snapshot found. Open the app with ?record, sign in, build a playlist, then re-run.');
  process.exit(1);
}

const { api } = await import('../src/spotify.js');
const responses = new Map(snapshot.calls.map((c) => [c.key, c.result]));
const recordedMethods = new Set(snapshot.calls.map((c) => c.key.slice(0, c.key.indexOf(':'))));

// Batch endpoints take an ARRAY of ids, and the recorded array order is not
// reproducible: resolveLineup resolves its searches in parallel, so a replay
// asks for the same artists in a different order and an exact key never hits.
// Index every object the snapshot ever saw by id, and serve batches from that
// instead — order-independent, and it also covers ids that arrived via a
// different call than the one being replayed.
const byId = new Map();
const indexObject = (o) => {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) return o.forEach(indexObject);
  if (typeof o.id === 'string' && (o.genres || o.album || o.popularity !== undefined)) {
    if (!byId.has(o.id)) byId.set(o.id, o);
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') indexObject(v);
};
for (const call of snapshot.calls) indexObject(call.result);

const fromIds = (ids) => (ids || []).map((id) => byId.get(id)).filter(Boolean);

for (const name of Object.keys(api)) {
  if (name === 'createPlaylist' || name === 'addTracks') {
    api[name] = async () => { throw new Error('replay never writes to Spotify'); };
    continue;
  }
  api[name] = async (...callArgs) => {
    const key = `${name}:${JSON.stringify(callArgs)}`;
    if (responses.has(key)) return structuredClone(responses.get(key));

    if ((name === 'artists' || name === 'tracks') && Array.isArray(callArgs[0])) {
      const hits = fromIds(callArgs[0]);
      if (hits.length) return structuredClone(hits);
    }

    // Same method + same first argument is close enough (trailing defaults drift).
    const prefix = `${name}:[${JSON.stringify(callArgs[0])}`;
    for (const [k, v] of responses) if (k.startsWith(prefix)) return structuredClone(v);

    if (!recordedMethods.has(name)) throw new Error(`Snapshot has no '${name}' calls — re-record with ?record after a full build.`);
    throw new Error(`No recorded response for ${key}`);
  };
}

// ── run the pipeline ───────────────────────────────────────────────────────

const { buildTasteProfile } = await import('../src/taste.js');
const { resolveLineup, enrichGenres, scoreArtists, selectTracks } = await import('../src/recommend.js');

const raw = JSON.parse(await readFile(flag('festivals', new URL('../data/festivals.json', import.meta.url)), 'utf8'));
const festivals = Array.isArray(raw) ? raw : raw.festivals;
const festivalId = positional[0] || snapshot.festival;
const festival = festivals.find((f) => f.id === festivalId);
if (!festival) {
  console.error(`Unknown festival '${festivalId}'. Options: ${festivals.map((f) => f.id).join(', ')}`);
  process.exit(1);
}

console.log(`\nReplaying ${festival.name}  ·  discovery ${discovery} · mainstream ${mainstream} · ≤${targetTracks} tracks\n`);

const taste = await buildTasteProfile(() => {});
const genres = taste.topGenres.slice(0, 6).map(([g]) => g).join(', ');
console.log(`Taste: ${taste.counts.topArtists} top artists · ${taste.counts.saved} saved · ${taste.counts.playlistTracks || 0} playlist tracks · ${taste.counts.albums || 0} albums`);
console.log(`       ${genres}`);
console.log(`       popularity band ~${Math.round(taste.popularity.mean)} · era ~${Math.round(taste.era.mean)}\n`);

const { artists, unmatched } = await resolveLineup(festival.lineup, taste.market, () => {});
const hydrated = (await api.artists(artists.map((a) => a.id))).map((a) => ({
  ...a,
  lineupName: artists.find((x) => x.id === a.id)?.lineupName,
}));

await enrichGenres(hydrated, taste.market, () => {});
const tagged = hydrated.filter((a) => (a.genres || []).length).length;
const inferred = hydrated.filter((a) => a.inferredGenres?.length).length;
console.log(`Genres: ${tagged} from Spotify · ${inferred} inferred from collaborators · ${hydrated.length - tagged - inferred} unknown\n`);

const ranked = scoreArtists(hydrated, taste, { discovery, mainstream, genrePrior: festival.genrePrior || [] });

console.log('── Ranked lineup ' + '─'.repeat(60));
for (const entry of [...ranked].sort((a, b) => b.percent - a.percent).slice(0, topN)) {
  console.log(`${String(entry.percent).padStart(3)}%  ${entry.artist.name.padEnd(28)} ${entry.why}`);
}
const floor = ranked.filter((e) => e.percent >= 30).length;
console.log(`\n(${ranked.length} matched, ${floor} above the playlist floor, ${unmatched.length} unmatched${unmatched.length ? ': ' + unmatched.join(', ') : ''})\n`);

const picks = await selectTracks(ranked, taste, { targetTracks, discovery, mainstream, onProgress: () => {} });

console.log('── Playlist ' + '─'.repeat(65));
picks.forEach((p, i) => {
  const tag = p.alreadySaved ? ' [saved]' : p.alreadyPlayed ? ' [you play this]' : !p.entry.seen ? ' [new artist]' : '';
  console.log(
    `${String(i + 1).padStart(2)}. ${String(p.entry.percent).padStart(3)}%  ` +
    `${p.track.artists.map((a) => a.name).join(', ')} — ${p.track.name}${tag}`
  );
});

// The blend is the whole point: a playlist that is all favourites has found
// nothing, and one that is all strangers is a radio station. Report both sides
// separately so a tuning change shows up as a shift in the mix.
const discoveries = picks.filter((p) => !p.entry.seen);
const known = picks.filter((p) => p.entry.isKnown);
const faint = picks.length - discoveries.length - known.length;
const avg = (list) => (list.length ? Math.round(list.reduce((s, p) => s + p.entry.percent, 0) / list.length) : 0);

console.log(`\n${picks.length} tracks from ${new Set(picks.map((p) => p.entry.artist.id)).size} artists`);
console.log(
  `  discovery : ${String(discoveries.length).padStart(2)} tracks · ` +
  `${new Set(discoveries.map((p) => p.entry.artist.id)).size} artists new to you · avg ${avg(discoveries)}% match`
);
console.log(
  `  favourites: ${String(known.length).padStart(2)} tracks · ` +
  `${new Set(known.map((p) => p.entry.artist.id)).size} artists you play · avg ${avg(known)}% match`
);
if (faint) console.log(`  faint     : ${faint} tracks from artists barely present in your data`);
console.log();

// ── optional review page ───────────────────────────────────────────────────
// --html writes a local page for judging the result track by track. It stays
// on this machine (served by the dev server, gitignored) because it contains
// the user's listening data.
const htmlPath = flag('html', null);
if (htmlPath !== null) {
  const target = htmlPath === '' || htmlPath === true
    ? new URL('../review.html', import.meta.url)
    : htmlPath;

  const payload = {
    festival: festival.name,
    tuning: { discovery, mainstream, targetTracks },
    taste: {
      topArtists: taste.counts.topArtists, saved: taste.counts.saved,
      playlistTracks: taste.counts.playlistTracks || 0, albums: taste.counts.albums || 0,
      genres: taste.topGenres.slice(0, 10).map(([g]) => g),
      popularity: Math.round(taste.popularity.mean), era: Math.round(taste.era.mean),
    },
    tracks: picks.map((p, i) => ({
      n: i + 1,
      artist: p.track.artists.map((a) => a.name).join(', '),
      title: p.track.name,
      percent: p.entry.percent,
      state: p.alreadySaved ? 'saved' : p.alreadyPlayed ? 'played' : !p.entry.seen ? 'new' : 'faint',
    })),
    artists: [...ranked].sort((a, b) => b.percent - a.percent).map((e) => ({
      name: e.artist.name,
      percent: e.percent,
      why: e.why,
      inPlaylist: picks.some((p) => p.entry.artist.id === e.artist.id),
      genres: (e.artist.genres || []).join(', ') || '(none from Spotify)',
    })),
    unmatched,
  };

  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${festival.name} — tuning review</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e5e5e7; --card:#fafafa; --accent:#4F46E5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0b0f; --fg:#f2f2f4; --dim:#9b9ba3; --line:#26262d; --card:#15151b; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 20px 120px; background:var(--bg); color:var(--fg);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size:23px; letter-spacing:-.02em; margin:0 0 4px; }
  h2 { font-size:15px; letter-spacing:-.01em; margin:32px 0 10px; }
  .sub { color:var(--dim); font-size:13.5px; margin:0 0 18px; }
  .row { display:flex; align-items:center; gap:10px; padding:8px 12px; border-bottom:1px solid var(--line); }
  .row:hover { background:var(--card); }
  .pct { font-variant-numeric:tabular-nums; font-weight:640; width:44px; flex:none; font-size:13px; }
  .meta { flex:1; min-width:0; }
  .meta b { font-weight:590; }
  .meta small { color:var(--dim); display:block; font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tag { font-size:11px; padding:1px 7px; border-radius:99px; background:var(--card); color:var(--dim); border:1px solid var(--line); flex:none; }
  .tag.new { color:#0a7; border-color:#0a755; }
  .vote { display:flex; gap:4px; flex:none; }
  .vote button { border:1px solid var(--line); background:transparent; border-radius:8px; cursor:pointer;
                 font-size:14px; width:32px; height:28px; line-height:1; color:var(--dim); }
  .vote button.on[data-v="up"] { background:#12915422; border-color:#129154; color:#16a35f; }
  .vote button.on[data-v="down"] { background:#c0392b22; border-color:#c0392b; color:#e05b4b; }
  textarea { width:100%; min-height:90px; margin-top:10px; padding:11px; border-radius:10px;
             border:1px solid var(--line); background:var(--card); color:var(--fg); font:inherit; font-size:14px; }
  .bar { position:fixed; left:0; right:0; bottom:0; padding:12px 20px; background:color-mix(in srgb,var(--bg) 92%,transparent);
         backdrop-filter:blur(12px); border-top:1px solid var(--line); }
  .bar-in { max-width:860px; margin:0 auto; display:flex; align-items:center; gap:14px; }
  .bar span { color:var(--dim); font-size:13px; flex:1; }
  .btn { border:0; background:var(--accent); color:#fff; padding:10px 18px; border-radius:10px;
         font:inherit; font-weight:600; font-size:14px; cursor:pointer; }
  details summary { cursor:pointer; color:var(--dim); font-size:13.5px; padding:6px 0; }
</style></head><body><div class="wrap">
<h1>${festival.name} — tuning review</h1>
<p class="sub" id="tastes"></p>
<h2>The playlist</h2>
<p class="sub">Mark anything you love or would skip. Only what you mark gets copied.</p>
<div id="tracks"></div>
<h2>Every matched artist</h2>
<p class="sub">Ranked as the engine sees them. Flag anyone ranked wrongly — especially good acts it buried.</p>
<details><summary>Show all ${payload.artists.length} artists</summary><div id="artists"></div></details>
<h2>Anything else</h2>
<textarea id="notes" placeholder="What felt wrong? What was missing?"></textarea>
</div>
<div class="bar"><div class="bar-in"><span id="count">Nothing marked yet</span>
<button class="btn" id="copy">Copy feedback</button></div></div>
<script>
const DATA = ${JSON.stringify(payload)};
const votes = { track:{}, artist:{} };
const el = (h) => { const d=document.createElement('div'); d.innerHTML=h; return d.firstElementChild; };

document.getElementById('tastes').textContent =
  DATA.taste.topArtists + ' top artists · ' + DATA.taste.saved + ' saved · ' + DATA.taste.playlistTracks +
  ' playlist tracks · ' + DATA.taste.albums + ' albums — ' + DATA.taste.genres.slice(0,6).join(', ') +
  ' — popularity ~' + DATA.taste.popularity + ' · era ~' + DATA.taste.era;

function voteBox(kind, key) {
  const box = el('<div class="vote"><button data-v="up">&#128077;</button><button data-v="down">&#128078;</button></div>');
  for (const b of box.children) b.onclick = () => {
    const v = b.dataset.v;
    votes[kind][key] = votes[kind][key] === v ? undefined : v;
    for (const s of box.children) s.classList.toggle('on', votes[kind][key] === s.dataset.v);
    tally();
  };
  return box;
}
function tally() {
  const n = Object.values(votes.track).filter(Boolean).length + Object.values(votes.artist).filter(Boolean).length;
  document.getElementById('count').textContent = n ? n + ' marked' : 'Nothing marked yet';
}

const tw = document.getElementById('tracks');
for (const t of DATA.tracks) {
  const row = el('<div class="row"></div>');
  row.append(el('<div class="pct">' + t.percent + '%</div>'));
  const label = { saved:'saved', played:'you play this', new:'new artist', faint:'' }[t.state];
  row.append(el('<div class="meta"><b></b><small></small></div>'));
  row.querySelector('b').textContent = t.artist;
  row.querySelector('small').textContent = t.title;
  if (label) row.append(el('<span class="tag' + (t.state==='new'?' new':'') + '">' + label + '</span>'));
  row.append(voteBox('track', t.n));
  tw.append(row);
}

const aw = document.getElementById('artists');
for (const a of DATA.artists) {
  const row = el('<div class="row"></div>');
  row.append(el('<div class="pct">' + a.percent + '%</div>'));
  row.append(el('<div class="meta"><b></b><small></small></div>'));
  row.querySelector('b').textContent = a.name + (a.inPlaylist ? '' : '  (not in playlist)');
  row.querySelector('small').textContent = a.why + ' — genres: ' + a.genres;
  row.append(voteBox('artist', a.name));
  aw.append(row);
}

document.getElementById('copy').onclick = async () => {
  const L = ['## Festifind feedback — ' + DATA.festival,
    '(discovery ' + DATA.tuning.discovery + ' · mainstream ' + DATA.tuning.mainstream + ')', ''];
  const tracks = DATA.tracks.filter(t => votes.track[t.n]);
  if (tracks.length) {
    L.push('### Tracks');
    for (const t of tracks) L.push((votes.track[t.n]==='up'?'LIKE  ':'SKIP  ') + t.percent + '% ' + t.artist + ' — ' + t.title + (t.state==='new'?' [new artist]':''));
    L.push('');
  }
  const artists = DATA.artists.filter(a => votes.artist[a.name]);
  if (artists.length) {
    L.push('### Artists');
    for (const a of artists) L.push((votes.artist[a.name]==='up'?'GOOD  ':'WRONG ') + a.percent + '% ' + a.name + (a.inPlaylist?'':' (not in playlist)') + ' — genres: ' + a.genres);
    L.push('');
  }
  const notes = document.getElementById('notes').value.trim();
  if (notes) L.push('### Notes', notes);
  const text = L.join('\\n');
  try { await navigator.clipboard.writeText(text); document.getElementById('count').textContent = 'Copied — paste it into the chat'; }
  catch { const t=document.getElementById('notes'); t.value=text; t.select(); document.getElementById('count').textContent='Select all in the box and copy'; }
};
</script></body></html>`;

  const { writeFile } = await import('node:fs/promises');
  await writeFile(target, page);
  console.log(`Review page written: ${typeof target === 'string' ? target : 'review.html'} → http://127.0.0.1:8888/review.html\n`);
}
