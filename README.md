# Albion Craft - Profitability Analyzer

A comprehensive market analysis and crafting profitability calculator for Albion Online.

## Overview

This tool analyzes ~6,500 items across 7 cities to identify the most profitable crafting opportunities based on:
- Real-time market data (prices, demand, supply signals)
- Material costs and availability
- Crafting fees and resource return rates
- User-specific stats (premium, focus, specialization)

## Features

- **Market Analysis**: Tracks demand, prices, and price trends for all items
- **Supply Signals**: Identifies rising/stable/falling markets using 7-day price trends
- **Profitability Calculation**: Calculates ROI with accurate material costs and return rates
- **Opportunity Ranking**: Weights profit by demand and supply signals
- **City-Specific Reports**: Generates separate opportunity lists for each city
- **Flexible Configuration**: Customize user stats (premium, focus, specialization)

## Architecture

### Local TypeScript Application
Moved from Google Sheets to local Node.js/TypeScript for:
- ✅ No quota limits on API calls
- ✅ Faster calculations (process all items in seconds)
- ✅ Better data management with SQLite (future)
- ✅ Extensible architecture for web dashboard

### Project Structure

```
albion-craft/
├── src/
│   ├── types/              # TypeScript type definitions
│   │   └── index.ts
│   ├── services/           # Core business logic
│   │   ├── data-loader.ts          # Load data from JSON/CSV
│   │   ├── profitability-calculator.ts  # Calculate profitability
│   │   └── report-generator.ts     # Generate CSV/JSON reports
│   └── cli.ts              # CLI application entry point
├── reports/                # Generated opportunity reports
├── recipes.json            # Crafting recipes data
├── materials.json          # Unique materials list
├── material-prices.json    # Material prices (fetched from AODP)
├── market-data.json        # Market data (demand, prices, trends)
├── extract-materials.js    # Extract materials from recipes
├── material-prices-fetcher.js  # Fetch material prices from AODP
└── package.json
```

### Data Flow

```
1. Recipes (recipes.json)
   ↓
2. Extract Materials → materials.json
   ↓
3. Fetch Material Prices (AODP API) → material-prices.json
   ↓
4. Load Market Data (from Google Sheets export) → market-data.json
   ↓
5. Calculate Profitability (TypeScript)
   ↓
6. Generate Reports (CSV/JSON)
```

## Installation

```bash
npm install
```

## Usage

### Step 1: Extract Materials from Recipes

```bash
npm run extract-materials
```

Output: `materials.json`, `materials.csv`, `materials-list.js` (282 unique materials)

### Step 2: Fetch Material Prices

```bash
npm run fetch-material-prices
```

This will:
- Fetch prices for 282 materials across 7 cities from AODP API
- Handle rate limiting with exponential backoff
- Save progress to `material-prices-progress.json` (resumable)
- Output `material-prices.json` and `material-prices.csv`

Expected output: ~1,974 price records (282 materials × 7 cities)

### Step 3: Export Market Data from Google Sheets

**TODO**: Create market data fetcher or export from Google Sheets

For now, manually export the MARKET_DATA sheet to `market-data.json`:

```json
[
  {
    "itemId": "T4_BAG",
    "city": "Caerleon",
    "dailyDemand": 15.2,
    "lowestSellPrice": 8500,
    "price7dAvg": 8200,
    "dataAgeHours": 2.5,
    "confidence": 0.95,
    "availableCapacity": 152,
    "priceTrendPct": 3.66,
    "supplySignal": "🟢 Rising",
    "marketSignal": "Strong"
  }
]
```

### Step 4: Run Profitability Analysis

```bash
npm run dev
# or
npm run calculate
```

This will:
1. Load recipes, material prices, and market data
2. Calculate profitability for all items in all cities
3. Generate reports in `./reports/` directory:
   - `all-opportunities.csv` - All profitable items sorted by profit rank
   - `top-opportunities-by-rank.csv` - Top 100 by profit rank
   - `top-opportunities-by-roi.csv` - Top 100 by ROI %
   - `caerleon-opportunities.csv` - Caerleon-specific opportunities
   - `bridgewatch-opportunities.csv` - Bridgewatch-specific opportunities
   - etc.

