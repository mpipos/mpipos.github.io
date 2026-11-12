import test from 'node:test';
import assert from 'node:assert/strict';
import { candlesFor, createMarket, groupBars, instrumentFile } from '../lib/market.js';
import { collectMovers } from '../lib/movers.js';
import { findDatasetProblems, hasCompletePrices, separateLateReports } from '../scripts/dataset-checks.js';
import { bsePageUrl, parseBseRows } from '../scripts/sources/bse.js';
import {
  listingPerformance,
  normaliseCompany,
  parseIpoDetail,
  parseLiveIssues,
  parsePastIssues,
  parsePriceBand,
  splitIssueName,
  summariseListings,
} from '../scripts/sources/ipo.js';
import { parseSebiList, splitFilingTitle } from '../scripts/sources/sebi.js';
import { closedSessionDate, parseLiveIndices, parseLiveStocks } from '../scripts/sources/nse-live.js';
import { pivotPoint } from '../lib/pivot.js';
import { decodeEntities, parseHeadlines } from '../scripts/sources/news.js';
import {
  collectIndexSessions,
  collectStockSessions,
  createSymbolResolver,
  detectPriceActions,
  parseAnnouncements,
  parseBoardMeetings,
  parseCorporateActions,
  parseCsv,
  parseMarketCaps,
  parseSmeNames,
  reportsOnlyThisDate,
  toIsoDate,
  toNumber,
} from '../scripts/sources/nse.js';
import { completedSessions, missingDays, parseFinancials } from '../scripts/sources/yahoo.js';

const seconds = (iso) => Date.parse(iso) / 1000;
const day = (iso) => Date.parse(iso) / 86_400_000;

test('pivot is (open + high + close) / 3 and ignores the low', () => {
  assert.equal(pivotPoint({ open: 10, high: 20, low: 1, close: 30 }), 20);
  assert.equal(pivotPoint({ open: 10, high: 20, low: 9999, close: 30 }), 20);
});

/* NSE reports */

test('reads NSE dates in all the forms its reports use', () => {
  assert.equal(toIsoDate('04-Nov-2026'), '2026-11-04');
  assert.equal(toIsoDate('05-JAN-2026'), '2026-01-05');
  assert.equal(toIsoDate('04-11-2026'), '2026-11-04');
  assert.equal(toIsoDate('04 NOV 2026'), '2026-11-04');
  assert.equal(toIsoDate('-'), null);
});

test('reads CSV with quoted commas and padded cells', () => {
  const rows = parseCsv('SYMBOL, NAME\nABC, "Alpha, Beta Ltd"\n\n');
  assert.deepEqual(rows, [{ SYMBOL: 'ABC', NAME: 'Alpha, Beta Ltd' }]);
});

