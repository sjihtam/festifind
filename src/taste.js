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
//
// Sources: top artists + tracks over all three time ranges, follows, saved
// tracks, saved albums, recent plays, and the playlists the user curates —
// every listening signal the API still exposes. Explicit acts (following,
// saving an album, adding to a playlist) outweigh passive ones, and dated
// signals decay so the profile tracks who you are now, not in 2019.

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
 * How much a dated signal still counts. A track saved last month says far more
 * about who you are now than one saved in 2019 — but old signals never hit
 * zero, because taste accretes rather than resets. Half-life ~18 months,
 * floored at 0.45. Undated items get a neutral 0.75.
 */
export function recencyWeight(addedAt, now = Date.now()) {
  const t = addedAt ? Date.parse(addedAt) : NaN;
  if (!Number.isFinite(t)) return 0.75;
  const months = Math.max(0, (now - t) / (1000 * 60 * 60 * 24 * 30.4));
  return 0.45 + 0.55 * Math.exp(-months / 18);
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
    followed, saved, recent, playlists, savedAlbums,
  ] = await Promise.all([
    api.topArtists('short_term'),
    api.topArtists('medium_term'),
    api.topArtists('long_term'),
    api.topTracks('short_term'),
    api.topTracks('medium_term'),
    api.topTracks('long_term'),
    api.followedArtists(),
    // Coverage matters for labelling: an artist saved beyond this cap would be
    // tagged "new artist", which is worse than a few extra requests.
    api.savedTracks(750),
    api.recentlyPlayed(50),
    // Both need scopes older sessions may not have granted yet — degrade to
    // nothing rather than failing the whole profile.
    api.myPlaylists(50).catch(() => []),
    api.savedAlbums(100).catch(() => []),
  ]);

  // Playlists the user actually curates, not ones they merely follow. Adding a
  // track to your own playlist is as deliberate as saving it — for many people
  // it has entirely replaced saving.
  const ownPlaylists = playlists.filter((p) => p?.owner?.id === me.id && p.tracks?.total > 0);
  let playlistItems = [];
  if (ownPlaylists.length) {
    onProgress('Reading the playlists you curate…');
    playlistItems = (
      await Promise.all(
        ownPlaylists.slice(0, 16).map((p) => api.playlistTracks(p.id, 200).catch(() => []))
      )
    )
      .flat()
      .filter((item) => item?.track?.id && !item.track.is_local);
  }

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

  // EVERY credited artist counts, not only the lead name. Crediting artists[0]
  // alone was why featured and collaborating artists kept coming back as "new to
  // you" — you had listened to them plenty, just never as the main artist.
  const creditWeight = (index) => (index === 0 ? 1 : 0.55);

  const savedByArtist = new Map();
  for (const item of saved) {
    (item?.track?.artists || []).forEach((artist, i) => {
      if (artist?.id) addWeight(savedByArtist, artist.id, creditWeight(i) * recencyWeight(item.added_at));
    });
  }
  // Diminishing returns, so one 80-track album obsession doesn't drown out
  // everything else.
  for (const [id, count] of savedByArtist) {
    addWeight(affinity, id, Math.min(Math.sqrt(count) * 0.35, 1.6));
  }

  // Tracks the user put on their own playlists — curation, the same deliberate
  // act as saving, and for playlist-first listeners the only record of taste
  // the library holds. Same diminishing-returns shape as saves.
  const playlistByArtist = new Map();
  for (const item of playlistItems) {
    (item.track.artists || []).forEach((artist, i) => {
      if (artist?.id) addWeight(playlistByArtist, artist.id, creditWeight(i) * recencyWeight(item.added_at));
    });
  }
  for (const [id, count] of playlistByArtist) {
    addWeight(affinity, id, Math.min(Math.sqrt(count) * 0.35, 1.7));
  }

  // Saving a whole album is the strongest per-artist commitment the library
  // records — stronger than any single track save.
  for (const item of savedAlbums) {
    const album = item?.album;
    if (!album) continue;
    const rec = recencyWeight(item.added_at);
    (album.artists || []).forEach((artist, i) => {
      if (artist?.id) addWeight(affinity, artist.id, (i === 0 ? 0.9 : 0.45) * rec);
    });
  }

  // Top *tracks* previously contributed nothing to affinity — only top *artists*
  // did, and that list is capped at 50 per time range. An artist you play
  // constantly but who sits outside that cap was invisible to the whole model.
  for (const [term, list] of [
    ['short_term', shortTracks],
    ['medium_term', mediumTracks],
    ['long_term', longTracks],
  ]) {
    list.forEach((track, rank) => {
      (track?.artists || []).forEach((artist, i) => {
        if (!artist?.id) return;
        addWeight(affinity, artist.id, TERM_WEIGHT[term] * rankWeight(rank) * 0.5 * creditWeight(i));
      });
    });
  }

  for (const item of recent) {
    (item?.track?.artists || []).forEach((artist, i) => {
      if (artist?.id) addWeight(affinity, artist.id, 0.12 * creditWeight(i));
    });
  }

  // --- Genre + token vectors ----------------------------------------------
  // Genres only come from full artist objects, so fetch any we're missing for
  // the artists that carry real weight.
  const heavyweights = [...affinity.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 220)
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
  const playlistTracks = playlistItems.map((i) => i.track);
  const trackPopularities = allTopTracks
    .concat(saved.map((s) => s.track).filter(Boolean))
    .concat(playlistTracks)
    .map((t) => t?.popularity)
    .filter((p) => typeof p === 'number');

  const years = allTopTracks
    .concat(playlistTracks)
    .map(releaseYear)
    .concat(savedAlbums.map((i) => releaseYear({ album: i?.album })))
    .filter(Boolean);

  const knownArtistIds = new Set(affinity.keys());

  // Saved and played are different facts and must not be conflated: a track in
  // your top tracks is one you play a lot, which is NOT the same as one you
  // saved. Labelling the former "in your library" was simply wrong.
  //
  // Each is matched by name as well as ID, because the same song exists under
  // many IDs (remaster, single, deluxe edition, regional release).
  const trackKey = (t) => `${t.artists?.[0]?.name} – ${normalizeTitle(t.name)}`.toLowerCase();

  // Playlist adds count as "saved": both are the user's own curation, and both
  // mean a discovery-mode playlist shouldn't waste a slot on that song.
  const savedTracks = saved.map((s) => s.track).filter(Boolean).concat(playlistTracks);
  const savedTrackIds = new Set(savedTracks.map((t) => t.id));
  const savedTrackNames = new Set(savedTracks.map(trackKey));

  // "Played" must include recent plays, not just top tracks — a song you had on
  // yesterday was reaching the playlist labelled "new".
  const playedSource = allTopTracks.concat(recent.map((r) => r?.track).filter((t) => t?.id));
  const playedTrackIds = new Set(playedSource.map((t) => t.id));
  const playedTrackNames = new Set(playedSource.map(trackKey));

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
  for (const track of playlistTracks) {
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
    savedTrackIds,
    savedTrackNames,
    playedTrackIds,
    playedTrackNames,
    popularity,
    artistPopularity: stats(artistPopularities),
    era: stats(years.length ? years : [new Date().getFullYear() - 6]),
    counts: {
      topArtists: new Set([...shortArtists, ...mediumArtists, ...longArtists].map((a) => a.id)).size,
      followed: followed.length,
      saved: saved.length,
      playlists: ownPlaylists.length,
      playlistTracks: playlistItems.length,
      albums: savedAlbums.length,
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
