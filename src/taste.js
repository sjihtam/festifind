// Builds a taste profile from everything Spotify still exposes about a user.
//
// With /audio-features gone there is no danceability/energy/valence to cluster
// on, so the profile leans on four axes that ARE still available and turn out to
// be surprisingly discriminative:
//
//   1. Genre vector      — what you listen to, weighted by rank and recency.
//   2. Token vector      — genre strings broken into words, so "melodic techno"
//                          and "melodic house" recognise each other. Spotify's
//                          genre taxonomy is hyper-specific; without this,
//                          almost nothing matches exactly.
//   3. Popularity band   — whether you sit on chart-toppers or deep in the tail.
//   4. Release era       — how old the music you actually play is.

import { api } from './spotify.js';

// Words that appear in so many genre strings they carry no signal.
const STOP_TOKENS = new Set(['music', 'and', 'the', 'of', 'pop', 'contemporary', 'modern']);

// Time ranges weighted by how well each represents "who you are" rather than
// "what you had on repeat last week". medium_term (~6 months) is the sweet spot.
const TERM_WEIGHT = {
  short_term: 0.85,
  medium_term: 1.25,
  long_term: 1.0,
};

function tokenize(genre) {
  return genre
    .toLowerCase()
    .split(/[\s\-/]+/)
    .filter((t) => t.length > 2 && !STOP_TOKENS.has(t));
}

/** Rank decay: #1 counts roughly 3x what #50 does, smoothly. */
function rankWeight(index) {
  return 1 / (1 + index * 0.045);
}

