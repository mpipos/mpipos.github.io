// Gathers prices, fundamentals, news and IPO records for the whole market. Each instrument gets its own
// file, which the page loads when someone chooses that instrument.
import { mkdirSync } from 'node:fs';
import { instrumentFile } from '../lib/market.js';
import { round } from '../lib/pivot.js';
import { findDatasetProblems, hasCompletePrices, separateLateReports } from './dataset-checks.js';
import { bsePageUrl, fetchBseRows, hasBseReport } from './sources/bse.js';
import {
  clearCacheFolder,
  mapPool,
  pauseAfterNetwork,
  pruneFolders,
  RateLimited,
  readCache,
  replaceCacheFolder,
  writeCache,
} from './sources/http.js';
import {
  fetchIssueDetail,
  fetchOpenIssues,
  fetchPastIssues,
  fetchUpcomingIssues,
  listingPerformance,
  normaliseCompany,
  summariseListings,
} from './sources/ipo.js';
import { fetchHeadlines, newsSearchUrl } from './sources/news.js';
import {
  addStockSessions,
  collectIndexSessions,
  createSymbolResolver,
  detectPriceActions,
  fetchDailyBundle,
  fetchEquityList,
  fetchIndexReport,
  fetchNifty500List,
  fetchPeReport,
  fetchPriceReport,
  fetchSymbolChanges,
  fetchTotalMarketList,
  hasPriceReport,
  parseAnnouncements,
  parseBoardMeetings,
  parseCorporateActions,
  parseMarketCaps,
  parseSmeNames,
  SME_SERIES,
  toIsoDate,
  toNumber,
} from './sources/nse.js';
import { fetchLiveSnapshot } from './sources/nse-live.js';
import { fetchSebiList, SEBI_DRAFT_LIST, SEBI_RHP_LIST } from './sources/sebi.js';
import { completedSessions, fetchChart, fetchFinancials, financialsPeriod, missingDays } from './sources/yahoo.js';

const YEARS = 3;
const FILING_DAYS = 8;
const MAX_FILINGS = 5;
const DAY_MS = 86_400_000;
const IPO_HISTORY_DAYS = 365;
const IPO_HEADLINES = 12;
const NEWS_FAILURE_LIMIT = 3;
const NEXT_FOLDER = 'site-next';
const SITE_FOLDER = 'site';

const NSE_INDICES = [
  { symbol: 'NIFTY 50', report: 'Nifty 50', news: '"Nifty 50"', keyword: 'nifty' },
  { symbol: 'NIFTY BANK', label: 'BANK NIFTY', report: 'Nifty Bank', news: '"Bank Nifty" OR "Nifty Bank"', keyword: 'bank' },
  { symbol: 'NIFTY FINANCIAL SERVICES', label: 'FINNIFTY', report: 'Nifty Financial Services', news: '"Nifty Financial Services" OR "FinNifty"', keyword: 'fin' },
  { symbol: 'NIFTY NEXT 50', report: 'Nifty Next 50', news: '"Nifty Next 50"', keyword: 'next 50' },
  { symbol: 'NIFTY 100', report: 'Nifty 100', news: '"Nifty 100"', keyword: 'nifty' },
  { symbol: 'NIFTY 500', report: 'Nifty 500', news: '"Nifty 500"', keyword: 'nifty' },
  { symbol: 'NIFTY MIDCAP 100', report: 'NIFTY Midcap 100', news: '"Nifty Midcap 100" OR "Nifty Midcap"', keyword: 'midcap' },
  { symbol: 'NIFTY SMALLCAP 100', report: 'NIFTY Smallcap 100', news: '"Nifty Smallcap 100" OR "Nifty Smallcap"', keyword: 'smallcap' },
  { symbol: 'NIFTY IT', report: 'Nifty IT', news: '"Nifty IT"', keyword: 'it' },
  { symbol: 'NIFTY AUTO', report: 'Nifty Auto', news: '"Nifty Auto"', keyword: 'auto' },
  { symbol: 'NIFTY PHARMA', report: 'Nifty Pharma', news: '"Nifty Pharma"', keyword: 'pharma' },
  { symbol: 'NIFTY FMCG', report: 'Nifty FMCG', news: '"Nifty FMCG"', keyword: 'fmcg' },
  { symbol: 'NIFTY METAL', report: 'Nifty Metal', news: '"Nifty Metal"', keyword: 'metal' },
  { symbol: 'NIFTY REALTY', report: 'Nifty Realty', news: '"Nifty Realty"', keyword: 'realty' },
  { symbol: 'NIFTY ENERGY', report: 'Nifty Energy', news: '"Nifty Energy"', keyword: 'energy' },
  { symbol: 'NIFTY PSU BANK', report: 'Nifty PSU Bank', news: '"Nifty PSU Bank"', keyword: 'psu' },
  { symbol: 'NIFTY PRIVATE BANK', report: 'Nifty Private Bank', news: '"Nifty Private Bank"', keyword: 'bank' },
  { symbol: 'INDIA VIX', report: 'India VIX', news: '"India VIX"', keyword: 'vix' },
];

