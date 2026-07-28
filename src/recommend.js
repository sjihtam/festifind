// The recommendation engine.
//
// Spotify's /recommendations endpoint is dead for new apps, so this scores the
// festival lineup against the taste profile directly. Three stages:
//
//   1. resolveLineup  — names on a poster -> real Spotify artists
//   2. scoreArtists   — rank the lineup by how well it fits you
//   3. selectTracks   — pick which songs, then order them so the playlist flows

import { api } from './spotify.js';
import { tokenize, normalizeTitle } from './taste.js';

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

function cosine(vecA, vecB) {
  // vecA is small (one artist), vecB is the normalised user vector, so iterate A.
  let dot = 0;
  let normA = 0;
  for (const [key, value] of vecA) {
    normA += value * value;
    const other = vecB.get(key);
    if (other) dot += value * other;
  }
  return normA ? dot / Math.sqrt(normA) : 0;
}

function vectorsFor(genres) {
  const genreVec = new Map();
  const tokenVec = new Map();
  for (const genre of genres) {
    const g = genre.toLowerCase();
    genreVec.set(g, (genreVec.get(g) || 0) + 1);
    for (const token of tokenize(g)) tokenVec.set(token, (tokenVec.get(token) || 0) + 0.6);
  }
  return { genreVec, tokenVec };
}

/** Bell curve: 1.0 at the target, falling off over `spread`. */
function gaussianFit(value, target, spread) {
  if (typeof value !== 'number') return 0.5;
  return Math.exp(-((value - target) ** 2) / (2 * Math.max(spread, 1) ** 2));
}

// Letters NFD can't decompose, but that artists and posters use interchangeably.
const TRANSLIT = { ø: 'o', æ: 'ae', œ: 'oe', ð: 'd', þ: 'th', ß: 'ss', ł: 'l', đ: 'd', ı: 'i' };

function foldName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics: "Céline" ~ "Celine"
    .toLowerCase()
    .replace(/[øæœðþßłđı]/g, (c) => TRANSLIT[c])
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Stage 1: resolve poster names to Spotify artists
// ---------------------------------------------------------------------------

/**
 * Festival posters carry stage names, not Spotify IDs. Search each one and pick
 * the best candidate, deliberately conservatively — a wrong match poisons the
 * playlist far worse than a missing artist does, so anything ambiguous is
 * reported back to the user instead of guessed at.
 */
export async function resolveLineup(names, market, onProgress = () => {}) {
  const resolved = [];
  const unmatched = [];
  let done = 0;

  const lookups = names.map(async (name) => {
    let candidates = [];
    try {
      candidates = await api.searchArtist(name, market);
    } catch {
      candidates = [];
    }

    onProgress(++done, names.length);

    const wanted = foldName(name);
    const scored = candidates
      .map((artist) => {
        const got = foldName(artist.name);
        let nameScore = 0;
        if (got === wanted) nameScore = 1;
        else if (got.startsWith(wanted) || wanted.startsWith(got)) nameScore = 0.72;
        else if (got.includes(wanted) || wanted.includes(got)) nameScore = 0.55;
        else return null;

        // Among equally-named artists, the one with an audience is the festival
        // act; the other is a bedroom project that happens to share a name.
        const reach = Math.log10((artist.followers?.total || 0) + 10) / 8;
        return { artist, score: nameScore + reach * 0.3 };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      unmatched.push(name);
      return;
    }
    resolved.push({ ...scored[0].artist, lineupName: name });
  });

  await Promise.all(lookups);

  // De-duplicate: the same act can appear under two spellings on one poster.
  const seen = new Set();
  const unique = resolved.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));

  return { artists: unique, unmatched };
}

// ---------------------------------------------------------------------------
// Stage 2: score the lineup
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {number} opts.discovery  0 = artists you already love, 1 = new to you
 * @param {number} opts.mainstream 0 = deep cuts and obscure acts, 1 = the hits
 */
