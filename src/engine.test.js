// Browser-run sanity tests for the pure scoring logic.
//
// These deliberately avoid the network: everything under test is a pure function
// over a synthetic taste profile. Open the app and run in the console:
//
//   const { runTests } = await import('/src/engine.test.js'); runTests();

import { scoreArtists } from './recommend.js';
import { tokenize, normalizeTitle } from './taste.js';
import { redirectUriFor } from './auth.js';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

function normalize(map) {
  const norm = Math.sqrt([...map.values()].reduce((s, v) => s + v * v, 0)) || 1;
  return new Map([...map].map(([k, v]) => [k, v / norm]));
}

/** A synthetic listener: deep into melodic/deep house, moderately obscure taste. */
function houseListener({ affinity = new Map() } = {}) {
  const raw = new Map([
    ['deep house', 3], ['melodic house', 2.5], ['organic house', 2],
    ['minimal techno', 1.4], ['nu disco', 1],
  ]);
  const tokens = new Map();
  for (const [genre, weight] of raw) {
    for (const t of tokenize(genre)) tokens.set(t, (tokens.get(t) || 0) + weight * 0.6);
  }
  return {
    genreWeights: normalize(raw),
    tokenWeights: normalize(tokens),
    rawGenreWeights: raw,
    affinity,
    artistPopularity: { mean: 45, std: 18 },
    popularity: { mean: 42, std: 18 },
    era: { mean: 2019, std: 5 },
    knownArtistIds: new Set(affinity.keys()),
    savedTrackIds: new Set(),
    savedTrackNames: new Set(),
    playedTrackIds: new Set(),
    playedTrackNames: new Set(),
  };
}

const artist = (id, name, genres, popularity = 45) => ({ id, name, genres, popularity });