const OTHER_INDICES = [
  { symbol: 'SENSEX', yahoo: '^BSESN', name: 'BSE SENSEX', exchange: 'BSE', currency: 'INR', news: '"Sensex"', keyword: 'sensex', region: 'IN' },
  { symbol: 'S&P 500', yahoo: '^GSPC', name: 'S&P 500', exchange: 'US', currency: 'USD', news: '"S&P 500"', keyword: 's&p', region: 'US' },
  { symbol: 'DOW JONES', label: 'DOW', yahoo: '^DJI', name: 'Dow Jones Industrial Average', exchange: 'US', currency: 'USD', news: '"Dow Jones"', keyword: 'dow', region: 'US' },
  // Nasdaq's own feed repeats the previous close as the open on about 25 of 750 days, which would skew the pivot.
  { symbol: 'NASDAQ COMPOSITE', label: 'NASDAQ', yahoo: '^IXIC', name: 'NASDAQ Composite', exchange: 'NASDAQ', currency: 'USD', news: '"Nasdaq Composite" OR "Nasdaq"', keyword: 'nasdaq', region: 'US' },
];

const STRIP_SYMBOLS = ['NIFTY 50', 'NIFTY BANK', 'NIFTY FINANCIAL SERVICES', 'SENSEX', 'S&P 500', 'NASDAQ COMPOSITE', 'DOW JONES'];

// Names the financial press uses more often than the registered company name.
const PRESS_NAMES = {
  SBIN: 'SBI',
  HINDUNILVR: 'HUL',
  LT: 'L&T',
  'M&M': 'M&M',
  TCS: 'TCS',
  RELIANCE: 'RIL',
  ITC: 'ITC',
  BEL: 'Bharat Electronics',
  HAL: 'HAL',
  ONGC: 'ONGC',
  NTPC: 'NTPC',
  DRREDDY: 'Dr Reddy',
  IRFC: 'IRFC',
  MOTHERSON: 'Motherson',
  LTM: 'LTIMindtree',
  TMPV: 'Tata Motors',
};

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const toDay = (iso) => Date.parse(iso) / DAY_MS;
const isoDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

