// Personal live mode. Live prices come only from the live mode running on your own computer, so Kite's
// data is never shown to the public:
//   - http://127.0.0.1:4174 is the live mode's own copy of the site, marked by a "live-mode" tag.
//   - The published site goes live too, but only in a browser that's been told to look for the live mode
//     on its own computer, by opening it once with ?live=on (and ?live=off to stop). Anyone else's browser
//     never looks, and keeps the last official update.
const LIVE_MODE = document.querySelector('meta[name="live-mode"]')?.content ?? null;
const LIVE_SERVER = 'http://127.0.0.1:4174';

function wantsLiveHere() {
  if (LIVE_MODE) return false;
  try {
    const choice = new URLSearchParams(location.search).get('live');
    if (choice === 'on') localStorage.setItem('liveOnThisComputer', '1');
    if (choice === 'off') localStorage.removeItem('liveOnThisComputer');
    return localStorage.getItem('liveOnThisComputer') === '1';
  } catch {
    return false;
  }
}

const LIVE_REMOTE = wantsLiveHere();
const liveBase = LIVE_MODE ? '' : LIVE_SERVER;

const liveTimeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });
const formatLiveTime = (time) => `${liveTimeFormat.format(new Date(time))} IST`;

function createLiveFeed() {
  if (!LIVE_MODE && !LIVE_REMOTE) return null;
  const listeners = new Set();
  const quotes = new Map();
  const watched = new Set();
  let status = { mode: LIVE_MODE ?? 'kite', loggedIn: false, connected: false, remote: LIVE_REMOTE };
  let lastTick = null;
  let reached = false;
  const notify = (kind, symbols = []) => listeners.forEach((listener) => listener(kind, symbols));

  const connect = () => {
    const source = new EventSource(`${liveBase}/live/stream`);
    source.addEventListener('status', (event) => {
      reached = true;
      status = { ...JSON.parse(event.data), remote: LIVE_REMOTE };
      notify('status');
    });
    source.addEventListener('quotes', (event) => {
      const { t, q } = JSON.parse(event.data);
      lastTick = t;
      for (const [symbol, values] of Object.entries(q)) quotes.set(symbol, values);
      notify('quotes', Object.keys(q));
    });
    source.addEventListener('error', () => {
      // On the published site the live mode may simply not be running yet, so it looks again each minute.
      if (LIVE_REMOTE && !reached) {
        source.close();
        status = { mode: 'off', loggedIn: false, connected: false, remote: true, message: 'The live mode isn’t running on this computer, so these are the last official prices.' };
        notify('status');
        setTimeout(connect, 60_000);
        return;
      }
      status = { ...status, connected: false, message: 'Lost the connection to the live mode. Is it still running?' };
      notify('status');
    });
  };
  connect();

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
      fetch(`${liveBase}/live/subscribe?symbol=${encodeURIComponent(symbol)}`).catch(() => watched.delete(symbol));
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const liveFeed = createLiveFeed();

// The pill in the top bar: whether prices are live, from whom, and when the last one arrived. When the live
// mode is waiting for today's token, the pill takes it, so starting each day needs no terminal.
function renderLivePill(host) {
  if (!liveFeed) return;
  const pill = el('div', { class: 'live-pill', role: 'status' });
  host.prepend(pill);
  document.body.classList.add('has-live');
  let formOpen = false;

  const tokenForm = (needsKey, message) => {
    const keyInput = needsKey ? el('input', { type: 'text', name: 'key', placeholder: 'API key', autocomplete: 'off', spellcheck: 'false', required: '' }) : null;
    const tokenInput = el('input', { type: 'password', name: 'token', placeholder: 'Today’s access token', autocomplete: 'off', spellcheck: 'false', required: '' });
    const note = el('span', { class: 'live-message' }, message ?? (needsKey ? 'Paste your Kite API key once, and today’s access token.' : 'Paste today’s access token from your algo’s login.'));
    const button = el('button', { type: 'submit' }, 'Go live');
    const form = el(
      'form',
      {
        class: 'live-form',
        onsubmit: async (event) => {
          event.preventDefault();
          button.disabled = true;
          note.textContent = 'Checking with Kite…';
          try {
            const response = await fetch('/live/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: tokenInput.value, key: keyInput?.value }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error ?? 'Kite didn’t accept that.');
            formOpen = false;
            draw();
          } catch (error) {
            note.textContent = error.message;
            button.disabled = false;
          }
        },
      },
      note,
      keyInput,
      tokenInput,
      button,
    );
    return form;
  };

  const draw = () => {
    const { mode, loggedIn, connected, user, message, needs } = liveFeed.status;
    pill.classList.toggle('is-on', connected && Boolean(liveFeed.lastTick));
    pill.classList.toggle('is-demo', mode === 'demo');
    pill.classList.toggle('is-asking', !loggedIn && !liveFeed.status.remote && (needs === 'key' || needs === 'token'));
    if (mode === 'demo') {
      return pill.replaceChildren(el('span', { class: 'live-dot', 'aria-hidden': 'true' }), `Demo prices, made up${liveFeed.lastTick ? ` · ${formatLiveTime(liveFeed.lastTick)}` : ''}`);
    }
    if (mode === 'off') {
      return pill.replaceChildren(el('span', { class: 'live-dot', 'aria-hidden': 'true' }), el('span', { title: message ?? '' }, 'Live mode not running · last official prices'));
    }
    // On the published site, today's token is pasted in the live mode's own page, which is this computer's.
    if (!loggedIn && liveFeed.status.remote && (needs === 'key' || needs === 'token')) {
      return pill.replaceChildren(el('a', { href: LIVE_SERVER, class: 'live-login' }, 'Paste today’s token to go live'));
    }
    if (!loggedIn && needs === 'login') {
      return fill(pill, message ? el('span', { class: 'live-message' }, message) : null, el('a', { href: '/live/login', class: 'live-login' }, 'Log in to Kite for live prices'));
    }
    if (!loggedIn && (needs === 'key' || needs === 'token')) {
      // Kept while someone is typing, so a status update doesn't wipe what they've pasted.
      if (formOpen && pill.querySelector('form')) return;
      formOpen = true;
      return pill.replaceChildren(tokenForm(needs === 'key', message));
    }
    formOpen = false;
    const when = liveFeed.lastTick ? ` · ${formatLiveTime(liveFeed.lastTick)}` : ' · waiting for prices';
    pill.replaceChildren(
      el('span', { class: 'live-dot', 'aria-hidden': 'true' }),
      connected ? `Live via Kite${user ? ` (${user})` : ''}${when}` : message ?? 'Connecting to Kite…',
    );
  };
  liveFeed.on(draw);
  draw();
}
