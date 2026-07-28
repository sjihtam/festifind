// UI orchestration: auth, festival choice, both engines, and playlist saving.

import {
  beginLogin, completeLoginIfCallback, setClientId,
  getRedirectUri, isLoggedIn, logout, isConfigured,
} from './auth.js';
import { api } from './spotify.js';
import { buildTasteProfile } from './taste.js';
import { resolveLineup, scoreArtists, selectTracks } from './recommend.js';
import { discoverArtists } from './discover.js';

const $ = (sel) => document.querySelector(sel);
const CUSTOM_LINEUPS = 'festifind.customLineups';
const CARD_ART = 'festifind.cardArt';

const state = {
  festivals: [],
  selected: null,
  taste: null,
  festival: { picks: [], ranked: [], unmatched: [] },
  discover: { picks: [], ranked: [] },
  when: 'upcoming',
  preset: 'balanced',
  customLineups: loadCustomLineups(),
  cardArt: loadCardArt(),
};

function loadCardArt() {
  try {
    return JSON.parse(localStorage.getItem(CARD_ART) || '{}');
  } catch {
    return {};
  }
}

/**
 * Some festivals have no freely licensed photo anywhere — Wikimedia Commons has
 * nothing for Dekmantel, Solar Weekend or Wildeburg, and the near-misses it
 * returns are unrelated events at the same venue. Rather than mislabel one of
 * those, fall back to a headliner's own Spotify press photo: always available,
 * genuinely relevant, and no licensing problem.
 *
 * One search per festival, cached, and only for the ones actually missing art.
 */
async function hydrateMissingArtwork() {
  const missing = state.festivals.filter(
    (f) => !f.image && !state.cardArt[f.id] && lineupFor(f).length
  );
  if (!missing.length) return;

  let found = false;
  await Promise.all(
    missing.map(async (f) => {
      // Try a couple of names in case the first headliner has no photo.
      for (const name of lineupFor(f).slice(0, 3)) {
        try {
          const [artist] = await api.searchArtist(name, state.taste?.market || 'NL');
          const url = artist?.images?.[0]?.url;
          if (url) {
            state.cardArt[f.id] = url;
            found = true;
            return;
          }
        } catch {
          return; // no token yet, or search failed — the gradient still looks fine
        }
      }
    })
  );

  if (found) {
    localStorage.setItem(CARD_ART, JSON.stringify(state.cardArt));
    renderFestivals();
  }
}

/**
 * Presets are the primary control. Two abstract axes are a lot to ask of someone
 * who just wants a playlist, so the sliders are demoted to "Fine-tune" and these
 * carry the common intents.
 */
const PRESETS = [
  { id: 'discover', label: 'Discover',  hint: 'Mostly artists new to you', discovery: 0.9,  mainstream: 0.35 },
  // Balanced is the default, and matches the slider values in index.html so the
  // highlighted preset always agrees with the controls underneath it.
  { id: 'balanced', label: 'Balanced',  hint: 'Favourites and new names',  discovery: 0.62, mainstream: 0.48 },
  { id: 'familiar', label: 'Familiar',  hint: 'Artists you already play',  discovery: 0.12, mainstream: 0.6 },
  { id: 'deep',     label: 'Deep cuts', hint: 'Album tracks, not singles',  discovery: 0.75, mainstream: 0.08 },
  { id: 'hits',     label: 'The hits',  hint: 'What the crowd will sing',   discovery: 0.45, mainstream: 0.95 },
];

/** Colour identity per festival, derived from its genres. */
const PALETTES = [
  [/hardstyle|hardcore|uptempo|frenchcore|gabber|hard dance|rawstyle/, ['#FF4D4D', '#FF8A3D']],
  [/jazz|soul|funk|blues|r&b/,                                        ['#F59E0B', '#EF4444']],
  [/hip hop|rap|trap|drill/,                                          ['#8B5CF6', '#D946EF']],
  [/indie|rock|folk|post-punk|singer|art pop|shoegaze/,               ['#0EA5E9', '#14B8A6']],
  [/trance|drum and bass|edm|big room/,                               ['#06B6D4', '#3B82F6']],
  [/house|disco|garage/,                                              ['#EC4899', '#F97316']],
  [/techno|electro|industrial|ambient|leftfield|experimental/,        ['#4F46E5', '#8B5CF6']],
];

function paletteFor(festival) {
  const genres = (festival.genrePrior || []).join(' ').toLowerCase();
  for (const [test, colours] of PALETTES) if (test.test(genres)) return colours;
  return ['#4F46E5', '#8B5CF6'];
}

// ── small helpers ──────────────────────────────────────────────────────────

function loadCustomLineups() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_LINEUPS) || '{}');
  } catch {
    return {};
  }
}

const saveCustomLineups = () =>
  localStorage.setItem(CUSTOM_LINEUPS, JSON.stringify(state.customLineups));

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 9000 : 4000);
}

function progressFor(selector) {
  return (message) => {
    const el = $(selector);
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span></span>';
    el.querySelector('span').textContent = message;
  };
}

const progress = progressFor('#progress');
const discoverProgress = progressFor('#discover-progress');

const fmtDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const dateRange = (f) => (f.start === f.end ? fmtDate(f.start) : `${fmtDate(f.start)} – ${fmtDate(f.end)}`);

