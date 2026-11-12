# Market Pivots and IPOs

Pick any stock or index on the Indian market and a trading day to get its pivot point, with a price chart, fundamentals and news. A separate section covers IPOs.

```
Pivot = (Open + High + Close) / 3
```

The live site is at https://mpipos.github.io/

## Automatic updates

GitHub rebuilds and publishes the page twice a day, using `.github/workflows/update.yml`:

- 21:15 India time, after NSE publishes the day's reports.
- 07:45 India time, after US markets close.

A Claude routine also asks GitHub for an update at 21:00 India time on weekdays, because GitHub often starts its scheduled runs hours late.

To update it straight away, open the project's **Actions** tab on GitHub, choose **Update the site**, then **Run workflow**.

If an update fails, the live page stays as it was and GitHub emails you. When one source fails, its instruments keep their earlier data while the rest update. If updates stop for more than six days, the page says so at the top. To see which sources GitHub can currently reach, and test a complete build without publishing it, run the **Check data sources** workflow.

## Build it on your own computer

With [Node.js](https://nodejs.org) 18 or newer:

```
npm run build
npm run preview
```

Then open http://127.0.0.1:4173. The page loads a data file for each stock, which browsers don't allow from a double-clicked file. Downloads are kept in `.cache/`, so a rebuild only fetches what's new. To rebuild the page without collecting data again, run `npm run assemble`.

## Where the data comes from

| Data | Source |
|---|---|
| NSE stock and index prices, delivery, P/E, P/B, dividend yield | NSE's daily reports |
| Market cap, shares issued, filings, board meetings, ex-dates | NSE's daily bundle |
| Companies that trade only on BSE | BSE's daily price file |
| IPO dates, price bands, lot sizes, subscription and documents | NSE's public issue records |
| IPO filings in the pipeline | SEBI's lists of offer documents |
| SENSEX, S&P 500, NASDAQ, Dow | Yahoo Finance, because no official source for these is usable (BSE's refuses automated requests, and Nasdaq's own feed has wrong opens on about 25 of 750 days) |
| Company financials | Yahoo Finance, for NIFTY 500 companies, refreshed monthly |
| News | Google News, for NIFTY 500 companies and indices, filtered to the publishers listed in `scripts/sources/news.js` |

The page names its source beside each set of figures. It doesn't use sites whose rules forbid automated access, which is why it has no grey market premium.

## How it works

- `scripts/collect.js` gathers everything into `.cache/site/`, using the readers in `scripts/sources/`. Each instrument gets its own file, which the page loads when someone chooses it.
- `scripts/dataset-checks.js` refuses an update that would damage the page.
- `lib/movers.js` works out each day's top gainers and losers, which `scripts/assemble.js` writes as a small file per date.
- `scripts/assemble.js` joins the list of instruments and the code in `page/` and `lib/` into `dist/index.html`, and copies the data files beside it.
- `lib/pivot.js` holds the formula.
- `lib/market.js` answers the page's questions, such as a day's pivot or the 52-week range.

## About the prices

- NSE prices are the ones actually traded on the day, so they aren't adjusted for later splits or bonuses. The page says when a later corporate action makes an old price look out of line with today's.
- The chart rescales prices across a corporate action to stay continuous. The sessions table always shows actual prices.
- The chart shows candles or a line of closing prices, from one day to three years. Candles group into weeks or months when a period is too long to show each day.
- Only finished trading days are included, so the current price shown is the latest close on record, not a live price.
- Top gainers and losers compare each close with the stock's previous close. They leave out corporate-action days, stocks that hadn't traded for over a week, and moves above 40%, which are almost always a price basis changing rather than a real day's move. NIFTY 500 means the index's current members.
- Rows no market could produce, such as an open above the day's high, are dropped. So are Yahoo's flat bars, which repeat the last close as all four prices. The page then says the day has no prices rather than show a wrong pivot.
- Corporate actions are detected from overnight falls of more than 25%, which every build logs for review. A smaller one, such as ITC's January 2025 demerger, appears as an ordinary price move.

## Test it

```
npm test
```
