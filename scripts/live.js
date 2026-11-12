// Personal live mode: serves the built site on this computer only, with prices streaming from your own
// Zerodha Kite Connect account. Kite's terms allow its live data in a private interface for your own use,
// not on a public site, so this binds to 127.0.0.1 and never publishes anything.
//
//   npm run live            log in to Kite in the browser, then prices stream while the market is open
//   npm run live -- --demo  made-up prices, to try the live screens without a Kite account
//
// Settings go in .env.kite, which git ignores. Either log in here with your app's key and secret:
//   KITE_API_KEY=…  and  KITE_API_SECRET=…
// or reuse the access token your own trading code already gets each morning, so there's no second login:
//   KITE_API_KEY=…  and  KITE_ACCESS_TOKEN=…  (or KITE_ACCESS_TOKEN_FILE=/path/to/the/file/it/saves)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentFile } from '../lib/market.js';
import { instrumentIndex, KITE_API, KITE_INDEX_NAMES, KITE_SOCKET, loginUrl, parseInstruments, parseTicks, sessionChecksum } from './sources/kite.js';

const PORT = Number(process.env.PORT) || 4174;
const HOST = '127.0.0.1';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const KITE_CACHE = join(ROOT, '.cache', 'kite');
const SESSION_FILE = join(KITE_CACHE, 'session.json');
const ENV_FILE = join(ROOT, '.env.kite');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const SEND_EVERY_MS = 1000;
const RECONNECT_MS = [2000, 5000, 15000, 30000, 60000];
const DEMO = process.argv.includes('--demo');

const log = (message) => console.log(`[${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })}] ${message}`);

function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('Build the site first: npm run build (or npm run assemble).');
  process.exit(1);
}

const env = readEnv();
const apiKey = process.env.KITE_API_KEY ?? env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET ?? env.KITE_API_SECRET;
const tokenSetting = process.env.KITE_ACCESS_TOKEN ?? env.KITE_ACCESS_TOKEN;
const tokenFile = process.env.KITE_ACCESS_TOKEN_FILE ?? env.KITE_ACCESS_TOKEN_FILE;
const reusesToken = Boolean(tokenSetting || tokenFile);
if (!DEMO && (!apiKey || (!apiSecret && !reusesToken))) {
  console.error(
    `Put your Kite Connect settings in ${ENV_FILE}, either\n  KITE_API_KEY=…\n  KITE_API_SECRET=…\nor, to reuse your trading code's login,\n  KITE_API_KEY=…\n  KITE_ACCESS_TOKEN=…   (or KITE_ACCESS_TOKEN_FILE=/path/to/token)\nor try the screens with: npm run live -- --demo`,
  );
  process.exit(1);
}

// The token another program saved: the file's whole text, or its "access_token" if the file is JSON.
function borrowedToken() {
  if (tokenSetting) return tokenSetting;
  try {
    const text = readFileSync(tokenFile, 'utf8').trim();
    if (text.startsWith('{')) return JSON.parse(text).access_token ?? null;
    return text || null;
  } catch {
    return null;
  }
}

/* What to stream: every heatmap stock and index, plus whatever stock is open on the page. */

const info = JSON.parse(readFileSync(join(DIST, 'data', 'h', 'info.json'), 'utf8'));
const wanted = new Set([...info.stocks.map(([symbol]) => symbol), ...Object.keys(KITE_INDEX_NAMES)]);

const quotes = new Map(); // symbol -> [last, open, high, low, previous close]
const changed = new Set();
const clients = new Set();
const state = { mode: DEMO ? 'demo' : 'kite', loggedIn: DEMO, connected: DEMO, user: null, message: null, lastTick: null };

function record(symbol, tick) {
  const before = quotes.get(symbol) ?? [];
  const next = [tick.last, tick.open ?? before[1] ?? null, tick.high ?? before[2] ?? null, tick.low ?? before[3] ?? null, tick.close ?? before[4] ?? null];
  quotes.set(symbol, next);
  changed.add(symbol);
  state.lastTick = Date.now();
}

/* Kite session. The access token lasts until 6 AM India time the next day, so it's kept on disk until then. */

const nextSixAmIst = (from) => {
  const sixAmUtc = new Date(from);
  sixAmUtc.setUTCHours(0, 30, 0, 0); // 06:00 in India
  if (sixAmUtc <= from) sixAmUtc.setUTCDate(sixAmUtc.getUTCDate() + 1);
  return sixAmUtc.getTime();
};

let session = null;
function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return saved.expires > Date.now() && saved.apiKey === apiKey ? saved : null;
  } catch {
    return null;
  }
}

