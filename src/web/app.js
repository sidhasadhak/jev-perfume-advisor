/**
 * Scent Sommelier - browser client. Vanilla JS, no build step.
 *
 * Safety rule: server strings only ever reach the DOM through textContent /
 * text nodes. The one exception is the assistant reply, which goes through
 * formatReply() (escape everything first, then add the two whitelisted tags).
 * Catalog URLs are restricted to http(s) before they become src/href.
 */

const API = { chat: '/api/chat', reset: '/api/reset', health: '/api/health' };
const SESSION_KEY = 'scent-sommelier.sessionId';
/** The server refuses longer messages (src/server/app.ts); the textarea's maxlength in index.html matches. */
const MAX_MESSAGE_CHARS = 1000;
/** maxlength stops input silently, so the count appears once a draft gets this close to the limit. */
const SHOW_COUNT_FROM = 800;
/** Live Jev turns fan out into several calls; give them room before giving up. */
const REQUEST_TIMEOUT_MS = 90_000;
const MONOGRAM_TONES = 8;
const MAX_ACCORDS = 5;

const EXAMPLES = [
  { kind: 'Occasion', text: 'Suggest a perfume for an evening party' },
  { kind: 'Climate', text: 'Something for Nordic winters' },
  { kind: 'Travel', text: 'What should I wear for a summer in Turkey?' },
  { kind: 'Work', text: 'Best perfume for a working professional' },
  { kind: 'Persona', text: 'A perfume for a 65-year-old lady who loves the colour pink' },
];

const CATALOG_LABELS = { seed: 'Seed catalog', csv: 'FragDB CSV', api: 'FragDB API' };
/** Facets.projection / longevity use 1..4; 0 means "no preference" and is skipped. */
const LEVEL_KEYS = new Set(['projection', 'longevity']);
const LEVEL_WORDS = ['', 'soft', 'moderate', 'strong', 'beast mode'];

const dom = {
  log: document.getElementById('log'),
  welcome: document.getElementById('welcome'),
  examples: document.getElementById('examples'),
  resumeNote: document.getElementById('resume-note'),
  form: document.getElementById('composer'),
  input: document.getElementById('message'),
  count: document.getElementById('composer-count'),
  send: document.getElementById('send'),
  newChat: document.getElementById('new-chat'),
  modeBadge: document.getElementById('mode-badge'),
  catalogBadge: document.getElementById('catalog-badge'),
};

const state = {
  sessionId: readSessionId(),
  busy: false,
  controller: null,
  /** Bumped by "New chat" so a reply that lands after a reset is dropped. */
  generation: 0,
  catalogKnown: false,
  model: '',
  /** Set when a paste was cut short by maxlength, so the count can say why the text stops. */
  pasteCut: false,
};

// ---------------------------------------------------------------------------
// Storage - the session id is kept per TAB in sessionStorage. localStorage is shared by
// every tab, so two tabs would drive one server session: "Why is #1 the top pick?" in one
// tab would explain the other tab's #1, and New chat in one would wipe the other's context.
// sessionStorage still survives a reload, which is what the resume note relies on.
// Any access may throw (private mode, blocked site data), so every one is guarded and the
// in-memory copy in `state` stays authoritative.
// ---------------------------------------------------------------------------

function readSessionId() {
  try {
    return sessionStorage.getItem(SESSION_KEY) || null;
  } catch {
    return null;
  }
}

function writeSessionId(id) {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable - the session simply lasts as long as this page */
  }
}

function setSessionId(id) {
  state.sessionId = id || null;
  writeSessionId(state.sessionId);
}

// ---------------------------------------------------------------------------
// Small DOM + formatting helpers
// ---------------------------------------------------------------------------

/** Create an element. Children are appended as nodes or text - never parsed as HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

/** Parse one of OUR static SVG strings (never server data) into a node. */
function icon(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstChild;
}

const ICONS = {
  bottle: '<svg viewBox="0 0 32 32" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="12.5" y="3.5" width="7" height="5" rx="1.4"/><rect x="7.5" y="11.5" width="17" height="17" rx="5"/></svg>',
  external: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5"/></svg>',
};

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Server text may carry **bold** and \n only - escape everything, then allow exactly those. */
function formatReply(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\r?\n/g, '<br>');
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

