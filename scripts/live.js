// Personal live mode: the site on this computer only, with prices streaming from your own Zerodha Kite
// Connect account. Kite's terms allow its live data in a private interface for your own use, not on a
// public site or for other people, so this listens on 127.0.0.1 and answers only this computer's browser.
//
//   Double-click "Start live mode.command", or run: npm run live
//   npm run live -- --demo   made-up prices, to try the screens without a Kite account
//   npm run automate         starts it by itself at 9:00 AM on weekdays (see scripts/automate.js)
//
// The pages and the day's official data come from the published site, so nothing needs building here.
//
// Settings live in .env.kite, which git ignores:
//   KITE_API_KEY               your app's key (asked for the first time)
//   KITE_ACCESS_TOKEN_FILE     where your algo saves its daily access token, so you never paste one
//   KITE_ACCESS_TOKEN          today's token, when pasted here or on the page (saved with the time)
//   KITE_API_SECRET            only to log in here instead, through the app's redirect URL
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { instrumentFile } from '../lib/market.js';
import { instrumentIndex, KITE_API, KITE_INDEX_NAMES, KITE_SOCKET, loginUrl, parseInstruments, parseTicks, sessionChecksum } from './sources/kite.js';

const PORT = Number(process.env.PORT) || 4174;
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const SITE = (process.env.LIVE_SITE ?? 'https://mpipos.github.io').replace(/\/$/, '');
// The published site may read the live prices too, but only in a browser on this computer, as nobody else's
// computer runs this server. That's how mpipos.github.io goes live on your Mac and nowhere else.
const READER_ORIGINS = new Set([new URL(SITE).origin, ...(process.env.LIVE_EXTRA_ORIGIN ? [process.env.LIVE_EXTRA_ORIGIN] : [])]);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
const KITE_CACHE = join(ROOT, '.cache', 'kite');
const SESSION_FILE = join(KITE_CACHE, 'session.json');
const ENV_FILE = join(ROOT, '.env.kite');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const SEND_EVERY_MS = 1000;
const RECONNECT_MS = [2000, 5000, 15000, 30000, 60000];
const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const LOCAL = args.includes('--local');
const UNTIL = args.includes('--until') ? args[args.indexOf('--until') + 1] : null;

const log = (message) => console.log(`[${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })}] ${message}`);

/* Settings */

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

function writeEnv(settings) {
  const lines = ['# Settings for npm run live. Git ignores this file, so it stays on this computer.', ...Object.entries(settings).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`)];
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`);
  chmodSync(ENV_FILE, 0o600);
}

let settings = readEnv();
const setting = (key) => process.env[key] ?? settings[key];

// Kite's access tokens last until 6 AM India time on the day after they're issued.
const nextSixAmIst = (from) => {
  const sixAmUtc = new Date(from);
  sixAmUtc.setUTCHours(0, 30, 0, 0); // 06:00 in India
  if (sixAmUtc <= from) sixAmUtc.setUTCDate(sixAmUtc.getUTCDate() + 1);
  return sixAmUtc.getTime();
};
const stillValid = (issuedAt) => Boolean(issuedAt) && Date.now() < nextSixAmIst(new Date(issuedAt));
// Tokens Kite turned down, so they aren't tried again and again.
const rejected = new Set();

// Today's access token, from wherever it is: the file your algo saves (dated by when it was saved), one
// pasted here or on the page, or one given in the environment.
function currentToken() {
  const file = setting('KITE_ACCESS_TOKEN_FILE');
  if (file) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      const token = text.startsWith('{') ? JSON.parse(text).access_token : text;
      if (token && !rejected.has(token) && stillValid(statSync(file).mtimeMs)) return { token, source: 'your algo’s token file' };
    } catch {
      // A missing or half-written file just means today's token isn't there yet.
    }
  }
  if (settings.KITE_ACCESS_TOKEN && !rejected.has(settings.KITE_ACCESS_TOKEN) && stillValid(settings.KITE_TOKEN_SAVED_AT)) return { token: settings.KITE_ACCESS_TOKEN, source: 'the token you pasted' };
  if (process.env.KITE_ACCESS_TOKEN && !rejected.has(process.env.KITE_ACCESS_TOKEN)) return { token: process.env.KITE_ACCESS_TOKEN, source: 'KITE_ACCESS_TOKEN' };
  return null;
}