function saveSession(saved) {
  mkdirSync(KITE_CACHE, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(saved));
  chmodSync(SESSION_FILE, 0o600);
}

const kiteHeaders = () => ({ 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${session.accessToken}` });

async function createSession(requestToken) {
  const response = await fetch(`${KITE_API}/session/token`, {
    method: 'POST',
    headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum: sessionChecksum(apiKey, requestToken, apiSecret) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.data?.access_token) throw new Error(body.message ?? `Kite refused the login (HTTP ${response.status})`);
  return { apiKey, accessToken: body.data.access_token, user: body.data.user_name ?? body.data.user_id ?? null, expires: nextSixAmIst(new Date()) };
}

/* Instruments: Kite's list of tokens, read once a day. */

let tokens = new Map(); // symbol -> token
let symbolsByToken = new Map();

async function loadInstruments() {
  const day = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const exchange of ['NSE', 'BSE']) {
    const file = join(KITE_CACHE, `instruments-${exchange}-${day}.csv`);
    let text;
    if (existsSync(file)) text = readFileSync(file, 'utf8');
    else {
      const response = await fetch(`${KITE_API}/instruments/${exchange}`, { headers: kiteHeaders() });
      if (!response.ok) throw new Error(`Kite's ${exchange} instrument list: HTTP ${response.status}`);
      text = await response.text();
      mkdirSync(KITE_CACHE, { recursive: true });
      writeFileSync(file, text);
    }
    rows.push(...parseInstruments(text));
  }
  tokens = instrumentIndex(rows);
  symbolsByToken = new Map([...tokens].map(([symbol, token]) => [token, symbol]));
  const missing = [...wanted].filter((symbol) => !tokens.has(symbol));
  log(`Kite has ${[...wanted].length - missing.length} of the ${wanted.size} instruments to stream.${missing.length ? ` Not found: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}` : ''}`);
}

/* Kite's ticker. Quote mode gives each instrument's last price, open, high, low and previous close. */

let socket = null;
let attempt = 0;

function subscribe(symbols) {
  const list = symbols.map((symbol) => tokens.get(symbol)).filter(Boolean);
  if (!list.length || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ a: 'subscribe', v: list }));
  socket.send(JSON.stringify({ a: 'mode', v: ['quote', list] }));
}

function connectTicker() {
  if (!session) return;
  socket = new WebSocket(`${KITE_SOCKET}?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(session.accessToken)}`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    attempt = 0;
    state.connected = true;
    state.message = null;
    log('Connected to Kite’s live prices.');
    subscribe([...wanted]);
    broadcastStatus();
  });
  socket.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message.type === 'error') {
          state.message = message.data;
          log(`Kite: ${message.data}`);
        }
      } catch {
        // Kite only sends JSON text messages, so anything else is ignored.
      }
      return;
    }
    for (const tick of parseTicks(data)) {
      const symbol = symbolsByToken.get(tick.token);
      if (symbol) record(symbol, tick);
    }
  });
  socket.addEventListener('close', (event) => {
    state.connected = false;
    broadcastStatus();
    if (!session || session.expires <= Date.now()) {
      session = null;
      state.loggedIn = false;
      state.message = 'Your Kite login has expired. Log in again.';
      return broadcastStatus();
    }
    if (reusesToken) {
      const fresh = borrowedToken();
      if (fresh && fresh !== session.accessToken) session = { ...session, accessToken: fresh, expires: nextSixAmIst(new Date()) };
    }
    const wait = RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)];
    log(`Kite’s live prices disconnected (${event.code}). Reconnecting in ${wait / 1000}s…`);
    setTimeout(connectTicker, wait);
  });
}

async function startKite() {
  try {
    await loadInstruments();
    connectTicker();
  } catch (error) {
    state.message = error.message;
    log(error.message);
    if (/HTTP 403/.test(error.message)) {
      session = null;
      state.loggedIn = false;
      if (reusesToken) state.message = 'The access token has expired or is wrong. Update it from your trading code’s login, then restart npm run live.';
    }
    broadcastStatus();
  }
}

/* Demo mode: a gentle random walk from each instrument's last official close. */