const intFmt = new Intl.NumberFormat();

function fmtInt(n) {
  return Number.isFinite(n) ? intFmt.format(Math.round(n)) : '–';
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function fmtUsd(usd) {
  return Number.isFinite(usd) ? `$${usd.toFixed(6)}` : '–';
}

/** Jev probabilities are 0..1; anything larger is already a percentage. */
function fmtPct(p) {
  if (!Number.isFinite(p)) return '–';
  return `${Math.round(p <= 1 ? p * 100 : p)}%`;
}

function humanize(s) {
  return String(s).replace(/_/g, ' ');
}

function humanizeKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

function safeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u, window.location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToEnd() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function revealStart(node) {
  node.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// ---------------------------------------------------------------------------
// Header status
// ---------------------------------------------------------------------------

function setBadge(kind, text, title) {
  dom.modeBadge.className = `badge badge-${kind}`;
  dom.modeBadge.querySelector('.badge-text').textContent = text;
  if (title) dom.modeBadge.title = title;
  else dom.modeBadge.removeAttribute('title');
}

function showMode(mode) {
  if (mode === 'live') {
    setBadge('live', 'Live Jev', state.model ? `Calling TypeSafe Jev (${state.model})` : 'Calling TypeSafe Jev');
  } else if (mode === 'mock') {
    setBadge('mock', 'Mock mode – not calling Jev', 'Decisions come from a local stand-in; set a Jev API key for live results');
  }
}

function isMode(mode) {
  return mode === 'live' || mode === 'mock';
}

function showCatalog(catalog) {
  if (!isObj(catalog)) return;
  const source = CATALOG_LABELS[catalog.source] ?? 'Catalog';
  const count = num(catalog.count);
  dom.catalogBadge.textContent = Number.isFinite(count) ? `${source} · ${fmtInt(count)} perfumes` : source;
  dom.catalogBadge.hidden = false;
  state.catalogKnown = true;
}

async function loadHealth() {
  try {
    // A hung server should not leave the badge on "Checking…" forever.
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined;
    const res = await fetch(API.health, { headers: { accept: 'application/json' }, signal });
    const health = await res.json();
    if (!res.ok || !isObj(health)) throw new Error(`health ${res.status}`);
    state.model = str(health.model);
    if (health.ok === false) setBadge('off', 'Service degraded', `Mode: ${str(health.mode) || 'unknown'}`);
    else if (isMode(health.mode)) showMode(health.mode);
    else setBadge('off', 'Mode unknown');
    showCatalog(health.catalog);
  } catch {
    setBadge('off', 'Server unreachable', 'Could not reach /api/health');
  }
}

// ---------------------------------------------------------------------------
// Welcome / empty state
// ---------------------------------------------------------------------------

function renderExamples() {
  dom.examples.replaceChildren(
    ...EXAMPLES.map(({ kind, text }) =>
      el('li', {},
        el('button', { type: 'button', class: 'example', onclick: () => send(text) },
          el('span', { class: 'example-kind', text: kind }),
          el('span', { class: 'example-text', text }),
        ),
      ),
    ),
  );
}

function showWelcome(show) {
  dom.welcome.hidden = !show;
  dom.resumeNote.hidden = !(show && state.sessionId);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function appendUser(text) {
  const node = el('div', { class: 'msg msg-user' },
    el('span', { class: 'sr-only', text: 'You said:' }),
    el('div', { class: 'bubble bubble-user', text }),
  );
  dom.log.append(node);
  return node;
}

function botShell(...content) {
  return el('div', { class: 'msg msg-bot' },
    el('span', { class: 'avatar', 'aria-hidden': 'true' }, icon(ICONS.bottle)),
    el('div', { class: 'bot-body' }, ...content),
  );
}

function appendTyping() {
  const node = botShell(
    el('div', { class: 'bubble bubble-bot typing-bubble' },
      el('span', { class: 'dots', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
      el('span', { class: 'sr-only', text: 'Scent Sommelier is thinking…' }),
    ),
  );
  node.classList.add('typing');
  dom.log.append(node);
  return node;
}

function appendAssistant(reply, mode) {
  const text = el('div', { class: 'bubble bubble-bot' });
  text.innerHTML = formatReply(str(reply.text)); // escaped inside formatReply
  const recs = Array.isArray(reply.recommendations) ? reply.recommendations.filter(isObj) : [];
  const node = botShell(
    el('span', { class: 'sr-only', text: 'Scent Sommelier said:' }),
    text,
    recs.length ? renderCards(recs) : null,
    renderFollowUps(reply.followUps),
    isObj(reply.debug) ? renderDebug(reply.debug, mode) : null,
  );
  dom.log.append(node);
  return node;
}

/** Without onRetry there is no "Try again": used when resending the same text cannot succeed. */
function appendError(message, onRetry = null, lead = 'Something went wrong. ') {
  const node = el('div', { class: 'error-note' },
    el('p', {}, el('strong', { text: lead }), message),
    onRetry ? el('button', { type: 'button', class: 'btn-retry', onclick: onRetry }, 'Try again') : null,
  );
  dom.log.append(node);
  return node;
}

// ---------------------------------------------------------------------------
// Recommendation cards
// ---------------------------------------------------------------------------

/** Up to three initials so houses like "Maison Francis Kurkdjian" read as "MFK". */
function initials(brand) {
  const words = str(brand).split(/[\s&+\-_./]+/).filter(Boolean);
  const letters = words.slice(0, 3).map((w) => Array.from(w)[0]).join('');
  return (letters || '?').toUpperCase();
}

/** FNV-1a so the same perfume always gets the same tile colour. */
function toneFor(pid) {
  let h = 0x811c9dc5;
  for (const ch of String(pid)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % MONOGRAM_TONES) + 1;
}

function monogram(rec) {
  const letters = initials(rec.brand);
  return el('div', {
    class: `monogram tone-${toneFor(rec.pid ?? rec.name)}${letters.length > 2 ? ' long' : ''}`,
    'aria-hidden': 'true',
    text: letters,
  });
}

function cardMedia(rec, rank) {
  const src = safeUrl(rec.photo);
  let visual = monogram(rec);
  if (src) {
    const img = el('img', {
      src,
      alt: `${str(rec.name)} by ${str(rec.brand)}`,
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
    });
    img.addEventListener('error', () => img.replaceWith(monogram(rec)), { once: true });
    visual = img;
  }
  return el('div', { class: 'card-media' },
    visual,
    // Decorative: the surrounding <ol> already announces the position.
    el('span', { class: 'rank', 'aria-hidden': 'true', text: String(rank) }),
  );
}

function matchMeter(match) {
  const pct = Math.max(0, Math.min(100, Math.round(num(match) || 0)));
  const fill = el('span', { class: 'meter-fill' });
  fill.style.width = `${pct}%`;
  return el('div', {
    class: 'match',
    role: 'meter',
    'aria-label': 'Match',
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': pct,
    'aria-valuetext': `${pct}% match`,
  },
    el('span', { class: 'meter-track', 'aria-hidden': 'true' }, fill),
    el('span', { class: 'match-label', 'aria-hidden': 'true', text: `${pct}% match` }),
  );
}

function renderCard(rec, rank) {
  const name = str(rec.name) || 'Unnamed fragrance';
  const brand = str(rec.brand);
  const year = num(rec.year);
  const accords = (Array.isArray(rec.accords) ? rec.accords : []).filter((a) => typeof a === 'string' && a).slice(0, MAX_ACCORDS);
  const bullets = (Array.isArray(rec.bullets) ? rec.bullets : []).filter((b) => typeof b === 'string' && b);
  const url = safeUrl(rec.url);

  return el('li', {},
    el('article', { class: 'card', 'aria-label': brand ? `${name} by ${brand}` : name },
      cardMedia(rec, rank),
      el('div', { class: 'card-body' },
        el('div', {},
          el('h3', { class: 'card-name', text: name }),
          el('p', { class: 'card-brand', text: [brand, Number.isFinite(year) ? String(year) : ''].filter(Boolean).join(' · ') }),
        ),
        matchMeter(rec.match),
        accords.length
          ? el('ul', { class: 'accords', 'aria-label': 'Main accords' }, accords.map((a) => el('li', { class: 'accord', text: a })))
          : null,
        str(rec.headline) ? el('p', { class: 'headline', text: rec.headline }) : null,
        bullets.length ? el('ul', { class: 'bullets' }, bullets.map((b) => el('li', { text: b }))) : null,
        url
          ? el('a', {
            class: 'card-link',
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
            'aria-label': `View ${name} on Fragrantica (opens in a new tab)`,
          }, 'View on Fragrantica', icon(ICONS.external))
          : null,
      ),
    ),
  );
}

function renderCards(recs) {
  return el('ol', { class: 'cards', 'aria-label': 'Recommended perfumes' }, recs.map((r, i) => renderCard(r, i + 1)));
}

function renderFollowUps(list) {
  const items = (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s.trim());
  if (!items.length) return null;
  return el('div', { class: 'followups', role: 'group', 'aria-label': 'Suggested replies' },
    items.map((t) => el('button', { type: 'button', class: 'chip-btn', onclick: () => send(t) }, t)),
  );
}

// ---------------------------------------------------------------------------
// "How Jev decided" - the typed decisions behind a reply
// ---------------------------------------------------------------------------

function kvChip(key, value) {
  return el('li', { class: 'kv' },
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v', text: value }),
  );
}

/** One chip per meaningful facet value; 'any', 0, '' and empty lists mean "no preference". */
function facetChips(facets) {
  const chips = [];
  for (const [key, value] of Object.entries(facets)) {
    const label = humanizeKey(key);
    if (typeof value === 'string') {
      if (!value || value === 'any') continue;
      chips.push(kvChip(label, key === 'persona' ? `“${value}”` : humanize(value)));
    } else if (typeof value === 'number') {
      if (!value || !Number.isFinite(value)) continue;
      const word = LEVEL_KEYS.has(key) && Number.isInteger(value) ? LEVEL_WORDS[value] : '';
      chips.push(kvChip(label, word ? `${word} (${value}/4)` : String(value)));
    } else if (Array.isArray(value)) {
      const items = value.filter((v) => v !== '' && v != null).map(String);
      if (items.length) chips.push(kvChip(label, key === 'referencePids' ? items.join(', ') : items.map(humanize).join(', ')));
    } else if (isObj(value)) {
      // likes / avoids: family -> Jev probability. Strongest first.
      Object.entries(value)
        .filter(([, w]) => typeof w === 'number' && w > 0)
        .sort((a, b) => b[1] - a[1])
        .forEach(([family, w]) => chips.push(kvChip(label, `${humanize(family)} ${fmtPct(w)}`)));
    } else if (value === true) {
      chips.push(kvChip(label, 'yes'));
    }
  }
  return chips;
}

function section(title, ...content) {
  return el('section', { class: 'jev-section' }, el('h4', { text: title }), ...content);
}

function understandingSection(u) {
  const intent = str(u.intent);
  const conf = num(u.intentConfidence);
  const summary = str(u.summary); // optional extra from the server; shown when present
  return section('Understood intent',
    el('div', { class: 'intent-row' },
      el('span', { class: 'intent-chip', text: intent ? humanize(intent) : 'unknown' }),
      Number.isFinite(conf)
        ? el('span', { class: 'confidence' },
          el('span', { class: 'meter-track', 'aria-hidden': 'true' }, (() => {
            const fill = el('span', { class: 'meter-fill' });
            fill.style.width = fmtPct(conf);
            return fill;
          })()),
          `${fmtPct(conf)} confident`)
        : null,
    ),
    summary ? el('p', { class: 'summary-line', text: summary }) : null,
  );
}

function callsTable(calls) {
  const rows = calls.filter(isObj).map((c) =>
    el('tr', {},
      el('td', { class: 'label' }, str(c.label) || '(unlabelled)', c.ok === false ? el('span', { class: 'tag-failed', text: 'failed' }) : null),
      el('td', { class: 'num', text: fmtInt(num(c.questions)) }),
      el('td', { class: 'num', text: fmtInt(num(c.inputTokens)) }),
      el('td', { class: 'num', text: fmtMs(num(c.latencyMs)) }),
    ),
  );
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'calls' },
      el('caption', { class: 'sr-only', text: 'Jev calls made for this reply' }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: 'Call' }),
        el('th', { scope: 'col', class: 'num', text: 'Questions' }),
        el('th', { scope: 'col', class: 'num', text: 'Tokens' }),
        el('th', { scope: 'col', class: 'num', text: 'Latency' }),
      )),
      el('tbody', {}, rows),
    ),
  );
}

