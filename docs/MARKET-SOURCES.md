# Market data sources

Hosts bonded nodes could vote into `MARKET_HOSTS` (see `MARKET-CREATOR.md`). Seven nodes read a public URL at the end of a round. Five must agree. Nodes hold no keys.

Measured 2026-10-31, 21:10-21:35 UTC, a Saturday night, from the test host (Swiss residential line). About 200 URLs, each read with `curl -s -m 10 -H 'Origin: https://testnet.bitcoin-arena.io' -D -`, twice, 5 s apart, then the working ones once more 17 minutes later.

**Terms.** I treat paid markets as commercial use. That is my reading, not legal advice. Before listing a host, someone should read its terms for real.

## Adding a host by vote

A proposal names, for each host, an example address, what the example reads, a documentation link, and for a socket that needs starting its init code. A list without these stands on no node.

- The owner's form tests the example on the node. **Make the proposal** opens only for the exact values that answered.
- The owner's door reads the example again before paying the deposit and again before signing. The example must answer both times.
- Every node reads the example when it takes the proposal and keeps what it saw for the voters. A failed read does not refuse the proposal. A page that answers one node and not another would otherwise leave the nodes with different lists.
- Yes needs the example to answer on that node at that moment.

### Init code

`function init(message, step)` runs on connecting (`message` null, `step` 0), then on each of the first four messages. It answers what to send: text, a list of them, or null. It takes the same check as a market's code, in the same sandbox, stopped after 2 s.

Init code that fails the check is refused by every node. Each node runs the check again before each run. Once voted, the code starts every socket read of that host.

Measured 2026-10-31 from the test host, five messages or 5 s:

| Socket | Without init | With init |
| --- | --- | --- |
| ws.kraken.com/v2 | 1 message, status only | ticker, 1.6 s |
| ws-feed.exchange.coinbase.com | nothing | ticker, 1.4 s |

An endless loop in init was stopped after 2 s and refused the read.

## Recommended first list

Primary publisher, no key, stable value, and the terms I read allow it or ask only for credit.

| Host | Settles | Note |
|---|---|---|
| `data-api.ecb.europa.eu` | EUR reference rates, €STR | Free commercial reuse, credit the ECB, do not alter |
| `markets.newyorkfed.org` | SOFR, EFFR, Fed target range | Automated access allowed, must carry their notice |
| `api.fiscaldata.treasury.gov` | US Treasury exchange rates, average rates | No key, no registration |
| `ec.europa.eu` (path `/eurostat/api/`) | Euro area inflation, unemployment | Free reuse with credit. List the path, not the whole host |
| `api.beta.ons.gov.uk`, `www.ons.gov.uk` | UK CPI, labour market | Open Government Licence |
| `api.bls.gov` | US CPI, payrolls | 25 requests a day without a key. Few markets only |
| `api.weather.gov`, `aviationweather.gov` | US and airport weather | NWS: "free to use for any purpose" |
| `data.geo.admin.ch` (path `/ch.meteoschweiz`) | Swiss weather | CC BY 4.0, commercial use allowed |
| `www.bundeswahlleiterin.de` | German federal results | dl-de/by-2-0, commercial use allowed |
| Seat's own `bitcoind` | Bitcoin chain facts | No third party at all. First choice for anything on chain |
| `mempool.space`, `blockstream.info` | Bitcoin chain facts, by height or hash | Fallback or cross-check. Limits unpublished |

Second list. It works in every test, but the terms need a decision or were not readable.

| Host | Why second |
|---|---|
| `api.exchange.coinbase.com` | Best crypto candle measured. Market Data Terms blocked my fetch, so unread |
| `www.bitstamp.net` | Clean candle. Terms unread |
| `api.kraken.com` | Clean closed candle. Terms section 9 bars bots and commercial use of "Our Content"; no API exception found |
| `www.bankofcanada.ca` | Rates "for statistical and analytical purposes only" |
| `data.api.abs.gov.au` | Works. Service is marked beta, licence page unread |
| `www150.statcan.gc.ca` | Needs POST. Licence unread |
| `app-prod-static-voteinfo.s3.eu-central-1.amazonaws.com` | Swiss federal votes, official. Terms page blocked my fetch |
| `results.aec.gov.au`, `er.ncsbe.gov` | Official results. Terms unread |
| `data.sec.gov` | Needs a declared User-Agent with a contact, no key |

