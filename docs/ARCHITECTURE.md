# Architecture & Design Decisions

## Overview

Albion Craft transitioned from a Google Sheets-based solution to a local Node.js/TypeScript application to overcome quota limitations and enable more sophisticated analysis.

## Why Move Away from Google Sheets?

### Problems with Google Sheets
1. **URL Fetch Quota**: 20,000 requests/day limit
   - Fetching 6,500 items × 7 cities = 45,500 API calls
   - Material prices: 282 materials × 7 cities = 1,974 calls
   - Total: ~47,000 calls needed, but quota only allows 20,000

2. **Performance**: Apps Script is slow for complex calculations
   - Calculating profitability for 6,500 items takes minutes
   - Local TypeScript can process in seconds

3. **Reliability**: Apps Script has execution time limits
   - 6-minute timeout for custom functions
   - 30-minute timeout for triggers

4. **Development Experience**:
   - No TypeScript
   - Limited debugging
   - No version control for scripts
   - No local testing

### Benefits of Local Application
✅ **No quota limits**: Unlimited API calls
✅ **Fast**: Process 6,500 items in <5 seconds
✅ **TypeScript**: Type safety & better IDE support
✅ **Version control**: Git-friendly
✅ **Testing**: Easy to write unit tests
✅ **Extensibility**: Can add web dashboard, CLI tools, etc.
✅ **Data management**: Can use SQLite/PostgreSQL for better querying

## Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         DATA SOURCES                             │
├─────────────────────────────────────────────────────────────────┤
│  • Albion Official API (recipes)                                 │
│  • AODP API (material prices, market data)                       │
│  • Google Sheets (optional, for manual exports)                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DATA FETCHERS (Node.js)                     │
├─────────────────────────────────────────────────────────────────┤
│  • recipe-fetcher.js → recipes.json                              │
│  • material-prices-fetcher.js → material-prices.json             │
│  • market-data-fetcher.js → market-data.json (TODO)              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LOCAL DATA STORE                            │
├─────────────────────────────────────────────────────────────────┤
│  Current: JSON files                                             │
│  Future: SQLite database for faster queries                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│               PROFITABILITY CALCULATOR (TypeScript)              │
├─────────────────────────────────────────────────────────────────┤
│  • ProfitabilityCalculator.calculateAll()                        │
│  • Returns ranked opportunities                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        OUTPUTS                                   │
├─────────────────────────────────────────────────────────────────┤
│  • CSV reports (for Google Sheets import)                        │
│  • JSON reports (for web dashboard)                              │
│  • CLI output (for quick analysis)                               │
└─────────────────────────────────────────────────────────────────┘
```

### Component Architecture

```typescript
src/
├── types/
│   └── index.ts                    // Type definitions
│
├── services/
│   ├── data-loader.ts              // Load data from JSON/CSV/DB
│   ├── profitability-calculator.ts // Core calculation engine
│   └── report-generator.ts         // Generate reports
│
├── utils/                          // Helper functions (future)
│   ├── api-client.ts               // AODP API wrapper
│   └── validators.ts               // Data validation
│
└── cli.ts                          // CLI entry point
```

### Data Models

```typescript
Recipe
├── itemId: string
├── material1-4: string
├── mat1-4Qty: number
├── craftingFee: number
└── focusCost: number

MaterialPrice
├── materialId: string
├── city: City
├── sellPriceMin: number
├── buyPriceMax: number
└── lastUpdated: string

MarketData
├── itemId: string
├── city: City
├── dailyDemand: number
├── lowestSellPrice: number
├── price7dAvg: number
├── priceTrendPct: number
└── supplySignal: SupplySignal

ProfitabilityResult
├── itemId: string
├── city: City
├── recipe: Recipe
├── marketData: MarketData
├── craftingCost: CraftingCost
├── netProfit: number
├── roiPercent: number
└── profitRank: number
```

## Data Storage Strategy

### Current: JSON Files

**Pros**:
- ✅ Simple to implement
- ✅ Human-readable
- ✅ Easy to export/import to Google Sheets
- ✅ No database setup required

**Cons**:
- ❌ Slow for large datasets (must load entire file)
- ❌ No indexing or queries
- ❌ Large file sizes

**Best for**: Initial development, prototyping, < 100k records

### Future: SQLite

**Pros**:
- ✅ Fast queries with indexes
- ✅ Single file database (portable)
- ✅ No server setup
- ✅ Supports transactions
- ✅ SQL queries for complex filtering

**Cons**:
- ❌ Slightly more complex setup
- ❌ Not human-readable

**Best for**: Production use, > 100k records, complex queries

**Schema Design**:
```sql
CREATE TABLE recipes (
  item_id TEXT PRIMARY KEY,
  material_1 TEXT,
  mat_1_qty INTEGER,
  material_2 TEXT,
  mat_2_qty INTEGER,
  material_3 TEXT,
  mat_3_qty INTEGER,
  material_4 TEXT,
  mat_4_qty INTEGER,
  crafting_fee INTEGER,
  focus_cost INTEGER
);

