// NSE's own published daily reports: the official record of Indian market prices.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { round } from '../../lib/pivot.js';
import { cachedDownload } from './http.js';

const ARCHIVE = 'https://nsearchives.nseindia.com';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// A report can appear late, so only days this old are remembered as having no report.
const SETTLED_AFTER_DAYS = 4;
// NSE's previous-close column isn't adjusted, so a corporate action shows up only as an overnight gap.
// Across three years of NIFTY 100 data, every fall past this size was a split, bonus or demerger,
// and the largest real market falls stopped at 20%. The build logs each one it finds for review.
const ACTION_GAP = 0.25;
const COMMON_RATIOS = [1 / 10, 1 / 5, 1 / 4, 1 / 3, 2 / 5, 1 / 2, 2 / 3];
const RATIO_TOLERANCE = 0.05;
const MAX_TEXT_LENGTH = 170;
const NOISY_FILINGS = /newspaper|trading window|share certificate|esop|esos|esps|compliance certificate|regulation 74|spurt/i;

export function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

export function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const keys = splitCsvLine(header);
  return lines
    .filter((line) => line.trim())
    .map((line) => {
      const cells = splitCsvLine(line);
      return Object.fromEntries(keys.map((key, i) => [key, cells[i] ?? '']));
    });
}

export const toNumber = (value) => {
  const number = Number(value);
  return value !== '' && Number.isFinite(number) ? number : null;
};