## Configuration

Edit user stats in [src/cli.ts](src/cli.ts:11-17):

```typescript
const DEFAULT_USER_STATS: UserStats = {
  premiumStatus: true,       // Premium account
  baseReturnRate: 43.9,      // 15.2% (no focus) or 43.9% (with focus)
  useFocus: true,            // Use focus when crafting
  specializationBonus: 0,    // 0-100 specialization levels
  craftingTaxRate: 3.5,      // Market tax rate (%)
};
```

## Profitability Calculation

### Return Rate Formula
```
Return Rate = Base (15.2% or 43.9% with focus)
            + Premium (20%)
            + Specialization (0.2% per level, max 20%)
```

### Cost & Profit Formulas
```
Material Cost = Σ(Material_Price × Quantity)
Effective Cost = Material Cost × (1 - Return Rate)
Total Cost = Effective Cost + Crafting Fee

Gross Revenue = Sell Price × (1 - Tax Rate)
Net Profit = Gross Revenue - Total Cost
ROI % = (Net Profit / Total Cost) × 100
```

### Profit Rank (Opportunity Score)
```
Profit Rank = (Net Profit × Daily Demand × Supply Multiplier) / 1000

Supply Multiplier:
  🟢 Rising (+10% trend) = 1.5
  🟡 Stable (-10% to +10%) = 1.0
  🔴 Falling (<-10% trend) = 0.5
```

## Data Sources

- **Recipes**: Official Albion API (`https://gameinfo.albiononline.com/api/gameinfo/items/{ITEM_ID}/data`)
- **Material Prices**: AODP API (`https://west.albion-online-data.com/api/v2/stats/prices/`)
- **Market Data**: AODP API (`https://west.albion-online-data.com/api/v2/stats/history/`)

## Roadmap

### Phase 3: Complete Local Transition
- [ ] Create market data fetcher (similar to material prices fetcher)
- [ ] Migrate to SQLite for faster queries
- [ ] Add configuration file (`config.json`) for user stats
- [ ] Add CLI arguments (`--city`, `--min-roi`, `--top-n`)

### Phase 4: Automation & Monitoring
- [ ] Auto-refresh data on schedule (cron jobs)
- [ ] Price alerts (notify when opportunities appear)
- [ ] Historical tracking (monitor profit trends over time)

### Phase 5: Web Dashboard
- [ ] Build React/Next.js web interface
- [ ] Real-time data updates
- [ ] Interactive charts and filters
- [ ] Mobile-responsive design

## Current Blocker: Market Data

The main blocker is getting market data into `market-data.json`. Two options:

1. **Manual Export**: Export MARKET_DATA sheet from Google Sheets as JSON
2. **Create Fetcher**: Build a Node.js script similar to material-prices-fetcher.js

For the fetcher, you'll need to:
- Fetch demand data from AODP API (7-day history endpoint)
- Calculate Daily_Demand, Price_7d_Avg, Price_Trend_Pct
- Assign Supply_Signal based on trend
- Export to market-data.json

## FAQ

**Q: Why move away from Google Sheets?**
A: Google Apps Script has a 20,000 URL fetch/day quota, which we exceed when fetching prices for 6,500 items × 7 cities. Local scripts have no such limits.

**Q: Can I still use Google Sheets for data storage?**
A: Yes! You can continue using Sheets as a data store and export to JSON/CSV for local analysis. Eventually, migrating to SQLite will provide better performance.

**Q: How often should I refresh material prices?**
A: Albion markets are dynamic. Run material prices fetcher every 1-6 hours depending on your needs.

**Q: What if I don't have market data?**
A: You can start with a subset. Export a few hundred items from your Google Sheets MARKET_DATA and test the profitability calculator first.

## License

MIT
