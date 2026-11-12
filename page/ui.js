// Small helpers shared by the page's views.
const CRORE = 10_000_000;
const LAKH = 100_000;

const prefersMotion = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Cross-fades the page between two states where the browser supports it.
function transition(update) {
  // A page-wide transition would interrupt the opening animation.
  if (document.startViewTransition && prefersMotion() && !document.hidden && !document.documentElement.classList.contains('intro')) {
    document.startViewTransition(update);
  } else {
    update();
  }
}

// Building nodes with textContent keeps text from outside sources out of the HTML parser.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

const locale = (currency) => (currency === 'INR' ? 'en-IN' : 'en-US');

function formatNumber(value, currency = 'INR', decimals = 2) {
  return new Intl.NumberFormat(locale(currency), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatSigned(value, currency = 'INR', decimals = 2) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatNumber(Math.abs(value), currency, decimals)}`;
}

function formatQuantity(value) {
  if (value >= CRORE) return `${formatNumber(value / CRORE)} Cr`;
  if (value >= LAKH) return `${formatNumber(value / LAKH)} L`;
  return formatNumber(value, 'INR', 0);
}

const formatCrore = (value) => formatNumber(value / CRORE, 'INR', 0);

// Trims a price's decimals when they're zero, as issue prices usually are.
const formatRupees = (value) => `₹${formatNumber(value, 'INR', Number.isInteger(value) ? 0 : 2)}`;

const dateFrom = (iso) => new Date(`${iso}T00:00:00Z`);
const dateFormat = (options) => new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });

const formatDate = (iso) => dateFormat({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(dateFrom(iso));
const formatPlainDate = (iso) => dateFormat({ day: 'numeric', month: 'short', year: 'numeric' }).format(dateFrom(iso));
const formatShortDate = (iso) => dateFormat({ day: 'numeric', month: 'short' }).format(dateFrom(iso));
const formatYear = (iso) => dateFormat({ month: 'short', year: 'numeric' }).format(dateFrom(iso));

const updatedFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });

// A small see-through tag on a card's top edge, saying when its data was last collected, in India time.
// A plain date (from a page built before times were recorded) shows without a time.
function updatedBadge(when) {
  if (!when) return null;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(when);
  const time = isDateOnly ? dateFrom(when) : new Date(when);
  if (Number.isNaN(time.getTime())) return null;
  const text = isDateOnly ? formatPlainDate(when) : `${updatedFormat.format(time)} IST`;
  return el('span', { class: 'updated-badge', title: `When this was last updated: ${text}` }, el('span', { class: 'updated-dot', 'aria-hidden': 'true' }), `Updated ${text}`);
}

const directionClass = (value) => (value > 0 ? 'is-up' : value < 0 ? 'is-down' : null);
const safeUrl = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);

function externalLink(url, text) {
  const href = safeUrl(url);
  if (!href) return text;
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function sectionHead(title, note) {
  return el('div', { class: 'section-head' }, el('h3', { class: 'section-title' }, title), note ? el('p', { class: 'section-note' }, note) : null);
}

function stat(label, value, { className, isText } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const valueClass = [className, isText ? 'is-text' : null].filter(Boolean).join(' ') || null;
  return el('div', { class: 'stat' }, el('dt', {}, label), el('dd', { class: valueClass }, value));
}

function statGroup(className, ...stats) {
  const present = stats.filter(Boolean);
  return present.length ? el('dl', { class: ['stats', className].filter(Boolean).join(' ') }, ...present) : null;
}

// A row of options with a pill that slides to the chosen one.
function segmented({ label, options, chosen, onChoose }) {
  const pill = el('span', { class: 'segment-pill', 'aria-hidden': 'true' });
  const group = el('div', { class: 'segmented', role: 'group', 'aria-label': label }, pill);
  const movePill = () => {
    const active = group.querySelector('[aria-pressed="true"]');
    if (!active) return;
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
  };
  for (const option of options) {
    group.append(
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(option.value === chosen),
          onclick: () => {
            group.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', 'false'));
            group.querySelector(`[data-value="${CSS.escape(option.value)}"]`).setAttribute('aria-pressed', 'true');
            movePill();
            onChoose(option.value);
          },
          'data-value': option.value,
        },
        option.label,
      ),
    );
  }
  requestAnimationFrame(movePill);
  new ResizeObserver(movePill).observe(group);
  return group;
}