const isPast = (f) => new Date(`${f.end}T23:59:59`) < new Date();

/** Human-scale countdown, which is what you actually want to know. */
function relativeWhen(f) {
  const now = new Date();
  const start = new Date(`${f.start}T12:00:00`);
  const days = Math.round((start - now) / 86400000);
  if (isPast(f)) return 'Finished';
  if (days <= 0) return 'On now';
  if (days === 1) return 'Tomorrow';
  if (days <= 7) return `In ${days} days`;
  if (days <= 13) return 'Next week';
  if (days <= 60) return `In ${Math.round(days / 7)} weeks`;
  return `In ${Math.round(days / 30)} months`;
}

/** Effective lineup: a user-pasted override wins over the bundled one. */
const lineupFor = (f) => state.customLineups[f.id] || f.lineup;

function lineupStatusTag(f) {
  switch (f.lineupStatus) {
    case 'verified': return '<span class="tag verified">full lineup</span>';
    case 'partial': return '<span class="tag partial">partial</span>';
    case 'not-announced': return '<span class="tag unannounced">no published lineup</span>';
    default: return '';
  }
}

const sliders = () => ({
  discovery: Number($('#discovery').value) / 100,
  mainstream: Number($('#mainstream').value) / 100,
  targetTracks: Number($('#length').value),
});

// ── auth / shell ───────────────────────────────────────────────────────────

const SPOTIFY_GLYPH = `<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.5 17.3a.75.75 0 0 1-1.03.25c-2.8-1.7-6.32-2.1-10.46-1.14a.75.75 0 1 1-.33-1.46c4.54-1.04 8.43-.58 11.57 1.34.35.22.46.68.25 1.02zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.2-1.97-8.08-2.54-11.87-1.39a.94.94 0 1 1-.54-1.8c4.32-1.3 9.7-.67 13.38 1.58.44.27.58.85.32 1.3zm.13-3.4C15.24 8.4 8.82 8.2 5.2 9.3a1.12 1.12 0 1 1-.65-2.15c4.16-1.26 11.25-1.02 15.7 1.62a1.12 1.12 0 0 1-1.15 1.93z"/>
</svg>`;

function renderSession() {
  const el = $('#session');
  if (!isLoggedIn()) { el.innerHTML = ''; return; }
  const name = state.taste?.user?.name || '';
  el.innerHTML = `
    ${name ? '<span class="avatar"></span><span class="who"></span>' : ''}
    <button class="btn ghost sm" id="logout" type="button">Sign out</button>`;
  if (name) {
    el.querySelector('.who').textContent = name;
    el.querySelector('.avatar').textContent = name.trim().charAt(0).toUpperCase();
  }
  $('#logout').onclick = () => { logout(); location.reload(); };
}

/**
 * Hero artwork: real artists from the 2026 lineups in this app, with some tiles
 * lit and the rest dimmed — the whole idea of the product in one image, which is
 * that a festival bill gets narrowed down to the acts that fit you.
 *
 * All freely licensed from Wikimedia Commons. CC BY and CC BY-SA oblige us to
 * credit, which renderHeroCredits does directly under the panel.
 */
const HERO_ARTISTS = [
  { name: 'Tyler, The Creator', festival: 'Lowlands', match: true,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Tyler%2C_The_Creator_%288048745695%29_%28cropped%29.jpg/330px-Tyler%2C_The_Creator_%288048745695%29_%28cropped%29.jpg',
    by: 'Incase', license: 'CC BY 2.0',
    page: 'https://commons.wikimedia.org/wiki/File:Tyler,_The_Creator_(8048745695)_(cropped).jpg' },
  { name: 'Lorde', festival: 'Lowlands', match: false,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/Lorde_%282022%29_%28cropped%29.jpg/330px-Lorde_%282022%29_%28cropped%29.jpg',
    by: 'Raph_PH', license: 'CC BY 2.0',
    page: 'https://commons.wikimedia.org/wiki/File:Lorde_(2022)_(cropped).jpg' },
  { name: 'Charlotte de Witte', festival: 'Awakenings', match: true,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Charlotte_De_Witte_2023.jpg/330px-Charlotte_De_Witte_2023.jpg',
    by: 'ManoSolo13241324', license: 'CC BY-SA 4.0',
    page: 'https://commons.wikimedia.org/wiki/File:Charlotte_De_Witte_2023.jpg' },
  { name: 'Little Simz', festival: 'Down The Rabbit Hole', match: true,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Little_Simz_Performing.jpg/330px-Little_Simz_Performing.jpg',
    by: 'GeorgeMichaelBaker', license: 'CC BY-SA 4.0',
    page: 'https://commons.wikimedia.org/wiki/File:Little_Simz_Performing.jpg' },
  { name: 'Peggy Gou', festival: 'Dekmantel', match: false,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Peggy_Gou_2019.jpg/330px-Peggy_Gou_2019.jpg',
    by: 'Davide Guidone', license: 'Public domain',
    page: 'https://commons.wikimedia.org/wiki/File:Peggy_Gou_2019.jpg' },
  { name: 'Skrillex', festival: 'Dekmantel', match: false,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/ba/Skrillex.jpg/330px-Skrillex.jpg',
    by: 'Weekly Dig', license: 'CC BY 2.0',
    page: 'https://commons.wikimedia.org/wiki/File:Skrillex.jpg' },
  { name: 'Florence Welch', festival: 'Down The Rabbit Hole', match: false,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Florence_Welch.jpg/330px-Florence_Welch.jpg',
    by: 'Kevin Utting', license: 'CC BY 2.0',
    page: 'https://commons.wikimedia.org/wiki/File:Florence_Welch.jpg' },
  { name: 'Nina Kraviz', festival: 'Awakenings', match: true,
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Nina_Kraviz%2C_2012.jpg/330px-Nina_Kraviz%2C_2012.jpg',
    by: 'Alec Luhn', license: 'CC BY 2.0',
    page: 'https://commons.wikimedia.org/wiki/File:Nina_Kraviz,_2012.jpg' },
];