**Not on any list:** FRED (terms bar scraping and commercial use), Binance (see below), all sports feeds, any equity index, any gold price.

**Categories with no clean source:** equities and indices, gold and metals, sports, US national elections, US GDP. Details in each section.

## What the tests say

1. **Settle on a closed, dated record, never a live value.** Coinbase spot, Binance, Kraken and Bitstamp tickers, Deribit's index, tip height and fees all moved within the test. Two equal reads of a live value are luck: Coinbase spot matched at 5 s, then went 77319.995 to 77380.805.
2. **Closed candles agree.** The 20:00 UTC candle was byte-identical from the test host, and from Ashburn, Frankfurt and Tokyo for Coinbase, Bitstamp and Binance Vision, and unchanged 17 minutes later.
3. **Wait 30 s after close.** Four minutes across seven exchanges, 364 reads, offsets +0.3 s to +150 s:

   | Exchange | First final read |
   |---|---|
   | Coinbase, Binance Vision, Kraken, Bybit | +0.3 s, all 4 minutes |
   | OKX | Prices at +0.3 s; `confirm` flag flips 0 to 1 by +2 s |
   | Bitstamp | Candle missing until +3 s |
   | Bitfinex | **+20 s in 2 of 4 minutes. Close went 77563 to 77534 after the minute ended** |

4. **Compare the parsed value, not the body.** These change on every read while the data does not: ABS and Norges and BIS (`id`, `prepared`), BoJ (`DATE`), BLS (`responseTime`), Cboe (`timestamp`), Bybit (`time`), Open-Meteo (`generationtime_ms`), ECB `jsondata` (`prepared`; use `csvdata`). blockchain.info's block JSON even changes `tx[].time` on a 2025 block.
5. **Pin the date in the URL.** `latest`, `recent=1` and `lastNObservations=1` change answer the moment the publisher posts. All pinned URLs below were measured.
6. **A 200 proves nothing.** Riksbank answers 200 with an empty body to your Origin header and real data without it. BEA gives 200 empty without a key. Stooq gives 200 with a JavaScript bot wall. Eurostat `prc_hicp_manr` still answers 200, frozen since 2026-02-06; the ECB series `ICP/M.U2.N.000000.4.ANR` stops at 2025-12. Check the observation date inside the answer.
7. **Nodes must not send an Origin header.** Only Riksbank broke, but nothing needs it server side. ACAO matters only for the dashboard's Test step: a host with no ACAO cannot be read from the browser, so run that test through the node.
8. **Read after the cache can expire.** Right after a release, nodes can get old and new answers. Cache-Control max-age measured: ECB CSV and Valet 30 s, ECB XML 300 s, ONS 900 s, OECD 2 h, World Bank 4 h, Frankfurter 1 day, UEFA 1175 s.
9. **IP addresses change the answer.** FPL gave 403 in Frankfurt, 200 in Ashburn and Tokyo. Yahoo gave 429 here, 200 from AWS. Three blocked nodes of seven means no five, and the round refunds.
10. **Say which number settles.** BLS marks payrolls `P` (preliminary). ERA5 marks recent days `PRELIMINARY`, then `FINAL`. GISTEMP revises back data.
11. **List exact hosts, with a path where the host is shared.** Never `amazonaws.com` or `ec.europa.eu` bare: anyone can post on the first, and the second carries far more than Eurostat.

## Reading the tables

- **All sources are free** unless the row says otherwise.
- **HTTP/ACAO:** `*`, `echo` (returns your Origin) or `none`.
- **Two reads:** *Same* = identical bytes. *Value same* = only metadata changed. *Moves* = the value changed.
- **3R:** also byte-identical from AWS Ashburn, Frankfurt and Tokyo. *3R 200* = all three answered 200, bodies differ in metadata only.
- **Limits and terms** come from the linked pages. "Not read" means I did not get the text. Update times are from publisher docs or my own knowledge, not measured.

## Crypto prices

