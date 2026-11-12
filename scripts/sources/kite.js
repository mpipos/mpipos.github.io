// Zerodha Kite Connect, for the personal live mode only (`npm run live`). Kite's terms don't allow its live
// data to be shown to the public, so none of this runs in the published site's build.
import { createHash } from 'node:crypto';
import { parseCsv } from './nse.js';

export const KITE_API = 'https://api.kite.trade';
export const KITE_SOCKET = 'wss://ws.kite.trade';

export const loginUrl = (apiKey) => `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;

// Kite's session request is signed with SHA-256 of the key, the one-time token and the secret.
export const sessionChecksum = (apiKey, requestToken, apiSecret) => createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');

// The site's names for indices, and the names Kite's instrument list may use for them.
export const KITE_INDEX_NAMES = {
  'NIFTY 50': ['NIFTY 50'],
  'NIFTY BANK': ['NIFTY BANK'],
  'NIFTY FINANCIAL SERVICES': ['NIFTY FIN SERVICE', 'NIFTY FINANCIAL SERVICES'],
  'NIFTY NEXT 50': ['NIFTY NEXT 50'],
  'NIFTY 100': ['NIFTY 100'],
  'NIFTY 500': ['NIFTY 500'],
  'NIFTY MIDCAP 100': ['NIFTY MIDCAP 100', 'NIFTY MID100'],
  'NIFTY SMALLCAP 100': ['NIFTY SMLCAP 100', 'NIFTY SMALLCAP 100'],
  'NIFTY IT': ['NIFTY IT'],
  'NIFTY AUTO': ['NIFTY AUTO'],
  'NIFTY PHARMA': ['NIFTY PHARMA'],
  'NIFTY FMCG': ['NIFTY FMCG'],
  'NIFTY METAL': ['NIFTY METAL'],
  'NIFTY REALTY': ['NIFTY REALTY'],
  'NIFTY ENERGY': ['NIFTY ENERGY'],
  'NIFTY PSU BANK': ['NIFTY PSU BANK'],
  'NIFTY PRIVATE BANK': ['NIFTY PVT BANK', 'NIFTY PRIVATE BANK'],
  'INDIA VIX': ['INDIA VIX'],
  SENSEX: ['SENSEX'],
};

// Maps the site's symbols to Kite's instrument tokens: NSE stocks by ticker, companies only on BSE as
// "BSE:TICKER", and indices by the names above.
export function instrumentIndex(rows) {
  const bySymbol = new Map();
  const indexByName = new Map();
  for (const row of rows) {
    const token = Number(row.instrument_token);
    if (!token) continue;
    if (row.segment === 'INDICES') indexByName.set(`${row.exchange}:${row.tradingsymbol.toUpperCase()}`, token);
    else if (row.instrument_type === 'EQ' && row.exchange === 'NSE') bySymbol.set(row.tradingsymbol, token);
    else if (row.instrument_type === 'EQ' && row.exchange === 'BSE' && !bySymbol.has(`BSE:${row.tradingsymbol}`)) bySymbol.set(`BSE:${row.tradingsymbol}`, token);
  }
  for (const [symbol, names] of Object.entries(KITE_INDEX_NAMES)) {
    const exchange = symbol === 'SENSEX' ? 'BSE' : 'NSE';
    const token = names.map((name) => indexByName.get(`${exchange}:${name}`)).find(Boolean);
    if (token) bySymbol.set(symbol, token);
  }
  return bySymbol;
}

export const parseInstruments = (text) => parseCsv(text);

// Kite's ticker sends binary messages: a count of packets, then each packet's length and bytes. Prices are
// in paise. An index packet carries last, high, low, open and previous close; a stock packet (quote or full
// mode) carries last, volume, then open, high, low and previous close. A one-byte message is a heartbeat.
export function parseTicks(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length < 2) return [];
  const count = buffer.readUInt16BE(0);
  const ticks = [];
  let at = 2;
  for (let i = 0; i < count && at + 2 <= buffer.length; i++) {
    const length = buffer.readUInt16BE(at);
    const packet = buffer.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    const price = (offset) => packet.readInt32BE(offset) / 100;
    const token = packet.readUInt32BE(0);
    if (length === 8) ticks.push({ token, last: price(4) });
    else if (length === 28 || length === 32) {
      ticks.push({ token, last: price(4), high: price(8), low: price(12), open: price(16), close: price(20) });
    } else if (length === 44 || length >= 184) {
      ticks.push({ token, last: price(4), volume: packet.readUInt32BE(16), open: price(28), high: price(32), low: price(36), close: price(40) });
    }
  }
  return ticks;
}