function renderHeroArt() {
  const grid = $('#hero-grid');
  grid.innerHTML = '';

  HERO_ARTISTS.forEach((artist, i) => {
    const tile = document.createElement('div');
    tile.className = `hero-tile${artist.match ? ' matched' : ''}`;
    tile.style.setProperty('--i', String(i));
    tile.innerHTML = `<img alt="" loading="lazy" /><span class="hero-tag"></span>`;
    tile.querySelector('img').src = artist.url;
    tile.querySelector('.hero-tag').textContent = artist.name;
    grid.appendChild(tile);
  });

  renderHeroCredits();
}

function renderHeroCredits() {
  const box = $('#hero-credits');
  if (!box) return;
  box.innerHTML = `<summary>Artist photo credits</summary><p></p>`;
  const p = box.querySelector('p');
  p.append('Wikimedia Commons: ');
  HERO_ARTISTS.forEach((a, i) => {
    const link = document.createElement('a');
    link.href = a.page;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${a.name} — ${a.by} (${a.license})`;
    p.append(link, i === HERO_ARTISTS.length - 1 ? '.' : ' · ');
  });
}

function showApp(loggedIn) {
  $('#hero').hidden = loggedIn;
  $('#app').hidden = !loggedIn;
  $('#actionbar').hidden = !(loggedIn && state.selected);
}

function renderConnect() {
  if (isLoggedIn()) {
    showApp(true);
    // Fills in artwork for festivals with no licensed photo. Fire-and-forget:
    // it re-renders the grid if it finds anything, and is harmless if it fails.
    hydrateMissingArtwork();
    return;
  }

  showApp(false);
  const cta = $('#hero-cta');

  if (isConfigured()) {
    cta.innerHTML = `
      <button class="btn spotify lg" id="connect" type="button">
        ${SPOTIFY_GLYPH}<span>Continue with Spotify</span>
      </button>
      <details class="note">
        <summary>What Festifind can see</summary>
        <p>
          Spotify shows you exactly what you're agreeing to. Festifind reads your top
          artists and tracks, who you follow, your saved songs and recent plays — and it
          can add a playlist, which only happens when you press Save. It never sees your
          password, email or payment details, and it never posts anything. Disconnect any
          time from <a href="https://www.spotify.com/account/apps/" target="_blank" rel="noopener noreferrer">your Spotify account page</a>.
        </p>
      </details>
      <details class="note">
        <summary>Use my own Spotify app instead</summary>
        <p>Only needed if you want this pointed at a Spotify app you control.</p>
        <div class="copyrow">
          <code id="redirect-uri"></code>
          <button class="btn ghost sm" id="copy-redirect" type="button">Copy</button>
        </div>
        <div class="copyrow">
          <input id="client-id" type="text" spellcheck="false" autocomplete="off" placeholder="Your Client ID" />
          <button class="btn sm" id="connect-custom" type="button">Use this ID</button>
        </div>
      </details>`;

    $('#redirect-uri').textContent = getRedirectUri();
    $('#copy-redirect').onclick = copyRedirect;
    $('#connect').onclick = startLogin;
    $('#connect-custom').onclick = () => {
      const id = $('#client-id').value.trim();
      if (!id) return toast('Paste a Client ID first.', true);
      setClientId(id);
      startLogin();
    };
    return;
  }

  cta.innerHTML = `
    <div class="disclaimer">
      <strong>This copy hasn't been set up yet.</strong>
      Run <code>npm run setup</code> in the project folder — about two minutes. After that,
      anyone you invite just sees a sign-in button.
    </div>
    <div class="copyrow">
      <code id="redirect-uri"></code>
      <button class="btn ghost sm" id="copy-redirect" type="button">Copy</button>
    </div>
    <span class="hint">Add this as a redirect URI, trailing slash included.</span>
    <div class="copyrow">
      <input id="client-id" type="text" spellcheck="false" autocomplete="off" placeholder="Client ID" />
      <button class="btn primary" id="connect" type="button">Connect</button>
    </div>
    <details class="note">
      <summary>How many people can use this?</summary>
      <p>
        Five, including you. Spotify caps Development Mode apps at 5 signed-in accounts,
        each added by email in the dashboard, and the owner needs Premium. Lifting that
        needs Extended Quota, granted only to registered businesses with 250,000+ monthly
        active users.
      </p>
    </details>`;

  $('#redirect-uri').textContent = getRedirectUri();
  $('#copy-redirect').onclick = copyRedirect;
  $('#connect').onclick = () => {
    const id = $('#client-id').value.trim();
    if (!id) return toast('Paste your Client ID first.', true);
    setClientId(id);
    startLogin();
  };
}

async function copyRedirect() {
  try {
    await navigator.clipboard.writeText(getRedirectUri());
    toast('Redirect URI copied.');
  } catch {
    toast('Could not copy — select the address and copy it manually.', true);
  }
}

async function startLogin() {
  try {
    await beginLogin();
  } catch (err) {
    toast(err.message, true);
  }
}

// ── festivals ──────────────────────────────────────────────────────────────

function renderFestivals() {
  const grid = $('#festival-grid');
  const list = state.festivals
    .filter((f) => (state.when === 'upcoming' ? !isPast(f) : true))
    .sort((a, b) => a.start.localeCompare(b.start));

  $('#festival-sub').textContent = state.festivals.length
    ? `${list.length} ${state.when === 'upcoming' ? 'still to come' : 'in 2026'} · lineups checked against official sites`
    : '';

  if (!list.length) {
    grid.innerHTML = `<p class="empty">Nothing left in 2026. Switch to “All of 2026” to look back.</p>`;
    return;
  }

  grid.innerHTML = '';
  for (const f of list) {
    const [c1, c2] = paletteFor(f);
    const custom = Boolean(state.customLineups[f.id]);
    const count = lineupFor(f).length;

    const card = document.createElement('div');
    card.className = `fest${isPast(f) ? ' past' : ''}${state.selected?.id === f.id ? ' selected' : ''}`;
    card.style.setProperty('--a1', c1);
    card.style.setProperty('--a2', c2);
    const photo = f.image?.url || state.cardArt[f.id];
    card.innerHTML = `
      <div class="fest-band${photo ? ' has-photo' : ''}">
        <span class="fest-check">✓</span>
        <span class="fest-when"></span>
      </div>
      <div class="fest-body">
        <div class="fest-name"></div>
        <div class="fest-meta"></div>
        <div class="fest-blurb"></div>
      </div>
      <div class="fest-tags">
        ${count ? `<span class="tag">${count} artists</span>` : ''}
        ${custom ? '<span class="tag custom">your lineup</span>' : lineupStatusTag(f)}
      </div>
      <div class="fest-actions">
        ${/* Festivals with no published bill can't work without acts, so they
              keep a way in. Everything else is just the official-site link. */
          count ? '' : '<button class="linklike" data-act="paste" type="button">Add the acts you want</button>'}
        ${custom ? '<button class="linklike" data-act="reset" type="button">Reset lineup</button>' : ''}
        <a class="linklike" href="${f.url}" target="_blank" rel="noopener noreferrer">Official site ↗</a>
      </div>`;

    if (photo) {
      const band = card.querySelector('.fest-band');
      // Set as a background rather than an <img> so the gradient scrim can sit
      // over it and keep the date chip readable on any photo.
      band.style.backgroundImage =
        `linear-gradient(150deg, color-mix(in srgb, ${c1} 62%, transparent), color-mix(in srgb, ${c2} 38%, transparent)), url("${photo}")`;
    }

    // textContent, not innerHTML — festival data is data, not markup.
    card.querySelector('.fest-when').textContent = relativeWhen(f);
    card.querySelector('.fest-name').textContent = f.name;
    card.querySelector('.fest-meta').textContent = `${dateRange(f)} · ${f.location}`;
    card.querySelector('.fest-blurb').textContent = f.blurb;

    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'paste') { e.stopPropagation(); return openLineupDialog(f); }
      if (act === 'reset') {
        e.stopPropagation();
        delete state.customLineups[f.id];
        saveCustomLineups();
        return renderFestivals();
      }
      if (e.target.closest('a')) return;
      state.selected = f;
      renderFestivals();
      renderActionBar();
    });

    grid.appendChild(card);
  }

  renderPhotoCredits(list);
}

/**
 * CC BY and CC BY-SA both require attribution, so the credits are part of
 * shipping the photos, not an optional extra.
 */
function renderPhotoCredits(list) {
  const box = $('#photo-credits');
  const withPhotos = list.filter((f) => f.image);
  if (!withPhotos.length) { box.hidden = true; return; }

  box.hidden = false;
  box.innerHTML = `<summary>Photo credits</summary><p></p>`;
  const p = box.querySelector('p');
  p.append(
    'Cards without a licensed festival photo show a headliner’s artist image from Spotify. ' +
    'Festival photos from Wikimedia Commons: '
  );
  withPhotos.forEach((f, i) => {
    const a = document.createElement('a');
    a.href = f.image.page;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `${f.name} — ${f.image.by} (${f.image.license})`;
    p.append(a);
    p.append(i === withPhotos.length - 1 ? '.' : ' · ');
  });
}

function renderActionBar() {
  const bar = $('#actionbar');
  if (!state.selected || !isLoggedIn()) { bar.hidden = true; return; }
  bar.hidden = false;
  const preset = PRESETS.find((p) => p.id === state.preset);
  $('#actionbar-title').textContent = state.selected.name;
  $('#actionbar-meta').textContent =
    `${$('#length').value} tracks · ${preset ? preset.label : 'Custom'}`;
}

// ── presets + sliders ──────────────────────────────────────────────────────

function renderPresets() {
  const wrap = $('#presets');
  wrap.innerHTML = '';
  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset${state.preset === preset.id ? ' active' : ''}`;
    btn.innerHTML = `<div class="preset-label"></div><div class="preset-hint"></div>`;
    btn.querySelector('.preset-label').textContent = preset.label;
    btn.querySelector('.preset-hint').textContent = preset.hint;
    btn.onclick = () => {
      state.preset = preset.id;
      $('#discovery').value = Math.round(preset.discovery * 100);
      $('#mainstream').value = Math.round(preset.mainstream * 100);
      renderPresets();
      syncControls();
      renderActionBar();
    };
    wrap.appendChild(btn);
  }
}

function describeDiscovery(v) {
  if (v < 20) return 'Mostly artists you already play. Few surprises.';
  if (v < 45) return 'Anchored on artists you know, with some new names.';
  if (v < 70) return 'A real balance of favourites and new artists.';
  if (v < 88) return 'Leans into artists you have never played — but only ones that fit.';
  return 'Almost entirely new to you. Discovery first.';
}

function describeMainstream(v) {
  if (v < 20) return 'Album tracks and back catalogue, past the singles.';
  if (v < 45) return 'Favours lesser-known tracks over obvious ones.';
  if (v < 70) return 'A mix of well-known tracks and album cuts.';
  if (v < 88) return 'Mostly singles and the recognisable songs.';
  return 'Biggest tracks only.';
}

function syncControls() {
  const d = Number($('#discovery').value);
  const m = Number($('#mainstream').value);
  const l = Number($('#length').value);
  $('#discovery-value').textContent = describeDiscovery(d);
  $('#mainstream-value').textContent = describeMainstream(m);
  $('#length-value').textContent = `${l} tracks · about ${Math.round((l * 3.6) / 60 * 10) / 10} hours`;
}

/** Manual slider use means the preset no longer describes the settings. */
function markCustom() {
  const match = PRESETS.find(
    (p) =>
      Math.abs(p.discovery * 100 - Number($('#discovery').value)) < 1 &&
      Math.abs(p.mainstream * 100 - Number($('#mainstream').value)) < 1
  );
  state.preset = match ? match.id : null;
  renderPresets();
  renderActionBar();
}

// ── shared result components ───────────────────────────────────────────────

function artMosaic(picks) {
  const seen = new Set();
  const images = [];
  for (const p of picks) {
    const url = p.track.album?.images?.[0]?.url;
    if (url && !seen.has(url)) { seen.add(url); images.push(url); }
    if (images.length === 4) break;
  }
  const node = document.createElement('div');
  node.className = 'mosaic';
  // One image fills the square; four make a grid. Anything between still tiles.
  for (const url of images.length ? images : [null]) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    if (url) img.src = url;
    if (images.length === 1) img.style.gridArea = '1 / 1 / 3 / 3';
    node.appendChild(img);
  }
  return node;
}