function saveToken(token) {
  settings = { ...readEnv(), KITE_ACCESS_TOKEN: token, KITE_TOKEN_SAVED_AT: new Date().toISOString() };
  writeEnv(settings);
}

async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question(question)).trim();
  prompt.close();
  return answer;
}

// In a terminal, ask for what's missing. Started by itself in the morning, it waits for the page instead.
if (!DEMO && process.stdin.isTTY) {
  if (!setting('KITE_API_KEY')) {
    console.log('\nFirst time: your Kite Connect API key is in the app your algo uses, at https://developers.kite.trade');
    const key = await ask('Paste your API key and press Enter: ');
    if (key) writeEnv((settings = { ...settings, KITE_API_KEY: key }));
  }
  if (setting('KITE_API_KEY') && !currentToken() && !setting('KITE_API_SECRET')) {
    console.log('\nToday’s access token is the one your algo got when it logged in to Kite this morning.');
    console.log('(Leave it empty to paste it on the page instead.)');
    const token = await ask('Paste today’s access token and press Enter: ');
    if (token) saveToken(token);
  }
}

const apiKey = () => setting('KITE_API_KEY');
const apiSecret = () => setting('KITE_API_SECRET');

/* The published site supplies the pages and the official data, so they're always the latest. */

const upstreamCache = new Map();

async function fromSite(path) {
  const response = await fetch(`${SITE}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return { status: response.status };
  return { status: 200, type: response.headers.get('content-type') ?? 'application/octet-stream', body: Buffer.from(await response.arrayBuffer()) };
}

async function readSiteFile(pathname, search) {
  const isPage = pathname === '/' || pathname === '/index.html';
  const local = async () => {
    const path = normalize(join(DIST, decodeURIComponent(isPage ? '/index.html' : pathname)));
    if (!path.startsWith(DIST + sep)) return { status: 404 };
    try {
      return { status: 200, type: TYPES[extname(path)] ?? 'application/octet-stream', body: await readFile(path) };
    } catch {
      return { status: 404 };
    }
  };
  if (LOCAL) return local();
  const key = `${isPage ? '/' : pathname}${search}`;
  // Data files are named by the update that made them, so each can be kept once fetched. The page is fetched every time.
  if (!isPage && upstreamCache.has(key)) return upstreamCache.get(key);
  try {
    const file = await fromSite(key);
    if (file.status === 200 && !isPage) upstreamCache.set(key, file);
    return file.status === 200 ? file : (await local()).status === 200 ? local() : file;
  } catch {
    return local();
  }
}

/* What to stream: every heatmap stock and index, plus whatever stock is open on the page. */

async function readInfo() {
  const file = await readSiteFile('/data/h/info.json', '');
  if (file.status === 200) return JSON.parse(file.body.toString('utf8'));
  log('Couldn’t read the heatmap’s list of stocks, so only indices will stream.');
  return { stocks: [] };
}

const info = await readInfo();
const wanted = new Set([...info.stocks.map(([symbol]) => symbol), ...Object.keys(KITE_INDEX_NAMES)]);

const quotes = new Map(); // symbol -> [last, open, high, low, previous close]
const changed = new Set();
const clients = new Set();
const state = { mode: DEMO ? 'demo' : 'kite', loggedIn: DEMO, connected: DEMO, needs: null, user: null, message: null, lastTick: null };

function record(symbol, tick) {
  const before = quotes.get(symbol) ?? [];
  quotes.set(symbol, [tick.last, tick.open ?? before[1] ?? null, tick.high ?? before[2] ?? null, tick.low ?? before[3] ?? null, tick.close ?? before[4] ?? null]);
  changed.add(symbol);
  state.lastTick = Date.now();
}

/* Kite session */

let session = null; // { accessToken, expires, user }

function loadLoginSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return saved.expires > Date.now() && saved.apiKey === apiKey() ? saved : null;
  } catch {
    return null;
  }
}

function saveLoginSession(saved) {
  mkdirSync(KITE_CACHE, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(saved));
  chmodSync(SESSION_FILE, 0o600);
}

const kiteHeaders = () => ({ 'X-Kite-Version': '3', Authorization: `token ${apiKey()}:${session.accessToken}` });

async function createLoginSession(requestToken) {
  const response = await fetch(`${KITE_API}/session/token`, {
    method: 'POST',
    headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: apiKey(), request_token: requestToken, checksum: sessionChecksum(apiKey(), requestToken, apiSecret()) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.data?.access_token) throw new Error(body.message ?? `Kite refused the login (HTTP ${response.status})`);
  return { apiKey: apiKey(), accessToken: body.data.access_token, user: body.data.user_name ?? body.data.user_id ?? null, expires: nextSixAmIst(new Date()) };
}

// What the page should ask for, if anything, before prices can stream.
function needsFor() {
  if (!apiKey()) return 'key';
  if (apiSecret()) return 'login';
  return 'token';
}

function waitForToken(message) {
  session = null;
  state.loggedIn = false;
  state.connected = false;
  state.needs = needsFor();
  state.message = message;
  broadcastStatus();
}

// Kite's instrument list doesn't need a valid token, so the token is checked against the profile, which does.
async function checkToken() {
  const response = await fetch(`${KITE_API}/user/profile`, { headers: kiteHeaders(), signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message ?? `Kite's profile: HTTP ${response.status}`), { status: response.status === 400 ? 403 : response.status });
  return body.data?.user_shortname ?? body.data?.user_name ?? null;
}

/* Instruments: Kite's list of tokens, read once a day. */

let tokens = new Map(); // symbol -> instrument token
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
      if (!response.ok) throw Object.assign(new Error(`Kite's ${exchange} instrument list: HTTP ${response.status}`), { status: response.status });
      text = await response.text();
      mkdirSync(KITE_CACHE, { recursive: true });
      writeFileSync(file, text);
    }
    rows.push(...parseInstruments(text));
  }
  tokens = instrumentIndex(rows);
  symbolsByToken = new Map([...tokens].map(([symbol, token]) => [token, symbol]));
  const missing = [...wanted].filter((symbol) => !tokens.has(symbol));
  log(`Kite has ${wanted.size - missing.length} of the ${wanted.size} instruments to stream.${missing.length ? ` Not found: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}` : ''}`);
}

