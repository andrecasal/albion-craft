# Albion Craft - Real-Time Profitability System

## Goal

Build a system that ingests live market data and calculates in real-time the most profitable actions:
- **Crafting from inventory** - Use materials you already have
- **Crafting from market** - Buy materials and craft
- **Arbitrage** - Buy cheap in one city, sell higher in another

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL DATA SOURCES                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────┐         ┌──────────────────────┐                  │
│  │  NATS Stream         │         │  REST API            │                  │
│  │  (Real-time orders)  │         │  (/charts endpoint)  │                  │
│  │                      │         │                      │                  │
│  │  - Full order book   │         │  - 30-day history    │                  │
│  │  - Price + quantity  │         │  - Daily avg price   │                  │
│  │  - ~130 orders/sec   │         │  - Daily volume      │                  │
│  └──────────┬───────────┘         └──────────┬───────────┘             §     │
│             │                                 │                              │
└─────────────┼─────────────────────────────────┼──────────────────────────────┘
              │                                 │
              ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INGESTION LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────┐         ┌──────────────────────┐                  │
│  │  NATS Collector      │         │  History Fetcher     │                  │
│  │  (collector.ts)      │         │  (incremental)       │                  │
│  │                      │         │                      │                  │
│  │  - Runs 24/7         │         │  - Fetches missing   │                  │
│  │  - Stores raw data   │         │    days only         │                  │
│  │  - Auto-reconnect    │         │  - Once per day      │                  │
│  └──────────┬───────────┘         └──────────┬───────────┘                  │
│             │                                 │                              │
└─────────────┼─────────────────────────────────┼──────────────────────────────┘
              │                                 │
              ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STORAGE LAYER                                      │
