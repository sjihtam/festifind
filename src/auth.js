// Spotify OAuth 2.0 Authorization Code + PKCE.
//
// PKCE is what makes this app backend-free: no client secret exists anywhere,
// so nothing sensitive ships to the browser. The only thing you configure is a
// Client ID, which is public by design.

import { SPOTIFY_CLIENT_ID, OWNER_CONTACT } from './config.js';

const AUTH_HOST = 'https://accounts.spotify.com';

/**
 * The redirect target is the app's own base URL — the directory the page lives
 * in — rather than a /callback route.
 *
 * That's what makes static hosting work. GitHub Pages serves projects from a
 * subpath (/festifind/) and has no SPA fallback, so a /callback route would just
 * 404. Redirecting to the page itself needs no server routing at all, and the
 * same code works from a subpath, a custom domain, or 127.0.0.1.
 *
 * Exported separately from the browser globals so it can be tested directly.
 */
export function redirectUriFor(origin, pathname) {
  // Drop any trailing filename ("/festifind/index.html" -> "/festifind/") and
  // guarantee exactly one trailing slash, since Spotify matches this exactly.
  const dir = pathname.replace(/[^/]*$/, '');
  return `${origin}${dir.endsWith('/') ? dir : `${dir}/`}`;
}

const REDIRECT_URI = redirectUriFor(location.origin, location.pathname);

const SCOPES = [
  'user-top-read',            // top artists + tracks, the backbone of the taste profile
  'user-library-read',        // saved tracks
  'user-follow-read',         // followed artists (strongest explicit signal)
  'user-read-recently-played',// short-term drift
  'user-read-private',        // country code, for track market filtering
  'playlist-modify-private',
  'playlist-modify-public',
].join(' ');

const LS = {
  clientId: 'festifind.clientId',
  verifier: 'festifind.pkceVerifier',
  tokens: 'festifind.tokens',
};

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomVerifier(length = 96) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

/**
 * The configured Client ID wins; the localStorage one is an escape hatch for
 * anyone who'd rather point this at their own Spotify app.
 */
export function getClientId() {
  return (SPOTIFY_CLIENT_ID || localStorage.getItem(LS.clientId) || '').trim();
}

/** True when setup has already been done, so nobody else has to see it. */
export function isConfigured() {
  return Boolean(getClientId());
}

export function getOwnerContact() {
  return (OWNER_CONTACT || '').trim();
}

export function setClientId(id) {
  localStorage.setItem(LS.clientId, id.trim());
}

export function getRedirectUri() {
  return REDIRECT_URI;
}

function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(LS.tokens) || 'null');
  } catch {
    return null;
  }
}

function writeTokens(payload) {
  const tokens = {
    access_token: payload.access_token,
    // A refresh grant may omit refresh_token; keep the previous one in that case.
    refresh_token: payload.refresh_token || readTokens()?.refresh_token,
    expires_at: Date.now() + (payload.expires_in - 60) * 1000, // 60s safety margin
  };
  localStorage.setItem(LS.tokens, JSON.stringify(tokens));
  return tokens;
}

export function isLoggedIn() {
  return Boolean(readTokens()?.refresh_token || readTokens()?.access_token);
}

export function logout() {
  localStorage.removeItem(LS.tokens);
  localStorage.removeItem(LS.verifier);
}

/**
 * Turn Spotify's OAuth error codes into something a non-technical user can act on.
 *
 * `access_denied` is the one that matters: it covers both "you hit Cancel" and
 * "your account isn't on this app's allowlist". Spotify doesn't distinguish
 * between them, and the allowlist cause is by far the more confusing one, so the
 * message has to name both possibilities without asserting either.
 */
function describeAuthError(code) {
  const ask = getOwnerContact()
    ? `Ask ${getOwnerContact()} to add your Spotify account.`
    : 'Ask whoever set this up to add your Spotify account.';

  if (code === 'access_denied') {
    return (
      'Spotify would not let you in. Either you cancelled on the permission screen, ' +
      `or your Spotify account has not been added to this app yet. ${ask}`
    );
  }
  if (code === 'invalid_client') {
    return 'This app\'s Spotify Client ID is wrong or the app was deleted. Whoever set this up needs to run setup again.';
  }
  return `Spotify refused the sign-in (${code}).`;
}

export async function beginLogin() {
  const clientId = getClientId();
  if (!clientId) throw new Error('This copy of Festifind has not been set up yet.');

  const verifier = randomVerifier();
  localStorage.setItem(LS.verifier, verifier);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope: SCOPES,
    show_dialog: 'false',
  });

  location.assign(`${AUTH_HOST}/authorize?${params}`);
}

/**
 * If the current URL is an OAuth callback, exchange the code for tokens.
 * Returns true when a login was just completed.
 */
export async function completeLoginIfCallback() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (!code && !error) return false;

  // Clear the query string either way so a refresh doesn't retry a spent code.
  history.replaceState({}, '', REDIRECT_URI);

  if (error) throw new Error(describeAuthError(error));

  const verifier = localStorage.getItem(LS.verifier);
  if (!verifier) throw new Error('Login state was lost. Try connecting again.');

  const res = await fetch(`${AUTH_HOST}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: getClientId(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (${res.status}): ${body.error_description || body.error || 'unknown'}`
    );
  }

  localStorage.removeItem(LS.verifier);
  writeTokens(body);
  return true;
}

async function refresh() {
  const tokens = readTokens();
  if (!tokens?.refresh_token) throw new Error('Session expired. Connect to Spotify again.');

  const res = await fetch(`${AUTH_HOST}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: getClientId(),
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    logout();
    throw new Error('Session expired. Connect to Spotify again.');
  }
  return writeTokens(body);
}

/** Returns a valid access token, refreshing transparently when needed. */
export async function getAccessToken() {
  let tokens = readTokens();
  if (!tokens) throw new Error('Not connected to Spotify.');
  if (Date.now() >= tokens.expires_at) tokens = await refresh();
  return tokens.access_token;
}