CREATE TABLE material_prices (
  material_id TEXT,
  city TEXT,
  sell_price_min INTEGER,
  buy_price_max INTEGER,
  last_updated TEXT,
  PRIMARY KEY (material_id, city)
);

CREATE TABLE market_data (
  item_id TEXT,
  city TEXT,
  daily_demand REAL,
  lowest_sell_price INTEGER,
  price_7d_avg INTEGER,
  data_age_hours REAL,
  confidence REAL,
  available_capacity INTEGER,
  price_trend_pct REAL,
  supply_signal TEXT,
  market_signal TEXT,
  PRIMARY KEY (item_id, city)
);

CREATE INDEX idx_market_demand ON market_data(daily_demand DESC);
CREATE INDEX idx_market_signal ON market_data(supply_signal);
CREATE INDEX idx_prices_material ON material_prices(material_id);
```

### When to Migrate to SQLite

Migrate when:
1. You have full market data (45,000+ records)
2. You want to query/filter data efficiently
3. You're building a web dashboard with real-time queries
4. JSON file loading becomes slow (> 2 seconds)

**Migration Plan**:
1. Create `src/services/database.ts` with SQLite setup
2. Create migration script to import JSON → SQLite
3. Update DataLoader to read from SQLite instead of JSON
4. Keep JSON export for backward compatibility

## Calculation Engine

### ProfitabilityCalculator

**Core Responsibilities**:
1. Index data by ID for fast lookup
2. Calculate return rate based on user stats
3. Calculate material costs for each recipe
4. Calculate profit, ROI, and profit rank
5. Rank opportunities by profit rank or ROI

**Performance**:
- Current: ~5-10 seconds for 6,500 items × 7 cities = 45,000 calculations
- With SQLite: ~1-2 seconds with indexed queries

**Optimization Opportunities**:
1. **Parallel processing**: Use worker threads for multi-core CPUs
2. **Caching**: Cache material prices in memory
3. **Lazy loading**: Only calculate top N opportunities
4. **Incremental updates**: Only recalculate items with price changes

## API Integration

### AODP API

**Base URL**: `https://west.albion-online-data.com/api/v2`

**Endpoints Used**:
1. `/stats/prices/{items}?locations={cities}` - Current prices
2. `/stats/history/{items}?locations={cities}` - Price history (for trends)

**Rate Limiting**:
- No official rate limit documented
- Best practice: 50 items per request, 1 second between requests
- Use exponential backoff for 429 errors

**Batch Strategy**:
- Materials: 282 items → 6 batches of 50 → ~6 seconds
- Market data: 6,500 items → 130 batches of 50 → ~2-3 minutes

## Deployment Options

### Option 1: Local CLI Tool (Current)
**Use Case**: Personal use, manual analysis
**Setup**: Run on your machine
**Pros**: Simple, fast, no server costs
**Cons**: Manual execution, no automation

### Option 2: Scheduled Cron Job
**Use Case**: Automated data refresh
**Setup**: Add cron job to run fetchers hourly
**Pros**: Auto-updated data
**Cons**: Still manual report viewing

Example crontab:
```bash
# Fetch material prices every hour
0 * * * * cd /path/to/albion-craft && npm run fetch-material-prices

# Fetch market data every 6 hours
0 */6 * * * cd /path/to/albion-craft && npm run fetch-market-data

# Run profitability analysis every 6 hours
5 */6 * * * cd /path/to/albion-craft && npm run calculate
```

### Option 3: Web Dashboard
**Use Case**: Real-time analysis with UI
**Setup**: Next.js + React + API routes
**Pros**: Interactive, shareable, beautiful UI
**Cons**: More complex, hosting costs