function renderRail(container, ranked, limit) {
  container.innerHTML = '';
  for (const entry of ranked.slice(0, limit)) {
    const { artist } = entry;
    const card = document.createElement('a');
    card.className = 'acard';
    card.href = artist.external_urls?.spotify || '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.innerHTML = `
      <img class="acard-img" alt="" loading="lazy" />
      <div class="acard-name"></div>
      <div class="acard-why"></div>
      <span class="acard-fit"></span>`;

    const img = artist.images?.[1]?.url || artist.images?.[0]?.url;
    if (img) card.querySelector('.acard-img').src = img;

    card.querySelector('.acard-name').textContent = artist.name;
    card.querySelector('.acard-why').textContent = entry.why;
    card.querySelector('.acard-fit').textContent =
      `${Math.round((Math.min(entry.score, 1.6) / 1.6) * 100)}% match`;
    container.appendChild(card);
  }
}

function renderTrackList(container, picks) {
  container.innerHTML = '';
  picks.forEach((pick, i) => {
    const { track, entry, alreadySaved, alreadyPlayed } = pick;
    const row = document.createElement('div');
    row.className = 'trk';
    row.innerHTML = `
      <div class="trk-n">${i + 1}</div>
      <img class="trk-art" alt="" loading="lazy" />
      <div>
        <div class="trk-title"></div>
        <div class="trk-sub"></div>
      </div>
      <div class="trk-why"></div>`;

    const art = track.album?.images?.at(-1)?.url;
    if (art) row.querySelector('.trk-art').src = art;

    const title = row.querySelector('.trk-title');
    title.textContent = track.name;
    // Track-level badges state only what was actually measured. "Saved" means it
    // is in your Liked Songs; "you play this" means it is in your top tracks,
    // which is a different thing and was previously mislabelled as saved.
    if (alreadySaved) title.insertAdjacentHTML('beforeend', '<span class="badge known">saved</span>');
    else if (alreadyPlayed) title.insertAdjacentHTML('beforeend', '<span class="badge known">you play this</span>');
    else if (!entry.isKnown) title.insertAdjacentHTML('beforeend', '<span class="badge">new artist</span>');

    row.querySelector('.trk-sub').textContent = track.artists.map((a) => a.name).join(', ');
    row.querySelector('.trk-why').textContent = entry.why;
    container.appendChild(row);
  });
}

function pills(items) {
  return items
    .map(([n, l]) => `<span class="pill"><strong>${n}</strong> ${l}</span>`)
    .join('');
}

/** Playlist creation writes to the user's account, so only ever on a click. */
function wireSave(buttonSel, nameSel, resultSel, getPayload) {
  $(buttonSel).onclick = async () => {
    const button = $(buttonSel);
    const { picks, description } = getPayload();
    const name = $(nameSel).value.trim() || 'Festifind playlist';

    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const playlist = await api.createPlaylist(state.taste.user.id, {
        name, description, isPublic: false,
      });
      await api.addTracks(playlist.id, picks.map((p) => p.track.uri));

      const box = $(resultSel);
      box.innerHTML = `<div class="saved-ok">Saved <strong></strong> — ${picks.length} tracks.
        <a href="${playlist.external_urls?.spotify}" target="_blank" rel="noopener noreferrer">Open in Spotify ↗</a></div>`;
      box.querySelector('strong').textContent = name;
      button.textContent = 'Saved ✓';
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), true);
      button.disabled = false;
      button.textContent = 'Save to Spotify';
    }
  };
}

function skeleton(container) {
  container.innerHTML = `
    <div class="skeleton">
      <div class="sk-hero">
        <div class="sk sk-mosaic"></div>
        <div>
          <div class="sk sk-line" style="width:32%"></div>
          <div class="sk" style="height:34px;width:64%;margin-bottom:14px"></div>
          <div class="sk sk-line" style="width:46%"></div>
        </div>
      </div>
      <div class="sk-rail">
        ${'<div><div class="sk sk-tile"></div><div class="sk sk-line" style="width:74%;margin-top:10px"></div></div>'.repeat(7)}
      </div>
    </div>`;
}

// ── festival results ───────────────────────────────────────────────────────

function renderFestivalResults() {
  const { picks, ranked, unmatched } = state.festival;
  const { selected, taste } = state;
  const el = $('#results');
  $('#section-results').hidden = false;

  if (!picks.length) {
    el.innerHTML = `<p class="empty">Nothing matched well enough to build a playlist.
      Try the Discover preset, or paste a fuller lineup.</p>`;
    return;
  }

  const newToYou = picks.filter((p) => !p.entry.isKnown).length;
  const artistCount = new Set(picks.map((p) => p.entry.artist.id)).size;

  el.innerHTML = `
    <div class="reveal">
      <div class="plhero">
        <div id="mosaic-slot"></div>
        <div>
          <div class="plhero-kicker">Your playlist</div>
          <h3 id="pl-title"></h3>
          <div class="plhero-stats">${pills([
            [picks.length, 'tracks'],
            [artistCount, 'artists'],
            [newToYou, 'outside your top artists'],
            [ranked.length, 'of the lineup matched'],
          ])}</div>
          <div class="save-row">
            <input type="text" id="playlist-name" aria-label="Playlist name" />
            <button class="btn primary" id="save-playlist" type="button">Save to Spotify</button>
          </div>
          <div id="save-result"></div>
        </div>
      </div>

      <h4 class="sub">Who to see</h4>
      <p class="sub-note">The lineup ranked by how well it fits you. Tap to open in Spotify.</p>
      <div class="rail" id="fest-artists"></div>

      <h4 class="sub">The tracks</h4>
      <p class="sub-note">Built from ${taste.counts.topArtists} of your top artists,
        ${taste.counts.followed} you follow and ${taste.counts.saved} saved songs.</p>
      <div class="tracklist" id="tracklist"></div>

      ${unmatched.length ? `<div class="unmatched"><strong>${unmatched.length} lineup ${unmatched.length === 1 ? 'name' : 'names'} could not be matched on Spotify</strong> and ${unmatched.length === 1 ? 'was' : 'were'} skipped rather than guessed at: <span id="unmatched-list"></span></div>` : ''}
    </div>`;

  $('#pl-title').textContent = selected.name;
  $('#playlist-name').value = `${selected.name} · for you`;
  $('#mosaic-slot').replaceWith(artMosaic(picks));
  if (unmatched.length) $('#unmatched-list').textContent = unmatched.join(', ');

  renderRail($('#fest-artists'), ranked, 20);
  renderTrackList($('#tracklist'), picks);

  // Stagger the three blocks in, subtly.
  [...el.querySelector('.reveal').children].forEach((child, i) => {
    child.style.animationDelay = `${Math.min(i, 5) * 55}ms`;
  });

  wireSave('#save-playlist', '#playlist-name', '#save-result', () => ({
    picks,
    description:
      `${selected.name} lineup matched to my listening. ${picks.length} tracks, ` +
      `${newToYou} from artists new to me. Made with Festifind.`,
  }));
}

async function generate() {
  if (!state.selected) return toast('Pick a festival first.', true);

  if (!lineupFor(state.selected).length) {
    return toast(
      `${state.selected.name} has no lineup published as one list. Use “Add the acts you want” on the card.`,
      true
    );
  }

  const button = $('#generate');
  button.disabled = true;
  $('#section-results').hidden = false;
  skeleton($('#results'));
  $('#section-results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const { discovery, mainstream, targetTracks } = sliders();

  try {
    await ensureTaste(progress);

    const names = lineupFor(state.selected);
    progress(`Matching ${names.length} artists on Spotify…`);
    const { artists, unmatched } = await resolveLineup(names, state.taste.market,
      (done, total) => progress(`Matching artists… ${done}/${total}`));

    if (!artists.length) throw new Error('None of the lineup could be matched on Spotify.');

    // Search results carry genres inconsistently; re-fetch in bulk so scoring
    // always sees the full artist object.
    progress('Loading genres and popularity…');
    const byId = new Map((await api.artists(artists.map((a) => a.id))).map((a) => [a.id, a]));
    const hydrated = artists.map((a) => ({ ...(byId.get(a.id) || a), lineupName: a.lineupName }));

    progress('Scoring the lineup against your taste…');
    const ranked = scoreArtists(hydrated, state.taste, {
      discovery, mainstream, genrePrior: state.selected.genrePrior || [],
    });

    const picks = await selectTracks(ranked, state.taste, {
      targetTracks, discovery, mainstream,
      onProgress: (done, total) => progress(`Choosing tracks… ${done}/${total} artists`),
    });

    state.festival = { ranked, picks, unmatched };
    progress(null);
    renderFestivalResults();
  } catch (err) {
    progress(null);
    console.error(err);
    $('#results').innerHTML = `<p class="empty">Could not build the playlist.</p>`;
    toast(err.message || String(err), true);
  } finally {
    button.disabled = false;
  }
}

// ── open-ended discovery ───────────────────────────────────────────────────

function renderDiscoverResults() {
  const { picks, ranked } = state.discover;
  const el = $('#discover-results');

  if (!picks.length) {
    el.innerHTML = `<p class="empty">Could not find enough new artists — your library
      already covers your genres thoroughly.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="reveal">
      <div class="plhero">
        <div id="disc-mosaic-slot"></div>
        <div>
          <div class="plhero-kicker">New to you</div>
          <h3>Artists you've never played</h3>
          <div class="plhero-stats">${pills([
            [ranked.length, 'artists found'],
            [picks.length, 'tracks'],
          ])}</div>
          <div class="save-row">
            <input type="text" id="disc-name" aria-label="Playlist name" value="New to me · picked from my taste" />
            <button class="btn primary" id="disc-save" type="button">Save to Spotify</button>
          </div>
          <div id="disc-save-result"></div>
        </div>
      </div>

      <h4 class="sub">Artists to try</h4>
      <p class="sub-note">Found from your own genres and from people credited alongside artists you already play.</p>
      <div class="rail" id="disc-artists"></div>

      <h4 class="sub">One track each</h4>
      <div class="tracklist" id="disc-tracklist"></div>
    </div>`;

  $('#disc-mosaic-slot').replaceWith(artMosaic(picks));
  renderRail($('#disc-artists'), ranked, 24);
  renderTrackList($('#disc-tracklist'), picks);

  wireSave('#disc-save', '#disc-name', '#disc-save-result', () => ({
    picks,
    description: `${picks.length} tracks from artists I have never played, matched to my listening history. Made with Festifind.`,
  }));
}

async function runDiscovery() {
  const button = $('#discover');
  button.disabled = true;
  skeleton($('#discover-results'));

  const { mainstream, targetTracks } = sliders();

  try {
    await ensureTaste(discoverProgress);

    const ranked = await discoverArtists(state.taste, { mainstream, onProgress: discoverProgress });
    if (!ranked.length) {
      state.discover = { picks: [], ranked: [] };
      discoverProgress(null);
      return renderDiscoverResults();
    }

    // discovery: 1 — every one of these is an artist the user has never played,
    // so there is no familiarity left to trade against.
    const picks = await selectTracks(ranked, state.taste, {
      targetTracks, discovery: 1, mainstream,
      onProgress: (done, total) => discoverProgress(`Picking a track each… ${done}/${total}`),
    });

    state.discover = { ranked, picks };
    discoverProgress(null);
    renderDiscoverResults();
  } catch (err) {
    discoverProgress(null);
    console.error(err);
    $('#discover-results').innerHTML = '';
    toast(err.message || String(err), true);
  } finally {
    button.disabled = false;
  }
}

async function ensureTaste(report) {
  if (state.taste) return state.taste;
  state.taste = await buildTasteProfile(report);
  renderSession();
  return state.taste;
}

// ── lineup dialog ──────────────────────────────────────────────────────────

let dialogTarget = null;

function openLineupDialog(festival) {
  dialogTarget = festival;
  $('#lineup-text').value = lineupFor(festival).join('\n');
  $('#lineup-dialog').showModal();
}

function parseLineupText(text) {
  return [...new Set(
    text
      .split(/[\n,;|]+/)
      .map((s) => s
        .replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '')
        .replace(/\s*\((?:live|dj set|b2b.*|hybrid set)\)\s*$/i, '')
        .trim())
      .filter((s) => s.length > 1 && s.length < 60)
      .filter((s) => !/^(friday|saturday|sunday|thursday|monday|tuesday|wednesday|vrijdag|zaterdag|zondag|donderdag|day \d|dag \d|stage|main stage|line ?-?up)$/i.test(s))
  )];
}

// ── boot ───────────────────────────────────────────────────────────────────

async function init() {
  if (location.protocol === 'file:') {
    $('#hero').hidden = false;
    $('#hero-cta').innerHTML = `
      <div class="disclaimer">
        <strong>This page needs to be served, not opened from a folder.</strong>
        Browsers block file access for pages loaded off disk, and Spotify sign-in needs a
        real address to return to.
      </div>
      <p class="hint">Run <code>npm start</code> in this folder, then open
        <a href="http://127.0.0.1:8888">http://127.0.0.1:8888</a>.</p>`;
    return;
  }

  // Resolved against this module's own URL, so it survives being served from a
  // subpath like /festifind/ on GitHub Pages.
  const res = await fetch(new URL('../data/festivals.json', import.meta.url));
  state.festivals = (await res.json()).festivals;

  renderHeroArt();
  renderFestivals();
  renderPresets();
  syncControls();

  for (const btn of document.querySelectorAll('#when-filter .seg-btn')) {
    btn.onclick = () => {
      document.querySelectorAll('#when-filter .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.when = btn.dataset.when;
      renderFestivals();
    };
  }

  for (const id of ['#discovery', '#mainstream']) {
    $(id).addEventListener('input', () => { syncControls(); markCustom(); });
  }
  $('#length').addEventListener('input', () => { syncControls(); renderActionBar(); });

  $('#generate').onclick = generate;
  $('#discover').onclick = runDiscovery;

  // The tuning controls stay out of the way until someone actually wants them.
  $('#customise').onclick = () => {
    const tune = $('#section-tune');
    tune.hidden = !tune.hidden;
    $('#customise').textContent = tune.hidden ? 'Customise' : 'Hide options';
    if (!tune.hidden) tune.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#close-tune').onclick = () => {
    $('#section-tune').hidden = true;
    $('#customise').textContent = 'Customise';
  };

  $('#lineup-dialog').addEventListener('close', (e) => {
    if (e.target.returnValue !== 'save' || !dialogTarget) return;
    const names = parseLineupText($('#lineup-text').value);
    if (!names.length) return toast('That did not contain any artist names.', true);
    state.customLineups[dialogTarget.id] = names;
    saveCustomLineups();
    renderFestivals();
    toast(`Lineup for ${dialogTarget.name} replaced with ${names.length} artists.`);
  });

  // Hairline under the app bar only once the page has moved.
  const onScroll = () => $('#appbar').classList.toggle('stuck', window.scrollY > 4);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  try {
    await completeLoginIfCallback();
  } catch (err) {
    toast(err.message, true);
  }

  renderSession();
  renderConnect();
  renderActionBar();

  // ?demo=1 renders the result views with obviously-synthetic data, so the
  // layout can be checked without signing in. It never touches Spotify and is
  // inert unless the flag is present.
  if (new URLSearchParams(location.search).has('demo')) enterDemoMode();
}

function enterDemoMode() {
  const fakeArtist = (i) => ({
    id: `demo${i}`,
    name: ['Overmono', 'Helena Hauff', 'Sofia Kourtesis', 'Skee Mask', 'Upsammy',
           'Palms Trax', 'Objekt', 'Nala Sinephro', 'Batu', 'Verraco',
           'Konduku', 'Bitter Babe'][i % 12],
    genres: ['deep house', 'techno'],
    popularity: 40 + (i % 30),
    images: [],
    external_urls: { spotify: '#' },
  });

  const picks = Array.from({ length: 24 }, (_, i) => {
    const artist = fakeArtist(i);
    return {
      track: {
        id: `t${i}`,
        uri: `spotify:track:demo${i}`,
        name: ['Gunk', 'Qualm', 'By Your Side', 'Rev8617', 'Twirls', 'Forever'][i % 6],
        popularity: 30 + (i % 40),
        album: { images: [], release_date: '2024-05-01' },
        artists: [{ name: artist.name }],
      },
      entry: {
        artist,
        score: 1.4 - i * 0.03,
        isKnown: i % 3 === 0,
        why: i % 3 === 0
          ? 'You already listen to this artist'
          : 'Outside your top artists · matches your deep house',
      },
      alreadySaved: i % 5 === 0,
      alreadyPlayed: i % 7 === 0,
    };
  });

  state.taste = {
    user: { id: 'demo', name: 'Demo' },
    counts: { topArtists: 84, followed: 37, saved: 300, genres: 62 },
  };
  state.selected = state.festivals[0];
  state.festival = { picks, ranked: picks.map((p) => p.entry), unmatched: ['DJ Unknown'] };
  state.discover = { picks: picks.slice(0, 18), ranked: picks.map((p) => p.entry) };

  showApp(true);
  renderSession();
  renderFestivals();
  renderActionBar();
  renderFestivalResults();
  renderDiscoverResults();
  toast('Demo mode — synthetic data, nothing from Spotify.');
}

init().catch((err) => {
  console.error(err);
  toast(`Failed to start: ${err.message}`, true);
});