export function scoreArtists(
  artists,
  taste,
  { discovery, mainstream, genrePrior = [], boosts = null }
) {
  const maxAffinity = Math.max(...taste.affinity.values(), 1);

  // Where on the popularity spectrum to aim. Anchored on the user's own listening
  // band, then pushed up or down by the slider.
  const targetArtistPop = Math.min(
    100,
    Math.max(0, taste.artistPopularity.mean + (mainstream - 0.5) * 46)
  );

  const priorVectors = vectorsFor(genrePrior);

  return artists
    .map((artist) => {
      const hasGenres = (artist.genres || []).length > 0;

      // Spotify has quietly stopped returning genres for many smaller artists.
      // Falling back on the festival's own genre profile is a weak signal, but a
      // far better one than scoring them zero and dropping them entirely.
      const { genreVec, tokenVec } = hasGenres
        ? vectorsFor(artist.genres)
        : priorVectors;

      const genreSim = cosine(genreVec, taste.genreWeights);
      const tokenSim = cosine(tokenVec, taste.tokenWeights);

      // Token similarity does the heavy lifting: Spotify's genre strings are so
      // granular that exact overlap is rare even between near-identical artists.
      let match = 0.5 * genreSim + 0.5 * tokenSim;
      if (!hasGenres) match *= 0.62; // discount the guess, but don't bury them

      const affinityRaw = taste.affinity.get(artist.id) || 0;
      const familiarity = Math.min(affinityRaw / maxAffinity, 1);
      const isKnown = familiarity > 0.02;

      // A slightly wide bell on purpose: matching your popularity band too tightly
      // makes the results feel narrow, and the interesting picks often sit just
      // outside it. Leniency here costs little and adds range.
      const popFit = gaussianFit(artist.popularity, targetArtistPop, 26);

      // Novelty is multiplied by `match`, never added on its own. An unfamiliar
      // artist is only interesting if they already fit — otherwise "discovery"
      // just degrades into noise, which is the usual failure mode here.
      const noveltyBonus = discovery * 0.4 * match * (isKnown ? 0 : 1);
      const familiarBonus = (1 - discovery) * 0.85 * familiarity;

      // Provenance boost, used by open-ended discovery: how the candidate was
      // found is itself evidence (a featured credit on a track you love beats a
      // random genre-tag match). Also multiplied by `match`, for the same reason
      // novelty is — provenance should amplify a good fit, never manufacture one.
      const boost = boosts?.get(artist.id) ? boosts.get(artist.id) * match : 0;

      const score = match + familiarBonus + noveltyBonus + boost + 0.18 * popFit;

      return {
        artist,
        score,
        match,
        familiarity,
        isKnown,
        popFit,
        usedPrior: !hasGenres,
        why: explain({ match, familiarity, isKnown, popFit, artist, taste }),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Short human-readable reason, shown next to each artist in the UI. */
function explain({ match, familiarity, isKnown, artist, taste }) {
  const shared = (artist.genres || [])
    .filter((g) => taste.rawGenreWeights.has(g.toLowerCase()))
    .sort(
      (a, b) =>
        taste.rawGenreWeights.get(b.toLowerCase()) - taste.rawGenreWeights.get(a.toLowerCase())
    )
    .slice(0, 2);

  // Deliberately understated. Spotify only exposes your top 50 artists per time
  // range, your follows, recent plays and saved tracks — so an artist missing
  // from all of that is "outside your top artists", which is provable, and NOT
  // "new to you", which isn't: you may well know them from playlists or radio.
  if (isKnown && familiarity > 0.45) return 'One of your most-played artists';
  if (isKnown) return 'You already listen to this artist';
  if (shared.length) return `Outside your top artists · matches your ${shared.join(' + ')}`;
  if (match > 0.25) return 'Outside your top artists · close to your usual sound';
  return 'Wildcard from the lineup';
}

// ---------------------------------------------------------------------------
// Stage 3: pick tracks and order them
// ---------------------------------------------------------------------------

/**
 * How many tracks each artist gets.
 *
 * On a big lineup this settles on one track per artist, which is what you want —
 * the playlist samples the whole bill. Seconds and thirds only get handed out on
 * a short lineup, where there aren't enough artists to fill the target length,
 * and then they go to the best matches first.
 */
function allocate(ranked, targetTracks) {
  const alloc = new Map();
  let remaining = targetTracks;

  // Everyone selected gets one track first, so the playlist reflects the lineup
  // rather than three artists on repeat.
  const pool = ranked.slice(0, targetTracks);
  for (const entry of pool) {
    if (remaining <= 0) break;
    alloc.set(entry.artist.id, 1);
    remaining--;
  }
  // Then hand out seconds and thirds from the top down.
  for (let pass = 0; pass < 2 && remaining > 0; pass++) {
    for (const entry of pool) {
      if (remaining <= 0) break;
      const current = alloc.get(entry.artist.id) || 0;
      if (current > pass + 1) continue;
      alloc.set(entry.artist.id, current + 1);
      remaining--;
    }
  }
  return alloc;
}

export async function selectTracks(
  ranked,
  taste,
  { targetTracks, discovery, mainstream, onProgress = () => {} }
) {
  // Take a wider slice of the lineup than we need, then let track scoring decide.
  const shortlist = ranked.slice(0, Math.min(ranked.length, Math.ceil(targetTracks * 1.1)));
  const alloc = allocate(shortlist, targetTracks);
  const targetTrackPop = Math.min(100, Math.max(0, taste.popularity.mean + (mainstream - 0.5) * 44));
  const wantsDeepCuts = mainstream < 0.45;

  let done = 0;
  const perArtist = await Promise.all(
    shortlist.map(async (entry) => {
      const quota = alloc.get(entry.artist.id) || 0;
      if (!quota) return null;

      let pool = [];
      try {
        pool = await api.artistTopTracks(entry.artist.id, taste.market);
      } catch {
        pool = [];
      }

      // In deep-cut mode the 10 top tracks are exactly what we DON'T want, so
      // pull album tracks too and let the popularity target sort it out.
      if (wantsDeepCuts && pool.length) {
        try {
          const albums = await api.artistAlbums(entry.artist.id, taste.market, 6);
          const albumTrackIds = (
            await Promise.all(
              albums.slice(0, 3).map((album) => api.albumTracks(album.id, taste.market))
            )
          )
            .flat()
            .slice(0, 45)
            .map((t) => t.id);

          if (albumTrackIds.length) {
            // Album-track objects have no popularity field; re-fetch as full tracks.
            pool = pool.concat(await api.tracks(albumTrackIds, taste.market));
          }
        } catch {
          /* deep cuts are a bonus, not a requirement */
        }
      }

      onProgress(++done, shortlist.length);

      const seenTitles = new Set();
      const scored = pool
        .filter((track) => {
          if (!track?.id || track.is_playable === false) return false;
          const title = normalizeTitle(track.name);
          if (seenTitles.has(title)) return false; // same song, different release
          seenTitles.add(title);
          return true;
        })
        .map((track) => {
          const popScore = gaussianFit(track.popularity, targetTrackPop, 24);
          const year = Number(track.album?.release_date?.slice(0, 4));
          const eraScore = gaussianFit(year, taste.era.mean, Math.max(taste.era.std * 1.6, 7));

          const key = `${track.artists?.[0]?.name} – ${normalizeTitle(track.name)}`.toLowerCase();
          // Saved and played are reported separately so the UI can say which it
          // actually is, rather than calling a much-played track "in your library".
          const alreadySaved = taste.savedTrackIds.has(track.id) || taste.savedTrackNames.has(key);
          const alreadyPlayed = taste.playedTrackIds.has(track.id) || taste.playedTrackNames.has(key);

          // In discovery mode a song you already know is a wasted slot.
          const knownPenalty =
            alreadySaved || alreadyPlayed ? -0.55 * discovery + 0.12 * (1 - discovery) : 0;

          return {
            track,
            trackScore: 0.62 * popScore + 0.22 * eraScore + knownPenalty + 0.16,
            alreadySaved,
            alreadyPlayed,
          };
        })
        .sort((a, b) => b.trackScore - a.trackScore)
        .slice(0, quota);

      return scored.map((s) => ({ ...s, entry }));
    })
  );

  const picks = perArtist.filter(Boolean).flat();
  return orderForFlow(picks);
}

/**
 * Order the playlist so it plays like a set rather than a shuffled list.
 *
 * Greedy nearest-neighbour walk over the artists by genre similarity: start with
 * the best match, then repeatedly jump to the most similar artist not yet used.
 * Adjacent tracks end up sonically related while the playlist as a whole still
 * travels across the lineup. Cheap at these sizes (~40 artists).
 */
function orderForFlow(picks) {
  const byArtist = new Map();
  for (const pick of picks) {
    const id = pick.entry.artist.id;
    if (!byArtist.has(id)) byArtist.set(id, []);
    byArtist.get(id).push(pick);
  }

  const artistIds = [...byArtist.keys()];
  const vectors = new Map(
    artistIds.map((id) => {
      const artist = byArtist.get(id)[0].entry.artist;
      return [id, vectorsFor(artist.genres || []).tokenVec];
    })
  );

  const remaining = new Set(artistIds);
  // Seed on the strongest match so the playlist opens well.
  let current = artistIds.reduce((best, id) =>
    byArtist.get(id)[0].entry.score > byArtist.get(best)[0].entry.score ? id : best
  , artistIds[0]);

  const order = [];
  while (remaining.size) {
    remaining.delete(current);
    order.push(current);
    let next = null;
    let bestSim = -1;
    for (const id of remaining) {
      const sim = cosine(vectors.get(current), vectors.get(id));
      if (sim > bestSim) {
        bestSim = sim;
        next = id;
      }
    }
    current = next;
  }

  // Round-robin within that artist order so no artist plays twice in a row.
  const queues = order.map((id) => byArtist.get(id));
  const out = [];
  for (let round = 0; out.length < picks.length; round++) {
    let placed = false;
    for (const queue of queues) {
      if (queue[round]) {
        out.push(queue[round]);
        placed = true;
      }
    }
    if (!placed) break;
  }
  return out;
}