// ---------------------------------------------------------------------------
// Jev's typed answers, grouped by the lever they pull
// ---------------------------------------------------------------------------

const STATUS_TEXT = {
  used: 'used',
  'low confidence': 'ignored: low confidence',
  'from earlier': 'from earlier in chat',
  overridden: 'overridden',
  'not used': 'not used',
};

function meter(p) {
  const fill = el('span', { class: 'meter-fill' });
  fill.style.width = fmtPct(Math.max(0, Math.min(1, p)));
  return el('span', { class: 'meter-track', 'aria-hidden': 'true' }, fill);
}

function decisionRow(item) {
  const p = num(item.probability);
  const certainty = num(item.certainty);
  const kindHint = item.kind === 'noul' ? 'probability of yes' : 'probability of this answer';
  const alts = Array.isArray(item.alternatives) ? item.alternatives.filter(isObj) : [];
  return el('li', { class: 'dec-row' },
    el('span', { class: 'dec-label', text: str(item.label) }),
    el('span', { class: 'dec-answer', text: str(item.answer) }),
    Number.isFinite(p)
      ? el('span', { class: 'dec-conf', title: kindHint }, meter(p), el('span', { text: fmtPct(p) }))
      : null,
    // Jev's certainty is a separate score from the answer's probability - label it so they are never compared.
    Number.isFinite(certainty) && item.kind !== 'noul'
      ? el('span', { class: 'dec-cert', title: 'Jev\u2019s overall certainty; answers below 45% are ignored', text: `certainty ${fmtPct(certainty)}` })
      : null,
    el('span', { class: `dec-status s-${str(item.status).replace(/\s+/g, '-')}`, text: STATUS_TEXT[item.status] || str(item.status) }),
    alts.length
      ? el('span', { class: 'dec-alt', text: `runner-up: ${alts.map((a) => `${str(a.label)} ${fmtPct(num(a.p))}`).join(', ')}` })
      : null,
  );
}

