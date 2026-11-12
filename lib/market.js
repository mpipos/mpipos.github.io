// Answers the page's questions. The list of everything is built into the page, and each instrument's
// prices load when someone chooses it.
import { pivotPoint, round } from './pivot.js';

const DAY_MS = 86_400_000;
const RANGE_DAYS = 365;
const RANGE_GRACE_DAYS = 7;
const WINDOW_BEFORE = 45;
const WINDOW_AFTER = 15;
const FRAME_SHARE_AFTER = 0.25;
const MAX_RESULTS = 12;

export const isoDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const toDay = (iso) => Date.parse(iso) / DAY_MS;

// Symbols like M&M or BSE:ABC become names that are safe for any file system or web address.
export const instrumentFile = (symbol) =>
  `${symbol.replace(/[^A-Za-z0-9-]/g, (character) => `_${character.charCodeAt(0).toString(16)}`)}.json`;

function actualBar(item, i) {
  const { o, h, l, c, decimals } = item;
  const bar = { date: isoDay(item.days[i]), open: o[i], high: h[i], low: l[i], close: c[i] };
  return { ...bar, pivot: round(pivotPoint(bar), decimals) };
}

// What to multiply a price from session `from` by, to compare it with prices at session `to`.
// A corporate action (a split, say) shifts the basis of every price either side of it.
function basisFactor(item, from, to) {
  if (from === to) return 1;
  const startDay = item.days[Math.min(from, to)];
  const endDay = item.days[Math.max(from, to)];
  const combined = item.actions
    .filter(({ date }) => toDay(date) > startDay && toDay(date) <= endDay)
    .reduce((product, { factor }) => product * factor, 1);
  return from < to ? combined : 1 / combined;
}

function describeSession(item, i) {
  const { decimals } = item;
  const bar = actualBar(item, i);
  // The exchanges publish no adjusted previous close, so a day's change can't be stated exactly across a corporate action.
  const hasAction = item.actions.some(({ date }) => toDay(date) === item.days[i]);
  const previous = i > 0 && !hasAction ? item.c[i - 1] : null;
  const closeVsPivot = round(bar.close - bar.pivot, decimals);
  return {
    ...bar,
    change: previous === null ? null : round(bar.close - previous, decimals),
    changePercent: previous === null ? null : round(((bar.close - previous) / previous) * 100, 2),
    closeVsPivot,
    closeVsPivotPercent: round((closeVsPivot / bar.pivot) * 100, 2),
    volume: item.vol?.[i] ?? null,
    delivery: item.del?.[i] ?? null,
    pe: item.pe?.[i] ?? null,
    pb: item.pb?.[i] ?? null,
    dividendYield: item.dy?.[i] ?? null,
  };
}

function yearRange(item, i) {
  const { decimals } = item;
  const startDay = item.days[i] - RANGE_DAYS;
  let first = i;
  while (first > 0 && item.days[first - 1] >= startDay) first--;

  let high = -Infinity;
  let low = Infinity;
  let highDate;
  let lowDate;
  for (let j = first; j <= i; j++) {
    const factor = basisFactor(item, j, i);
    if (item.h[j] * factor > high) {
      high = item.h[j] * factor;
      highDate = isoDay(item.days[j]);
    }
    if (item.l[j] * factor < low) {
      low = item.l[j] * factor;
      lowDate = isoDay(item.days[j]);
    }
  }
  const close = item.c[i];
  const coversYear = item.days[first] - startDay <= RANGE_GRACE_DAYS;
  const openingClose = item.c[first] * basisFactor(item, first, i);
  return {
    high: round(high, decimals),
    low: round(low, decimals),
    highDate,
    lowDate,
    from: isoDay(item.days[first]),
    coversYear,
    position: high === low ? 0.5 : Math.min(1, Math.max(0, (close - low) / (high - low))),
    yearReturn: coversYear ? round(((close - openingClose) / openingClose) * 100, 2) : null,
  };
}

function chartBars(item, start, end, i) {
  const { decimals } = item;
  const bars = [];
  for (let j = start; j <= end; j++) {
    const factor = basisFactor(item, j, i);
    const scale = (price) => round(price * factor, decimals);
    bars.push({
      ...actualBar(item, j),
      chartOpen: scale(item.o[j]),
      chartHigh: scale(item.h[j]),
      chartLow: scale(item.l[j]),
      chartClose: scale(item.c[j]),
    });
  }
  const rescaledFor = item.actions
    .map(({ date }) => date)
    .filter((date) => toDay(date) > item.days[start] && toDay(date) <= item.days[end]);
  return { bars, selectedIndex: i - start, rescaledFor };
}

function chartWindow(item, i) {
  return chartBars(item, Math.max(0, i - WINDOW_BEFORE), Math.min(item.days.length - 1, i + WINDOW_AFTER), i);
}