Read a candle by its open time. The sample is the minute 20:00 UTC, `1793476800`.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| [Coinbase Exchange](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits) | `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2026-10-31T20:00:00Z&end=2026-10-31T20:00:00Z` | No | 200 `*` | `[[1793476800,77428.19,77447.04,77428.19,77447.03,1.81031312]]` | Same, 3R | 10/s per IP, burst 15 | [Not read](https://www.coinbase.com/legal/market_data) (403 to me) | 1 min |
| Bitstamp | `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1&start=1793476800` | No | 200 `*` | `"close": "77445.82"` | Same, 3R | 400/s, 10,000 per 10 min (third-party summaries) | Not read | 1 min |
| [Kraken](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/) | `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=1793476740` | No | 200 `echo` | `[1793476800,"77432.9","77439.1","77432.9","77439.0",...]` | Closed rows same. Last row open | Not found | [Limits](https://www.kraken.com/legal/global-terms), section 9 | 1 min. **720 rows only, so 12 h** |
| [Binance Vision](https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf) | `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=1793476800000&limit=1` | No | 200 `*` | `...,"77603.96000000",...` | Same, 3R | Weight based, 429 then 418 ban | **Bars commercial use** | 1 min |
| OKX | `https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=1m&after=1793476860000&limit=1` | No | 200 `echo` | `"77560.1"` | Same | Not read | Not read | 1 min |
| Bybit | `https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&start=1793476800000&end=1793476800000&limit=1` | No | 200 `echo` | `"77554.8"` | Value same | Not read | Not read | 1 min |
| DefiLlama (aggregator) | `https://coins.llama.fi/prices/historical/1793476800/coingecko:bitcoin` | No | 200 `echo` | `"price":77489.09,"confidence":0.99` | Same | Not read | Not read | Cached 1 h |

Name one exchange and quote currency. The same minute closed at 77447 on Coinbase and 77604 on Binance, because USDT is not USD.

Rejected: Bitfinex (settles late, see above). CoinGecko (aggregator; 429 on first call, 200 fifteen minutes later). Pyth Hermes ([401](https://docs.pyth.network/price-feeds/core/fetch-price-updates), key required since August 2026). CryptoCompare (401, key). Gemini (200, returns the whole recent list, not one pinned candle).

### Binance by region

Binance has two hosts. Measured through public Globalping probes.

| Host | Ashburn | Boardman | Frankfurt | Helsinki | Singapore | Tokyo |
|---|---|---|---|---|---|---|
| `api.binance.com` | **451** | **451** | 200 | 200 | 200 | 200 |
| `fapi.binance.com` | **451** | Not measured | 200 | Not measured | Not measured | Not measured |
| `data-api.binance.vision` | 200 | 200 | 200 | 200 (Falkenstein) | 200 | 200 |

The 451 body names "a restricted location". Both hosts gave the same candle bytes where both answered. The Vision host fixes the block but not the terms: version 1.0 of 2026-08-26 covers "data.binance.vision and associated endpoints", says CC BY-NC-SA, and "Commercial licensing is strictly excluded". Whether `data-api` counts as an associated endpoint needs a lawyer. I did not get the text of Binance's main Terms of Use. Coinbase and Kraken answered 200 from all regions tried.

### WSS

Two sockets per feed, opened 3 s apart, held 14 s, both connected.

| Feed | Trades A / B | Seen by both |
|---|---|---|
| `wss://ws-feed.exchange.coinbase.com` | 55 / 56 | 47 |
| `wss://stream.binance.com:9443/ws/btcusdt@trade` | 19 / 20 | 16 |
| `wss://data-stream.binance.vision/ws/btcusdt@trade` | 5 / 4 | 1 |
| `wss://ws.kraken.com/v2` | 5 / 10 | 3 |
| `wss://ws.bitstamp.net` | 0 / 0 (no trades in the window) | 0 |
| `wss://mempool.space/api/v1/ws` | 12 / 15 messages | Blocks not compared |

Two nodes on a socket do not hold the same list. Use sockets for the live price on screen and settle from the closed REST candle. Measured from the test host only.

## FX and rates

Primary publishers throughout, so ranked by terms.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| ECB | `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2026-10-30&endPeriod=2026-10-30&format=csvdata` | No | 200 `*` | `...,2026-10-30,1.1172,A,F,...` | Same, 3R | Not found | [OK](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html): commercial use, credit, no changes | Daily, working days |
| NY Fed | `https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate=2026-10-29&endDate=2026-10-29` | No | 200 `echo` | `"percentRate": 3.94` | Same, 3R | Not found | [OK with notice](https://www.newyorkfed.org/privacy/termsofuse) | Daily, ~8:00 ET next day |
| US Treasury | `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange?filter=record_date:eq:2026-09-30,country_currency_desc:eq:Euro%20Zone-Euro` | No | 200 `*` | `"exchange_rate":"0.881"` | Same | Not stated | [Open, no token](https://fiscaldata.treasury.gov/api-documentation/) | Quarterly |
| Bank of Canada | `https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2026-10-30&end_date=2026-10-30` | No | 200 `*` | `"v": "1.3960"` | Same, 3R | Not published | [Limits](https://www.bankofcanada.ca/terms/): statistical use only | Daily |
| Bank of Japan | `https://www.stat-search.boj.or.jp/api/v1/getDataCode?format=json&lang=en&db=FM08&code=FXERD01&startDate=202610` | No | 200 `none` | USD/JPY 9:00 JST series | Value same | "Excessive" access barred | [Notice](https://www.stat-search.boj.or.jp/info/api_notice_en.pdf): email them before release, show their credit | Daily |
| Riksbank | `https://api.riksbank.se/swea/v1/Observations/SEKUSDPMI/2026-10-26/2026-10-30` | No | 200 `none` | `{"date":"2026-10-26","value":9.95576}` | Same, without Origin | [Not published](https://www.riksbank.se/en-gb/statistics/interest-rates-and-exchange-rates/retrieving-interest-rates-and-exchange-rates-via-api/faq--the-api-for-interest-rates-and-exchange-rates/) | Not read | Daily. **Empty if Origin is sent** |
| Bank of England | `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Oct/2026&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N` | No | 200 `none` | `01 Oct 2026,3.75` | Same | Not found | [Limits](https://www.bankofengland.co.uk/legal): non-commercial; some FX is LSEG's | Daily |

Also 200 and byte-stable, terms not read: Poland `api.nbp.pl` (`"mid":3.9251`), Brazil `api.bcb.gov.br` (`"valor":"5.4212"`), Czech `api.cnb.cz`, Australia `www.rba.gov.au`, Turkey `www.tcmb.gov.tr`, Bundesbank `api.statistiken.bundesbank.de`. Value same: Norges Bank, BIS.

Rejected: `home.treasury.gov` yield curve (200 after 18.5 s, timed out at 10 s from here, no answer from Ashburn or Frankfurt). [FRED](https://fred.stlouisfed.org/legal/) (keyless CSV works, terms bar scraping and commercial use; API needs a key). Frankfurter and open.er-api.com (thin mirrors, cached 1 day and 1 h).

## Equities and indices

**No keyless, stable, permitted source for prices.** Do not list one yet. Company-reported figures are the exception.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| [SEC EDGAR](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) (primary, filings only) | `https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Assets.json` | No, but **declared User-Agent** | 403 plain curl; 200 with UA, ACAO `*` on `/submissions`, `none` on this path | `"label":"Assets"` | Single read only | 10/s | Fair access rules read; reuse not read | On filing |
| Cboe delayed (undocumented) | `https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/_SPX.json` | No | 200 `none` | `"current_price": 7580.0698` | Value same, 3R 200 | Not found | Not read | Delayed. Not pinned to a date |
| MSCI (undocumented) | `https://app2.msci.com/products/service/index/indexmaster/getLevelDataForGraph?currency_symbol=USD&index_variant=STRD&start_date=20261001&end_date=20261030&data_frequency=DAILY&index_codes=990100` | No | 200 `none` | `"level_eod":4893.62` | Same, 3R | Not found | Not read | Daily |

The market was closed, so "same" here says nothing about trading hours.

Rejected: Nasdaq (curl error 92, HTTP/2 stream reset). Stooq (bot wall, old URL 404). Yahoo (429 here, 200 from AWS, undocumented). IEX (403). SIX (303 to a 404). Alpha Vantage (key; `demo` is IBM only). Pyth (key). FRED `SP500` and `DJIA` (200, but the page says "Reproduction of S&P 500 in any form is prohibited" without written permission). S&P's and MSCI's own licence terms not read; index levels are licensed products, so assume they need a contract.

## Commodities

**No keyless, permitted daily gold or oil price in JSON.** Oil is close through EIA.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| [EIA API](https://www.eia.gov/opendata/) (primary) | `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=DEMO_KEY&frequency=daily&data%5B0%5D=value&facets%5Bseries%5D%5B%5D=RWTC&sort%5B0%5D%5Bcolumn%5D=period&sort%5B0%5D%5Bdirection%5D=desc&length=1` | **Yes** (403 without; `DEMO_KEY` works, free key to register) | 200 `*` | `"period":"2026-10-27","value":"103.37"` | Same | `DEMO_KEY`: 10 | Reuse page not read | Weekly |
| EIA gas storage | `https://ir.eia.gov/ngs/wngsr.json` | No | 302 to a signed URL, then 200 | `"release_date":"2026-Oct-29"` | Single read | Not found | Not read | Weekly. Node must follow a redirect |
| EIA history page | `https://www.eia.gov/dnav/pet/hist/RWTCD.htm` | No | 200 `none` | HTML table, 470 KB | Single read | Not found | Not read | Weekly |
| World Bank Pink Sheet | `https://thedocs.worldbank.org/en/doc/18675f1d1639c7a34d463f59263ba0a2-0050012025/related/CMO-Historical-Data-Monthly.xlsx` | No | 200 `none` | Binary XLSX, 778 KB | Same | Not found | Not read | Monthly. Nodes cannot JSON-path it |

Rejected: [LBMA](https://www.ice.com/iba/licensing) (403 Cloudflare; ICE requires a licence to redistribute or price against it). CME (curl error 92). USDA NASS and MARS (401/403, key). FRED oil series (terms). Binance `XAUUSDT` perpetual (closed candle stable, 451 from the US, not bullion, Binance terms). Swissquote public feed (undocumented, bid and ask move, thin). gold-api.com (200, aggregator, no stated source, thin).

## Macro statistics

Very good outside the US. The US has no keyless GDP.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| [BLS](https://www.bls.gov/developers/api_faqs.htm) CPI | `https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0` | No (v1) | 200 `*` | `"period":"M09","value":"336.940"` | Value same, 3R 200 | **25 a day**, 50 per 10 s. Per IP or not: not stated | Federal data, page not read | Monthly, 8:30 ET |
| BLS payrolls | `https://api.bls.gov/publicAPI/v1/timeseries/data/CES0000000001` | No | 200 `*` | `"value":"159044"`, code `P` | Same at 5 s | As above | As above | Monthly. **Preliminary, then revised** |
| [Eurostat](https://ec.europa.eu/eurostat/help/copyright-notice) HICP | `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr?format=JSON&geo=EA&unit=RCH_A&coicop18=TOTAL&time=2026-09` | No | 200 `*` | `"value":{"0":3.8}` | Same | Not found | OK with credit. Non-EU data not for commercial reuse | Monthly |
| Eurostat jobless rate | `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/une_rt_m?format=JSON&geo=EA21&age=TOTAL&sex=T&s_adj=SA&unit=PC_ACT&time=2026-09` | No | 200 `*` | `"value":{"0":6.5}` | Same, 3R | Not found | As above | Monthly. `EA20` returns empty; use `EA21` |
| [ONS](https://developer.ons.gov.uk/) | `https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7g7/mm23/data` | No | 200 `*` | `"date":"2026 SEP","value":"3.5"` | Same | [120/10 s, 200/min](https://developer.ons.gov.uk/bots/) | OGL v3 | Monthly, next 18 Nov |
| [ABS](https://www.abs.gov.au/about/data-services/application-programming-interfaces-apis/data-api-user-guide) | `https://data.api.abs.gov.au/rest/data/ABS,CPI,2.0.0/1.10001.10.50.Q?startPeriod=2026-Q3&endPeriod=2026-Q3&format=jsondata` | No | 200 `echo` | `2026-Q3: 103.64` | Value same, 3R 200 | Not stated. Beta | Not read | Quarterly |
| [StatCan](https://www.statcan.gc.ca/en/developers/wds/user-guide) | POST `https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods` with `[{"vectorId":41690973,"latestN":1}]` | No | 200 `*` | `"refPer":"2026-09-01","value":170.0` | Single read | 25/s per IP | Not stated | Daily, 8:30 ET. May return 409 from midnight to 8:30 ET |

Aggregators, second rank, later than the publisher: OECD `sdmx.oecd.org` (200, cached 2 h), IMF `api.imf.org` (200 keyless, value same, `3.7377` for 2026-M09), World Bank `api.worldbank.org` (200, annual GDP, cached 4 h).

Rejected: BEA (200 with empty body without a key; from memory it takes a registered UserID, docs not read). Census (302 to `missing_key.html`). FRED CPI, payrolls, GDP (200, terms bar it). `www.bls.gov` pages (403 to curl). Statistics Norway dataset 1086 (410, retired). Destatis (307 redirect, not followed). ECB `ICP` old key (stops 2025-12). Eurostat `prc_hicp_manr` (frozen; [v1 datasets archived](https://ec.europa.eu/eurostat/web/hicp/information-data)).

## Elections and official results

Good where a national body publishes files. **No keyless national source for the US.** There is no federal results feed: states publish separately. AP's feed needs a [paid account](https://elex.readthedocs.io/). Certified results can take weeks, so a market should name the phase it settles on.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| German Federal Returning Officer | `https://www.bundeswahlleiterin.de/bundestagswahlen/2025/ergebnisse/opendata/btw25/csv/kerg2.csv` | No | 200 `none` | CSV 1.8 MB, licence in header | Same | Not found | [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0): commercial OK | Per election |
| Swiss Federal Statistical Office | `https://app-prod-static-voteinfo.s3.eu-central-1.amazonaws.com/v1/ogd/sd-t-17-02-20260927-eidgAbstimmung.json` | No | 200 `none` | `"jaStimmenInProzent": 29.84`, `"vorlageAngenommen": false` | Same | Not found | Not read (403 to me) | Per vote. Date in file name |
| Australian Electoral Commission | `https://results.aec.gov.au/31496/Website/Downloads/HouseFirstPrefsByPartyDownload-31496.csv` | No | 200 `none` | `Phase:FinalResults` in the first line | Same | Not found | Not read | Per election |
| North Carolina State Board (one state) | `https://er.ncsbe.gov/enr/20241105/data/results_0.txt` | No | 200 `*` | `"bnm":"Donald J. Trump","vct":"2898423"` | Same | Not found | Not read | Date in path. 2026 path not tested |
| UK Parliament | `https://members-api.parliament.uk/api/Location/Constituency/4047/ElectionResults` | No | 200 `*` | `"result":"Con Hold","majority":121` | Same | Not found | Open Parliament Licence, page 403 to me | After each election |
| Elections Canada | `https://enr.elections.ca/DownloadResults.aspx` | No | 200 `none` | Tab text | Value same; first line is a clock | Not found | Not read | Live on the night |

Rejected: Georgia Clarity (403), Arizona (403 bot check), California SoS (500), New Zealand (403), Virginia (404). Brazil TSE (config file 200, `ele2026` listed, but every results path I tried gave 404). FEC (key, and it is filings, not results). India `results.eci.gov.in` (HTML, 200). European Parliament results path 404.

**User-editable, do not list:** Wikipedia and Wikidata (`www.wikidata.org` 200, last edit same day). Democracy Club (200, volunteer project). **Circular:** Polymarket Gamma (200, a market's own answer). **Unresolved:** `www.data.gouv.fr` hosts many publishers; I could not confirm who may post, so do not list the host.

## Sports

**Nothing passes.** League feeds answer and are stable, but their terms bar this use. Keyless feeds with open terms are user-edited. This needs a paid licence or a decision to accept the risk.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| MLB (official) | `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28` | No | 200 `*` | `"detailedState":"Final"`, 4-1 | Same, 3R | Not found | [Bad](https://gdx.mlb.com/components/copyright.txt): individual, non-commercial, non-bulk | Live |
| NHL (official) | `https://api-web.nhle.com/v1/score/2026-10-29` | No | 200 `none` | `WPG 4, TBL 6, "OFF"` | Same | Not found | [Bad](https://www.nhl.com/info/terms-of-service): no scraping, non-commercial | Live |
| ESPN (undocumented) | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261025` | No | 200 `*` | `"PIT VS NO"`, `STATUS_FINAL`, 10-16 | Same, 3R (first 10 KB) | Not found | [Bad](https://disneytermsofuse.com/english/): no bots, no commercial use | Live |
| UEFA (undocumented) | `https://match.uefa.com/v5/matches?competitionId=1&fromDate=2026-10-21&toDate=2026-10-21&limit=1&offset=0&order=ASC` | No | 200, ACAO `www.uefa.com` | `"status":"FINISHED"`, `"home":2,"away":4` | Same, 3R (first 10 KB) | Not found | Not read. Cached 20 min | Live |
| FIFA (undocumented) | `https://api.fifa.com/api/v3/calendar/matches?from=2026-07-19T00:00:00Z&to=2026-07-20T00:00:00Z&language=en&count=2` | No | 200 `*` | Scores, `MatchStatus` | Same, 3R | Not found | Not found | Live |
| [Jolpica F1](https://github.com/jolpica/jolpica-f1/blob/main/docs/rate_limits.md) (community) | `https://api.jolpi.ca/ergast/f1/2026/last/results.json?limit=1` | No | 200 `*` | `"Antonelli"` | Same | 4/s, 500/h, "will decrease" | Not read | After races. Thin |

Rejected: NBA CDN (403 Akamai, also from AWS). Premier League FPL (403 in Frankfurt; `finished` stays false for hours after full time). football-data.org ([token](https://www.football-data.org/client/register), 10/min). OpenF1 (401: all access keyed during live sessions). Sofascore (403). NCAA (404).

**User-editable, do not list:** [OpenLigaDB](https://www.openligadb.de/) (200 keyless, ODbL, but any registered user enters results, so a market creator could). [TheSportsDB](https://www.thesportsdb.com/docs_api) (key `123`, 30/min, editor programme).

## Weather and climate

Best category. US government data has few conditions. Settle on one named station.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| [NWS](https://www.weather.gov/documentation/services-web-api) | `https://api.weather.gov/stations/KNYC/observations?start=2026-10-31T00:00:00Z&end=2026-10-31T02:00:00Z` | No, asks for a User-Agent | 200 `*` | `"value": 14.4`, degC, on the latest route | Same, 3R | Not public, ~5 s retry | OK: "free to use for any purpose" | About hourly |
| NWS daily climate report | `https://api.weather.gov/products/types/CLI/locations/NYC` | No | 200 `*` | Index of text products | Same | As above | As above | Daily. Text, needs parsing |
| NOAA Aviation Weather | `https://aviationweather.gov/api/data/metar?ids=KJFK&format=json&date=2026-10-31T20:00:00Z&hours=1` | No | 200 `none` | `"temp":15.6`, `"reportTime":"2026-10-31T20:00:00.000Z"` | Same, 3R | Not read | Not read | Hourly |
| NOAA NCEI daily | `https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries&stations=USW00094728&startDate=2026-10-28&endDate=2026-10-28&dataTypes=TMAX,TMIN,PRCP&format=json&units=metric` | No | 200 `*` | `"TMAX":"16.1","TMIN":"7.2"` | Same | Not found | Not read | Lags about 3 days |
| [MeteoSwiss](https://opendatadocs.meteoswiss.ch/general/terms-of-use) | `https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/sma/ogd-smn_sma_d_recent.csv` | No | 200 `*` | `SMA;30.10.2026 00:00;7.1;9.6;5.1;...` | Same | "Excessive use" barred | OK: CC BY 4.0, commercial | Daily |
| [DWD](https://opendata.dwd.de/climate_environment/REA/Terms_of_use_REA.txt) | `https://opendata.dwd.de/weather/weather_reports/poi/10637-BEOB.csv` | No | 200 `none` | Frankfurt hourly, comma decimals | Same at 5 s, rolling file | Not found | OK with credit (REA terms; assumed to apply) | Hourly |
| NOAA GML CO2 | `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv` | No | 200 `*` | `2026,9,...,426.07` | Same | Not found | "Freely available", file header | Monthly. Revisable |
| NASA GISTEMP | `https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv` | No | 200 `none` | `2026 Sep: 1.38` | Same | Not found | Not read; US government work | Monthly. **Revises back data** |
| NOAA global anomaly | `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series/globe/tavg/land_ocean/1/9/2026-2026/data.json` | No | 200 `*` | `"departure":1.33` | Same | Not found | Not read | Monthly |
| Copernicus Climate Pulse | `https://sites.ecmwf.int/data/climatepulse/data/series/era5_daily_series_2t_global.csv` | No | 200 `none` | `2026-10-28,14.937,...,FINAL` | Same | Not found | Copernicus licence, not read | Daily. Settle only on `FINAL` |

Also 200: USGS earthquakes `earthquake.usgs.gov` (`metadata.generated` changes), NHC `www.nhc.noaa.gov/CurrentStorms.json` (`"activeStorms": []`).

Rejected: [Open-Meteo](https://open-meteo.com/en/terms) (works, model output, free tier non-commercial). Bright Sky (DWD mirror). NASA POWER (200, model data, value same).

## Bitcoin chain data

Read your own node first. For an HTTP source, read by height or hash, never the tip.

| Source | Endpoint | Key | HTTP/ACAO | Sample | Two reads | Rate limit | Terms | Updates |
|---|---|---|---|---|---|---|---|---|
| Seat's `bitcoind` | RPC, not HTTP | No | Not measured here | | | None | None | Each block |
| [mempool.space](https://mempool.space/docs/api/rest) | `https://mempool.space/api/block/000000000000000000010538edbfd2d5b809a33dd83f284aeea41c6d0d96968a` | No | 200 `*` | `"height":900000,"tx_count":1562` | Same | [Unpublished](https://github.com/mempool/mempool/discussions/752), 429 then ban | Not read; maintainer says run your own node | Immutable once deep |
| mempool.space height to hash | `https://mempool.space/api/block-height/900000` | No | 200 `*` | `000000000000000000010538...` | Same, 3R | As above | As above | Immutable once deep |
| Blockstream | `https://blockstream.info/api/block-height/900000` | No | 200 `*` | Same hash | Same, 3R | Not found | Not read | Immutable once deep |
| Blockchain.com | `https://blockchain.info/q/getblockcount` | No | 200 `*` | `974025` | Same at 5 s, then 974026 | Not found | Not read | Tip, not fixed |
| Coin Metrics Community | `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=HashRate,TxCnt&frequency=1d&start_time=2026-10-20&end_time=2026-10-21` | No | 200 `*` | `"TxCnt":"800236"` | Same | 6000 per 20 s, header | Not read | Daily, derived |

Block JSON for height 900,000 matched field by field between mempool.space and Blockstream. Block hashes matched on mempool.space, Blockstream and blockchain.info. Tip hash matched on all three at one moment; all moved one block in the next 17 minutes.

Deep blocks are safe. A value depending on the tip needs a fixed height at least 6 deep. Fees and `difficulty-adjustment` are live estimates and moved. Hashrate is an estimate per provider and not a chain fact. blockchain.info `/stats` showed `total_fees_btc: -46250000000`: do not trust that endpoint. Bitnodes moved (302 to `btcnodes.io`). Blockchair and btcscan.org worked but are thin.

## Not measured

- **The moment of release.** No publisher posted during the test, and markets were closed. Cache windows above are from headers, not from watching two nodes straddle a release.
- **Regions.** Only the "3R" rows and the Binance table left the test host. The probes sent no Origin header.
- **Candle freeze.** Four quiet weekend minutes. A busy minute may settle later, hence 30 s rather than 20.
- **WSS from outside Switzerland**, and WSS from the US to Binance.
- **Long-term stability.** One evening cannot show whether a URL survives. Eurostat archived a dataset this year and Statistics Norway removed one, so expect it.
- **Terms marked "not read".** Treat as unknown, not as allowed.
