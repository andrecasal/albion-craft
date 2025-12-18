# Project Status

**Last Updated**: December 18, 2024

## Overview

Albion Craft is a profitability calculator for Albion Online that helps players identify the most profitable crafting opportunities based on real-time market data.

## Project Phases

### Phase 0: Data Setup ✅ COMPLETED

**Goal**: Organize static game data (items, materials, recipes, game constants)

**Status**: ✅ Complete

**Completed Tasks**:
- ✅ Converted items.csv to JSON (6,465 items)
- ✅ Extracted materials list (282 unique materials)
- ✅ Fetched material names from Official Albion API
- ✅ Organized recipes.json (1,340 recipes)
- ✅ Created src/constants/ folder structure
- ✅ Created game constants files:
  - taxes.json (market taxes: 8%/4% sales tax, 2.5% listing fee)
  - return-rates.json (production bonuses by city)
- ✅ Set up TypeScript project with proper types
- ✅ Created data-loader service for loading all static data
- ✅ Created production-calculator utilities (RRR formulas)

**Key Files**:
- [src/constants/items.json](src/constants/items.json) - All game items
- [src/constants/materials.json](src/constants/materials.json) - Crafting materials
- [src/constants/recipes.json](src/constants/recipes.json) - Crafting recipes
- [src/constants/taxes.json](src/constants/taxes.json) - Market and listing taxes
- [src/constants/return-rates.json](src/constants/return-rates.json) - Production bonuses
- [src/types/index.ts](src/types/index.ts) - TypeScript type definitions
- [src/services/data-loader.ts](src/services/data-loader.ts) - Data loading service
- [src/utils/production-calculator.ts](src/utils/production-calculator.ts) - RRR calculations

---

### Phase 1: Market Demand & Supply Analysis ✅ COMPLETED

**Goal**: Determine how many of each item to craft to satisfy market demand for the next X days

**Key Question**: "How many of each item should I craft and put up for sale to satisfy the market for the next X days?"

**Status**: ✅ Complete

**Completed Tasks**:
- ✅ Integrated Albion Online Data Project (AODP) API
- ✅ Created market data fetcher with current prices and historical data
- ✅ Implemented price trend analysis (7-day averages)
- ✅ Calculate supply signals from price trends (🟢 Rising, 🟡 Stable, 🔴 Falling)
- ✅ Created market analyzer service with demand analysis
- ✅ Added user settings for target days of supply
- ✅ Implemented resume capability for long-running fetches
- ✅ Added confidence scoring based on data freshness

**Key Files**:
- [scripts/operations/market-data-fetcher.js](scripts/operations/market-data-fetcher.js) - Fetches market data from AODP
- [src/services/market-analyzer.ts](src/services/market-analyzer.ts) - Analyzes market demand and supply
- [src/services/user-settings.ts](src/services/user-settings.ts) - User preferences management

**Features**:
- Batch fetching with rate limiting (50 items/request, 1s delay)
- Historical price data for 7-day trend analysis
- Supply signal calculation based on price trends
- Configurable market analysis (conservative/balanced/aggressive presets)
- User settings persistence (saved to user-settings.json)
- Progress tracking with resume capability

**Usage**:
```bash
# Fetch market data
npm run fetch:market-data

# Output: data/generated/market-data.json
```

---

### Phase 2: Profitability Calculation 🔜 NEXT PHASE

**Goal**: Calculate which items yield the most profit given current market demand

**Key Question**: "Given the quantity of each item the market is demanding right now, what items would yield the most profit?"

**Tasks**:
- [ ] Implement crafting cost calculator
  - Calculate raw material costs
  - Apply Resource Return Rate (RRR) based on production bonuses
  - Include crafting fees (user input at runtime)
- [ ] Calculate revenue
  - Apply market sales tax (8% without premium, 4% with premium)
  - Apply listing fee (2.5%)
  - Calculate gross revenue
- [ ] Calculate profitability metrics
  - Net profit per item
  - ROI percentage
  - Profit per focus point (if using focus)
- [ ] Rank opportunities
  - Weight by demand
  - Filter by supply signal
  - Sort by profitability
- [ ] Generate opportunity reports per city

**User Inputs Needed at Runtime**:
- Premium status (affects sales tax: 8% vs 4%)
- Focus usage (yes/no, affects RRR)
- Specialization levels (affects city bonuses)
- Crafting/refining service fee (dynamic, changes per station)

**Deliverables**:
- Profitability calculator service (src/services/profitability-calculator.ts)
- User settings prompt/config
- Report generator (src/services/report-generator.ts)
- CLI interface for viewing results

**Success Criteria**:
- Accurate cost calculations including RRR
- Accurate profit calculations including all taxes
- Can process 45,000+ opportunities (6,465 items × 7 cities) in < 10 seconds
- Results ranked by weighted profitability score

---

### Phase 3: Shopping List Generator 🔜 PLANNED

**Goal**: Create a shopping list of materials needed to craft the most profitable items