function startDemo() {
  const seeds = [];
  for (const symbol of wanted) {
    const file = join(ROOT, '.cache', 'site', 'i', instrumentFile(symbol));
    if (!existsSync(file)) continue;
    const item = JSON.parse(readFileSync(file, 'utf8'));
    const close = item.c.at(-1);
    if (!close) continue;
    const open = close * (1 + (Math.random() - 0.5) * 0.01);
    seeds.push(symbol);
    record(symbol, { last: open, open, high: open, low: open, close });
  }
  log(`Demo prices for ${seeds.length} instruments. These are made up, not market data.`);
  setInterval(() => {
    for (let i = 0; i < Math.ceil(seeds.length / 6); i++) {
      const symbol = seeds[Math.floor(Math.random() * seeds.length)];
      const [last, open, high, low, close] = quotes.get(symbol);
      const next = Math.max(0.05, last * (1 + (Math.random() - 0.5) * 0.004));
      record(symbol, { last: next, open, high: Math.max(high, next), low: Math.min(low, next), close });
    }
  }, 500);
}

/* The page's side: a stream of changes, sent once a second. */

const statusPayload = () => ({ mode: state.mode, loggedIn: state.loggedIn, connected: state.connected, user: state.user, message: state.message, lastTick: state.lastTick });
const send = (client, event, payload) => client.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
function broadcastStatus() {
  for (const client of clients) send(client, 'status', statusPayload());
}

setInterval(() => {
  if (!changed.size) return;
  const q = Object.fromEntries([...changed].map((symbol) => [symbol, quotes.get(symbol)]));
  changed.clear();
  for (const client of clients) send(client, 'quotes', { t: state.lastTick, q });
}, SEND_EVERY_MS);

async function serveFile(pathname, response) {
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const path = normalize(join(DIST, relative));
  if (!path.startsWith(DIST + sep)) throw new Error('Outside the site');
  let body = await readFile(path);
  // Only this server tells the page it's in live mode, so the published site never asks for live prices.
  if (path.endsWith('index.html')) body = Buffer.from(body.toString('utf8').replace('<head>', `<head>\n<meta name="live-mode" content="${state.mode}">`));
  response.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  response.end(body);
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/live/login') {
      if (DEMO) return response.writeHead(302, { Location: '/' }).end();
      // Reusing another program's token means logging in there, never here.
      if (!apiSecret) {
        state.message = 'Log in with your trading code as usual, update the token, then restart npm run live.';
        broadcastStatus();
        return response.writeHead(302, { Location: '/' }).end();
      }
      return response.writeHead(302, { Location: loginUrl(apiKey) }).end();
    }
    if (url.pathname === '/live/callback') {
      const requestToken = url.searchParams.get('request_token');
      if (DEMO || url.searchParams.get('status') !== 'success' || !requestToken) return response.writeHead(302, { Location: '/' }).end();
      session = await createSession(requestToken);
      saveSession(session);
      state.loggedIn = true;
      state.user = session.user;
      state.message = null;
      log(`Logged in to Kite${session.user ? ` as ${session.user}` : ''}.`);
      startKite();
      return response.writeHead(302, { Location: '/' }).end();
    }
    if (url.pathname === '/live/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      clients.add(response);
      send(response, 'status', statusPayload());
      if (quotes.size) send(response, 'quotes', { t: state.lastTick, q: Object.fromEntries(quotes) });
      request.on('close', () => clients.delete(response));
      return;
    }
    if (url.pathname === '/live/subscribe') {
      const symbol = url.searchParams.get('symbol') ?? '';
      if (symbol && !wanted.has(symbol) && wanted.size < 2900) {
        wanted.add(symbol);
        subscribe([symbol]);
      }
      return response.writeHead(204).end();
    }
    await serveFile(url.pathname, response);
  } catch (error) {
    if (url.pathname === '/live/callback') {
      state.message = error.message;
      log(`Kite login failed: ${error.message}`);
      return response.writeHead(302, { Location: '/' }).end();
    }
    response.writeHead(404).end('Not found');
  }
}).listen(PORT, HOST, () => {
  log(`Personal live mode at http://${HOST}:${PORT} (only on this computer).`);
  if (DEMO) return startDemo();
  const borrowed = reusesToken ? borrowedToken() : null;
  if (reusesToken && !borrowed) log(`Couldn’t read the access token${tokenFile ? ` from ${tokenFile}` : ''}.`);
  // A borrowed token can't say when it was issued, so it's taken as today's, which lasts until 6 AM.
  session = borrowed ? { apiKey, accessToken: borrowed, user: null, expires: nextSixAmIst(new Date()) } : loadSession();
  if (borrowed) {
    state.loggedIn = true;
    log('Using the access token from your trading code’s login, so there’s no second login.');
    startKite();
  } else if (session) {
    state.loggedIn = true;
    state.user = session.user;
    log('Using today’s Kite login.');
    startKite();
  } else if (!reusesToken) log(`Open the page and choose “Log in to Kite”. Your Kite app’s redirect URL must be http://${HOST}:${PORT}/live/callback`);
});
