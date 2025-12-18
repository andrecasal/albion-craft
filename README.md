# Albion Craft

A comprehensive market analysis and crafting profitability calculator for Albion Online.

## Quick Links

- 📚 [Full Documentation](docs/README.md)
- 🚀 [Quick Start Guide](docs/QUICKSTART.md)
- 🏗️ [Architecture & Design](docs/ARCHITECTURE.md)

## What It Does

Analyzes ~6,500 items across 7 cities to identify the most profitable crafting opportunities based on:
- Real-time market data (prices, demand, supply signals)
- Material costs and availability
- Crafting fees and resource return rates
- User-specific stats (premium, focus, specialization)

## Quick Start

```bash
# Install dependencies
npm install

# One-time setup (or run after game updates)
npm run setup:all  # Runs all setup scripts

# OR run setup scripts individually:
npm run setup:convert-items         # Convert items CSV to JSON
npm run setup:extract-materials     # Extract materials from recipes
npm run setup:fetch-material-names  # Fetch official names from API

# Fetch current data (run frequently)
npm run fetch:prices      # Fetch material prices from AODP API
npm run fetch:sample-data # Create sample market data for testing

# Run profitability analysis
npm run dev
```

## Project Structure

```
albion-craft/
├── docs/                           # 📚 Documentation
│   ├── README.md                   # Full docs
│   ├── QUICKSTART.md              # Quick start
│   └── ARCHITECTURE.md            # Design decisions
├── src/                            # 💻 TypeScript source
│   ├── types/                      # Type definitions
│   ├── services/                   # Business logic
│   └── cli.ts                      # CLI entry point
├── scripts/                        # 🔧 Data fetching scripts
│   ├── setup/                      # One-time setup scripts
│   │   ├── convert-items-csv.js
│   │   ├── extract-materials.js
│   │   └── fetch-material-names.js
│   └── operations/                 # Regular operational scripts
│       ├── material-prices-fetcher.js
│       └── create-sample-market-data.js
├── data/                           # 📦 Data files
│   ├── static/                     # Static data (version controlled)
│   │   ├── items.json             # All items (6,400)
│   │   ├── recipes.json           # Crafting recipes (1,340)
│   │   └── materials.json         # Materials list (282)
│   └── generated/                  # Generated data (gitignored)
│       ├── material-prices.json   # Fetched prices
│       └── market-data.json       # Market data
├── for-reference/                  # 🗂️ Legacy (to be deleted)
└── reports/                        # 📊 Generated reports (gitignored)
```

## Features

- ✅ No API quota limits (local processing)
- ✅ Fast calculations (process 6,500 items in seconds)
- ✅ Type-safe TypeScript architecture
- ✅ Supply signal analysis (rising/stable/falling markets)
- ✅ ROI and profit rank calculations
- ✅ City-specific opportunity reports
- ✅ Configurable user stats

## Current Status

- ✅ Material prices fetcher
- ✅ Profitability calculation engine
- ✅ Report generator
- 🚧 Market data fetcher (needed)
- ⏳ SQLite migration (future)
- ⏳ Web dashboard (future)

## Next Steps

1. **Get Market Data**: Export from Google Sheets or create a fetcher
2. **Run Analysis**: Generate profitability reports
3. **Automate**: Set up cron jobs for regular updates
4. **Extend**: Add web dashboard, alerts, etc.

See [docs/README.md](docs/README.md) for detailed information.

## License

MIT
