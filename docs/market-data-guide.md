# Market Data Interpretation Guide

This document explains how to interpret and use market data from the Albion Online Data API.

## Data Sources Overview

| Endpoint     | Best For                               | Shows Quantities | Shows Prices | Freshness               |
| ------------ | -------------------------------------- | ---------------- | ------------ | ----------------------- |
| `/prices`    | Single-item instant price checking     | No               | Min/Max      | Last seen               |
| `/history`   | Pricing baseline, demand analysis      | Yes (traded)     | Average      | Hourly/daily aggregates |
| Order Book   | At-scale execution planning, liquidity | Yes (available)  | Exact        | `updated_at` field      |

## Prices Endpoint

**Use for:** Quick single-item price checks and small-scale arbitrage.

### What it shows
- `sell_price_min`: Lowest sell order price (what you'd pay to buy instantly)
- `buy_price_max`: Highest buy order price (what you'd receive selling instantly)
- `*_date`: When this price was last observed

### Recommended usage
- **Single-item price check**: Quickly see best prices across cities
- **Small arbitrage**: Find price gaps for individual items
- **Freshness check**: Always check `*_date` - stale data (>1 hour) is unreliable

### Limitations
- **No quantities**: A low price might be for just 1 item - unsuitable for bulk trades
- **Snapshot data**: Prices change constantly; this is last-seen, not current
- **May be stale**: Orders could be fulfilled between observation and your action


## History Endpoint

**Use for:** Assessing market demand and calculating stable reference prices.

### What it shows
- `item_count`: Number of items **actually traded** during the period
- `avg_price`: Volume-weighted average transaction price
- `timestamp`: The hour/day this data represents

### Available time scales
- **Daily average (last 28 days)**: Stable baseline for long-term pricing (e.g., material costs)
- **6-hour average (last 7 days)**: Recent trends and short-term price movements
- **Hourly average (last 24 hours)**: Intraday fluctuations and immediate market state

### Recommended usage
- Use 28-day daily data to assess stable material baseline prices
- Use 7-day 6h data to identify recent price trends for crafted items
- Use 24h hourly data for timing trades within a single session
- Volume data helps gauge demand - high volume = active market, low volume = illiquid

### Limitations
- Data is aggregated, so you miss granular price movements within each period
- Average price can be skewed by a few large transactions
- Historical only - doesn't reflect current order book state

## Order Book (Database)

**Use for:** Planning trades at scale with quantity awareness.

### What it shows
- `price` + `amount`: Exact order details
- `order_type`: Whether it's a sell or buy order
- `expires`: Order expiration date
- `updated_at`: When we last verified this order exists

### Recommended usage
- **Bulk trading**: Know exactly how many items are available at each price
- **Slippage estimation**: Calculate actual cost to buy/sell N items
- **Liquidity analysis**: Sum quantities across price levels
- **Fresh data filtering**: Only trust orders where `updated_at` is recent

### Limitations
- **Staleness risk**: Orders may be fulfilled before expiration - always check `updated_at`
- **Partial fills**: An order might have been partially filled since last update
- **Collection delay**: Depends on how often the collector runs

## Practical Strategies

### Crafting Profitability
1. Use `/history` 28-day daily data to assess material baseline prices
2. Use order book to find where to actually buy materials now
3. Use `/history` 7-day 6h data for crafted item prices (expected sell price)

### City Arbitrage
- **Small scale**: Use `/prices` to spot price gaps, execute quickly
- **Bulk trades**: Use order book to verify quantity exists at the target price
- **Freshness**: Check `updated_at` / `*_date` - ignore data older than 30 minutes

### Market Timing
1. Use `/history` to identify which items have rising volume (demand increasing)
2. Cross-reference with order book to see available supply
3. Rising volume + rising prices = opportunity