test('treats a dash or blank as no number', () => {
  assert.equal(toNumber('-'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('.63'), 0.63);
});

test('rejects a price report whose rows belong to another day', () => {
  // NSE answers a holiday's URL with another day's prices.
  const header = 'SYMBOL, SERIES, DATE1, PREV_CLOSE\n';
  assert.equal(reportsOnlyThisDate(`${header}ABC, EQ, 04-Nov-2025, 10\n`, '2025-11-05'), false);
  assert.equal(reportsOnlyThisDate(`${header}ABC, EQ, 05-Nov-2025, 10\n`, '2025-11-05'), true);
  assert.equal(reportsOnlyThisDate('<html>', '2025-11-05'), false);
});

const CHANGES = [
  { 'OLD SYMBOL': 'ZOMATO', 'NEW SYMBOL': 'ETERNAL', 'EFFECTIVE DATE': '09-APR-2025' },
  { 'OLD SYMBOL': 'AAA', 'NEW SYMBOL': 'BBB', 'EFFECTIVE DATE': '01-JAN-2024' },
  { 'OLD SYMBOL': 'BBB', 'NEW SYMBOL': 'CCC', 'EFFECTIVE DATE': '01-JAN-2025' },
];

test('follows a renamed ticker only for dates before the change', () => {
  const resolve = createSymbolResolver(CHANGES);
  assert.equal(resolve('ZOMATO', '2025-04-08'), 'ETERNAL');
  assert.equal(resolve('ZOMATO', '2025-04-09'), 'ZOMATO');
  assert.equal(resolve('AAA', '2023-06-01'), 'CCC');
  assert.equal(resolve('RELIANCE', '2023-06-01'), 'RELIANCE');
});

const priceRow = (symbol, series, close) => ({
  SYMBOL: symbol,
  SERIES: series,
  OPEN_PRICE: '100',
  HIGH_PRICE: '110',
  LOW_PRICE: '90',
  CLOSE_PRICE: String(close),
  TTL_TRD_QNTY: '500',
  DELIV_PER: '-',
});

test('joins a renamed stock into one history, preferring the EQ series', () => {
  const sessions = collectStockSessions(
    [
      { date: '2025-04-08', rows: [priceRow('ZOMATO', 'EQ', 101), priceRow('OTHER', 'EQ', 5)] },
      { date: '2025-04-09', rows: [priceRow('ETERNAL', 'BE', 999), priceRow('ETERNAL', 'EQ', 102), priceRow('ETERNAL', 'N1', 1)] },
    ],
    new Set(['ETERNAL']),
    createSymbolResolver(CHANGES),
  );
  assert.deepEqual(sessions.get('ETERNAL').map((s) => s.close), [101, 102]);
  assert.equal(sessions.get('ETERNAL')[0].delivery, null);
});

test('skips a price row with a missing price', () => {
  const sessions = collectStockSessions(
    [{ date: '2025-01-01', rows: [{ ...priceRow('ABC', 'EQ', 1), HIGH_PRICE: '-' }] }],
    new Set(['ABC']),
    (symbol) => symbol,
  );
  assert.equal(sessions.has('ABC'), false);
});

test('finds corporate actions from overnight falls, using a clean ratio where one fits', () => {
  const actionsFor = (close, open) => detectPriceActions([{ date: '2024-10-25', close }, { date: '2024-10-28', open }]);
  // Real cases from NSE's reports.
  assert.deepEqual(actionsFor(2655.7, 1337), [{ date: '2024-10-28', factor: 0.5 }]); // Reliance 1:1 bonus
  assert.deepEqual(actionsFor(9331, 956), [{ date: '2024-10-28', factor: 0.1 }]); // Bajaj Finance split and bonus
  assert.deepEqual(actionsFor(709.4, 148.2), [{ date: '2024-10-28', factor: 0.2 }]); // Adani Power 4:1 split
  assert.equal(actionsFor(4257.6, 2830)[0].factor, Number((2 / 3).toFixed(6))); // Trent 1:2 bonus
  assert.equal(actionsFor(773.6, 289.5)[0].factor, Number((289.5 / 773.6).toFixed(6))); // Vedanta demerger keeps its own gap
  // Real market falls aren't corporate actions.
  assert.deepEqual(actionsFor(871.55, 697.25), []); // Adani Energy, 21 Nov 2024
  assert.deepEqual(actionsFor(3210.35, 2728.45), []); // BSE, 29 Apr 2024
  assert.deepEqual(actionsFor(755.8, 870), []);
});

test('reads an index under any capitalisation, with its valuation ratios', () => {
  const report = {
    date: '2026-11-04',
    rows: [
      {
        'Index Name': 'NIFTY Midcap 100',
        'Open Index Value': '10',
        'High Index Value': '12',
        'Low Index Value': '9',
        'Closing Index Value': '11',
        'P/E': '20.5',
        'P/B': '-',
        'Div Yield': '1.1',
      },
    ],
  };
  const [session] = collectIndexSessions([report], 'Nifty Midcap 100');
  assert.equal(session.close, 11);
  assert.equal(session.pe, 20.5);
  assert.equal(session.pb, null);
  assert.deepEqual(collectIndexSessions([{ ...report, rows: [{ ...report.rows[0], 'Open Index Value': '-' }] }], 'NIFTY Midcap 100'), []);
});

test('reads filings, skipping routine notices and other companies', () => {
  const text = [
    'COMPANY NAME    SYMBOL    : ANNOUNCEMENTS',
    'Tata Consultancy Services Limited TCS : Copy of Newspaper Publication TCS : Tata Consultancy Services Limited has informed the Exchange about Copy of Newspaper Publication',
    "Tata Consultancy Services Limited TCS : Updates TCS : Tata Consultancy Services Limited has informed the Exchange regarding 'Press Release'.",
    'Kuantum Papers Limited KUANTUM : Updates KUANTUM : Kuantum Papers Limited has informed the Exchange.',
  ].join('\n');
  assert.deepEqual(parseAnnouncements(text, '2026-11-04', new Set(['TCS'])), [
    { symbol: 'TCS', date: '2026-11-04', category: 'Updates', text: 'Press Release' },
  ]);
});

test('drops filing text that only repeats the category', () => {
  const line = 'Reliance Industries Limited RELIANCE : Investor Presentation RELIANCE : Reliance Industries Limited has informed the Exchange about Investor Presentation';
  assert.equal(parseAnnouncements(line, '2026-11-02', new Set(['RELIANCE']))[0].text, '');
});

test('reads only upcoming board meetings and corporate actions', () => {
  const meetings = 'COMPANY NAME    SYMBOL     : BM DATE    : BM PURPOSE\nCantabil Retail India Limited CANTABIL : 12-NOV-2026 : Financial Results CANTABIL : 13-Nov-2026 :  Rescheduled\nOld Co Limited OLD : 01-NOV-2026 : Dividend';
  assert.deepEqual(parseBoardMeetings(meetings, '2026-11-05', new Set(['CANTABIL', 'OLD'])), [
    { symbol: 'CANTABIL', date: '2026-11-12', purpose: 'Financial Results' },
  ]);
  const actions = 'SERIES,SYMBOL,SECURITY,RECORD_DT,BC_STRT_DT,BC_END_DT,EX_DT,ND_STRT_DT,ND_END_DT,PURPOSE\nEQ,POWERGRID,Power Grid,2026-11-06,,,2026-11-06,,,INTERIM DIVIDEND - RS 3 PER SHARE\nN1,POWERGRID,Bond,2026-11-06,,,2026-11-06,,,INTEREST PAYMENT\nEQ,POWERGRID,Power Grid,2026-01-01,,,2026-01-01,,,OLD';
  assert.deepEqual(parseCorporateActions(actions, '2026-11-05', new Set(['POWERGRID'])), [
    { symbol: 'POWERGRID', date: '2026-11-06', purpose: 'INTERIM DIVIDEND - RS 3 PER SHARE' },
  ]);
});

test('reads market cap from the padded EQ row', () => {
  const text = 'Trade Date,Symbol,Series,Security Name,Category,Last Trade Date,Face Value(Rs.),Issue Size,Close Price/Paid up value(Rs.),Market Cap(Rs.)              \n04 NOV 2026,RELIANCE,EQ,RELIANCE INDUSTRIES LTD  ,Listed    ,04 NOV 2026,               10.00,       13532538722,           1311.00, 17741158264542.00  ';
  assert.deepEqual(parseMarketCaps(text, new Set(['RELIANCE'])).get('RELIANCE'), {
    marketCap: 17741158264542,
    shares: 13532538722,
    faceValue: 10,
  });
});

/* Yahoo */

function yahooChart({ bars, gmtoffset = 19800, regular, priceHint = 2 }) {
  return {
    meta: { priceHint, gmtoffset, currentTradingPeriod: regular && { regular } },
    timestamp: bars.map((bar) => seconds(bar.at)),
    indicators: {
      quote: [
        {
          open: bars.map((bar) => (bar.blank ? null : bar.open ?? 100)),
          high: bars.map((bar) => (bar.blank ? null : bar.high ?? 110)),
          low: bars.map((bar) => (bar.blank ? null : bar.low ?? 90)),
          close: bars.map((bar) => (bar.blank ? null : bar.close ?? 105)),
        },
      ],
    },
  };
}

const LATER = seconds('2026-12-01T00:00:00Z');

test('cleans float noise out of Yahoo prices', () => {
  const chart = yahooChart({ bars: [{ at: '2025-11-03T03:45:00Z', open: 25696.849609375, high: 25803.099609375, low: 25645.5, close: 25763.349609375 }] });
  assert.deepEqual(completedSessions(chart, LATER), [{ date: '2025-11-03', open: 25696.85, high: 25803.1, low: 25645.5, close: 25763.35 }]);
});

test('uses the exchange’s local date, not the UTC date', () => {
  // Sydney opens at 10:00 AEDT, which is 23:00 UTC on the previous day.
  const chart = yahooChart({ bars: [{ at: '2025-11-02T23:00:00Z' }], gmtoffset: 39600 });
  assert.equal(completedSessions(chart, LATER)[0].date, '2025-11-03');
});

test('leaves an unfinished session out of stored prices', () => {
  const regular = { start: seconds('2026-11-05T03:45:00Z'), end: seconds('2026-11-05T10:00:00Z') };
  const chart = yahooChart({ bars: [{ at: '2026-11-04T03:45:00Z' }, { at: '2026-11-05T03:45:00Z' }], regular });
  const dates = (now) => completedSessions(chart, seconds(now)).map((session) => session.date);
  assert.deepEqual(dates('2026-11-05T06:36:00Z'), ['2026-11-04']);
  assert.deepEqual(dates('2026-11-05T10:00:00Z'), ['2026-11-04', '2026-11-05']);
});

test('treats a flat bar as missing, because it repeats the last close', () => {
  const chart = yahooChart({ bars: [{ at: '2025-03-17T03:45:00Z' }, { at: '2025-03-18T03:45:00Z', open: 1238.85, high: 1238.85, low: 1238.85, close: 1238.85 }] });
  assert.deepEqual(completedSessions(chart, LATER).map((session) => session.date), ['2025-03-17']);
  assert.deepEqual(missingDays(chart, LATER), ['2025-03-18']);
});

test('reports a blank bar as missing, unless the day has prices or is still trading', () => {
  const regular = { start: seconds('2026-11-05T03:45:00Z'), end: seconds('2026-11-05T10:00:00Z') };
  const chart = yahooChart({
    bars: [
      { at: '2026-11-03T03:45:00Z', blank: true },
      { at: '2026-11-04T03:45:00Z', blank: true },
      { at: '2026-11-04T09:00:00Z' },
      { at: '2026-11-05T03:45:00Z', blank: true },
    ],
    regular,
  });
  assert.deepEqual(missingDays(chart, seconds('2026-11-05T06:36:00Z')), ['2026-11-03']);
});

test('reads annual financials into yearly rows, newest years kept', () => {
  const point = (asOfDate, raw) => ({ asOfDate, reportedValue: { raw } });
  const rows = parseFinancials({
    timeseries: {
      result: [
        { meta: { type: ['annualTotalRevenue'] }, annualTotalRevenue: [null, point('2021-03-31', 1), point('2022-03-31', 2), point('2023-03-31', 3), point('2024-03-31', 4), point('2025-03-31', 5)] },
        { meta: { type: ['annualNetIncome'] }, annualNetIncome: [point('2025-03-31', 50)] },
      ],
    },
  });
  assert.deepEqual(rows.map((row) => row.year), ['2022-03-31', '2023-03-31', '2024-03-31', '2025-03-31']);
  assert.equal(rows.at(-1).profit, 50);
  assert.equal(rows[0].profit, null);
});

/* Guards on automatic updates */

const report = (date, ready = true) => ({ date, rows: ready ? [] : null });

test('lets the newest days wait when NSE hasn’t published them yet', () => {
  const reports = ['01', '02', '03', '04', '05'].map((d, i) => report(`2026-11-${d}`, i < 4));
  const { ready, late } = separateLateReports(reports);
  assert.equal(ready.length, 4);
  assert.deepEqual(late, ['2026-11-05']);
  assert.deepEqual(separateLateReports(reports.slice(0, 4)).late, []);
});

test('stops the update when a report is missing further back', () => {
  const old = ['01', '02', '03', '04', '05', '06'].map((d, i) => report(`2026-11-${d}`, i !== 1));
  assert.throws(() => separateLateReports(old), /2026-11-02/);
  const inside = ['01', '02', '03', '04', '05', '06'].map((d, i) => report(`2026-11-${d}`, i !== 4));
  assert.throws(() => separateLateReports(inside), /2026-11-05/);
});

function healthyDataset(latest = '2026-11-04') {
  return { stockCount: 5000, symbols: new Set(['NIFTY 50']), incomplete: [], latestNseDay: day(latest) };
}

test('accepts a healthy update', () => {
  assert.deepEqual(findDatasetProblems(healthyDataset(), day('2026-11-03'), ['NIFTY 50'], '2026-11-05'), []);
});

test('refuses an update that would damage the page', () => {
  const problemsOf = (dataset, previous = null, required = ['NIFTY 50']) => findDatasetProblems(dataset, previous, required, '2026-11-05');
  assert.match(problemsOf({ ...healthyDataset(), stockCount: 49 })[0], /only 49 stocks/);
  assert.match(problemsOf(healthyDataset(), null, ['SENSEX'])[0], /SENSEX is missing/);
  assert.match(problemsOf(healthyDataset('2026-11-03'), day('2026-11-04'))[0], /went backwards/);
  assert.match(problemsOf(healthyDataset('2026-10-01'))[0], /newest NSE data/);
  assert.match(problemsOf({ ...healthyDataset(), incomplete: ['ABC'] })[0], /ABC has incomplete prices/);
});

test('recognises a complete price history', () => {
  const series = { days: [1, 2], o: [1, 1], h: [1, 1], l: [1, 1], c: [1, 1] };
  assert.equal(hasCompletePrices(series), true);
  assert.equal(hasCompletePrices({ ...series, c: [1] }), false);
  assert.equal(hasCompletePrices({ days: [], o: [], h: [], l: [], c: [] }), false);
});

/* BSE */

const BSE_HEADER = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4';
const bseRow = (group, isin = 'INE117A01022') => `2026-11-04,2026-11-04,CM,BSE,STK,500002,${isin},ABB,${group},,,,,ABB INDIA LIMITED,6580.00,6800.45,6450.50,6754.00,6754.00,6580.70,,6750.00,,,6121,40877483.00,1458,F1,1,,,,,`;

test('reads BSE equity rows and skips bonds and funds', () => {
  const rows = parseBseRows([BSE_HEADER, bseRow('A'), bseRow('F'), bseRow('G'), bseRow('M'), ''].join('\n'));
  assert.deepEqual(rows.map((row) => row.group), ['A', 'M']);
  assert.deepEqual(rows[0], {
    code: '500002',
    isin: 'INE117A01022',
    symbol: 'ABB',
    group: 'A',
    name: 'ABB INDIA LIMITED',
    open: 6580,
    high: 6800.45,
    low: 6450.5,
    close: 6754,
    volume: 6121,
  });
});

test('builds an address BSE recognises for a company', () => {
  assert.equal(bsePageUrl('RELIANCE INDUSTRIES LTD.', 'RELIANCE', '500325'), 'https://www.bseindia.com/stock-share-price/reliance-industries-ltd/reliance/500325/');
});

/* IPOs */

test('reads a price band however NSE writes it', () => {
  assert.deepEqual(parsePriceBand('Rs.78 to Rs.82'), { low: 78, high: 82 });
  assert.deepEqual(parsePriceBand('Rs. 78/- to Rs. 82/- per Equity Share'), { low: 78, high: 82 });
  assert.deepEqual(parsePriceBand('Rs.1,960'), { low: 1960, high: 1960 });
  assert.deepEqual(parsePriceBand('-'), { low: null, high: null });
});

test('keeps only equity IPOs from NSE’s record, with clean dates and prices', () => {
  const issues = parsePastIssues([
    { companyName: 'Bombay Coated', ipoEndDate: '02-NOV-2026', ipoStartDate: '29-OCT-2026', issuePrice: '    82', listingDate: '05-NOV-2026', priceRange: 'Rs.78 to Rs.82', securityType: 'BE', symbol: 'BCSSL' },
    { companyName: 'Vedant Poly', ipoEndDate: '04-NOV-2026', ipoStartDate: '02-NOV-2026', issuePrice: '-', listingDate: '-', priceRange: 'Rs.88 to Rs.94', securityType: 'SME', symbol: 'VPFL' },
    { companyName: 'Some Bond', ipoEndDate: '04-NOV-2026', ipoStartDate: '02-NOV-2026', issuePrice: '1000', listingDate: '-', priceRange: '-', securityType: 'DEBT', symbol: 'BOND' },
    { companyName: 'Some REIT', ipoEndDate: '04-NOV-2026', ipoStartDate: '02-NOV-2026', issuePrice: '100', listingDate: '-', priceRange: '-', securityType: 'RR', symbol: 'REIT' },
  ]);
  assert.deepEqual(issues.map((issue) => issue.symbol), ['BCSSL', 'VPFL']);
  assert.deepEqual(issues[0], {
    symbol: 'BCSSL',
    name: 'Bombay Coated',
    cancelled: null,
    board: 'Main board',
    start: '2026-10-29',
    end: '2026-11-02',
    band: 'Rs.78 to Rs.82',
    bandHigh: 82,
    issuePrice: 82,
    listingDate: '2026-11-05',
  });
  assert.equal(issues[1].board, 'SME');
  assert.equal(issues[1].issuePrice, null);
  assert.equal(issues[1].listingDate, null);
});

test('separates a cancellation note from the company’s name', () => {
  assert.deepEqual(splitIssueName('Sri Priyanka Geo Commex Limited-Issue Withdrawn'), { name: 'Sri Priyanka Geo Commex Limited', cancelled: 'withdrawn' });
  assert.deepEqual(splitIssueName('IC Electricals Company Limited-Issue postponed'), { name: 'IC Electricals Company Limited', cancelled: 'postponed' });
  assert.deepEqual(splitIssueName('Rajputana Stainless Limited-Special Withdrawal Option'), { name: 'Rajputana Stainless Limited', cancelled: null });
  assert.deepEqual(splitIssueName('Bombay Coated Limited'), { name: 'Bombay Coated Limited', cancelled: null });
});

test('reads NSE’s open-issue fields', () => {
  const [issue] = parseLiveIssues([
    { symbol: 'ABC', companyName: 'Alpha Limited', series: 'EQ', issueStartDate: '05-Nov-2026', issueEndDate: '07-Nov-2026', issuePrice: 'Rs.100 to Rs.110', issueSize: '1000000', noOfTime: '2.5' },
  ]);
  assert.equal(issue.start, '2026-11-05');
  assert.equal(issue.end, '2026-11-07');
  assert.equal(issue.bandHigh, 110);
  assert.equal(issue.subscribedTimes, 2.5);
  assert.equal(issue.board, 'Main board');
});

const IPO_DETAIL = {
  issueInfo: {
    dataList: [
      { title: 'Bombay Coated', value: '' },
      { title: 'Issue Type', value: 'Book Building' },
      { title: 'Price Range', value: 'Rs. 78/- to Rs. 82/- per Equity Share' },
      { title: 'Bid Lot', value: '182 Equity Shares and in multiples thereof' },
      { title: 'Cut-off time for UPI Mandate Confirmation', value: '"02-Nov-2026 (upto 5:00 PM) The new cut-off time for UPI mandate acceptance is 05:00 PM on last day"' },
      { title: 'Maximum Subscription Amount for Retail Investor', value: '"Rs. 2,00,000"' },
      { title: 'Book Running Lead Managers', value: '<b>Smart Horizon</b>   Capital' },
      { title: 'Red Herring Prospectus', value: 'https://nsearchives.nseindia.com/content/ipo/RHP_BCSSL.zip' },
      { title: 'Anchor Allocation Report', value: 'https://evil.example.com/steal.zip' },
    ],
  },
  bidDetails: [
    { srNo: '1', category: 'Qualified Institutional Buyers(QIBs)', noOfTime: '16.428095514' },
    { srNo: '1(a)', category: 'Foreign Institutional Investors', noOfTime: null },
    { srNo: '2.1', category: 'NII above Ten Lakh', noOfTime: '90.213' },
    { srNo: '3(a)', category: 'Cut Off', noOfTime: null },
    { srNo: null, category: 'Total', noOfTime: '32.733' },
  ],
  demandGraphALL: { noOfTimesIssueSubscribed: 60.88 },
  activeCat: { updateTime: 'Updated as on 02-Nov-2026 19:00:00' },
};

test('turns an NSE IPO record into facts, subscription and safe document links', () => {
  const detail = parseIpoDetail(IPO_DETAIL);
  assert.equal(detail.facts.type, 'Book Building');
  assert.equal(detail.facts.managers, 'Smart Horizon Capital');
  assert.equal(detail.facts.retailLimit, 'Rs. 2,00,000');
  assert.equal(detail.facts.upiCutoff, '02-Nov-2026 (upto 5:00 PM)');
  assert.equal(detail.lotSize, 182);
  assert.deepEqual(detail.subscription, [
    { category: 'Qualified Institutional Buyers(QIBs)', times: 16.43 },
    { category: 'NII above Ten Lakh', times: 90.21 },
    { category: 'Total', times: 32.73 },
  ]);
  assert.equal(detail.subscribedAllExchanges, 60.88);
  // The link to another site is refused.
  assert.deepEqual(detail.documents, [{ name: 'Red herring prospectus', url: 'https://nsearchives.nseindia.com/content/ipo/RHP_BCSSL.zip' }]);
});

test('treats an empty IPO record as no record', () => {
  assert.equal(parseIpoDetail({ issueInfo: { dataList: [] }, bidDetails: [] }), null);
  assert.equal(parseIpoDetail({}), null);
});

test('works out listing gains, allowing for later splits', () => {
  const sessions = [
    { date: '2024-10-22', open: 1934, close: 1819.6 },
    { date: '2024-10-23', open: 1820, close: 1800 },
  ];
  const performance = listingPerformance({ issuePrice: 1960, listingDate: '2024-10-22' }, sessions);
  assert.equal(performance.listingOpen, 1934);
  assert.equal(performance.listingGain, -1.33);
  assert.equal(performance.returnSinceIssue, -8.16);
  // After a 1:1 bonus, a ₹1,000 close equals ₹2,000 on the original basis.
  const split = listingPerformance(
    { issuePrice: 1000, listingDate: '2024-01-01' },
    [{ date: '2024-01-01', open: 1100, close: 1200 }, { date: '2025-01-01', open: 1000, close: 1000 }],
    [{ date: '2024-06-01', factor: 0.5 }],
  );
  assert.equal(split.returnSinceIssue, 100);
  assert.equal(listingPerformance({ issuePrice: 100, listingDate: null }, sessions), null);
  assert.equal(listingPerformance({ issuePrice: null, listingDate: '2024-10-22' }, sessions).listingGain, null);
});

test('summarises listings by board', () => {
  const issue = (name, board, listingGain) => ({ name, board, listingDate: '2026-01-01', performance: { listingGain } });
  const { mainBoard, sme } = summariseListings([
    issue('A', 'Main board', 10),
    issue('B', 'Main board', -5),
    issue('C', 'Main board', 40),
    issue('D', 'SME', 90),
    { name: 'E', board: 'SME', listingDate: null },
    { name: 'F', board: 'Main board', listingDate: '2026-01-01', performance: null },
  ]);
  assert.equal(mainBoard.count, 4);
  assert.equal(mainBoard.priced, 3);
  assert.equal(mainBoard.medianGain, 10);
  assert.equal(mainBoard.positiveShare, 67);
  assert.deepEqual(mainBoard.best, { name: 'C', gain: 40 });
  assert.deepEqual(mainBoard.worst, { name: 'B', gain: -5 });
  assert.equal(sme.count, 1);
});

test('matches a company across SEBI’s and NSE’s spellings', () => {
  assert.equal(normaliseCompany('BOMBAY COATED AND SPECIAL STEELS LIMITED'), normaliseCompany('Bombay Coated and Special Steels Ltd.'));
  assert.notEqual(normaliseCompany('Alpha Limited'), normaliseCompany('Beta Limited'));
});

test('splits a SEBI filing title into company and document', () => {
  assert.deepEqual(splitFilingTitle('SFC Environmental Technologies Ltd. - Addendum to RHP'), { company: 'SFC Environmental Technologies Ltd.', document: 'Addendum to RHP' });
  assert.deepEqual(splitFilingTitle('SFC Environmental Technologies Ltd.- RHP <br><a href='), { company: 'SFC Environmental Technologies Ltd.', document: 'RHP' });
  assert.deepEqual(splitFilingTitle('BLS Polymers Limited – RHP'), { company: 'BLS Polymers Limited', document: 'RHP' });
  assert.deepEqual(splitFilingTitle('Zetwerk Manufacturing Businesses Limited : Addendum to RHP'), { company: 'Zetwerk Manufacturing Businesses Limited', document: 'Addendum to RHP' });
  assert.deepEqual(splitFilingTitle('Carlsberg India Limited- UDRHP-1'), { company: 'Carlsberg India Limited', document: 'UDRHP-1' });
  assert.deepEqual(splitFilingTitle('Plain Name Limited'), { company: 'Plain Name Limited', document: 'Filing' });
});

test('groups SEBI’s rows by company, newest first, and refuses other sites', () => {
  const row = (date, slug, title) => `<td>${date}</td> <td><a href="https://www.sebi.gov.in/filings/public-issues/oct-2026/${slug}.html" target="_blank" title="${title}" class="points"> ${title}</a> </tr>`;
  const html = [
    row('Oct 19, 2026', 'b', 'Beta Limited - RHP'),
    row('Oct 26, 2026', 'a2', 'Alpha Limited - Addendum to RHP'),
    row('Oct 20, 2026', 'a1', 'Alpha Limited - RHP'),
    '<td>Oct 28, 2026</td> <td><a href="https://evil.example.com/x.html" title="Evil Limited - RHP">x</a>',
  ].join('\n');
  const companies = parseSebiList(html);
  assert.deepEqual(companies.map((company) => company.company), ['Alpha Limited', 'Beta Limited']);
  assert.equal(companies[0].date, '2026-10-26');
  assert.deepEqual(companies[0].documents.map((document) => document.name), ['Addendum to RHP', 'RHP']);
});

test('reads SME company names from NSE’s bundle', () => {
  const names = parseSmeNames('MARKET,SERIES,SYMBOL,SECURITY,PREV_CL_PR\nN,SM,AGUL,A G UNIVERSAL LIMITED,56.00\n');
  assert.equal(names.get('AGUL'), 'A G UNIVERSAL LIMITED');
});

/* News */

const NOW = Date.parse('2026-11-05T12:00:00Z');
const item = (title, publisher, { link = 'https://news.google.com/rss/articles/x', date = 'Wed, 04 Nov 2026 08:00:00 GMT' } = {}) =>
  `<item><title>${title} - ${publisher}</title><link>${link}</link><pubDate>${date}</pubDate><source url="https://x">${publisher}</source></item>`;

test('keeps headlines only from trusted publishers, and strips the publisher from the title', () => {
  const xml = item('Reliance jumps &amp; rises', 'Reuters') + item('Reliance moon soon', 'Some Blog');
  assert.deepEqual(parseHeadlines(xml, { now: NOW }), [
    { title: 'Reliance jumps & rises', publisher: 'Reuters', url: 'https://news.google.com/rss/articles/x', date: '2026-11-04' },
  ]);
});

test('refuses unsafe links, old stories, duplicates and off-topic titles', () => {
  const xml = [
    item('Unsafe', 'Reuters', { link: 'javascript:alert(1)' }),
    item('Elsewhere', 'Reuters', { link: 'https://example.com/a' }),
    item('Old story', 'Reuters', { date: 'Wed, 01 Jan 2025 08:00:00 GMT' }),
    item('Same headline here', 'Reuters'),
    item('Same headline here!', 'Mint'),
    item('Off topic', 'Reuters'),
  ].join('');
  const titles = parseHeadlines(xml, { now: NOW, isRelevant: (title) => !title.startsWith('Off') }).map((story) => story.title);
  assert.deepEqual(titles, ['Same headline here']);
});

test('decodes numeric and named entities once', () => {
  assert.equal(decodeEntities('A &amp; B &#39;C&#x27; &amp;amp;'), "A & B 'C' &amp;");
});

/* The page's market logic */

function stock(overrides = {}) {
  return {
    symbol: 'ABC',
    name: 'Alpha Beta Limited',
    type: 'Stock',
    exchange: 'NSE',
    currency: 'INR',
    source: 'nse',
    decimals: 2,
    days: ['2024-10-24', '2024-10-25', '2024-10-28', '2024-10-29', '2024-10-31'].map(day),
    o: [2500, 2600, 1300, 1310, 1320],
    h: [2600, 2700, 1350, 1340, 1330],
    l: [2400, 2500, 1290, 1300, 1310],
    c: [2550, 2640, 1330, 1320, 1325],
    vol: [10, 20, 30, 40, 50],
    del: [50, 51, 52, 53, null],
    actions: [{ date: '2024-10-28', factor: 0.5 }],
    news: [],
    ...overrides,
  };
}

async function marketOf(...instruments) {
  const entries = instruments.map((item) => [item.symbol, item.name, item.type, item.exchange, item.label ?? '']);
  const calendars = { NSE: ['2024-10-24', '2024-10-25', '2024-10-28', '2024-10-29', '2024-10-30', '2024-10-31'].map(day), BSE: [] };
  const market = createMarket(
    { builtOn: '2024-11-01', coverage: 'test', counts: {}, calendars, newsCoverage: 'NIFTY 500', list: entries, strip: [] },
    async (symbol) => instruments.find((item) => item.symbol === symbol),
  );
  await Promise.all(instruments.map((item) => market.load(item.symbol)));
  return market;
}

test('gives the pivot and the actual traded prices for a session', async () => {
  const { session } = (await marketOf(stock())).lookup('ABC', '2024-10-24');
  assert.equal(session.pivot, 2550);
  assert.equal(session.open, 2500);
  assert.equal(session.delivery, 50);
  assert.equal(session.closeVsPivot, 0);
});

test('states no change for a corporate-action day or the first day, and a normal one otherwise', async () => {
  const market = await marketOf(stock());
  assert.equal(market.lookup('ABC', '2024-10-28').session.change, null);
  assert.equal(market.lookup('ABC', '2024-10-24').session.change, null);
  assert.equal(market.lookup('ABC', '2024-10-29').session.change, -10);
  assert.equal(market.lookup('ABC', '2024-10-29').session.changePercent, -0.75);
});

test('draws the chart on the selected session’s price basis, keeping actual prices for reading', async () => {
  const market = await marketOf(stock());
  const after = market.lookup('ABC', '2024-10-29').chart;
  assert.equal(after.bars[0].chartClose, 1275);
  assert.equal(after.bars[0].close, 2550);
  assert.equal(after.bars[0].pivot, 2550);
  assert.equal(after.bars[after.selectedIndex].chartClose, 1320);
  assert.deepEqual(after.rescaledFor, ['2024-10-28']);

  const before = market.lookup('ABC', '2024-10-24').chart;
  assert.equal(before.bars[0].chartClose, 2550);
  assert.equal(before.bars[3].chartClose, 2640);
});

test('a time frame shows that many sessions, keeping some after an older one', async () => {
  const market = await marketOf(stock());
  const latest = market.lookup('ABC', '2024-10-31').chartFor(3);
  assert.deepEqual(latest.bars.map((bar) => bar.date), ['2024-10-28', '2024-10-29', '2024-10-31']);
  assert.equal(latest.selectedIndex, 2);

  const older = market.lookup('ABC', '2024-10-25').chartFor(4);
  assert.deepEqual(older.bars.map((bar) => bar.date), ['2024-10-24', '2024-10-25', '2024-10-28', '2024-10-29']);
  assert.equal(older.selectedIndex, 1);

  const everything = market.lookup('ABC', '2024-10-31').chartFor(Infinity);
  assert.equal(everything.bars.length, 5);
  assert.deepEqual(everything.rescaledFor, ['2024-10-28']);
  assert.equal(market.lookup('ABC', '2024-10-29').chartFor(1).bars[0].date, '2024-10-29');
});

test('groups candles into weeks and months on the chart’s single price basis', async () => {
  const { bars } = (await marketOf(stock())).lookup('ABC', '2024-10-29').chartFor(Infinity);
  const [first, second] = groupBars(bars, 'week');
  assert.deepEqual(
    { date: first.date, open: first.chartOpen, high: first.chartHigh, low: first.chartLow, close: first.chartClose },
    { date: '2024-10-25', open: 1250, high: 1350, low: 1200, close: 1320 },
  );
  assert.deepEqual(
    { date: second.date, open: second.chartOpen, high: second.chartHigh, low: second.chartLow, close: second.chartClose },
    { date: '2024-10-31', open: 1300, high: 1350, low: 1290, close: 1325 },
  );
  assert.equal(first.pivot, undefined);

  const months = groupBars(bars, 'month');
  assert.equal(months.length, 1);
  assert.equal(months[0].chartOpen, 1250);
  assert.equal(months[0].chartClose, 1325);
  assert.equal(groupBars(bars, 'day'), bars);
});

test('uses the shortest candle that leaves room for all of them', async () => {
  const { bars } = (await marketOf(stock())).lookup('ABC', '2024-10-31').chartFor(Infinity);
  assert.equal(candlesFor(bars, 5).period, 'day');
  assert.equal(candlesFor(bars, 2).period, 'week');
  assert.equal(candlesFor(bars, 1).period, 'month');
  assert.equal(candlesFor(bars, 1).bars.length, 1);
});

function mover(symbol, closes, overrides = {}) {
  return {
    symbol,
    type: 'Stock',
    decimals: 2,
    days: ['2024-10-24', '2024-10-25', '2024-10-28'].slice(0, closes.length).map(day),
    c: closes,
    actions: [],
    ...overrides,
  };
}

test('ranks a day’s gainers and losers, largest first, with each stock’s close and change', () => {
  const movers = collectMovers([
    mover('UP5', [100, 105]),
    mover('UP20', [100, 120]),
    mover('DOWN10', [200, 180]),
    mover('DOWN2', [100, 98]),
    mover('FLAT', [100, 100]),
  ]);
  const { all } = movers.get('2024-10-25');
  assert.deepEqual(all.gainers, [['UP20', 120, 20], ['UP5', 105, 5]]);
  assert.deepEqual(all.losers, [['DOWN10', 180, -10], ['DOWN2', 98, -2]]);
  assert.equal(all.count, 5);
  assert.equal(movers.has('2024-10-24'), false);
});

test('leaves out moves that are not a real day’s trading', () => {
  const movers = collectMovers([
    mover('REAL', [100, 110]),
    mover('SPLIT', [100, 50], { actions: [{ date: '2024-10-25', factor: 0.5 }] }),
    mover('UNFLAGGED', [100, 300]),
    mover('RELISTED', [100, 115], { days: ['2024-10-01', '2024-10-25'].map(day) }),
  ]);
  const { all } = movers.get('2024-10-25');
  assert.deepEqual(all.gainers.map(([symbol]) => symbol), ['REAL']);
  assert.deepEqual(all.losers, []);
  assert.equal(all.count, 1);
});

test('keeps a stock that last traded a few days earlier, as over a long weekend', () => {
  const movers = collectMovers([mover('WEEKEND', [100, 110], { days: ['2024-10-21', '2024-10-25'].map(day) })]);
  assert.deepEqual(movers.get('2024-10-25').all.gainers, [['WEEKEND', 110, 10]]);
});

test('keeps only the top ten on each side, breaking ties by symbol so a rebuild gives the same list', () => {
  const stocks = Array.from({ length: 13 }, (_, i) => mover(`S${String(i).padStart(2, '0')}`, [100, 120]));
  const { gainers } = collectMovers(stocks).get('2024-10-25').all;
  assert.equal(gainers.length, 10);
  assert.deepEqual(gainers.slice(0, 2).map(([symbol]) => symbol), ['S00', 'S01']);
  assert.equal(gainers.at(-1)[0], 'S09');
});

test('lists NIFTY 500 members separately from the whole market', () => {
  const movers = collectMovers([mover('BIG', [100, 102], { nifty500: true }), mover('SMALL', [100, 120])]);
  const { all, nifty500 } = movers.get('2024-10-25');
  assert.deepEqual(all.gainers.map(([symbol]) => symbol), ['SMALL', 'BIG']);
  assert.deepEqual(nifty500.gainers.map(([symbol]) => symbol), ['BIG']);
  assert.equal(nifty500.count, 1);
});

test('gives the latest close on record, whichever date is selected', async () => {
  const market = await marketOf(stock());
  const latest = { date: '2024-10-31', close: 1325 };
  assert.deepEqual(market.lookup('ABC', '2024-10-24').latest, latest);
  assert.deepEqual(market.lookup('ABC', '2024-10-31').latest, latest);
  assert.deepEqual(market.lookup('ABC', '2024-10-27').latest, latest);
});

test('flags only corporate actions after the selected session', async () => {
  const market = await marketOf(stock());
  assert.deepEqual(market.lookup('ABC', '2024-10-25').laterActions, [{ date: '2024-10-28', factor: 0.5 }]);
  assert.deepEqual(market.lookup('ABC', '2024-10-28').laterActions, []);
});

test('works out the range on one price basis, and says when it covers under a year', async () => {
  const { range } = (await marketOf(stock())).lookup('ABC', '2024-10-29');
  assert.equal(range.high, 1350);
  assert.equal(range.highDate, '2024-10-25');
  assert.equal(range.low, 1200);
  assert.equal(range.lowDate, '2024-10-24');
  assert.equal(range.coversYear, false);
  assert.equal(range.yearReturn, null);
  assert.equal(range.from, '2024-10-24');
});

test('gives a one-year return when a full year of history exists', async () => {
  const days = [day('2023-10-30'), day('2024-10-29')];
  const item = stock({ days, o: [100, 200], h: [100, 200], l: [100, 200], c: [100, 150], actions: [], vol: [1, 1], del: [1, 1] });
  const { range } = (await marketOf(item)).lookup('ABC', '2024-10-29');
  assert.equal(range.coversYear, true);
  assert.equal(range.yearReturn, 50);
});

test('tells a holiday from a day without trades, an unlisted date and the end of the data', async () => {
  const market = await marketOf(stock());
  const reason = (date) => market.lookup('ABC', date).reason;
  assert.equal(reason('2024-10-26'), 'closed');
  assert.equal(reason('2024-10-30'), 'missing');
  assert.equal(reason('2024-10-01'), 'before');
  assert.equal(reason('2024-11-01'), 'ended');
});

test('uses a stored list of gaps where a source reports them', async () => {
  const market = await marketOf(stock({ exchange: 'US', gaps: ['2024-10-30'] }));
  assert.equal(market.lookup('ABC', '2024-10-30').reason, 'missing');
});

test('offers the neighbouring sessions when a day has none', async () => {
  const data = (await marketOf(stock())).lookup('ABC', '2024-10-26');
  assert.equal(data.session, null);
  assert.equal(data.previousSession, '2024-10-25');
  assert.equal(data.nextSession, '2024-10-28');
});

test('loads each instrument only once', async () => {
  let loads = 0;
  const market = createMarket(
    { builtOn: '2024-11-01', coverage: 'test', calendars: { NSE: [day('2024-10-24')] }, list: [['ABC', 'Alpha', 'Stock', 'NSE', '']], strip: [] },
    async () => {
      loads++;
      return stock();
    },
  );
  assert.equal(market.isLoaded('ABC'), false);
  await market.load('ABC');
  await market.load('ABC');
  assert.equal(loads, 1);
  assert.equal(market.isLoaded('ABC'), true);
  assert.equal(market.has('ZZZ'), false);
});

test('makes a safe, unique file name for every symbol', () => {
  assert.equal(instrumentFile('RELIANCE'), 'RELIANCE.json');
  assert.equal(instrumentFile('BAJAJ-AUTO'), 'BAJAJ-AUTO.json');
  assert.equal(instrumentFile('M&M'), 'M_26M.json');
  assert.equal(instrumentFile('BSE:ABC'), 'BSE_3aABC.json');
  assert.equal(instrumentFile('S&P 500'), 'S_26P_20500.json');
  assert.notEqual(instrumentFile('M&M'), instrumentFile('M M'));
});

test('search finds names, symbols and button labels, ranking the best match first', async () => {
  const market = await marketOf(
    stock({ symbol: 'HDFCBANK', name: 'HDFC Bank Limited' }),
    stock({ symbol: 'SENSEX', name: 'BSE SENSEX', type: 'Index' }),
    stock({ symbol: 'S&P 500', name: 'S&P 500', label: 'S&P 500', type: 'Index', exchange: 'US' }),
    stock({ symbol: 'NIFTY BANK', name: 'NIFTY BANK', label: 'BANK NIFTY', type: 'Index' }),
    stock({ symbol: 'BSE:TITAN', name: 'Titan Biotech', exchange: 'BSE' }),
    stock({ symbol: 'TITAN', name: 'Titan Company Limited' }),
  );
  const symbols = (query) => market.search(query).map((option) => option.symbol);
  assert.deepEqual(symbols('hdfc bank'), ['HDFCBANK']);
  assert.deepEqual(symbols('bank hdfc'), ['HDFCBANK']);
  assert.equal(symbols('s&p')[0], 'S&P 500');
  assert.equal(symbols('bank nifty')[0], 'NIFTY BANK');
  // The same ticker on both exchanges shows the NSE stock first.
  assert.deepEqual(symbols('titan'), ['TITAN', 'BSE:TITAN']);
  assert.deepEqual(symbols('zzqqxx'), []);
  assert.deepEqual(symbols('   '), []);
});

test('live NSE data counts only once the session has closed', () => {
  assert.equal(closedSessionDate('12-Nov-2026 15:30'), '2026-11-12');
  assert.equal(closedSessionDate('12-Nov-2026 11:02'), null);
  assert.equal(parseLiveIndices({ timestamp: '12-Nov-2026 11:02', data: [] }).date, null);
  const { date, rows } = parseLiveIndices({
    timestamp: '12-Nov-2026 15:30',
    data: [{ index: 'NIFTY 50', open: 10, high: 12, low: 9, last: 11, pe: '20.5', pb: '3', dy: '1.4' }, { index: 'BAD', open: 0 }],
  });
  assert.equal(date, '2026-11-12');
  assert.deepEqual(rows.get('nifty 50'), { open: 10, high: 12, low: 9, close: 11, pe: 20.5, pb: 3, dy: 1.4 });
  assert.equal(rows.size, 1);
});

test('live stock rows skip the index row and incomplete prices', () => {
  const rows = parseLiveStocks({
    data: [
      { symbol: 'NIFTY 500', priority: 1, open: 1, dayHigh: 1, dayLow: 1, lastPrice: 1 },
      { symbol: 'TCS', priority: 0, open: 100, dayHigh: 110, dayLow: 95, lastPrice: 105, totalTradedVolume: 5000 },
      { symbol: 'XYZ', priority: 0, open: 0, dayHigh: 1, dayLow: 1, lastPrice: 1 },
    ],
  });
  assert.deepEqual([...rows.keys()], ['TCS']);
  assert.equal(rows.get('TCS').close, 105);
});