function datesBetween(fromIso, toIsoDay) {
  const dates = [];
  for (let time = Date.parse(fromIso); time <= Date.parse(toIsoDay); time += DAY_MS) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

const isPossible = ({ open, high, low, close }) =>
  low <= high && open >= low && open <= high && close >= low && close <= high;

let rejectedRows = 0;

// A row no market could have produced is dropped rather than turned into a wrong pivot.
function keepPossible(sessions) {
  const kept = sessions.filter(isPossible);
  rejectedRows += sessions.length - kept.length;
  return { kept, rejected: sessions.filter((session) => !isPossible(session)).map((session) => session.date) };
}

function seriesFields(sessions, extraKeys = {}) {
  const fields = {
    days: sessions.map((session) => toDay(session.date)),
    o: sessions.map((session) => session.open),
    h: sessions.map((session) => session.high),
    l: sessions.map((session) => session.low),
    c: sessions.map((session) => session.close),
  };
  for (const [field, key] of Object.entries(extraKeys)) {
    fields[field] = sessions.map((session) => session[key] ?? null);
  }
  return fields;
}

const companyShortName = (name) => name.replace(/\s+(limited|ltd\.?)$/i, '').replace(/\s+\(india\)$/i, '').trim();

// Exchange files often give names in capitals, which read better as ordinary names.
function readableName(name) {
  const trimmed = String(name).trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .replace(/(^|[\s(&/-])([a-z])/g, (whole, before, letter) => before + letter.toUpperCase())
    .replace(/\b(Ltd|Pvt)\b\.?/g, (word) => word.replace(/\.$/, ''));
}

function stockNewsTerms(symbol, shortName) {
  const press = PRESS_NAMES[symbol];
  const firstWords = shortName.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
  const query = press && press !== shortName ? `("${shortName}" OR "${press}")` : `"${shortName}"`;
  return {
    query: `${query} (share OR stock)`,
    isRelevant: (title) => {
      const lower = title.toLowerCase();
      return lower.includes(firstWords) || lower.includes(symbol.toLowerCase()) || Boolean(press && lower.includes(press.toLowerCase()));
    },
  };
}

// What this instrument had last time, so that a failing source doesn't blank it out.
function previousOf(symbol) {
  const saved = readCache(`${SITE_FOLDER}/i/${instrumentFile(symbol)}`);
  return saved ? JSON.parse(saved) : null;
}

async function readNseCalendar(fromIso, toIsoDay) {
  const dates = datesBetween(fromIso, toIsoDay);
  log(`Reading NSE's index report for ${dates.length} calendar days…`);
  const reports = await mapPool(dates, 3, 60, async (date) => ({ date, rows: await fetchIndexReport(date) }));
  return reports.filter((report) => report.rows?.length);
}

async function readPriceAvailability(indexReports) {
  log(`Checking NSE's price report for ${indexReports.length} trading days…`);
  const checks = await mapPool(indexReports, 3, 60, async ({ date }) => ({ date, rows: (await hasPriceReport(date)) ? [] : null }));
  const { ready, late } = separateLateReports(checks);
  if (late.length) log(`NSE hasn't published prices for ${late.join(', ')} yet, so they wait for the next update.`);
  return new Set(ready.map((report) => report.date));
}

async function readNseStocks(tradingDays, targets, resolveSymbol) {
  const sessions = new Map();
  for (const date of tradingDays) {
    addStockSessions(sessions, date, await fetchPriceReport(date), targets, resolveSymbol);
  }
  return sessions;
}

async function readBseOnlyStocks(tradingDays, nseIsins) {
  log('Checking BSE price files…');
  const checks = await mapPool(tradingDays, 3, 80, async (date) => ({ date, ok: await hasBseReport(date) }));
  const days = checks.filter(({ ok }) => ok).map(({ date }) => date);
  if (!days.length) return { days, sessions: new Map(), companies: new Map() };

  const companies = new Map();
  for (const row of await fetchBseRows(days.at(-1))) {
    if (!nseIsins.has(row.isin)) companies.set(row.code, row);
  }
  const sessions = new Map();
  for (const date of days) {
    for (const row of await fetchBseRows(date)) {
      if (!companies.has(row.code) || !row.open || !row.high || !row.low || !row.close) continue;
      if (!sessions.has(row.code)) sessions.set(row.code, []);
      sessions.get(row.code).push({ date, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
    }
  }
  return { days, sessions, companies };
}

async function readExchangeNotices(tradingDays, targets) {
  const recent = tradingDays.slice(-FILING_DAYS);
  const bundles = await mapPool(recent, 2, 100, async (date) => ({ date, bundle: await fetchDailyBundle(date) }));
  const available = bundles.filter(({ bundle }) => bundle);
  if (!available.length) {
    log('No NSE daily bundle could be read, so filings and market caps stay as they were.');
    return null;
  }
  const latest = available.at(-1);
  const today = new Date().toISOString().slice(0, 10);
  const groupBySymbol = (items) => {
    const grouped = new Map();
    for (const item of items) {
      if (!grouped.has(item.symbol)) grouped.set(item.symbol, []);
      grouped.get(item.symbol).push(item);
    }
    return grouped;
  };
  return {
    filings: groupBySymbol(available.flatMap(({ date, bundle }) => parseAnnouncements(bundle.announcements, date, targets))),
    corporateActions: groupBySymbol(parseCorporateActions(latest.bundle.corporateActions, today, targets)),
    boardMeetings: groupBySymbol(available.flatMap(({ bundle }) => parseBoardMeetings(bundle.boardMeetings, today, targets))),
    marketCaps: parseMarketCaps(latest.bundle.marketCaps, targets),
    smeNames: parseSmeNames(latest.bundle.smeList),
  };
}

async function readFinancials(symbols) {
  const financials = new Map();
  for (const symbol of symbols) {
    try {
      financials.set(symbol, await fetchFinancials(symbol));
    } catch (error) {
      if (error instanceof RateLimited) {
        log(`Yahoo is rate-limiting, so financials stop after ${financials.size} of ${symbols.length} companies.`);
        break;
      }
      log(`Financials unavailable for ${symbol}: ${error.message}`);
    }
    await pauseAfterNetwork(500);
  }
  return financials;
}

async function readHeadlines(requests) {
  log(`Reading headlines for ${requests.length} instruments…`);
  const headlines = new Map();
  let failuresInARow = 0;
  for (const request of requests) {
    // Past a few failures in a row the source is refusing, so everything left keeps its earlier headlines.
    if (failuresInARow >= NEWS_FAILURE_LIMIT) break;
    try {
      headlines.set(request.key, await fetchHeadlines(request));
      failuresInARow = 0;
    } catch (error) {
      failuresInARow++;
      log(`Headlines failed for ${request.key}: ${error.message}`);
    }
    await pauseAfterNetwork(700);
  }
  log(`Read headlines for ${headlines.size} of ${requests.length}.`);
  return headlines;
}

async function readIpos(sessionsOf, actionsOf, today) {
  const cutoff = new Date(Date.parse(today) - IPO_HISTORY_DAYS * DAY_MS).toISOString().slice(0, 10);
  const [past, open, upcoming, rhpFiled, draftsFiled] = await Promise.all([
    fetchPastIssues(),
    fetchOpenIssues(),
    fetchUpcomingIssues(),
    fetchSebiList(SEBI_RHP_LIST),
    fetchSebiList(SEBI_DRAFT_LIST),
  ]);

  const recent = past.filter((issue) => issue.end && issue.end >= cutoff).sort((a, b) => (b.listingDate ?? b.end).localeCompare(a.listingDate ?? a.end));
  log(`IPOs: ${open.length} open and ${upcoming.length} upcoming on NSE, ${recent.length} in the last year, ${past.length} on record.`);

  const withDetail = await mapPool([...open, ...upcoming, ...recent], 1, 250, async (issue) => {
    try {
      return { ...issue, detail: await fetchIssueDetail(issue) };
    } catch (error) {
      log(`IPO details unavailable for ${issue.symbol}: ${error.message}`);
      return { ...issue, detail: null };
    }
  });
  const openCount = open.length;
  const upcomingCount = upcoming.length;
  const recentWithFigures = withDetail.slice(openCount + upcomingCount).map((issue) => ({
    ...issue,
    performance: listingPerformance(issue, sessionsOf(issue.symbol), actionsOf(issue.symbol)),
  }));

  // A SEBI filing is only "still ahead" until NSE's records show the company's issue.
  const onRecord = new Map(past.map((issue) => [normaliseCompany(issue.name), issue]));
  const withStatus = (filing) => {
    const issue = onRecord.get(normaliseCompany(filing.company));
    return {
      ...filing,
      symbol: issue?.symbol ?? null,
      listingDate: issue?.listingDate ?? null,
      cancelled: issue?.cancelled ?? null,
      closed: Boolean(issue && !issue.listingDate),
    };
  };

  const headlines = await fetchHeadlines({
    key: 'IPO-market',
    query: 'IPO India (subscription OR listing OR "price band" OR DRHP)',
    isRelevant: (title) => /\bipo\b/i.test(title),
    limit: IPO_HEADLINES,
  }).catch((error) => {
    log(`IPO headlines unavailable: ${error.message}`);
    return null;
  });

  return {
    asOf: today,
    open: withDetail.slice(0, openCount),
    upcoming: withDetail.slice(openCount, openCount + upcomingCount),
    recent: recentWithFigures,
    summary: summariseListings(recentWithFigures),
    rhpFiled: rhpFiled.map(withStatus),
    draftsFiled: draftsFiled.map(withStatus),
    news: headlines,
    totalOnRecord: past.length,
  };
}

const today = new Date().toISOString().slice(0, 10);
const fromIso = new Date(Date.now() - Math.round(YEARS * 365.25) * DAY_MS).toISOString().slice(0, 10);

const previousMeta = JSON.parse(readCache(`${SITE_FOLDER}/meta.json`) ?? 'null');

pruneFolders('news', today);
pruneFolders('yahoo/charts', today);
pruneFolders('nse/lists', today);
pruneFolders('nse/ipo-live', today);
pruneFolders('yahoo/financials', financialsPeriod());
clearCacheFolder(NEXT_FOLDER);
mkdirSync(new URL(`../.cache/${NEXT_FOLDER}/i/`, import.meta.url), { recursive: true });

const [nifty500, totalMarket, equityList, symbolChanges] = await Promise.all([
  fetchNifty500List(),
  fetchTotalMarketList(),
  fetchEquityList(),
  fetchSymbolChanges(),
]);
const listings = new Map(equityList.map((row) => [row.SYMBOL, row]));
const nseIsins = new Set(equityList.map((row) => row['ISIN NUMBER']));
const sectors = new Map(totalMarket.map((row) => [row.Symbol, row]));
const tierOne = new Map(nifty500.map((row) => [row.Symbol, row]));
if (listings.size < 1500 || tierOne.size < 400) throw new Error(`Unexpected NSE lists: ${listings.size} listed, ${tierOne.size} in the NIFTY 500`);

const allIndexReports = await readNseCalendar(fromIso, today);
const readyDays = await readPriceAvailability(allIndexReports);
const indexReports = allIndexReports.filter((report) => readyDays.has(report.date));
const tradingDays = indexReports.map((report) => report.date);
const latestDay = tradingDays.at(-1);
log(`NSE data runs from ${tradingDays[0]} to ${latestDay} across ${tradingDays.length} trading days.`);

// The price report is the only list of SME stocks, which NSE's main listing file leaves out.
const latestRows = await fetchPriceReport(latestDay);
const smeSymbols = new Set(latestRows.filter((row) => SME_SERIES.has(row.SERIES)).map((row) => row.SYMBOL));
const targets = new Set([...listings.keys(), ...smeSymbols]);
const stockSessions = await readNseStocks(tradingDays, targets, createSymbolResolver(symbolChanges));
log(`Read NSE prices for ${stockSessions.size} stocks (${smeSymbols.size} on the SME platform).`);

// Before NSE publishes its reports, today's close comes from its live data. Official reports replace it later.
let provisionalDay = null;
const live = await fetchLiveSnapshot();
if (live && live.date > latestDay) {
  provisionalDay = live.date;
  let liveStocks = 0;
  for (const [symbol, row] of live.stocks) {
    const sessions = stockSessions.get(symbol);
    if (!sessions?.length || sessions.at(-1).date >= live.date) continue;
    sessions.push({ date: live.date, ...row, delivery: null });
    liveStocks++;
  }
  log(`NSE hasn't published ${live.date} reports yet, so its live close is used for ${liveStocks} stocks and ${live.indices.size} indices.`);
}

const bse = await readBseOnlyStocks(tradingDays, nseIsins);
log(`Read BSE prices for ${bse.sessions.size} companies not on NSE's main board, across ${bse.days.length} days.`);

const notices = await readExchangeNotices(tradingDays, targets);
const peReport = (await fetchPeReport(latestDay)) ?? [];
const peBySymbol = new Map(peReport.map((row) => [row.SYMBOL, row]));
log(`Read P/E for ${peReport.length} NSE stocks.`);

const financials = await readFinancials([...tierOne.keys()]);
log(`Read financials for ${financials.size} companies.`);

const yahooCharts = new Map();
for (const index of OTHER_INDICES) {
  try {
    yahooCharts.set(index.symbol, await fetchChart(index.yahoo, fromIso));
  } catch (error) {
    log(`Keeping earlier ${index.symbol} prices: ${error.message}`);
  }
  await pauseAfterNetwork(1000);
}

const shortNameOf = (symbol) => companyShortName(listings.get(symbol)?.['NAME OF COMPANY'] ?? tierOne.get(symbol)?.['Company Name'] ?? symbol);
const stockNews = [...tierOne.keys()].filter((symbol) => targets.has(symbol)).map((symbol) => ({ key: symbol, ...stockNewsTerms(symbol, shortNameOf(symbol)) }));
const keywordRelevance = (keyword) => (title) => title.toLowerCase().includes(keyword);
const indexNews = [...NSE_INDICES, ...OTHER_INDICES].map((index) => ({
  key: index.symbol,
  query: index.news,
  region: index.region ?? 'IN',
  isRelevant: keywordRelevance(index.keyword),
}));
const headlines = await readHeadlines([...indexNews, ...stockNews]);

const list = [];
const incomplete = [];
const strip = [];
const allActions = new Map();
let latestNseDay = 0;

function saveInstrument(item) {
  if (!hasCompletePrices(item)) {
    incomplete.push(item.symbol);
    return;
  }
  writeCache(`${NEXT_FOLDER}/i/${instrumentFile(item.symbol)}`, JSON.stringify(item));
  list.push([item.symbol, item.name, item.type, item.exchange, item.label ?? '']);
  if (item.exchange === 'NSE') latestNseDay = Math.max(latestNseDay, item.days.at(-1));
  if (STRIP_SYMBOLS.includes(item.symbol)) {
    const close = item.c.at(-1);
    const before = item.c.at(-2);
    strip.push({
      symbol: item.symbol,
      label: item.label ?? item.name.replace(/^BSE /, ''),
      close,
      changePercent: before ? round(((close - before) / before) * 100, 2) : null,
      currency: item.currency,
    });
  }
}

for (const index of NSE_INDICES) {
  const official = collectIndexSessions(indexReports, index.report);
  const liveRow = provisionalDay && live.indices.get(index.report.toLowerCase());
  if (liveRow) official.push({ date: provisionalDay, ...liveRow });
  const { kept: sessions } = keepPossible(official);
  if (!sessions.length) throw new Error(`NSE's report has no rows for ${index.report}`);
  saveInstrument({
    symbol: index.symbol,
    label: index.label,
    name: index.symbol,
    type: 'Index',
    exchange: 'NSE',
    currency: 'INR',
    source: 'nse',
    decimals: 2,
    ...seriesFields(sessions, { pe: 'pe', pb: 'pb', dy: 'dy' }),
    actions: [],
    news: headlines.get(index.symbol) ?? previousOf(index.symbol)?.news ?? [],
    newsUrl: newsSearchUrl(index.news),
    officialUrl: 'https://www.niftyindices.com/reports/historical-data',
  });
}

for (const index of OTHER_INDICES) {
  const chart = yahooCharts.get(index.symbol);
  const before = previousOf(index.symbol);
  const news = headlines.get(index.symbol) ?? before?.news ?? [];
  if (!chart) {
    if (!before) throw new Error(`No prices available for ${index.symbol}`);
    saveInstrument({ ...before, news });
    continue;
  }
  const { kept: sessions, rejected } = keepPossible(completedSessions(chart));
  saveInstrument({
    symbol: index.symbol,
    label: index.label,
    name: index.name,
    type: 'Index',
    exchange: index.exchange,
    currency: index.currency,
    source: 'yahoo',
    decimals: chart.meta.priceHint ?? 2,
    ...seriesFields(sessions),
    gaps: [...missingDays(chart), ...rejected],
    actions: [],
    news,
    newsUrl: newsSearchUrl(index.news, index.region),
  });
}

for (const symbol of targets) {
  const { kept: sessions } = keepPossible(stockSessions.get(symbol) ?? []);
  if (!sessions.length) continue;
  const listing = listings.get(symbol);
  const isTierOne = tierOne.has(symbol);
  const before = isTierOne || !notices ? previousOf(symbol) : null;
  const name = readableName(listing?.['NAME OF COMPANY'] ?? notices?.smeNames.get(symbol) ?? tierOne.get(symbol)?.['Company Name'] ?? symbol);
  const pe = peBySymbol.get(symbol);
  const cap = notices?.marketCaps.get(symbol);
  const actions = detectPriceActions(sessions);
  if (actions.length) allActions.set(symbol, actions);
  const byDate = (a, b) => b.date.localeCompare(a.date);
  const sector = sectors.get(symbol)?.Industry ?? tierOne.get(symbol)?.Industry ?? null;
  const shortName = companyShortName(name);
  saveInstrument({
    symbol,
    name,
    type: 'Stock',
    exchange: 'NSE',
    board: smeSymbols.has(symbol) ? 'SME' : 'Main board',
    currency: 'INR',
    source: 'nse',
    decimals: 2,
    ...seriesFields(sessions, { vol: 'volume', del: 'delivery' }),
    actions,
    profile: {
      asOf: latestDay,
      industry: sector,
      isin: listing?.['ISIN NUMBER'] ?? null,
      listed: listing ? toIsoDate(listing['DATE OF LISTING'] ?? '') : null,
      faceValue: cap?.faceValue ?? toNumber(listing?.['FACE VALUE'] ?? ''),
      marketCap: cap?.marketCap ?? before?.profile?.marketCap ?? null,
      shares: cap?.shares ?? before?.profile?.shares ?? null,
      // A blank P/E in NSE's report means the company has none, so the old one is kept only if the report itself is missing.
      pe: peReport.length ? toNumber(pe?.['SYMBOL P/E'] ?? '') : before?.profile?.pe ?? null,
      adjustedPe: peReport.length ? toNumber(pe?.['ADJUSTED P/E'] ?? '') : before?.profile?.adjustedPe ?? null,
    },
    nifty500: tierOne.has(symbol) || undefined,
    financials: financials.get(symbol) ?? before?.financials ?? [],
    filings: notices
      ? (notices.filings.get(symbol) ?? []).sort(byDate).slice(0, MAX_FILINGS).map(({ date, category, text }) => ({ date, category, text }))
      : before?.filings ?? [],
    upcoming: notices
      ? [
          ...(notices.boardMeetings.get(symbol) ?? []).map(({ date, purpose }) => ({ date, kind: 'Board meeting', text: purpose })),
          ...(notices.corporateActions.get(symbol) ?? []).map(({ date, purpose }) => ({ date, kind: 'Ex-date', text: purpose })),
        ].sort((a, b) => a.date.localeCompare(b.date))
      : (before?.upcoming ?? []).filter((event) => event.date >= today),
    news: headlines.get(symbol) ?? before?.news ?? [],
    newsUrl: newsSearchUrl(`"${shortName}" (share OR stock)`),
    officialUrl: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
  });
}
const nseStockCount = list.filter(([, , type]) => type === 'Stock').length;

for (const [code, company] of bse.companies) {
  const { kept: sessions } = keepPossible(bse.sessions.get(code) ?? []);
  if (!sessions.length) continue;
  const name = readableName(company.name);
  const symbol = `BSE:${company.symbol}`;
  saveInstrument({
    symbol,
    name,
    type: 'Stock',
    exchange: 'BSE',
    board: company.group === 'M' || company.group === 'MT' || company.group === 'MS' ? 'SME' : 'Main board',
    currency: 'INR',
    source: 'bse',
    decimals: 2,
    ...seriesFields(sessions, { vol: 'volume' }),
    actions: detectPriceActions(sessions),
    profile: { asOf: bse.days.at(-1), isin: company.isin, group: company.group, code },
    financials: [],
    filings: [],
    upcoming: [],
    news: [],
    newsUrl: newsSearchUrl(`"${companyShortName(name)}" (share OR stock)`),
    officialUrl: bsePageUrl(company.name, company.symbol, code),
  });
}

const stockEntries = list.filter(([, , type]) => type === 'Stock');
const indexCount = list.length - stockEntries.length;
const bseCount = stockEntries.length - nseStockCount;
const meta = {
  builtOn: today,
  coverage: `${stockEntries.length.toLocaleString('en-IN')} stocks and ${indexCount} indices`,
  counts: { nse: nseStockCount, sme: smeSymbols.size, bse: bseCount, indices: indexCount },
  calendars: { NSE: [...tradingDays, ...(provisionalDay ? [provisionalDay] : [])].map(toDay), BSE: bse.days.map(toDay) },
  newsCoverage: 'NIFTY 500',
  list,
  strip: STRIP_SYMBOLS.map((symbol) => strip.find((item) => item.symbol === symbol)).filter(Boolean),
  latestNseDay,
  provisionalDay,
};

let ipos = null;
try {
  ipos = await readIpos(
    (symbol) => stockSessions.get(symbol),
    (symbol) => allActions.get(symbol) ?? [],
    today,
  );
} catch (error) {
  log(`IPO data unavailable, so the page keeps what it had: ${error.message}`);
  ipos = JSON.parse(readCache(`${SITE_FOLDER}/ipos.json`) ?? 'null');
}
if (ipos) {
  const previousIpos = JSON.parse(readCache(`${SITE_FOLDER}/ipos.json`) ?? 'null');
  ipos.news = ipos.news ?? previousIpos?.news ?? [];
  writeCache(`${NEXT_FOLDER}/ipos.json`, JSON.stringify(ipos));
}

const requiredSymbols = [...NSE_INDICES, ...OTHER_INDICES].map((index) => index.symbol);
const problems = findDatasetProblems(
  { stockCount: stockEntries.length, symbols: new Set(list.map(([symbol]) => symbol)), incomplete, latestNseDay },
  previousMeta?.latestNseDay ?? null,
  requiredSymbols,
  today,
);
if (problems.length) throw new Error(`Not publishing this update: ${problems.join('; ')}`);
writeCache(`${NEXT_FOLDER}/meta.json`, JSON.stringify(meta));
replaceCacheFolder(NEXT_FOLDER, SITE_FOLDER);

log(meta.coverage);
log(`NSE stocks ${nseStockCount} (SME ${smeSymbols.size}), BSE-only ${bseCount}, indices ${indexCount}.`);
log(`Latest NSE session: ${isoDay(latestNseDay)}. Impossible rows rejected: ${rejectedRows}.`);
const inNifty500 = [...allActions].filter(([symbol]) => tierOne.has(symbol));
log(`Corporate actions: ${[...allActions.values()].flat().length} across ${allActions.size} NSE stocks. In the NIFTY 500: ${inNifty500.flatMap(([symbol, actions]) => actions.map((action) => `${symbol} ${action.date} x${round(action.factor, 3)}`)).join('; ')}`);
log(`IPOs: ${ipos ? `${ipos.recent.length} in the last year, median main-board listing gain ${ipos.summary.mainBoard.medianGain}%` : 'none available'}.`);
log('Done.');