export function runTests() {
  results.length = 0;

  // ── 1. Genre matching beats non-matching ────────────────────────────────
  {
    const taste = houseListener();
    const ranked = scoreArtists(
      [
        artist('a', 'Deep House Act', ['deep house', 'melodic house']),
        artist('b', 'Death Metal Act', ['death metal', 'grindcore']),
      ],
      taste,
      { discovery: 0.7, mainstream: 0.5 }
    );
    check('genre match outranks mismatch', ranked[0].artist.id === 'a',
      ranked.map((r) => `${r.artist.name}=${r.score.toFixed(3)}`).join(', '));
  }

  // ── 2. Token overlap gives partial credit across near-genres ────────────
  // The whole reason tokenWeights exists: "melodic techno" shares no exact genre
  // with this listener, but should still beat something entirely unrelated.
  {
    const taste = houseListener();
    const ranked = scoreArtists(
      [
        artist('a', 'Melodic Techno Act', ['melodic techno']),
        artist('b', 'Bluegrass Act', ['bluegrass', 'old-time']),
      ],
      taste,
      { discovery: 0.7, mainstream: 0.5 }
    );
    const melodic = ranked.find((r) => r.artist.id === 'a');
    const bluegrass = ranked.find((r) => r.artist.id === 'b');
    check('adjacent genre gets partial credit via tokens',
      melodic.match > 0.1 && melodic.match > bluegrass.match * 3,
      `melodic=${melodic.match.toFixed(3)} bluegrass=${bluegrass.match.toFixed(3)}`);
  }

  // ── 3. Discovery slider actually changes the ranking ────────────────────
  {
    const known = artist('known', 'Artist You Play', ['deep house']);
    const fresh = artist('fresh', 'Unknown Match', ['deep house', 'melodic house']);
    const taste = houseListener({ affinity: new Map([['known', 10]]) });

    const familiar = scoreArtists([known, fresh], taste, { discovery: 0, mainstream: 0.5 });
    const discovery = scoreArtists([known, fresh], taste, { discovery: 1, mainstream: 0.5 });

    check('discovery=0 favours the artist you already play',
      familiar[0].artist.id === 'known',
      familiar.map((r) => `${r.artist.id}=${r.score.toFixed(3)}`).join(', '));
    check('discovery=1 favours the new artist',
      discovery[0].artist.id === 'fresh',
      discovery.map((r) => `${r.artist.id}=${r.score.toFixed(3)}`).join(', '));
  }

  // ── 4. Novelty must not outrank a bad fit ───────────────────────────────
  // The key guard: at max discovery, an unknown artist who does NOT match should
  // still lose to a known artist who does. Otherwise "discovery" is just noise.
  {
    const taste = houseListener({ affinity: new Map([['known', 10]]) });
    const ranked = scoreArtists(
      [
        artist('known', 'Known Deep House', ['deep house', 'melodic house']),
        artist('noise', 'Unknown Polka', ['polka', 'schlager']),
      ],
      taste,
      { discovery: 1, mainstream: 0.5 }
    );
    check('max discovery still rejects a poor fit',
      ranked[0].artist.id === 'known',
      ranked.map((r) => `${r.artist.id}=${r.score.toFixed(3)}`).join(', '));
  }

  // ── 5. Mainstream slider shifts the popularity target ───────────────────
  {
    const taste = houseListener();
    const obscure = artist('obscure', 'Obscure', ['deep house'], 12);
    const famous = artist('famous', 'Famous', ['deep house'], 88);

    const deep = scoreArtists([obscure, famous], taste, { discovery: 0.7, mainstream: 0 });
    const hits = scoreArtists([obscure, famous], taste, { discovery: 0.7, mainstream: 1 });

    check('mainstream=0 prefers the obscure artist', deep[0].artist.id === 'obscure',
      deep.map((r) => `${r.artist.id}=${r.score.toFixed(3)}`).join(', '));
    check('mainstream=1 prefers the popular artist', hits[0].artist.id === 'famous',
      hits.map((r) => `${r.artist.id}=${r.score.toFixed(3)}`).join(', '));
  }

  // ── 6. Genre-less artists fall back to the festival prior, discounted ────
  {
    const taste = houseListener();
    const [withPrior] = scoreArtists([artist('x', 'No Genres', [])], taste, {
      discovery: 0.7, mainstream: 0.5, genrePrior: ['deep house', 'melodic house'],
    });
    const [withoutPrior] = scoreArtists([artist('x', 'No Genres', [])], taste, {
      discovery: 0.7, mainstream: 0.5, genrePrior: [],
    });
    check('genre prior rescues artists with no genre data',
      withPrior.usedPrior && withPrior.match > 0 && withPrior.match > withoutPrior.match,
      `prior=${withPrior.match.toFixed(3)} none=${withoutPrior.match.toFixed(3)}`);

    const [real] = scoreArtists([artist('y', 'Real', ['deep house', 'melodic house'])], taste, {
      discovery: 0.7, mainstream: 0.5, genrePrior: ['deep house', 'melodic house'],
    });
    check('prior-based match is discounted below a real one',
      withPrior.match < real.match,
      `prior=${withPrior.match.toFixed(3)} real=${real.match.toFixed(3)}`);
  }

  // ── 7. Provenance boost amplifies fit but cannot manufacture it ─────────
  {
    const taste = houseListener();
    const good = artist('g', 'Good Fit', ['deep house']);
    const bad = artist('b', 'Bad Fit', ['polka']);
    const boosts = new Map([['g', 0.42], ['b', 0.42]]);

    const plain = scoreArtists([good, bad], taste, { discovery: 1, mainstream: 0.5 });
    const boosted = scoreArtists([good, bad], taste, { discovery: 1, mainstream: 0.5, boosts });

    const gainGood = boosted.find((r) => r.artist.id === 'g').score - plain.find((r) => r.artist.id === 'g').score;
    const gainBad = boosted.find((r) => r.artist.id === 'b').score - plain.find((r) => r.artist.id === 'b').score;

    check('collaborator boost lifts a good fit more than a bad one',
      gainGood > 0 && gainGood > gainBad * 5,
      `goodGain=${gainGood.toFixed(4)} badGain=${gainBad.toFixed(4)}`);
  }

  // ── 8. Title normalisation collapses release variants ───────────────────
  {
    const variants = [
      'Midnight City',
      'Midnight City (Remastered 2021)',
      'Midnight City - Remastered',
      'Midnight City (Live)',
      'Midnight City - Radio Edit',
    ].map(normalizeTitle);
    check('release variants collapse to one title',
      new Set(variants).size === 1, JSON.stringify([...new Set(variants)]));

    check('genuinely different songs stay distinct',
      normalizeTitle('Reckoner') !== normalizeTitle('Nude'));
  }

  // ── 9. Tokeniser drops noise words ──────────────────────────────────────
  {
    const tokens = tokenize('contemporary jazz music');
    check('tokeniser strips filler words',
      tokens.includes('jazz') && !tokens.includes('music') && !tokens.includes('contemporary'),
      JSON.stringify(tokens));
  }

  // ── 10. Redirect URI survives every hosting shape ───────────────────────
  // Spotify matches the redirect URI exactly, so a stray missing or doubled
  // slash breaks sign-in. These are the four ways this app actually gets served.
  {
    const cases = [
      // [origin, pathname, expected]
      ['http://127.0.0.1:8888', '/', 'http://127.0.0.1:8888/'],
      ['http://127.0.0.1:8888', '/index.html', 'http://127.0.0.1:8888/'],
      // GitHub Pages project site — served from a subpath.
      ['https://user.github.io', '/festifind/', 'https://user.github.io/festifind/'],
      ['https://user.github.io', '/festifind/index.html', 'https://user.github.io/festifind/'],
      // User site or custom domain — served from the root.
      ['https://user.github.io', '', 'https://user.github.io/'],
      ['https://festifind.example.com', '/', 'https://festifind.example.com/'],
      // Legacy /callback bookmark should normalise back to the base.
      ['http://127.0.0.1:8888', '/callback', 'http://127.0.0.1:8888/'],
    ];
    const wrong = cases
      .map(([origin, path, want]) => [path, redirectUriFor(origin, path), want])
      .filter(([, got, want]) => got !== want);

    check('redirect URI is correct for every hosting shape', wrong.length === 0,
      wrong.map(([p, got, want]) => `${p}: got ${got}, want ${want}`).join(' | '));
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
  }
  return { passed, total: results.length, results };
}