// NSE writes dates as 04-Nov-2026, 05-JAN-2026, 04-11-2026 and 04 NOV 2026.
export function toIsoDate(value) {
  const [day, month, year] = value.trim().split(/[-\s]+/);
  const monthNumber = /^\d+$/.test(month) ? Number(month) : MONTHS.indexOf(month.toUpperCase()) + 1;
  if (!monthNumber || !year) return null;
  return `${year}-${String(monthNumber).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

const dayMonthYear = (iso) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
const dayMonthShortYear = (iso) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(2, 4)}`;

function isSettled(iso) {
  return Date.now() - Date.parse(iso) > SETTLED_AFTER_DAYS * 86_400_000;
}

// The index report is the trading calendar: unlike the price report, it is absent on closed days.
export async function fetchIndexReport(iso) {
  const body = await cachedDownload(
    `nse/index/${iso}.csv`,
    `${ARCHIVE}/content/indices/ind_close_all_${dayMonthYear(iso)}.csv`,
    {
      keepMissing: isSettled(iso),
      isValid: (buffer) => buffer.toString('utf8', 0, 10) === 'Index Name',
    },
  );
  if (!body) return null;
  const rows = parseCsv(body.toString('utf8'));
  return rows.filter((row) => toIsoDate(row['Index Date']) === iso);
}

export function reportsOnlyThisDate(text, iso) {
  const firstRow = text.split(/\r?\n/, 2)[1];
  return Boolean(firstRow) && toIsoDate(splitCsvLine(firstRow)[2] ?? '') === iso;
}

// On a holiday this URL still answers, with another day's prices, so the date on the rows is checked.
function downloadPriceReport(iso) {
  return cachedDownload(
    `nse/prices/${iso}.csv`,
    `${ARCHIVE}/products/content/sec_bhavdata_full_${dayMonthYear(iso)}.csv`,
    { isValid: (buffer) => reportsOnlyThisDate(buffer.toString('utf8', 0, 600), iso) },
  );
}

export async function hasPriceReport(iso) {
  return Boolean(await downloadPriceReport(iso));
}

export async function fetchPriceReport(iso) {
  const body = await downloadPriceReport(iso);
  return body ? parseCsv(body.toString('utf8')) : null;
}

export async function fetchPeReport(iso) {
  const body = await cachedDownload(`nse/pe/${iso}.csv`, `${ARCHIVE}/content/equities/peDetail/PE_${dayMonthShortYear(iso)}.csv`);
  return body ? parseCsv(body.toString('utf8')) : null;
}

function unzipFile(zipBuffer, name) {
  const dir = mkdtempSync(join(tmpdir(), 'nse-bundle-'));
  try {
    const path = join(dir, 'bundle.zip');
    writeFileSync(path, zipBuffer);
    return execFileSync('unzip', ['-p', path, name], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function fetchDailyBundle(iso) {
  const zip = await cachedDownload(`nse/bundle/${iso}.zip`, `${ARCHIVE}/archives/equities/bhavcopy/pr/PR${dayMonthShortYear(iso)}.zip`);
  if (!zip) return null;
  const suffix = dayMonthYear(iso);
  const part = (name) => {
    try {
      return unzipFile(zip, name);
    } catch {
      return '';
    }
  };
  return {
    announcements: part(`an${suffix}.txt`),
    corporateActions: part(`bc${suffix}.csv`),
    boardMeetings: part(`bm${suffix}.txt`),
    marketCaps: part(`mcap${suffix}.csv`),
    smeList: part(`sme${suffix}.csv`),
  };
}

async function fetchListing(path) {
  const today = new Date().toISOString().slice(0, 10);
  const body = await cachedDownload(`nse/lists/${today}/${path.replaceAll('/', '_')}`, `${ARCHIVE}/${path}`);
  if (!body) throw new Error(`NSE list unavailable: ${path}`);
  return parseCsv(body.toString('latin1'));
}

export const fetchNifty500List = () => fetchListing('content/indices/ind_nifty500list.csv');
export const fetchTotalMarketList = () => fetchListing('content/indices/ind_niftytotalmarket_list.csv');
export const fetchEquityList = () => fetchListing('content/equities/EQUITY_L.csv');
export const fetchSymbolChanges = () => fetchListing('content/equities/symbolchange.csv');
export const fetchIndexMembers = (file) => fetchListing(`content/indices/${file}`);

// Prices filed under a company's old ticker belong to today's ticker.
export function createSymbolResolver(changes) {
  const byOldSymbol = new Map();
  for (const row of changes) {
    const change = {
      next: row['NEW SYMBOL'],
      effective: toIsoDate(row['EFFECTIVE DATE'] ?? ''),
    };
    if (!row['OLD SYMBOL'] || !change.next || !change.effective) continue;
    if (!byOldSymbol.has(row['OLD SYMBOL'])) byOldSymbol.set(row['OLD SYMBOL'], []);
    byOldSymbol.get(row['OLD SYMBOL']).push(change);
  }
  return (symbol, tradeDate) => {
    let current = symbol;
    for (let hop = 0; hop < 5; hop++) {
      const change = byOldSymbol.get(current)?.find(({ effective }) => tradeDate < effective);
      if (!change) break;
      current = change.next;
    }
    return current;
  };
}

// EQ, BE and BZ are the main board, and SM and ST are the SME platform. The report's other series are bonds, funds and the like.
const STOCK_SERIES = ['EQ', 'BE', 'BZ', 'SM', 'ST'];
export const SME_SERIES = new Set(['SM', 'ST']);

// One day's rows go straight into each stock's history, so the build never holds whole reports in memory.
export function addStockSessions(sessions, date, rows, targets, resolveSymbol) {
  const chosen = new Map();
  for (const row of rows) {
    const rank = STOCK_SERIES.indexOf(row.SERIES);
    if (rank < 0) continue;
    const symbol = resolveSymbol(row.SYMBOL, date);
    if (!targets.has(symbol)) continue;
    if (!chosen.has(symbol) || rank < chosen.get(symbol).rank) chosen.set(symbol, { rank, row });
  }
  for (const [symbol, { row }] of chosen) {
    const open = toNumber(row.OPEN_PRICE);
    const high = toNumber(row.HIGH_PRICE);
    const low = toNumber(row.LOW_PRICE);
    const close = toNumber(row.CLOSE_PRICE);
    if (!open || !high || !low || !close) continue;
    if (!sessions.has(symbol)) sessions.set(symbol, []);
    sessions.get(symbol).push({
      date,
      open,
      high,
      low,
      close,
      volume: toNumber(row.TTL_TRD_QNTY),
      delivery: toNumber(row.DELIV_PER),
    });
  }
}

export function collectStockSessions(reports, targets, resolveSymbol) {
  const sessions = new Map();
  for (const { date, rows } of reports) addStockSessions(sessions, date, rows, targets, resolveSymbol);
  return sessions;
}

export function detectPriceActions(sessions) {
  const actions = [];
  for (let i = 1; i < sessions.length; i++) {
    const gap = sessions[i].open / sessions[i - 1].close;
    if (gap >= 1 - ACTION_GAP) continue;
    // The open also carries the night's market move, so a clean ratio is used where one fits.
    const ratio = COMMON_RATIOS.find((candidate) => Math.abs(gap / candidate - 1) <= RATIO_TOLERANCE);
    actions.push({ date: sessions[i].date, factor: round(ratio ?? gap, 6) });
  }
  return actions;
}

export function collectIndexSessions(reports, wantedName) {
  const wanted = wantedName.toLowerCase();
  const sessions = [];
  for (const { date, rows } of reports) {
    const row = rows.find((candidate) => candidate['Index Name'].toLowerCase() === wanted);
    if (!row) continue;
    const open = toNumber(row['Open Index Value']);
    const high = toNumber(row['High Index Value']);
    const low = toNumber(row['Low Index Value']);
    const close = toNumber(row['Closing Index Value']);
    if (!open || !high || !low || !close) continue;
    sessions.push({
      date,
      open,
      high,
      low,
      close,
      pe: toNumber(row['P/E']),
      pb: toNumber(row['P/B']),
      dy: toNumber(row['Div Yield']),
    });
  }
  return sessions;
}

const shorten = (text) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_TEXT_LENGTH) return clean;
  return `${clean.slice(0, MAX_TEXT_LENGTH).replace(/\s+\S*$/, '')}…`;
};

const FILING_PREAMBLE = /^has (?:informed the Exchange (?:about|regarding|that)|submitted to the Exchange,?)\s*/i;

// Drops the stock phrasing every filing opens with, and anything that only repeats the category.
function filingText(details, company, category) {
  const body = details.replace(company, '').trim().replace(FILING_PREAMBLE, '').replace(/^['"]|['".]+$/g, '').trim();
  if (!body || body.toLowerCase() === category.trim().toLowerCase()) return '';
  return shorten(body[0].toUpperCase() + body.slice(1));
}

// Each line reads: Company Name SYMBOL : Category SYMBOL : Details
export function parseAnnouncements(text, date, targets) {
  const filings = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(.*?) (\S+) : (.*?) \2 : (.*)$/);
    if (!match || !targets.has(match[2]) || NOISY_FILINGS.test(match[3])) continue;
    const [, company, symbol, category, details] = match;
    filings.push({
      symbol,
      date,
      category: category.trim(),
      text: filingText(details, company, category),
    });
  }
  return filings;
}

export function parseCorporateActions(text, fromDate, targets) {
  return parseCsv(text)
    .filter((row) => STOCK_SERIES.includes(row.SERIES) && targets.has(row.SYMBOL) && row.EX_DT >= fromDate)
    .map((row) => ({ symbol: row.SYMBOL, date: row.EX_DT, purpose: shorten(row.PURPOSE) }));
}

// Each line reads: Company Name SYMBOL : 12-NOV-2026 : Purpose
export function parseBoardMeetings(text, fromDate, targets) {
  const meetings = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(.*?) (\S+) : (\d{2}-[A-Z]{3}-\d{4}) : (.*)$/);
    if (!match || !targets.has(match[2])) continue;
    const date = toIsoDate(match[3]);
    if (date < fromDate) continue;
    meetings.push({ symbol: match[2], date, purpose: shorten(match[4].split(` ${match[2]} : `)[0]) });
  }
  return meetings;
}

export function parseMarketCaps(text, targets) {
  const caps = new Map();
  for (const row of parseCsv(text)) {
    if (!STOCK_SERIES.includes(row.Series) || !targets.has(row.Symbol)) continue;
    caps.set(row.Symbol, {
      marketCap: toNumber(row['Market Cap(Rs.)']),
      shares: toNumber(row['Issue Size']),
      faceValue: toNumber(row['Face Value(Rs.)']),
    });
  }
  return caps;
}

export function parseSmeNames(text) {
  return new Map(parseCsv(text).map((row) => [row.SYMBOL, row.SECURITY]));
}