/* Kite's ticker. Quote mode gives each instrument's last price, open, high, low and previous close. */

let socket = null;
let attempt = 0;
let failedOpens = 0;

function subscribe(symbols) {
  const list = symbols.map((symbol) => tokens.get(symbol)).filter(Boolean);
  if (!list.length || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ a: 'subscribe', v: list }));
  socket.send(JSON.stringify({ a: 'mode', v: ['quote', list] }));
}

function connectTicker() {
  if (!session) return;
  const mine = (socket = new WebSocket(`${KITE_SOCKET}?api_key=${encodeURIComponent(apiKey())}&access_token=${encodeURIComponent(session.accessToken)}`));
  mine.binaryType = 'arraybuffer';
  mine.addEventListener('open', () => {
    attempt = 0;
    failedOpens = 0;
    state.connected = true;
    state.message = null;
    log('Connected to Kite’s live prices.');
    subscribe([...wanted]);
    broadcastStatus();
  });
  mine.addEventListener('message', ({ data }) => {
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
  let opened = false;
  mine.addEventListener('open', () => (opened = true));
  mine.addEventListener('close', async (event) => {
    if (mine !== socket) return; // replaced by a newer connection
    state.connected = false;
    broadcastStatus();
    if (!session) return;
    // Refused again and again without ever connecting usually means the token stopped working.
    if (!opened && ++failedOpens >= 3) {
      failedOpens = 0;
      try {
        await checkToken();
      } catch (error) {
        if (error.status === 403) {
          rejected.add(session.accessToken);
          return waitForToken('Kite stopped accepting today’s token. Paste a fresh one.');
        }
      }
    }
    // A new day's token may have arrived (your algo's file, or one pasted), so it's picked up here.
    const fresh = currentToken();
    if (fresh && fresh.token !== session.accessToken) session = { ...session, accessToken: fresh.token, expires: nextSixAmIst(new Date()) };
    else if (session.expires <= Date.now()) return waitForToken('Today’s Kite login is needed. Paste today’s access token.');
    const wait = RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)];
    log(`Kite’s live prices disconnected (${event.code}). Reconnecting in ${wait / 1000}s…`);
    setTimeout(connectTicker, wait);
  });
}

