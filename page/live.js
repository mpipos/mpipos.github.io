// Personal live mode. Only `npm run live` on your own computer marks the page with a "live-mode" tag, so the
// published site never asks for live prices, and Kite's data is never shown to the public.
const LIVE_MODE = document.querySelector('meta[name="live-mode"]')?.content ?? null;

const liveTimeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });
const formatLiveTime = (time) => `${liveTimeFormat.format(new Date(time))} IST`;

function createLiveFeed() {
  if (!LIVE_MODE) return null;
  const listeners = new Set();
  const quotes = new Map();
  const watched = new Set();
  let status = { mode: LIVE_MODE, loggedIn: false, connected: false };
  let lastTick = null;
  const notify = (kind, symbols = []) => listeners.forEach((listener) => listener(kind, symbols));

  const source = new EventSource('/live/stream');
  source.addEventListener('status', (event) => {
    status = JSON.parse(event.data);
    notify('status');
  });
  source.addEventListener('quotes', (event) => {
    const { t, q } = JSON.parse(event.data);
    lastTick = t;
    for (const [symbol, values] of Object.entries(q)) quotes.set(symbol, values);
    notify('quotes', Object.keys(q));
  });
  source.addEventListener('error', () => {
    status = { ...status, connected: false, message: 'Lost the connection to the live server. Is npm run live still running?' };
    notify('status');
  });

  return {
    mode: LIVE_MODE,
    get status() {
      return status;
    },
    get lastTick() {
      return lastTick;
    },
    // The latest price, with the day's move against the previous close.
    quote(symbol) {
      const values = quotes.get(symbol);
      if (!values?.[0]) return null;
      const [last, open, high, low, previous] = values;
      const change = previous ? last - previous : null;
      return { last, open, high, low, previous, change, changePercent: previous ? (change / previous) * 100 : null };
    },
    symbols: () => [...quotes.keys()],
    // Asks the live server to stream a stock that isn't in the heatmap, such as the one open on the page.
    watch(symbol) {
      if (!symbol || watched.has(symbol) || quotes.has(symbol)) return;
      watched.add(symbol);
      fetch(`/live/subscribe?symbol=${encodeURIComponent(symbol)}`).catch(() => watched.delete(symbol));
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const liveFeed = createLiveFeed();

// The pill in the top bar: whether prices are live, from whom, and when the last one arrived.
function renderLivePill(host) {
  if (!liveFeed) return;
  const pill = el('div', { class: 'live-pill', role: 'status' });
  host.prepend(pill);
  document.body.classList.add('has-live');
  const draw = () => {
    const { mode, loggedIn, connected, user, message } = liveFeed.status;
    pill.classList.toggle('is-on', connected && Boolean(liveFeed.lastTick));
    pill.classList.toggle('is-demo', mode === 'demo');
    if (mode === 'demo') {
      return pill.replaceChildren(el('span', { class: 'live-dot', 'aria-hidden': 'true' }), `Demo prices, made up${liveFeed.lastTick ? ` · ${formatLiveTime(liveFeed.lastTick)}` : ''}`);
    }
    if (!loggedIn) {
      return fill(pill, message ? el('span', { class: 'live-message' }, message) : null, el('a', { href: '/live/login', class: 'live-login' }, 'Log in to Kite for live prices'));
    }
    const when = liveFeed.lastTick ? ` · ${formatLiveTime(liveFeed.lastTick)}` : ' · waiting for prices';
    pill.replaceChildren(
      el('span', { class: 'live-dot', 'aria-hidden': 'true' }),
      connected ? `Live via Kite${user ? ` (${user})` : ''}${when}` : message ?? 'Connecting to Kite…',
    );
  };
  liveFeed.on(draw);
  draw();
}