function addWeight(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

/** L2-normalise a weight map so cosine similarity is well behaved. */
function normalize(map) {
  const norm = Math.sqrt([...map.values()].reduce((s, v) => s + v * v, 0)) || 1;
  const out = new Map();
  for (const [k, v] of map) out.set(k, v / norm);
  return out;
}

function stats(values) {
  if (!values.length) return { mean: 50, std: 20, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.max(Math.sqrt(variance), 6), n: values.length };
}

function releaseYear(track) {
  const date = track?.album?.release_date;
  const year = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : null;
}

/**
 * @param {(msg: string) => void} onProgress
 */
export async function buildTasteProfile(onProgress = () => {}) {
  onProgress('Reading your Spotify profile…');
  const me = await api.me();
  const market = me.country || 'NL';

  onProgress('Pulling your top artists and tracks…');
  const [
    shortArtists, mediumArtists, longArtists,
    shortTracks, mediumTracks, longTracks,
    followed, saved, recent,
  ] = await Promise.all([
    api.topArtists('short_term'),
    api.topArtists('medium_term'),
    api.topArtists('long_term'),
    api.topTracks('short_term'),
    api.topTracks('medium_term'),
    api.topTracks('long_term'),
    api.followedArtists(),
    api.savedTracks(300),
    api.recentlyPlayed(50),
  ]);

  onProgress('Modelling your taste…');

  // --- Artist affinity -----------------------------------------------------
  // How strongly the user is attached to each artist they already listen to.
  const affinity = new Map();
  const artistObjects = new Map();

  const noteArtist = (artist, weight) => {
    if (!artist?.id) return;
    addWeight(affinity, artist.id, weight);
    if (artist.genres && !artistObjects.has(artist.id)) artistObjects.set(artist.id, artist);
  };

  for (const [term, list] of [
    ['short_term', shortArtists],
    ['medium_term', mediumArtists],
    ['long_term', longArtists],
  ]) {
    list.forEach((artist, i) => noteArtist(artist, TERM_WEIGHT[term] * rankWeight(i)));
  }

  // Following someone is an explicit, deliberate act — weight it heavily.
  followed.forEach((artist) => noteArtist(artist, 1.4));

  // Saved tracks: credited to the primary artist, with diminishing returns so a
  // single 80-track album obsession doesn't drown out everything else.
  const savedByArtist = new Map();
  for (const item of saved) {
    const artist = item?.track?.artists?.[0];
    if (artist?.id) addWeight(savedByArtist, artist.id, 1);
  }
  for (const [id, count] of savedByArtist) {
    addWeight(affinity, id, Math.min(Math.sqrt(count) * 0.35, 1.6));
  }

  for (const item of recent) {
    const artist = item?.track?.artists?.[0];
    if (artist?.id) addWeight(affinity, artist.id, 0.12);
  }

  // --- Genre + token vectors ----------------------------------------------
  // Genres only come from full artist objects, so fetch any we're missing for
  // the artists that carry real weight.
  const heavyweights = [...affinity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 150)
    .map(([id]) => id);

  const missing = heavyweights.filter((id) => !artistObjects.has(id));
  if (missing.length) {
    onProgress('Fetching genre data for your artists…');
    for (const artist of await api.artists(missing)) artistObjects.set(artist.id, artist);
  }

  const genreWeights = new Map();
  const tokenWeights = new Map();
  const artistPopularities = [];

  for (const [id, weight] of affinity) {
    const artist = artistObjects.get(id);
    if (!artist) continue;
    if (typeof artist.popularity === 'number') artistPopularities.push(artist.popularity);

    const genres = artist.genres || [];
    if (!genres.length) continue;

    // Split the artist's weight across their genres so a 9-genre artist doesn't
    // count nine times as much as a 1-genre artist.
    const share = weight / Math.sqrt(genres.length);
    for (const genre of genres) {
      addWeight(genreWeights, genre.toLowerCase(), share);
      for (const token of tokenize(genre)) addWeight(tokenWeights, token, share * 0.6);
    }
  }

  // --- Popularity band + era ----------------------------------------------
  const allTopTracks = [...shortTracks, ...mediumTracks, ...longTracks];
  const trackPopularities = allTopTracks
    .concat(saved.map((s) => s.track).filter(Boolean))
    .map((t) => t?.popularity)
    .filter((p) => typeof p === 'number');

  const years = allTopTracks.map(releaseYear).filter(Boolean);

  const knownArtistIds = new Set(affinity.keys());
  const knownTrackIds = new Set(
    [...allTopTracks, ...saved.map((s) => s.track)].filter(Boolean).map((t) => t.id)
  );
  // Match on name too: the same song exists under many IDs (remaster, single,
  // deluxe edition, regional release), and ID-only dedupe misses all of them.
  const knownTrackNames = new Set(
    [...allTopTracks, ...saved.map((s) => s.track)]
      .filter(Boolean)
      .map((t) => `${t.artists?.[0]?.name} – ${normalizeTitle(t.name)}`.toLowerCase())
  );

  const popularity = stats(trackPopularities);

  // Seeds for collaborator-based discovery: the artist credits on tracks the user
  // demonstrably likes, weighted by how much that track counts. Secondary credits
  // on a track you love are one of the few high-precision discovery signals the
  // API still hands out for free.
  const collaboratorSeeds = [];
  allTopTracks.forEach((track, i) => {
    if (track?.artists?.length > 1) collaboratorSeeds.push([track.artists, rankWeight(i % 50) * 1.2]);
  });
  for (const item of saved) {
    const track = item?.track;
    if (track?.artists?.length > 1) collaboratorSeeds.push([track.artists, 0.7]);
  }

  return {
    market,
    collaboratorSeeds,
    user: { id: me.id, name: me.display_name, url: me.external_urls?.spotify },
    genreWeights: normalize(genreWeights),
    tokenWeights: normalize(tokenWeights),
    rawGenreWeights: genreWeights,
    affinity,
    knownArtistIds,
    knownTrackIds,
    knownTrackNames,
    popularity,
    artistPopularity: stats(artistPopularities),
    era: stats(years.length ? years : [new Date().getFullYear() - 6]),
    counts: {
      topArtists: new Set([...shortArtists, ...mediumArtists, ...longArtists].map((a) => a.id)).size,
      followed: followed.length,
      saved: saved.length,
      genres: genreWeights.size,
    },
    topGenres: [...genreWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

/** Strip the noise that makes the same song look like six different songs. */
export function normalizeTitle(name = '') {
  return name
    .toLowerCase()
    .replace(/\s*[\(\[][^\)\]]*(remaster|remix|live|version|edit|mix|deluxe|mono|stereo|radio|extended|instrumental|acoustic|demo|anniversary)[^\)\]]*[\)\]]/g, '')
    .replace(/\s*-\s*(remaster|remastered|live|radio edit|single version|extended mix|original mix)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export { tokenize };