function leversSection(levers) {
  const cards = levers.filter(isObj).map((g) => {
    const items = Array.isArray(g.items) ? g.items.filter(isObj) : [];
    const active = items.filter((i) => i.status !== 'not mentioned');
    const quiet = items.filter((i) => i.status === 'not mentioned');
    return el('div', { class: 'lever' },
      el('h5', { text: str(g.lever) }),
      active.length ? el('ul', { class: 'dec-list' }, active.map(decisionRow)) : null,
      quiet.length
        ? el('p', { class: 'dec-quiet', text: `Not mentioned: ${quiet.map((i) => str(i.label).toLowerCase()).join(', ')}` })
        : null,
    );
  });
  return section('Jev\u2019s decisions, by lever', el('div', { class: 'lever-grid' }, cards));
}

function screeningSection(scr) {
  const top = Array.isArray(scr.top) ? scr.top.filter(isObj) : [];
  return section(`Screening \u2014 Jev judged all ${fmtInt(num(scr.screened))} perfumes`,
    el('p', { class: 'dec-quiet', text: 'One yes/no question each: \u201cwould this be a strong pick for this request?\u201d Top 10 by probability:' }),
    el('ol', { class: 'screen-list' }, top.map((t) =>
      el('li', {},
        el('span', { class: 'screen-name' }, el('strong', { text: str(t.name) }), ` ${str(t.brand)}`),
        el('span', { class: 'dec-conf' }, meter(num(t.p)), el('span', { text: fmtPct(num(t.p)) })),
      ))),
  );
}