// A time frame's worth of sessions. An older session keeps some of what came after it in view.
function chartFrame(item, i, sessions) {
  const last = item.days.length - 1;
  const count = Math.min(sessions, item.days.length);
  const after = Math.min(last - i, Math.round(count * FRAME_SHARE_AFTER));
  const start = Math.max(0, i + after - count + 1);
  return chartBars(item, start, Math.min(last, start + count - 1), i);
}

// Weeks start on Monday, and day 0 was a Thursday.
export const weekOf = (date) => Math.floor((toDay(date) + 3) / 7);
const PERIOD_KEYS = { week: weekOf, month: (date) => date.slice(0, 7) };

// One candle for each week or month, dated by its last session. Prices stay on the chart's single basis.
export function groupBars(bars, period) {
  const keyOf = PERIOD_KEYS[period];
  if (!keyOf) return bars;
  const groups = new Map();
  for (const bar of bars) {
    const key = keyOf(bar.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  return [...groups.values()].map((group) => {
    const open = group[0].chartOpen;
    const high = Math.max(...group.map((bar) => bar.chartHigh));
    const low = Math.min(...group.map((bar) => bar.chartLow));
    const close = group.at(-1).chartClose;
    return { period, date: group.at(-1).date, open, high, low, close, chartOpen: open, chartHigh: high, chartLow: low, chartClose: close };
  });
}

// The shortest candle that leaves room for all of them: days, then weeks, then months.
export function candlesFor(bars, capacity) {
  for (const period of ['day', 'week']) {
    const grouped = groupBars(bars, period);
    if (grouped.length <= capacity) return { period, bars: grouped };
  }
  return { period: 'month', bars: groupBars(bars, 'month') };
}

export function createMarket({ builtOn, coverage, counts, calendars, newsCoverage, list, strip }, fetchInstrument) {
  const directory = list.map(([symbol, name, type, exchange, label]) => ({ symbol, name, type, exchange, label: label || undefined }));
  const known = new Map(directory.map((entry) => [entry.symbol, entry]));
  const loaded = new Map();
  const openDays = Object.fromEntries(Object.entries(calendars).map(([exchange, days]) => [exchange, new Set(days)]));
  const allDays = Object.values(calendars).flat();

  function noSessionReason(item, date, day) {
    if (date > isoDay(item.days.at(-1))) return 'ended';
    if (date < isoDay(item.days[0])) return 'before';
    if (item.gaps?.includes(date) || openDays[item.exchange]?.has(day)) return 'missing';
    return 'closed';
  }

  return {
    builtOn,
    coverage,
    counts,
    newsCoverage,
    strip,
    minDate: isoDay(Math.min(...allDays)),
    maxDate: isoDay(Math.max(...allDays)),

    has: (symbol) => known.has(symbol),
    isOpen: (exchange, date) => Boolean(openDays[exchange]?.has(toDay(date))),
    tradingDays: (exchange) => (calendars[exchange] ?? []).slice().sort((a, b) => a - b).map(isoDay),
    entry: (symbol) => known.get(symbol),
    isLoaded: (symbol) => loaded.has(symbol),

    async load(symbol) {
      if (!loaded.has(symbol)) loaded.set(symbol, await fetchInstrument(symbol));
      return loaded.get(symbol);
    },

    lookup(symbol, date) {
      const item = loaded.get(symbol);
      const day = toDay(date);
      const i = item.days.indexOf(day);
      const previousIndex = item.days.findLastIndex((candidate) => candidate < day);
      const nextIndex = item.days.findIndex((candidate) => candidate > day);
      const base = {
        instrument: item,
        date,
        latest: { date: isoDay(item.days.at(-1)), close: item.c.at(-1) },
        previousSession: previousIndex < 0 ? null : isoDay(item.days[previousIndex]),
        nextSession: nextIndex < 0 ? null : isoDay(item.days[nextIndex]),
      };
      if (i < 0) return { ...base, session: null, reason: noSessionReason(item, date, day) };
      return {
        ...base,
        session: describeSession(item, i),
        range: yearRange(item, i),
        chart: chartWindow(item, i),
        chartFor: (sessions) => chartFrame(item, i, sessions),
        laterActions: item.actions.filter((action) => toDay(action.date) > day),
      };
    },

    search(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return [];
      const [first] = terms;
      const whole = terms.join(' ');
      const bare = (symbol) => symbol.replace(/^BSE:/, '').toLowerCase();
      const rank = ({ symbol, name, label, type, exchange }) => {
        let score;
        if (bare(symbol) === whole || label?.toLowerCase() === whole) score = 0;
        else if (bare(symbol).startsWith(first) || label?.toLowerCase().startsWith(first)) score = 1;
        else if (name.toLowerCase().startsWith(first)) score = 2;
        else score = 3;
        // Within a tier, indices come first, then NSE stocks, then companies only on BSE.
        return score * 3 + (type === 'Index' ? 0 : exchange === 'NSE' ? 1 : 2);
      };
      return directory
        .filter(({ symbol, name, label }) => {
          const haystack = `${symbol} ${name} ${label ?? ''}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, MAX_RESULTS);
    },
  };
}
