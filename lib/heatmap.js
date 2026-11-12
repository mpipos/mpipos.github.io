// The heatmap's data: which stocks each NSE index holds, and each trading day's moves for them.
import { dailyChanges } from './movers.js';

const CRORE = 10_000_000;
export const NIFTY_500 = 'NIFTY 500';

const shortName = (name) => name.replace(/\s+(limited|ltd\.?)$/i, '').trim();

// `members` maps an index to the stocks it holds today. NIFTY 500's comes from the stocks themselves.
export function createHeatmapCollector(members) {
  const wanted = new Set([...members.values()].flatMap((symbols) => [...symbols]));
  const stocks = [];
  const changes = [];

  return {
    add(stock) {
      if (stock.type !== 'Stock' || stock.exchange !== 'NSE') return;
      if (!stock.nifty500 && !wanted.has(stock.symbol)) return;
      const cap = stock.profile?.marketCap;
      stocks.push({
        symbol: stock.symbol,
        name: shortName(stock.name),
        sector: stock.profile?.industry || 'Other',
        cap: cap ? Math.round(cap / CRORE) : null,
        nifty500: Boolean(stock.nifty500),
      });
      changes.push(new Map([...dailyChanges(stock)].map(({ date, close, percent }) => [date, [close, percent]])));
    },

    // Indices are in the order the page lists them. Only those with members can be opened.
    finish(indices) {
      const sectors = [...new Set(stocks.map(({ sector }) => sector))].sort();
      const position = new Map(stocks.map(({ symbol }, i) => [symbol, i]));
      const membersOf = (symbol) => {
        if (symbol === NIFTY_500) return stocks.flatMap((stock, i) => (stock.nifty500 ? [i] : []));
        const held = [...(members.get(symbol) ?? [])].filter((member) => position.has(member)).map((member) => position.get(member));
        return held.length ? held.sort((a, b) => a - b) : null;
      };
      const indexChanges = indices.map((index) => new Map([...dailyChanges(index)].map(({ date, percent }) => [date, percent])));

      const dates = new Set([...changes, ...indexChanges].flatMap((byDate) => [...byDate.keys()]));
      const days = new Map();
      for (const date of [...dates].sort()) {
        days.set(date, {
          i: indexChanges.map((byDate) => byDate.get(date) ?? null),
          s: changes.map((byDate) => byDate.get(date) ?? null),
        });
      }

      return {
        info: {
          sectors,
          stocks: stocks.map(({ symbol, name, sector, cap }) => [symbol, name, sectors.indexOf(sector), cap]),
          indices: indices.map(({ symbol, label, name }) => [symbol, label || name, membersOf(symbol)]),
        },
        days,
      };
    },
  };
}