const CHECK_COLUMNS = [
  ['occasion_fit', 'Occasion'], ['climate_fit', 'Climate'], ['persona_fit', 'Wearer'],
  ['taste_fit', 'Taste'], ['reference_fit', 'Like ref.'], ['conflict', 'Conflict'],
];

function judgingSection(rows) {
  const judged = rows.filter(isObj);
  const cols = CHECK_COLUMNS.filter(([k]) => judged.some((r) => isObj(r.checks) && Number.isFinite(num(r.checks[k]))));
  return section('Detailed judging \u2014 Jev\u2019s top-screened perfumes',
    el('div', { class: 'table-wrap' },
      el('table', { class: 'calls judge' },
        el('caption', { class: 'sr-only', text: 'Jev fit score and yes/no checks per perfume' }),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col', text: 'Perfume' }),
          el('th', { scope: 'col', class: 'num', text: 'Fit (0\u20134)' }),
          cols.map(([, label]) => el('th', { scope: 'col', class: 'num', text: label })),
        )),
        el('tbody', {}, judged.map((r) => el('tr', {},
          el('td', { class: 'label', text: str(r.name) }),
          el('td', { class: 'num', text: Number.isFinite(num(r.fit)) ? num(r.fit).toFixed(1) : '\u2013' }),
          cols.map(([k]) => {
            const v = isObj(r.checks) ? num(r.checks[k]) : NaN;
            const bad = k === 'conflict' ? v >= 0.5 : v < 0.5;
            return el('td', { class: `num${Number.isFinite(v) && bad ? ' weak' : ''}`, text: Number.isFinite(v) ? fmtPct(v) : '\u2013' });
          }),
        ))),
      ),
    ),
  );
}

