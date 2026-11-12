// NSE's live market data (the feed behind its heatmap page), used for a provisional same-day close
// shortly after 15:30 IST. NSE's end-of-day reports replace these figures once they are published.
import { toIsoDate, toNumber } from './nse.js';

const SITE = 'https://www.nseindia.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CLOSE_TIME = '15:30';
const STOCK_INDEX = 'NIFTY 500';

// Returns the trading date once the session has closed, or null while it is still open.
export function closedSessionDate(timestamp) {
  const [date, time] = String(timestamp ?? '').split(' ');
  const iso = date ? toIsoDate(date) : null;
  return iso && time >= CLOSE_TIME ? iso : null;
}

export function parseLiveIndices(payload) {
  const date = closedSessionDate(payload?.timestamp);
  const rows = new Map();
  if (!date) return { date: null, rows };
  for (const row of payload.data ?? []) {
    const open = toNumber(row.open);
    const high = toNumber(row.high);
    const low = toNumber(row.low);
    const close = toNumber(row.last);
    if (!row.index || !open || !high || !low || !close) continue;
    rows.set(row.index.toLowerCase(), { open, high, low, close, pe: toNumber(row.pe), pb: toNumber(row.pb), dy: toNumber(row.dy) });
  }
  return { date, rows };
}

export function parseLiveStocks(payload) {
  const rows = new Map();
  for (const row of payload?.data ?? []) {
    if (!row.symbol || row.priority) continue;
    const open = toNumber(row.open);
    const high = toNumber(row.dayHigh);
    const low = toNumber(row.dayLow);
    const close = toNumber(row.lastPrice);
    if (!open || !high || !low || !close) continue;
    rows.set(row.symbol, { open, high, low, close, volume: toNumber(row.totalTradedVolume) });
  }
  return rows;
}

async function getJson(path, cookie) {
  const response = await fetch(`${SITE}${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

// Any failure returns null, so the build carries on with the official reports alone.
export async function fetchLiveSnapshot() {
  try {
    const home = await fetch(SITE, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    const cookie = home.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    const indices = parseLiveIndices(await getJson('/api/allIndices', cookie));
    if (!indices.date) return null;
    const stocks = parseLiveStocks(await getJson(`/api/equity-stockIndices?index=${encodeURIComponent(STOCK_INDEX)}`, cookie));
    return { date: indices.date, indices: indices.rows, stocks };
  } catch (error) {
    console.log(`NSE's live data is unavailable: ${error.message}`);
    return null;
  }
}