// Starts streaming with a token. A token Kite rejects goes back to waiting for one, with the reason.
async function startKite(accessToken, { user = null, source = null } = {}) {
  session = { accessToken, user, expires: nextSixAmIst(new Date()) };
  state.loggedIn = true;
  state.needs = null;
  state.user = user;
  state.message = null;
  broadcastStatus();
  try {
    const name = await checkToken();
    state.user = user ?? name;
    session.user = state.user;
    await loadInstruments();
    if (source) log(`Streaming with ${source}${state.user ? `, as ${state.user}` : ''}.`);
    socket?.close();
    connectTicker();
    return null;
  } catch (error) {
    if (error.status === 403) rejected.add(accessToken);
    const reason = error.status === 403 ? 'Kite didn’t accept that access token. It may be yesterday’s, or from another app.' : error.message;
    log(reason);
    waitForToken(reason);
    return reason;
  }
}

// While waiting for today's token, keep checking your algo's file, so its morning login is enough.
setInterval(() => {
  if (DEMO || session || !apiKey()) return;
  const fresh = currentToken();
  if (fresh) startKite(fresh.token, { source: fresh.source });
}, 30_000);

/* Demo mode: a gentle random walk from each instrument's last official close. */

async function startDemo() {
  const seeds = [];
  const closeOf = async (symbol) => {
    const localFile = join(ROOT, '.cache', 'site', 'i', instrumentFile(symbol));
    if (existsSync(localFile)) return JSON.parse(readFileSync(localFile, 'utf8')).c.at(-1);
    const file = await readSiteFile(`/data/i/${instrumentFile(symbol)}`, '');
    return file.status === 200 ? JSON.parse(file.body.toString('utf8')).c.at(-1) : null;
  };
  const list = [...wanted];
  for (let i = 0; i < list.length; i += 16) {
    const closes = await Promise.all(list.slice(i, i + 16).map((symbol) => closeOf(symbol).catch(() => null)));
    closes.forEach((close, j) => {
      if (!close) return;
      const open = close * (1 + (Math.random() - 0.5) * 0.01);
      seeds.push(list[i + j]);
      record(list[i + j], { last: open, open, high: open, low: open, close });
    });
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

const statusPayload = () => ({ mode: state.mode, loggedIn: state.loggedIn, connected: state.connected, needs: state.needs, user: state.user, message: state.message, lastTick: state.lastTick });
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

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Too large');
  }
  return body;
}

const json = (response, status, payload) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(payload));

