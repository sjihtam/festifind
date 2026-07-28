// Open-ended discovery: artists and songs you might like, with no festival attached.
//
// The obvious way to build this — POST a few seed artists to /recommendations —
// no longer exists for apps created after November 2024. So candidates are
// generated from two channels that DO still work, then scored by the same engine
// the festival matcher uses:
//
//   A. Genre search   — `genre:"..."` is still supported on artist search, so the
//                       user's own top genres become queries. Broad reach, but
//                       noisy: it finds anyone tagged that way, at any quality.
//   B. Collaborators  — featured and secondary artists on tracks the user already
//                       plays. Far narrower, far higher hit-rate: these are people
//                       whose work the user has demonstrably already enjoyed,
//                       usually without ever having played them on their own.
//
// The two are deliberately complementary — A gives breadth, B gives precision —
// and B is score-boosted to reflect that.

import { api } from './spotify.js';
import { scoreArtists } from './recommend.js';

const GENRES_TO_PROBE = 14;
const PER_GENRE = 50;

/** Channel A: search Spotify for artists tagged with the user's own top genres. */
async function fromGenres(taste, onProgress) {
  const genres = taste.topGenres.slice(0, GENRES_TO_PROBE);
  const found = new Map();
  let done = 0;

  await Promise.all(
    genres.map(async ([genre, weight]) => {
      try {
        const res = await api.searchArtistsByGenre(genre, taste.market, PER_GENRE);
        for (const artist of res) {
          if (!artist?.id) continue;
          const existing = found.get(artist.id);
          // An artist surfacing under several of your genres is a better bet than
          // one that only matched a single tag — accumulate that evidence.
          if (existing) existing.weight += weight;
          else found.set(artist.id, { artist, weight, sources: new Set([genre]) });
          found.get(artist.id).sources.add(genre);
        }
      } catch {
        /* one dud genre query shouldn't sink the run */
      }
      onProgress(++done, genres.length);
    })
  );

  return found;
}

/**
 * Channel B: secondary artists on tracks the user already listens to.
 * A feature credit is a strong, cheap signal that the API still gives away free.
 */
async function fromCollaborators(taste) {
  const counts = new Map();

  for (const [trackArtists, weight] of taste.collaboratorSeeds) {
    // Skip the primary artist: that's someone the user already has.
    for (const artist of trackArtists.slice(1)) {
      if (!artist?.id || taste.knownArtistIds.has(artist.id)) continue;
      counts.set(artist.id, (counts.get(artist.id) || 0) + weight);
    }
  }

  if (!counts.size) return new Map();

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120);

  const artists = await api.artists(top.map(([id]) => id));
  const byId = new Map(artists.map((a) => [a.id, a]));

  const out = new Map();
  for (const [id, weight] of top) {
    const artist = byId.get(id);
    if (artist) out.set(id, { artist, weight, collab: true, sources: new Set(['featured on tracks you play']) });
  }
  return out;
}

/**
 * Build a ranked list of artists the user probably doesn't know but should.
 * @returns {Promise<Array>} scored entries, same shape the festival matcher emits
 */
export async function discoverArtists(taste, { mainstream, onProgress = () => {} }) {
  onProgress('Searching your genres for artists you have missed…');
  const [genreHits, collabHits] = await Promise.all([
    fromGenres(taste, (done, total) => onProgress(`Searching your genres… ${done}/${total}`)),
    fromCollaborators(taste),
  ]);

  onProgress('Filtering out everything you already listen to…');

  const merged = new Map();
  for (const [id, entry] of genreHits) merged.set(id, entry);
  for (const [id, entry] of collabHits) {
    const existing = merged.get(id);
    if (existing) {
      existing.collab = true;
      existing.weight += entry.weight;
      for (const s of entry.sources) existing.sources.add(s);
    } else {
      merged.set(id, entry);
    }
  }

  // The whole point is artists the user does NOT already have.
  const candidates = [...merged.values()].filter(
    ({ artist }) => !taste.knownArtistIds.has(artist.id)
  );

  if (!candidates.length) return [];

  // Boost map: how much each candidate's provenance is worth, over and above
  // pure genre similarity.
  const boosts = new Map();
  for (const { artist, weight, collab, sources } of candidates) {
    const multiGenre = Math.min((sources.size - 1) * 0.06, 0.18);
    boosts.set(artist.id, (collab ? 0.42 : 0) + multiGenre + Math.min(weight * 0.12, 0.12));
  }

  const provenance = new Map(
    candidates.map(({ artist, collab, sources }) => [
      artist.id,
      collab ? 'Featured on tracks you already play' : `Matches your ${[...sources].slice(0, 2).join(' + ')}`,
    ])
  );

  onProgress('Scoring candidates against your taste…');
  const ranked = scoreArtists(
    candidates.map((c) => c.artist),
    taste,
    { discovery: 1, mainstream, boosts }
  );

  // Replace the generic explanation with where the candidate actually came from.
  for (const entry of ranked) {
    const reason = provenance.get(entry.artist.id);
    if (reason) entry.why = reason;
  }

  return ranked;
}
