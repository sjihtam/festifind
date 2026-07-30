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

for (const name of Object.keys(api)) {
  if (name === 'createPlaylist' || name === 'addTracks') {
    api[name] = async () => { throw new Error('replay never writes to Spotify'); };
    continue;
  }
  api[name] = async (...cbFree) => {
    const key = `${name}:${JSON.stringify(cbFree)}`;
    if (responses.has(key)) return structuredClone(responses.get(key));
    // Same method + same first argument is close enough (trailing defaults drift).
    const prefix = `${name}:[${JSON.stringify(cbFree[0])}`;
    for (const [k, v] of responses) if (k.startsWith(prefix)) return structuredClone(v);
    if (!recordedMethods.has(name)) throw new Error(`Snapshot has no '${name}' calls — re-record with ?record after a full build.`);
    throw new Error(`No recorded response for ${key}`);
  };
}

// ── run the pipeline ───────────────────────────────────────────────────────

const { buildTasteProfile } = await import('../src/taste.js');
const { resolveLineup, scoreArtists, selectTracks } = await import('../src/recommend.js');

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