**Tech Stack**:
- Frontend: Next.js + React + TailwindCSS
- Backend: Next.js API routes + SQLite
- Charts: Recharts or Chart.js
- Deployment: Vercel (free tier)

### Option 4: Discord Bot
**Use Case**: Share opportunities with guild
**Setup**: Discord.js bot + scheduled tasks
**Pros**: Share with team, notifications
**Cons**: Limited UI

## Recommended Architecture for Production

```
┌─────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                               │
├─────────────────────────────────────────────────────────────────┤
│  SQLite Database (recipes, prices, market data)                  │
│  + Cron jobs to refresh data every 1-6 hours                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BUSINESS LOGIC                              │
├─────────────────────────────────────────────────────────────────┤
│  ProfitabilityCalculator (shared by CLI & web)                   │
│  + Caching layer (Redis or in-memory)                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                ┌────────────┴─────────────┐
                │                          │
                ▼                          ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│       CLI TOOL           │  │     WEB DASHBOARD        │
├──────────────────────────┤  ├──────────────────────────┤
│  • Quick analysis        │  │  • Interactive UI        │
│  • CSV exports           │  │  • Real-time updates     │
│  • Batch processing      │  │  • Charts & filters      │
└──────────────────────────┘  └──────────────────────────┘
```

## Next Steps

### Phase 3: Complete Local Transition ✅ (DONE)
- [x] Material prices fetcher
- [x] TypeScript architecture
- [x] Profitability calculator
- [x] Report generator
- [ ] Market data fetcher
- [ ] SQLite migration

### Phase 4: Automation
- [ ] Cron jobs for data refresh
- [ ] Price change alerts (Discord/email)
- [ ] Historical tracking

### Phase 5: Web Dashboard
- [ ] Next.js frontend
- [ ] API endpoints
- [ ] Interactive charts
- [ ] Real-time updates

## Questions & Answers

### Q: Should I keep using Google Sheets?
**A**: Use Google Sheets as a **viewer** for reports, not as the primary data store or calculation engine.

**Recommended hybrid approach**:
1. Local Node.js for data fetching & calculations
2. Export reports to CSV
3. Import CSV to Google Sheets for viewing/sharing
4. Use Google Sheets Data Studio for dashboards

### Q: SQLite vs PostgreSQL?
**A**: Use **SQLite** unless you need:
- Multiple users with concurrent writes
- Network access (remote queries)
- Very large datasets (> 1GB)

For Albion Craft, SQLite is perfect because:
- Single-user application
- Data size is manageable (~50-100 MB)
- Local file access is faster than network

### Q: How to handle data freshness?
**A**: Implement a `last_updated` timestamp on all data:

```typescript
interface DataFreshness {
  recipes: Date;          // Update: weekly (recipes rarely change)
  materialPrices: Date;   // Update: hourly (prices change frequently)
  marketData: Date;       // Update: every 6 hours (demand changes daily)
}
```

Add a freshness check in the CLI:
```typescript
if (isDataStale(marketData, 6 * 60 * 60 * 1000)) {
  console.warn('⚠️  Market data is > 6 hours old. Run fetch-market-data to update.');
}
```

### Q: How to scale to 100+ users?
**A**:
1. **0-10 users**: Current architecture (local CLI)
2. **10-100 users**: Web dashboard + SQLite
3. **100+ users**: Migrate to PostgreSQL + cloud hosting

For now, focus on single-user optimization.

## Design Decisions

### Why TypeScript?
- Type safety prevents bugs
- Better IDE support (autocomplete, refactoring)
- Easier to maintain as project grows

### Why separate services?
- Single Responsibility Principle
- Easier to test
- Can swap implementations (JSON → SQLite)

### Why CSV output?
- Google Sheets compatibility
- Excel compatibility
- Human-readable
- Easy to share

### Why profit rank instead of just ROI?
ROI alone can be misleading:
- 1000% ROI on an item that sells 0.1/day = useless
- 50% ROI on an item that sells 100/day = great

Profit Rank = `(Net Profit × Daily Demand × Supply Multiplier) / 1000`

This balances:
- **Profit per item** (net profit)
- **Market size** (daily demand)
- **Market health** (supply signal)

## Conclusion

This architecture provides:
- ✅ No quota limitations
- ✅ Fast calculations
- ✅ Type safety
- ✅ Extensibility for future features
- ✅ Easy to maintain

Start with JSON files, migrate to SQLite when needed, and add web dashboard when ready.