function stat(label, value) {
  return el('div', { class: 'stat' }, el('dt', { text: label }), el('dd', { text: value }));
}

function renderDebug(debug, mode) {
  const u = isObj(debug.understanding) ? debug.understanding : null;
  const t = isObj(debug.telemetry) ? debug.telemetry : {};
  const calls = Array.isArray(debug.jevCalls) ? debug.jevCalls : [];
  const wallMs = num(debug.wallMs);
  const candidates = num(debug.candidates);
  const scr = isObj(debug.screening) ? debug.screening : null;
  const failures = num(t.failures);

  const trace = isObj(debug.trace) ? debug.trace : null;
  const levers = trace && Array.isArray(trace.levers) ? trace.levers : [];
  const facets = u && isObj(u.facets) ? facetChips(u.facets) : [];
  const uncertain = u && Array.isArray(u.uncertain) ? u.uncertain.filter((k) => typeof k === 'string') : [];

  const metaBits = [
    Number.isFinite(num(t.calls)) ? `${fmtInt(num(t.calls))} ${num(t.calls) === 1 ? 'call' : 'calls'}` : '',
    Number.isFinite(num(t.questions)) ? `${fmtInt(num(t.questions))} questions` : '',
    mode === 'mock' ? 'no cost' : fmtUsd(num(t.usd)),
    fmtMs(wallMs),
  ].filter((s) => s && s !== '–');
  // In mock mode no Jev call was made and nothing was billed - say so on the collapsed summary too.
  if (mode === 'mock') metaBits.unshift('MOCK \u2014 not Jev');

  return el('details', { class: 'jev' },
    el('summary', {},
      el('span', { class: 'jev-title', text: 'How Jev decided' }),
      metaBits.length ? el('span', { class: 'jev-meta', text: metaBits.join(' · ') }) : null,
    ),
    el('div', { class: 'jev-body' },
      el('p', { class: 'jev-note', text: 'Jev never writes prose. Each call below returned typed answers - a choice among fixed options, a score on a scale, or a probability - and the reply was assembled from those decisions plus catalog data.' }),
      mode === 'mock'
        ? el('p', { class: 'jev-note mock', text: 'Mock mode: these decisions came from a local stand-in, not the live Jev API.' })
        : null,
      u ? understandingSection(u) : null,
      levers.length ? leversSection(levers) : null,
      !levers.length && facets.length ? section('Facets Jev extracted', el('ul', { class: 'chips' }, facets)) : null,
      !levers.length && uncertain.length
        ? section('Jev was unsure about', el('ul', { class: 'chips' }, uncertain.map((k) => el('li', { class: 'kv unsure', text: humanizeKey(k) }))))
        : null,
      trace && isObj(trace.screening) ? screeningSection(trace.screening) : null,
      trace && Array.isArray(trace.judging) && trace.judging.length ? judgingSection(trace.judging) : null,
      calls.length ? section('Jev calls', callsTable(calls)) : null,
      section('Totals',
        el('dl', { class: 'totals' },
          stat('Calls', fmtInt(num(t.calls))),
          stat('Questions', fmtInt(num(t.questions))),
          stat('Input tokens', fmtInt(num(t.inputTokens))),
          stat('Cost', mode === 'mock' ? '$0 (mock: nothing billed)' : fmtUsd(num(t.usd))),
          stat('Wall time', fmtMs(wallMs)),
          stat('Jev time (sum)', fmtMs(num(t.totalLatencyMs))),
          stat('Candidates', fmtInt(candidates)),
          scr ? stat('Screened by Jev', `${fmtInt(num(scr.screened))} of ${fmtInt(num(scr.of))}`) : null,
          failures > 0 ? stat('Failed calls', fmtInt(failures)) : null,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body (proxy error page etc.) - handled below */
  }
  if (!res.ok) {
    const reason = isObj(data) && typeof data.error === 'string' && data.error ? data.error : `The server answered ${res.status}.`;
    const err = new Error(reason);
    err.status = res.status; // send() uses it to tell a refused message from a passing failure
    throw err;
  }
  return data;
}

/**
 * A 4xx means the server refused this exact request (too long, malformed), so resending the
 * same text fails the same way every time. 408 and 429 are about timing, not content.
 */
function canRetry(err) {
  const status = err instanceof Error ? err.status : undefined;
  return !(typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429);
}

function isValidChatResponse(data) {
  return isObj(data) && typeof data.sessionId === 'string' && isObj(data.reply) && typeof data.reply.text === 'string';
}

// ---------------------------------------------------------------------------
// Conversation flow
// ---------------------------------------------------------------------------

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle('is-busy', busy);
  dom.form.setAttribute('aria-busy', String(busy));
  syncSendButton();
}

function syncSendButton() {
  const text = dom.input.value.trim();
  dom.send.disabled = state.busy || !text || text.length > MAX_MESSAGE_CHARS;
}

/** Older suggestion chips go stale once the conversation moves on. */
function clearFollowUps() {
  dom.log.querySelectorAll('.followups').forEach((n) => n.remove());
}

/** Sending a failed message again from the composer is a retry: reuse its bubble rather than show it twice. */
function failedBubbleFor(text) {
  const node = dom.log.querySelector('.msg-user.failed');
  return node?.querySelector('.bubble-user')?.textContent === text ? node : null;
}

function clearErrors() {
  dom.log.querySelectorAll('.error-note').forEach((n) => n.remove());
  dom.log.querySelectorAll('.msg.failed').forEach((n) => n.classList.remove('failed'));
}

/** `typed`: the text came from the composer. Only then does a failed send put it back there - a chip's or example's text is not the user's draft. */
async function send(rawText, userNode = null, { typed = false } = {}) {
  const text = String(rawText).trim();
  if (!text || state.busy) return;
  // The composer empties only once the send is really under way, and a retry takes back the
  // draft restored after the failure - but never text the user has typed since.
  if (dom.input.value.trim() === text) setComposerText('');

  const retrying = userNode ?? failedBubbleFor(text);
  showWelcome(false);
  clearFollowUps();
  clearErrors();
  const bubble = retrying ?? appendUser(text);
  const typing = appendTyping();
  scrollToEnd();

  setBusy(true);
  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const body = state.sessionId ? { sessionId: state.sessionId, message: text } : { message: text };
    const data = await postJson(API.chat, body, controller.signal);
    if (generation !== state.generation) return;
    if (!isValidChatResponse(data)) throw new Error('The server sent a reply I could not read.');

    setSessionId(data.sessionId);
    if (isMode(data.mode)) showMode(data.mode);
    if (!state.catalogKnown) loadHealth();
    typing.remove();
    const node = appendAssistant(data.reply, data.mode);
    revealStart(node);
  } catch (err) {
    if (generation !== state.generation) return;
    typing.remove();
    const message = timedOut
      ? 'The sommelier took too long to answer.'
      : err instanceof TypeError
        ? 'Could not reach the server. Check your connection.'
        : err instanceof Error ? err.message : String(err);
    const restored = typed && restoreDraft(text);
    const reason = sentence(message);
    if (canRetry(err)) {
      bubble.classList.add('failed');
      appendError(message, () => send(text, bubble, { typed }));
    } else if (restored) {
      // Refused, so it never joined the conversation: drop the bubble and let the user edit the text.
      bubble.remove();
      // If that was the first message, bring the welcome back rather than leaving an empty page.
      if (!dom.log.querySelector('.msg')) showWelcome(true);
      appendError(`${reason} Your message is back in the box below to edit.`, null, 'Not sent. ');
      dom.input.focus();
    } else {
      bubble.classList.add('failed');
      appendError(reason, null, 'Not sent. ');
    }
    scrollToEnd();
  } finally {
    clearTimeout(timer);
    if (generation === state.generation) {
      state.controller = null;
      setBusy(false);
    }
  }
}

async function newChat() {
  state.generation += 1;
  state.controller?.abort();
  state.controller = null;
  const previous = state.sessionId;
  setSessionId(null);
  dom.log.replaceChildren();
  setBusy(false);
  showWelcome(true);
  window.scrollTo({ top: 0 });
  dom.input.focus();
  if (!previous) return;
  try {
    await postJson(API.reset, { sessionId: previous });
  } catch {
    /* the local reset already guarantees a fresh session on the next message */
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

const COMPOSER_MAX_PX = 168;

function setComposerText(value) {
  dom.input.value = value;
  autoGrow();
  syncSendButton();
  updateCount();
}

/** "message is too long" -> "Message is too long." */
function sentence(text) {
  const t = String(text).trim().replace(/[\s.]+$/, '');
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : '';
}

/** A failed message goes back in the composer so it is never lost - unless the user has typed something else meanwhile. */
function restoreDraft(text) {
  const current = dom.input.value.trim();
  if (current && current !== text) return false;
  setComposerText(text);
  return true;
}

/** Shown near the limit, because maxlength otherwise stops typing (and cuts pastes) without a word. */
function updateCount() {
  const n = dom.input.value.length;
  if (n < MAX_MESSAGE_CHARS) state.pasteCut = false;
  const show = n >= SHOW_COUNT_FROM;
  const note = n > MAX_MESSAGE_CHARS
    ? ' - too long to send'
    : state.pasteCut
      ? ' - the rest of the paste did not fit'
      : n === MAX_MESSAGE_CHARS ? ' - limit reached' : '';
  dom.count.hidden = !show;
  dom.count.textContent = show ? `${fmtInt(n)} / ${fmtInt(MAX_MESSAGE_CHARS)}${note}` : '';
  dom.count.classList.toggle('at-limit', n >= MAX_MESSAGE_CHARS);
}

/** Grow with the text up to a cap, and only show a scrollbar once past it. */
function autoGrow() {
  dom.input.style.height = 'auto';
  const full = dom.input.scrollHeight;
  dom.input.style.height = `${Math.min(full, COMPOSER_MAX_PX)}px`;
  dom.input.style.overflowY = full > COMPOSER_MAX_PX ? 'auto' : 'hidden';
}

function submitComposer() {
  const text = dom.input.value.trim();
  // Too long only happens when text got in around maxlength; the count already says so, and
  // sending would just earn a 400. send() clears the composer itself once it goes ahead.
  if (!text || state.busy || text.length > MAX_MESSAGE_CHARS) return;
  send(text, null, { typed: true });
}

/**
 * Enter that confirms an IME conversion (Japanese, Chinese, Korean...) must not send.
 * Chrome and Firefox flag that keydown with isComposing; Safari fires compositionend first,
 * so its keydown arrives with isComposing false and only keyCode 229 ("IME busy") tells.
 */
function isImeKeydown(e) {
  return e.isComposing || e.keyCode === 229;
}

dom.form.addEventListener('submit', (e) => {
  e.preventDefault();
  submitComposer();
});

dom.input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || isImeKeydown(e)) return;
  e.preventDefault();
  submitComposer();
});

dom.input.addEventListener('input', () => {
  autoGrow();
  syncSendButton();
  updateCount();
});

// Runs before maxlength trims the paste, so it can tell whether anything will be cut.
dom.input.addEventListener('paste', (e) => {
  const pasted = (e.clipboardData?.getData('text') ?? '').replace(/\r\n?/g, '\n');
  const { value, selectionStart, selectionEnd } = dom.input;
  state.pasteCut = value.length - (selectionEnd - selectionStart) + pasted.length > MAX_MESSAGE_CHARS;
  // Already full with nothing selected: no text goes in, so no input event will refresh the count.
  if (state.pasteCut && value.length === MAX_MESSAGE_CHARS) updateCount();
});

dom.newChat.addEventListener('click', newChat);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

renderExamples();
showWelcome(true);
syncSendButton();
updateCount();
loadHealth();
