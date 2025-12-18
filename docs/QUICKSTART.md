# Quick Start Guide

Get the profitability analyzer running in 5 minutes!

## Prerequisites

- Node.js 18+ installed
- Albion Online market data (from Google Sheets or API)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Extract Materials

```bash
npm run extract-materials
```

This extracts 282 unique materials from recipes.json and creates:
- `materials.json`
- `materials.csv`
- `materials-list.js`

### 3. Fetch Material Prices

```bash
npm run fetch-material-prices
```

This fetches current material prices from the AODP API. It will:
- Fetch prices for 282 materials across 7 cities
- Take ~6 batches (50 materials per batch)
- Save progress to `material-prices-progress.json`
- Output `material-prices.json` and `material-prices.csv`

**Expected time**: ~1-2 minutes
**Expected output**: ~1,974 price records

### 4. Get Market Data

You have two options:

#### Option A: Use Sample Data (For Testing)

```bash
npm run create-sample-market-data
```

This creates a minimal `market-data.json` with 4 sample items for testing.

#### Option B: Export from Google Sheets (For Production)

1. Open your Google Sheet with MARKET_DATA
2. File → Download → Comma-separated values (.csv)
3. Save as `market-data.csv` in the project root
4. Convert to JSON manually or use a CSV-to-JSON tool

Expected format:
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

### 5. Run Profitability Analysis

```bash
npm run dev
```

This will:
1. Load all data files
2. Calculate profitability for all craftable items
3. Generate reports in `./reports/` directory

## View Results

Check the `reports/` directory for CSV files:

- **all-opportunities.csv** - All profitable items sorted by profit rank
- **top-opportunities-by-rank.csv** - Top 100 by profit rank
- **top-opportunities-by-roi.csv** - Top 100 by ROI %
- **caerleon-opportunities.csv** - Caerleon-specific opportunities
- **bridgewatch-opportunities.csv** - Bridgewatch-specific opportunities
- etc.

## Configuration

Edit user stats in [src/cli.ts](src/cli.ts) (lines 11-17):

```typescript
const DEFAULT_USER_STATS: UserStats = {
  premiumStatus: true,       // Premium account
  baseReturnRate: 43.9,      // 43.9% with focus, 15.2% without
  useFocus: true,
  specializationBonus: 0,    // 0-100 (adds 0.2% per level)
  craftingTaxRate: 3.5,      // Market tax %
};
```

Then run `npm run dev` again to recalculate with new settings.

## Troubleshooting

### "recipes.json not found"
Make sure you have `recipes.json` in the project root from your earlier fetcher.

### "material-prices.json not found"
Run `npm run fetch-material-prices` first.

### "market-data.json not found"
Run `npm run create-sample-market-data` for testing, or export from Google Sheets.

### "Cannot find module 'typescript'"
Run `npm install` to install all dependencies.

## Next Steps

1. **Automate market data fetching**: Create a market-data-fetcher.js similar to material-prices-fetcher.js
2. **Schedule updates**: Use cron jobs to refresh prices hourly
3. **Add filters**: Modify CLI to filter by city, min ROI, or item type
4. **Build web dashboard**: Create a web interface for easier analysis

## Support

Check the main [README.md](README.md) for detailed documentation on:
- Architecture overview
- Data flow
- Profitability formulas
- Future roadmap

## Quick Reference

```bash
# Extract materials from recipes
npm run extract-materials

# Fetch material prices from AODP
npm run fetch-material-prices

# Create sample market data for testing
npm run create-sample-market-data

# Run profitability analysis
npm run dev

# Build TypeScript (optional)
npm run build
```

That's it! You now have a local profitability analyzer running. 🎉
