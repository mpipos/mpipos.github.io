// Each trading day's biggest rises and falls, worked out from every stock's closing prices.
import { isoDay } from './market.js';
import { round } from './pivot.js';

const MOVERS_SHOWN = 10;
// Long enough for a long weekend or a holiday. A longer gap isn't one day's move.
const MAX_GAP_DAYS = 7;
// The exchanges' usual daily limit is 20%. Beyond this it is almost always a price basis changing, not trading.
const MAX_BELIEVABLE_MOVE = 40;

const emptyGroup = () => ({ count: 0, gainers: [], losers: [] });

// Keeps a short list in order without holding every stock's every day in memory.
function keepTop(list, row, isBefore) {
  const at = list.findIndex((other) => isBefore(row, other));
  if (at >= 0) list.splice(at, 0, row);
  else if (list.length < MOVERS_SHOWN) list.push(row);
  if (list.length > MOVERS_SHOWN) list.pop();
}

const higherFirst = ([symbolA, , a], [symbolB, , b]) => a > b || (a === b && symbolA < symbolB);
const lowerFirst = ([symbolA, , a], [symbolB, , b]) => a < b || (a === b && symbolA < symbolB);

function addToGroup(group, row) {
  group.count++;
  const [, , change] = row;
  if (change > 0) keepTop(group.gainers, row, higherFirst);
  if (change < 0) keepTop(group.losers, row, lowerFirst);
}

export function collectMovers(stocks) {
  const days = new Map();
  for (const stock of stocks) {
    const actionDates = new Set((stock.actions ?? []).map(({ date }) => date));
    for (let i = 1; i < stock.days.length; i++) {
      const date = isoDay(stock.days[i]);
      if (stock.days[i] - stock.days[i - 1] > MAX_GAP_DAYS || actionDates.has(date)) continue;
      const percent = ((stock.c[i] - stock.c[i - 1]) / stock.c[i - 1]) * 100;
      if (!Number.isFinite(percent) || Math.abs(percent) > MAX_BELIEVABLE_MOVE) continue;

      if (!days.has(date)) days.set(date, { all: emptyGroup(), nifty500: emptyGroup() });
      const day = days.get(date);
      const row = [stock.symbol, stock.c[i], round(percent, 2)];
      addToGroup(day.all, row);
      if (stock.nifty500) addToGroup(day.nifty500, row);
    }
  }
  return days;
}
