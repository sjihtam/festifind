// Thin Spotify Web API client.
//
// Only endpoints that still work for newly-created apps are used here. As of the
// November 2024 deprecation, apps created after that date get 403 on:
//   /recommendations, /audio-features, /audio-analysis,
//   /artists/{id}/related-artists, featured-playlists, category playlists.
// The recommendation engine in recommend.js exists because of that.

import { getAccessToken } from './auth.js';

const API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

let inFlight = 0;
const MAX_CONCURRENT = 6;
const queue = [];

function acquire() {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Core request helper. Handles auth, concurrency capping, 429 back-off and
 * transient 5xx retries.
 */
async function request(path, { method = 'GET', body, retries = 3 } = {}) {
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      const token = await getAccessToken();
      const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 && attempt < retries) {
        // Spotify's Retry-After is in seconds. It can occasionally be large.
        const wait = Number(res.headers.get('Retry-After') || 2);
        await sleep(Math.min(wait, 20) * 1000);
        continue;
      }

      if (res.status >= 500 && attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }

      if (res.status === 204) return null;

      const text = await res.text();

      // Spotify normally returns JSON, but proxies, captive portals, CDN error
      // pages and rate-limit walls return HTML or plain text. Parsing that blindly
      // surfaced a raw "JSON parse error" with no clue where it came from.
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new SpotifyError(
            `Spotify returned something that isn't JSON (HTTP ${res.status}) from ${path.split('?')[0]}. ` +
            `First bytes: ${JSON.stringify(text.slice(0, 80))}. ` +
            `That usually means a network or proxy issue rather than a problem with your account.`,
            res.status,
            text.slice(0, 200)
          );
        }
      }

      if (!res.ok) {
        const detail = json?.error?.message || text || res.statusText;
        if (res.status === 403) {
          throw new SpotifyError(
            `Spotify refused this request (403): ${detail}. If this mentions a deprecated endpoint, that API is no longer available to new apps.`,
            403,
            detail
          );
        }
        throw new SpotifyError(`Spotify API ${res.status}: ${detail}`, res.status, detail);
      }

      return json;
    }
  } finally {
    release();
  }
}

/** Split an array into fixed-size chunks (Spotify's batch endpoints cap at 50). */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Follow `next` links until `limit` items are collected. */
async function paginate(path, limit) {
  const items = [];
  let url = path;
  while (url && items.length < limit) {
    const page = await request(url);
    if (!page?.items?.length) break;
    items.push(...page.items);
    url = page.next;
  }
  return items.slice(0, limit);
}

export const api = {
  me: () => request('/me'),

  topArtists: (time_range, limit = 50) =>
    paginate(`/me/top/artists?time_range=${time_range}&limit=50`, limit),

  topTracks: (time_range, limit = 50) =>
    paginate(`/me/top/tracks?time_range=${time_range}&limit=50`, limit),

  savedTracks: (limit = 200) => paginate('/me/tracks?limit=50', limit),

  savedAlbums: (limit = 100) => paginate('/me/albums?limit=50', limit),

  myPlaylists: (limit = 50) => paginate('/me/playlists?limit=50', limit),

  playlistTracks: (id, limit = 200) => {
    // `fields` trims the payload to what the taste profile reads — full playlist
    // pages are enormous (every track carries available_markets etc.).
    const fields = encodeURIComponent(
      'items(added_at,track(id,name,popularity,is_local,artists(id,name),album(release_date))),next'
    );
    return paginate(`/playlists/${id}/tracks?limit=100&fields=${fields}`, limit);
  },

  recentlyPlayed: async (limit = 50) => {
    const page = await request(`/me/player/recently-played?limit=${Math.min(limit, 50)}`);
    return page?.items || [];
  },

  followedArtists: async (limit = 200) => {
    const items = [];
    let url = '/me/following?type=artist&limit=50';
    while (url && items.length < limit) {
      const page = await request(url);
      const artists = page?.artists;
      if (!artists?.items?.length) break;
      items.push(...artists.items);
      url = artists.next;
    }
    return items.slice(0, limit);
  },

  /** Batched artist lookup — the only way to get genres and popularity. */
  artists: async (ids) => {
    const unique = [...new Set(ids.filter(Boolean))];
    const pages = await Promise.all(
      chunk(unique, 50).map((batch) => request(`/artists?ids=${batch.join(',')}`))
    );
    return pages.flatMap((p) => p?.artists || []).filter(Boolean);
  },

  searchArtist: async (name, market) => {
    const q = encodeURIComponent(name);
    const res = await request(`/search?q=${q}&type=artist&limit=5&market=${market}`);
    return res?.artists?.items || [];
  },

  /**
   * Artist search filtered by genre. This is the closest surviving substitute for
   * the retired /recommendations endpoint — it's how discovery finds artists the
   * user has never played. Returns full artist objects, genres included.
   */
  searchArtistsByGenre: async (genre, market, limit = 50) => {
    const q = encodeURIComponent(`genre:"${genre}"`);
    const pages = [];
    for (let offset = 0; offset < limit; offset += 50) {
      const res = await request(
        `/search?q=${q}&type=artist&limit=${Math.min(50, limit - offset)}&offset=${offset}&market=${market}`
      );
      const items = res?.artists?.items || [];
      pages.push(...items);
      if (items.length < 50) break;
    }
    return pages;
  },

  artistTopTracks: async (id, market) => {
    const res = await request(`/artists/${id}/top-tracks?market=${market}`);
    return res?.tracks || [];
  },

  artistAlbums: async (id, market, limit = 12) => {
    const res = await request(
      `/artists/${id}/albums?include_groups=album,single&market=${market}&limit=${limit}`
    );
    return res?.items || [];
  },

  albumTracks: async (id, market) => {
    const res = await request(`/albums/${id}/tracks?market=${market}&limit=50`);
    return res?.items || [];
  },

  /** Full track objects, needed for popularity (album-track objects lack it). */
  tracks: async (ids, market) => {
    const unique = [...new Set(ids.filter(Boolean))];
    const pages = await Promise.all(
      chunk(unique, 50).map((batch) => request(`/tracks?ids=${batch.join(',')}&market=${market}`))
    );
    return pages.flatMap((p) => p?.tracks || []).filter(Boolean);
  },

  createPlaylist: (userId, { name, description, isPublic }) =>
    request(`/users/${userId}/playlists`, {
      method: 'POST',
      body: { name, description, public: isPublic },
    }),

  addTracks: async (playlistId, uris) => {
    // 100 URIs per call, and order matters, so these go sequentially.
    for (const batch of chunk(uris, 100)) {
      await request(`/playlists/${playlistId}/tracks`, {
        method: 'POST',
        body: { uris: batch },
      });
    }
  },
};