│                           (database.sqlite)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  orders table (from NATS)                                             │   │
│  │  ─────────────────────────                                            │   │
│  │  - id (PK)                                                            │   │
│  │  - item_id, item_group_id                                             │   │
│  │  - location_id                                                        │   │
│  │  - quality_level, enchantment_level                                   │   │
│  │  - price_silver (cents - divide by 100 for display)                   │   │
│  │  - amount                                                             │   │
│  │  - auction_type ('offer' = sell, 'request' = buy)                     │   │
│  │  - expires (ISO timestamp)                                            │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  price_history table (from REST API)                                  │   │
│  │  ───────────────────────────────────                                  │   │
│  │  - item_id                                                            │   │
│  │  - location_id                                                        │   │
│  │  - date (YYYY-MM-DD)                                                  │   │
│  │  - avg_price (cents)                                                  │   │
│  │  - item_count (volume)                                                │   │
│  │  - PRIMARY KEY (item_id, location_id, date)                           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────┐                                                   │
│  │  Static JSON files   │                                                   │
│  │  ───────────────────  │                                                   │
│  │  - items.json        │                                                   │
│  │  - recipes.json      │                                                   │
│  │  - materials/*.json  │                                                   │
│  └──────────────────────┘                                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           QUERY LAYER                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OrderBookDatabase (order-book-db.ts)                                       │
│  ─────────────────────────────────────                                      │
│                                                                              │
│  Real-time queries (from orders table):                                     │
│  - getMarketDepth(item, city) → full order book with quantities             │
│  - getBestSellPrices(item) → cheapest sell orders per city                  │
│  - getBestBuyPrices(item) → highest buy orders per city                     │
│  - calculateBuyCost(item, qty) → exact cost to buy N units                  │
│  - findArbitrageOpportunities() → profitable city-to-city trades            │
│                                                                              │
│  Historical queries (from price_history table):                             │
│  - get30DayAverage(item, city) → historical average price                   │
│  - getPriceTrend(item, city) → is price rising/falling?                     │
│  - getDailyVolume(item, city) → market liquidity                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ANALYSIS LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  Opportunity Ranker (TO BUILD)                                        │   │
│  │  ─────────────────────────────                                        │   │
│  │                                                                       │   │
│  │  Combines all data sources to rank opportunities:                     │   │
│  │                                                                       │   │
│  │  1. Get current prices from order book (NATS data)                    │   │
│  │  2. Get historical context (REST API data)                            │   │
│  │  3. Calculate profitability for:                                      │   │
│  │     - Arbitrage (buy city A → sell city B)                            │   │
│  │     - Crafting (material cost vs sell price)                          │   │
│  │  4. Rank by profit/hour or ROI                                        │   │
│  │  5. Filter by user preferences (city, tier, etc.)                     │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PRESENTATION LAYER                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  CLI / TUI (cli.ts)                                                         │
│  ─────────────────                                                          │
│                                                                              │
│  - Real-time opportunity dashboard                                          │
│  - Auto-refresh display                                                     │
│  - Filter by opportunity type, city, tier                                   │
│  - Detailed view for each opportunity                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Sources Integration

### NATS Stream (Primary - Real-time)
- **What**: Individual market orders with price + quantity
- **Use**: Precise decision-making, market depth, exact costs
- **Freshness**: Seconds old
- **Stored**: `orders` table in SQLite

### REST API (Secondary - Historical context)
- **What**: 30-day historical averages and volumes
- **Use**: "Is this a good price?" context
- **Freshness**: Daily
- **Stored**: `price_history` table in SQLite (incremental updates)

### How they synergize:
```
NATS:  "T6 Leather is 2,500 silver, 50 available"
API:   "30-day average is 2,800, daily volume is 200"
       ───────────────────────────────────────────
       "Price is 11% below average, good liquidity → BUY SIGNAL"
```

---

## Key Technical Decisions

### 1. SQLite for all persistent data
- Single `database.sqlite` file
- WAL mode for concurrent read/write
- Orders table (live data) + price_history table (historical)

### 2. Store raw values, transform on display
- `price_silver` stored in cents (raw API value)
- Divide by 100 only when displaying to user
- No precision loss, reversible

### 3. Incremental history fetching
- Track latest date in `price_history` table
- Only fetch missing days from REST API
- Reduces API calls from 30 days to 1 day on daily refresh

### 4. Collector runs 24/7, CLI is on-demand
- `npm run collect` - background process, always running
- `npm run dev` - interactive CLI, reads from SQLite
- No IPC needed, SQLite handles concurrent access

### 5. Order expiration via `expires` field
- Each order has an expiration timestamp
- Periodic cleanup removes expired orders
- No need for "last seen" heuristics

---

## Implementation Status

### Completed
- [x] NATS stream connection and parsing
- [x] SQLite order book storage (`orders` table)
- [x] NATS collector service (`npm run collect`)
- [x] Order expiration cleanup
- [x] Market depth queries
- [x] Basic arbitrage finder (in order-book-db.ts)

### Phase 1: CLI with Real-Time Order Book (Current)

Migrate CLI features to use SQLite order book instead of REST API JSON files.

**Order of implementation:**

1. **City Arbitrage (Simplest)** ✅
   - [x] Wire up existing `findArbitrageOpportunities()` from order-book-db.ts
   - [x] Display results in CLI with item names from items.json
   - [x] Add filters: min profit, min quantity, city filter

2. **Craft from Market**
   - [ ] Use `calculateBuyCost()` for material costs (real-time)
   - [ ] Use `getBestBuyPrices()` for sell price (where to sell crafted item)
   - [ ] Calculate profit using real order book data
   - [ ] Handle case where order book lacks data for some materials

3. **Craft from Inventory**
   - [ ] Same as above, but only look up sell prices (materials already owned)

4. **Material Buy Opportunities**
   - [ ] Compare current order book prices across cities
   - [ ] Show where each material is cheapest

### Phase 2: Historical Context (Later)
- [ ] Add `price_history` table to SQLite schema
- [ ] Incremental history fetcher (fetch only missing days from REST API)
- [ ] Enrich displays with "current vs 30-day avg" context

### Phase 3: TUI Dashboard (Later)
- [ ] Real-time auto-refreshing display
- [ ] Unified opportunity ranker (arbitrage + crafting combined)

---

## Commands

```bash
# Start the 24/7 collector (run in background)
npm run collect

# Interactive CLI
npm run dev
```
