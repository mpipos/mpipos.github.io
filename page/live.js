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

// Whether this browser has chosen to pause live prices, with the Live button. Remembered per browser.
function livePausedHere() {
  try {
    return localStorage.getItem('livePaused') === '1';
  } catch {
    return false;
  }
}

// If the live mode goes quiet for this long (the Mac asleep, the live mode stopped), the page goes back to
// the official prices, which update by themselves every evening as they always have.
const LIVE_GRACE_MS = 20_000;

function createLiveFeed() {
  if (!LIVE_MODE && !LIVE_REMOTE) return null;
  const listeners = new Set();
  const quotes = new Map();
  const watched = new Set();
  let status = { mode: 'off', loggedIn: false, connected: false, remote: LIVE_REMOTE };
  let lastTick = null;
  let source = null;
  let retry = null;
  let grace = null;
  let paused = livePausedHere();
  const notify = (kind, symbols = []) => listeners.forEach((listener) => listener(kind, symbols));

  // Drops every live price, so each view shows the official one again.
  const forget = () => {
    clearTimeout(grace);
    grace = null;
    const had = quotes.size > 0;
    quotes.clear();
    watched.clear();
    lastTick = null;
    if (had) notify('reset');
  };

  const connect = () => {
    clearTimeout(retry);
    if (paused) return;
    let reached = false;
    source = new EventSource(`${liveBase}/live/stream`);
    source.addEventListener('status', (event) => {
      reached = true;
      clearTimeout(grace);
      grace = null;
      status = { ...JSON.parse(event.data), remote: LIVE_REMOTE };
      // Waiting for today's token means no live prices, so the official ones show meanwhile.
      if (!status.loggedIn && status.mode !== 'demo') forget();
      notify('status');
    });
    source.addEventListener('quotes', (event) => {
      const { t, q } = JSON.parse(event.data);
      lastTick = t;
      for (const [symbol, values] of Object.entries(q)) quotes.set(symbol, values);
      notify('quotes', Object.keys(q));
    });
    source.addEventListener('error', () => {
      status = {
        ...status,
        connected: false,
        mode: reached ? status.mode : 'off',
        message: 'Either the live mode isn’t running on this Mac, or the browser hasn’t let this site reach it. In Brave or Chrome, click the icon left of the address, then Site settings, and allow access to apps on this device (local network). Until then these are the last official prices.',
      };
      notify('status');
      if (!reached) {
        // Not running yet: look again each minute, quietly.
        source.close();
        retry = setTimeout(connect, 60_000);
        return;
      }
      // It was running and stopped: the browser keeps trying, and after a short wait the official prices return.
      grace ??= setTimeout(() => {
        status = { ...status, mode: 'off' };
        forget();
        notify('status');
      }, LIVE_GRACE_MS);
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
    get paused() {
      return paused;
    },
    // The Live button: off shows the official prices only, on goes back to live ones.
    setPaused(next) {
      paused = next;
      try {
        if (next) localStorage.setItem('livePaused', '1');
        else localStorage.removeItem('livePaused');
      } catch {
        // Without storage the choice lasts until the page closes.
      }
      if (next) {
        source?.close();
        clearTimeout(retry);
        status = { mode: 'paused', loggedIn: false, connected: false, remote: LIVE_REMOTE };
        forget();
        notify('status');
      } else connect();
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
      if (paused || !symbol || watched.has(symbol) || quotes.has(symbol)) return;
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
  // The Live button exists only in a browser on your own Mac: one opened with ?live=on, or the live mode's
  // own page. Everyone else's page never has it.
  const toggle = el(
    'button',
    { type: 'button', class: 'live-toggle', title: 'Live prices from your Kite account, on this Mac only', onclick: () => liveFeed.setPaused(!liveFeed.paused) },
    el('span', { class: 'live-dot', 'aria-hidden': 'true' }),
    'Live',
  );
  host.prepend(toggle, pill);
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
    const isLive = connected && Boolean(liveFeed.lastTick);
    toggle.setAttribute('aria-pressed', String(!liveFeed.paused));
    toggle.classList.toggle('is-on', isLive);
    pill.hidden = liveFeed.paused;
    if (liveFeed.paused) return;
    pill.classList.toggle('is-on', isLive);
    pill.classList.toggle('is-demo', mode === 'demo');
    pill.classList.toggle('is-asking', !loggedIn && !liveFeed.status.remote && (needs === 'key' || needs === 'token'));
    if (mode === 'demo') {
      return pill.replaceChildren(`Demo prices, made up${liveFeed.lastTick ? ` · ${formatLiveTime(liveFeed.lastTick)}` : ''}`);
    }
    if (mode === 'off') {
      return pill.replaceChildren(el('span', { title: message ?? '' }, 'Live mode off or blocked · official prices'));
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
    pill.replaceChildren(connected ? `Kite${user ? ` (${user})` : ''}${when}` : message ?? 'Connecting to Kite…');
  };
  liveFeed.on(draw);
  draw();
}