const server = createServer(async (request, response) => {
  // Only this computer's own browser gets an answer. Another website, even one that points its name at
  // 127.0.0.1, is refused, so it can't read the prices or change the token.
  if (!ALLOWED_HOSTS.has(request.headers.host ?? '')) return response.writeHead(403).end('Forbidden');
  const url = new URL(request.url, ORIGIN);
  const reader = request.headers.origin;
  if (url.pathname.startsWith('/live/') && READER_ORIGINS.has(reader) && url.pathname !== '/live/token') {
    // Browsers ask before a public site reaches this computer, and this answers yes for your own site only.
    response.setHeader('Access-Control-Allow-Origin', reader);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      return response.writeHead(204).end();
    }
  }
  try {
    if (url.pathname === '/live/token' && request.method === 'POST') {
      if (request.headers.origin !== ORIGIN && request.headers.origin !== `http://localhost:${PORT}`) return json(response, 403, { error: 'Forbidden' });
      if (DEMO) return json(response, 400, { error: 'Demo prices need no token.' });
      const { token, key } = JSON.parse(await readBody(request));
      if (key && typeof key === 'string') writeEnv((settings = { ...readEnv(), KITE_API_KEY: key.trim() }));
      if (!apiKey()) return json(response, 400, { error: 'Your API key is needed first.' });
      if (!token || typeof token !== 'string') return json(response, 400, { error: 'Paste today’s access token.' });
      saveToken(token.trim());
      const problem = await startKite(token.trim(), { source: 'the token you pasted' });
      return problem ? json(response, 400, { error: problem }) : json(response, 200, { ok: true });
    }
    if (url.pathname === '/live/login') {
      if (DEMO || !apiSecret()) return response.writeHead(302, { Location: '/' }).end();
      return response.writeHead(302, { Location: loginUrl(apiKey()) }).end();
    }
    if (url.pathname === '/live/callback') {
      const requestToken = url.searchParams.get('request_token');
      if (DEMO || !apiSecret() || url.searchParams.get('status') !== 'success' || !requestToken) return response.writeHead(302, { Location: '/' }).end();
      const login = await createLoginSession(requestToken);
      saveLoginSession(login);
      log(`Logged in to Kite${login.user ? ` as ${login.user}` : ''}.`);
      startKite(login.accessToken, { user: login.user });
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
    const file = await readSiteFile(url.pathname, url.search);
    if (file.status !== 200) return response.writeHead(file.status === 404 ? 404 : 502).end('Not found');
    let { body } = file;
    // Only this server marks the page as live, so the published site never asks for live prices.
    if (file.type.startsWith('text/html')) body = Buffer.from(body.toString('utf8').replace('<head>', `<head>\n<meta name="live-mode" content="${state.mode}">`));
    response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' });
    response.end(body);
  } catch (error) {
    if (url.pathname === '/live/callback') {
      waitForToken(`Kite login failed: ${error.message}`);
      return response.writeHead(302, { Location: '/' }).end();
    }
    if (url.pathname === '/live/token') return json(response, 400, { error: 'Couldn’t read that. Paste the token again.' });
    response.writeHead(500).end('Something went wrong');
  }
});

// Opens your own site, live on this Mac. Chrome is used where it's installed, because it lets a public site
// reach this computer once you allow it, and ?live=on makes that browser show the Live button.
const CHROME = '/Applications/Google Chrome.app';
const openPage = () => {
  if (process.platform !== 'darwin' || args.includes('--no-open')) return;
  const page = DEMO || LOCAL || process.env.LIVE_SITE ? ORIGIN : `${SITE}/?live=on`;
  execFile('open', existsSync(CHROME) && page !== ORIGIN ? ['-a', CHROME, page] : [page], () => {});
};

// Started again while already running (say, by the 9 AM start after you'd opened it yourself), it just opens the page.
server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error;
  log(`The live mode is already running at ${ORIGIN}.`);
  openPage();
  process.exit(0);
});

// --until 21:30 stops it once the evening's official update is in, unless it was started later than that.
function stopAtCloseOfDay() {
  if (!UNTIL || !/^\d{1,2}:\d{2}$/.test(UNTIL)) return;
  const [hours, minutes] = UNTIL.split(':').map(Number);
  const now = new Date();
  const istNow = new Date(now.getTime() + 330 * 60_000);
  const istStop = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), hours, minutes));
  const wait = istStop.getTime() - 330 * 60_000 - now.getTime();
  if (wait <= 0) return;
  setTimeout(() => {
    log(`It’s ${UNTIL}, so the live mode stops and the site shows the official prices. It starts again on the next weekday morning.`);
    process.exit(0);
  }, wait);
}

server.listen(PORT, HOST, async () => {
  log(`Personal live mode at ${ORIGIN} (only on this computer). Close this window or press Ctrl+C to stop.`);
  stopAtCloseOfDay();
  openPage();
  if (DEMO) return startDemo();
  if (!apiKey()) return waitForToken('Your Kite API key is needed once. Paste it on the page.');
  const fromLogin = apiSecret() ? loadLoginSession() : null;
  if (fromLogin) return startKite(fromLogin.accessToken, { user: fromLogin.user, source: 'today’s Kite login' });
  const fresh = currentToken();
  if (fresh) return startKite(fresh.token, { source: fresh.source });
  waitForToken(setting('KITE_ACCESS_TOKEN_FILE') ? 'Waiting for your algo to log in and save today’s token. Or paste it here.' : 'Paste today’s access token from your algo’s login.');
  log('Waiting for today’s access token. Paste it on the page, or let your algo save it to its token file.');
});