**Key Question**: "What materials do I need to buy to craft and sell the most profitable items?"

**Tasks**:
- [ ] Aggregate material requirements for top N opportunities
- [ ] Calculate total quantities needed
- [ ] Fetch current buy prices for materials
- [ ] Calculate total shopping cost
- [ ] Generate formatted shopping list
- [ ] Add support for batch crafting (craft multiple of same item)
- [ ] Show expected profit after material costs

**User Inputs**:
- Number of top opportunities to include
- Total silver budget available
- Focus points available

**Deliverables**:
- Shopping list generator (src/services/shopping-list-generator.ts)
- Material aggregator utility
- Budget optimizer (maximize profit within budget)
- Export to CSV/JSON

**Success Criteria**:
- Accurate material quantity calculations
- Respects user budget constraints
- Optimizes for maximum profit within constraints
- Easy to follow shopping list format

---

## Current Status

**Active Phase**: Phase 1 (Market Demand & Supply) - ✅ Complete
**Next Phase**: Phase 2 (Profitability Calculation)

## File Organization

### Source Code (src/)
```
src/
├── constants/              # Static game data (JSON files)
│   ├── items.json
│   ├── materials.json
│   ├── recipes.json
│   ├── taxes.json
│   └── return-rates.json
├── types/                  # TypeScript type definitions
│   └── index.ts
├── services/               # Business logic services
│   ├── data-loader.ts      # ✅ Load static data
│   ├── market-analyzer.ts  # ⏳ Analyze market demand/supply
│   ├── profitability-calculator.ts  # ⏳ Calculate profits
│   ├── report-generator.ts # ⏳ Generate reports
│   └── shopping-list-generator.ts   # ⏳ Generate shopping lists
├── utils/                  # Utility functions
│   └── production-calculator.ts  # ✅ RRR calculations
└── cli.ts                  # ⏳ CLI interface
```

### Scripts (scripts/)
```
scripts/
├── setup/                  # One-time setup scripts
│   ├── convert-items-csv.js        # ✅ Convert items.csv to JSON
│   ├── extract-materials.js        # ✅ Extract materials from recipes
│   └── fetch-material-names.js     # ✅ Fetch material names from API
└── operations/             # Regular operation scripts
    ├── material-prices-fetcher.js  # ⏳ Fetch material prices
    └── market-data-fetcher.js      # ⏳ Fetch market data (Phase 1)
```

### Data (data/)
```
data/
├── generated/              # Generated/fetched data (gitignored)
│   ├── material-prices.json    # ⏳ Fetched material prices
│   └── market-data.json        # ⏳ Fetched market data
└── reports/                # Generated reports (gitignored)
    └── opportunities-{city}.csv
```

## Next Actions

### Immediate (Phase 1 Start)
1. Create market-data-fetcher.js script
2. Integrate AODP API for market data
3. Implement price trend analysis
4. Add supply signal calculation
5. Create market-analyzer service

### After Phase 1
1. Implement profitability-calculator service (Phase 2)
2. Create CLI prompts for user settings (Phase 2)
3. Generate opportunity reports (Phase 2)
4. Build shopping list generator (Phase 3)

## npm Scripts

### Setup (one-time)
```bash
npm run setup:convert-items    # Convert items.csv to JSON
npm run setup:extract-materials # Extract materials from recipes
npm run setup:fetch-material-names # Fetch material names
npm run setup:all              # Run all setup scripts
```

### Operations (run frequently)
```bash
npm run fetch:prices           # Fetch material prices from AODP
npm run fetch:market-data      # ⏳ Fetch market data (Phase 1)
```

### Application
```bash
npm run build                  # Compile TypeScript
npm start                      # Run compiled application
npm run dev                    # Run in development mode
npm run calculate              # Alias for dev
```

### Utilities
```bash
npm run calc:rrr              # Calculate RRR values for different scenarios
```

## Performance Targets

- **Material prices fetch**: < 2 minutes for 282 materials
- **Market data fetch**: < 5 minutes for 6,465 items × 7 cities
- **Profitability calculation**: < 10 seconds for 45,000+ opportunities
- **Report generation**: < 5 seconds

## Success Criteria (Production Ready)

- ✅ All static data organized and loaded correctly
- ⏳ Market data fetcher works reliably
- ⏳ Price trends accurately reflect supply conditions
- ⏳ Profitability calculations are accurate (verified against Google Sheets)
- ⏳ All calculations run in < 15 seconds total
- ⏳ CLI is user-friendly and intuitive
- ⏳ Shopping list generator optimizes within budget

## Documentation

- [README.md](README.md) - Project overview and quick start
- [docs/](docs/) - Detailed documentation
- This file - Project phases and current status

---

**Status Summary**:
- Phase 0 (Data Setup): ✅ 100% complete
- Phase 1 (Market Analysis): ✅ 100% complete
- Phase 2 (Profitability): ⏳ 0% complete - Starting next
- Phase 3 (Shopping List): ⏳ 0% complete
- Overall Project: 🚧 50% complete
