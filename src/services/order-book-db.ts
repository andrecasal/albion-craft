// order-book-db.ts
// SQLite-based order book storage for real-time market data

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { City } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Orders not re-confirmed within this time are considered stale and excluded from queries
const STALE_ORDER_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// TYPES
// ============================================================================

export interface MarketOrder {
  id: number;
  itemId: string;
  itemGroupId: string;
  locationId: number;
  qualityLevel: number;
  enchantmentLevel: number;
  priceSilver: number; // In hundredths of silver (raw value); divide by 10000 for silver
  amount: number;
  auctionType: 'offer' | 'request'; // offer = sell, request = buy
  expires: string; // ISO timestamp
}

export interface OrderBookEntry {
  price: number;
  amount: number;
  orderCount: number;
}

export interface MarketDepth {
  itemId: string;
  locationId: number;
  sellOrders: OrderBookEntry[]; // Sorted by price ascending (cheapest first)
  buyOrders: OrderBookEntry[]; // Sorted by price descending (highest first)
  totalSellAmount: number;
  totalBuyAmount: number;
  bestSellPrice: number | null;
  bestBuyPrice: number | null;
  spread: number | null;
  spreadPercent: number | null;
}

export interface ArbitrageOpportunity {
  itemId: string;
  itemName: string;
  quality: number;
  buyCity: string;
  buyPrice: number;
  buyAmount: number;
  sellCity: string;
  sellPrice: number;
  sellAmount: number;
  profitPerUnit: number;
  profitPercent: number;
  maxQuantity: number;
  totalProfit: number;
}

export interface OptimalArbitrageResult {
  itemId: string;
  quality: number;
  buyCity: string;
  sellCity: string;
  // Optimal quantities
  optimalQuantity: number;          // Items to buy for max profit (within carry capacity)
  capacityLimitedQuantity: number;  // Max items we can carry
  profitLimitedQuantity: number;    // Items where marginal profit > 0
  // Costs and revenues (walking through order book depth)
  totalBuyCost: number;             // Total silver to spend
  totalSellRevenue: number;         // Gross revenue before tax
  totalTax: number;                 // 4% quick sell tax
  totalProfit: number;              // Net profit after tax
  // Averages
  avgBuyPrice: number;              // Weighted average buy price
  avgSellPrice: number;             // Weighted average sell price
  avgProfitPerUnit: number;         // Average profit per item
  profitPercent: number;            // ROI percentage
  // Order book details (for transparency)
  buyOrdersUsed: Array<{ price: number; amount: number }>;
  sellOrdersUsed: Array<{ price: number; amount: number }>;
}

// Location ID to City name mapping
export const LOCATION_TO_CITY: Record<number, City> = {
  7: 'Thetford',
  301: 'Martlock',
  1002: 'Fort Sterling',
  1006: 'Lymhurst',
  2004: 'Lymhurst',
  3003: 'Bridgewatch',
  3005: 'Fort Sterling',
  3008: 'Thetford',
  3010: 'Lymhurst',
  4002: 'Caerleon',
  5003: 'Brecilien',
  // Portal markets (map to main city)
  1012: 'Martlock',
  2002: 'Thetford',
  3002: 'Bridgewatch',
};

export const CITY_TO_LOCATION: Record<City, number[]> = {
  'Thetford': [7, 3008, 2002],
  'Martlock': [301, 1012],
  'Fort Sterling': [1002, 3005],
  'Lymhurst': [1006, 2004, 3010],
  'Bridgewatch': [3003, 3002],
  'Caerleon': [4002],
  'Brecilien': [5003],
};

// ============================================================================
// DATABASE SERVICE
// ============================================================================

export class OrderBookDatabase {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStmt: Database.Statement;
  private deleteExpiredStmt: Database.Statement;

  constructor(dbPath?: string) {
    const defaultPath = path.join(process.cwd(), 'src', 'db', 'database.sqlite');
    const finalPath = dbPath || defaultPath;

    // Ensure directory exists
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrent access
    this.db.pragma('synchronous = NORMAL'); // Faster writes, still safe

    this.migrate(); // Run migrations first for existing databases
    this.initSchema();
    this.insertStmt = this.prepareInsert();
    this.updateStmt = this.prepareUpdate();
    this.deleteExpiredStmt = this.prepareDeleteExpired();
  }

  private migrate(): void {
    // Add last_seen column if it doesn't exist (migration for existing databases)
    const columns = this.db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
    const hasLastSeen = columns.some(col => col.name === 'last_seen');
    if (!hasLastSeen) {
      this.db.exec('ALTER TABLE orders ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0');
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL,
        item_group_id TEXT NOT NULL,
        location_id INTEGER NOT NULL,
        quality_level INTEGER NOT NULL,
        enchantment_level INTEGER NOT NULL,
        price_silver INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        auction_type TEXT NOT NULL,
        expires TEXT NOT NULL,
        last_seen INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_item_location
        ON orders(item_id, location_id);

      CREATE INDEX IF NOT EXISTS idx_item_type_location
        ON orders(item_id, auction_type, location_id);

      CREATE INDEX IF NOT EXISTS idx_expires
        ON orders(expires);

      CREATE INDEX IF NOT EXISTS idx_location
        ON orders(location_id);

      CREATE INDEX IF NOT EXISTS idx_last_seen
        ON orders(last_seen);

      -- Stats table to track ingestion metrics
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Price history table for historical data from AODP /charts endpoint
      CREATE TABLE IF NOT EXISTS price_history (
        item_id TEXT NOT NULL,
        location_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        avg_price INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, location_id, date)
      );

      CREATE INDEX IF NOT EXISTS idx_price_history_item
        ON price_history(item_id);

      CREATE INDEX IF NOT EXISTS idx_price_history_date
        ON price_history(date);

      -- Hourly price history table for high-resolution data from AODP /charts endpoint (time-scale=1)
      CREATE TABLE IF NOT EXISTS hourly_price_history (
        item_id TEXT NOT NULL,
        location_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        avg_price INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, location_id, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_hourly_price_history_item
        ON hourly_price_history(item_id);

      CREATE INDEX IF NOT EXISTS idx_hourly_price_history_timestamp
        ON hourly_price_history(timestamp);
    `);
  }

  private prepareInsert(): Database.Statement {
    return this.db.prepare(`
      INSERT OR REPLACE INTO orders
        (id, item_id, item_group_id, location_id, quality_level, enchantment_level,
         price_silver, amount, auction_type, expires, last_seen)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private prepareUpdate(): Database.Statement {
    return this.db.prepare(`
      UPDATE orders SET
        price_silver = ?,
        amount = ?,
        expires = ?
      WHERE id = ?
    `);
  }

  private prepareDeleteExpired(): Database.Statement {
    return this.db.prepare(`
      DELETE FROM orders WHERE expires < ?
    `);
  }

  // ============================================================================
  // WRITE OPERATIONS
  // ============================================================================

  /**
   * Upsert a market order (insert or update if exists)
   */
  upsertOrder(order: MarketOrder): void {
    this.insertStmt.run(
      order.id,
      order.itemId,
      order.itemGroupId,
      order.locationId,
      order.qualityLevel,
      order.enchantmentLevel,
      order.priceSilver,
      order.amount,
      order.auctionType,
      order.expires,
      Date.now()
    );
  }

  /**
   * Bulk upsert orders (much faster for batch inserts)
   */
  upsertOrders(orders: MarketOrder[]): void {
    const now = Date.now();
    const transaction = this.db.transaction((orders: MarketOrder[]) => {
      for (const order of orders) {
        this.insertStmt.run(
          order.id,
          order.itemId,
          order.itemGroupId,
          order.locationId,
          order.qualityLevel,
          order.enchantmentLevel,
          order.priceSilver,
          order.amount,
          order.auctionType,
          order.expires,
          now
        );
      }
    });
    transaction(orders);
  }

  /**
   * Remove expired orders
   * Returns the number of orders deleted
   */
  cleanupExpired(): number {
    const now = new Date().toISOString();
    const staleThreshold = Date.now() - STALE_ORDER_THRESHOLD_MS;

    // Delete expired orders
    const expiredResult = this.deleteExpiredStmt.run(now);

    // Delete stale orders (not seen within threshold)
    const staleResult = this.db.prepare(
      'DELETE FROM orders WHERE last_seen < ? AND last_seen > 0'
    ).run(staleThreshold);

    return expiredResult.changes + staleResult.changes;
  }

  // ============================================================================
  // READ OPERATIONS
  // ============================================================================

  /**
   * Get market depth for an item at a location
   */
  getMarketDepth(itemId: string, locationId: number, quality?: number): MarketDepth {
    const now = new Date().toISOString();
    const staleThreshold = Date.now() - STALE_ORDER_THRESHOLD_MS;

    let whereClause = 'item_id = ? AND location_id = ? AND expires > ? AND last_seen > ?';
    const params: (string | number)[] = [itemId, locationId, now, staleThreshold];

    if (quality !== undefined) {
      whereClause += ' AND quality_level = ?';
      params.push(quality);
    }

    // Get sell orders (offers) sorted by price ascending
    const sellOrders = this.db.prepare(`
      SELECT price_silver as price, SUM(amount) as amount, COUNT(*) as orderCount
      FROM orders
      WHERE ${whereClause} AND auction_type = 'offer'
      GROUP BY price_silver
      ORDER BY price_silver ASC
    `).all(...params) as OrderBookEntry[];

    // Get buy orders (requests) sorted by price descending
    const buyOrders = this.db.prepare(`
      SELECT price_silver as price, SUM(amount) as amount, COUNT(*) as orderCount
      FROM orders
      WHERE ${whereClause} AND auction_type = 'request'
      GROUP BY price_silver
      ORDER BY price_silver DESC
    `).all(...params) as OrderBookEntry[];

    const totalSellAmount = sellOrders.reduce((sum, o) => sum + o.amount, 0);
    const totalBuyAmount = buyOrders.reduce((sum, o) => sum + o.amount, 0);
    const bestSellPrice = sellOrders.length > 0 ? sellOrders[0].price : null;
    const bestBuyPrice = buyOrders.length > 0 ? buyOrders[0].price : null;

    let spread: number | null = null;
    let spreadPercent: number | null = null;
    if (bestSellPrice !== null && bestBuyPrice !== null) {
      spread = bestSellPrice - bestBuyPrice;
      spreadPercent = (spread / bestBuyPrice) * 100;
    }

    return {
      itemId,
      locationId,
      sellOrders,
      buyOrders,
      totalSellAmount,
      totalBuyAmount,
      bestSellPrice,
      bestBuyPrice,
      spread,
      spreadPercent,
    };
  }

  /**
   * Get market depth for an item across all cities
   */
  getMarketDepthAllCities(itemId: string, quality?: number): Record<City, MarketDepth> {
    const result: Partial<Record<City, MarketDepth>> = {};

    for (const [city, locationIds] of Object.entries(CITY_TO_LOCATION) as [City, number[]][]) {
      // Aggregate across all location IDs for this city
      const depths = locationIds.map((locId) => this.getMarketDepth(itemId, locId, quality));

      // Combine depths from multiple locations
      const combined: MarketDepth = {
        itemId,
        locationId: locationIds[0],
        sellOrders: [],
        buyOrders: [],
        totalSellAmount: 0,
        totalBuyAmount: 0,
        bestSellPrice: null,
        bestBuyPrice: null,
        spread: null,
        spreadPercent: null,
      };

      for (const depth of depths) {
        combined.sellOrders.push(...depth.sellOrders);
        combined.buyOrders.push(...depth.buyOrders);
        combined.totalSellAmount += depth.totalSellAmount;
        combined.totalBuyAmount += depth.totalBuyAmount;

        if (depth.bestSellPrice !== null) {
          if (combined.bestSellPrice === null || depth.bestSellPrice < combined.bestSellPrice) {
            combined.bestSellPrice = depth.bestSellPrice;
          }
        }
        if (depth.bestBuyPrice !== null) {
          if (combined.bestBuyPrice === null || depth.bestBuyPrice > combined.bestBuyPrice) {
            combined.bestBuyPrice = depth.bestBuyPrice;
          }
        }
      }

      // Sort combined orders
      combined.sellOrders.sort((a, b) => a.price - b.price);
      combined.buyOrders.sort((a, b) => b.price - a.price);

      // Recalculate spread
      if (combined.bestSellPrice !== null && combined.bestBuyPrice !== null) {
        combined.spread = combined.bestSellPrice - combined.bestBuyPrice;
        combined.spreadPercent = (combined.spread / combined.bestBuyPrice) * 100;
      }

      result[city] = combined;
    }

    return result as Record<City, MarketDepth>;
  }

  /**
   * Get best sell price for an item across cities
   */
  getBestSellPrices(itemId: string, quality?: number): Record<City, number | null> {
    const depths = this.getMarketDepthAllCities(itemId, quality);
    const result: Partial<Record<City, number | null>> = {};

    for (const [city, depth] of Object.entries(depths) as [City, MarketDepth][]) {
      result[city] = depth.bestSellPrice;
    }

    return result as Record<City, number | null>;
  }

  /**
   * Get best buy price for an item across cities
   */
  getBestBuyPrices(itemId: string, quality?: number): Record<City, number | null> {
    const depths = this.getMarketDepthAllCities(itemId, quality);
    const result: Partial<Record<City, number | null>> = {};

    for (const [city, depth] of Object.entries(depths) as [City, MarketDepth][]) {
      result[city] = depth.bestBuyPrice;
    }

    return result as Record<City, number | null>;
  }

  /**
   * Calculate cost to buy a specific quantity of an item
   * Returns total cost and average price per unit
   */
  calculateBuyCost(
    itemId: string,
    locationId: number,
    quantity: number,
    quality?: number
  ): { totalCost: number; avgPrice: number; filled: number } | null {
    const depth = this.getMarketDepth(itemId, locationId, quality);

    if (depth.sellOrders.length === 0) {
      return null;
    }

    let remaining = quantity;
    let totalCost = 0;
    let filled = 0;

    for (const order of depth.sellOrders) {
      if (remaining <= 0) break;

      const take = Math.min(remaining, order.amount);
      totalCost += take * order.price;
      filled += take;
      remaining -= take;
    }

    return {
      totalCost,
      avgPrice: filled > 0 ? Math.round(totalCost / filled) : 0,
      filled,
    };
  }

  /**
   * Find arbitrage opportunities between cities
   * @param minProfitPercent Minimum profit percentage to include
   * @param minQuantity Minimum quantity available
   * @param onProgress Optional callback for progress updates (0-100)
   */
  findArbitrageOpportunities(
    minProfitPercent: number = 5,
    minQuantity: number = 1,
    onProgress?: (percent: number, current: number, total: number) => void
  ): ArbitrageOpportunity[] {
    const now = new Date().toISOString();
    const staleThreshold = Date.now() - STALE_ORDER_THRESHOLD_MS;

    // Get all unique items with orders (excluding stale)
    const items = this.db.prepare(`
      SELECT DISTINCT item_id, quality_level
      FROM orders
      WHERE expires > ? AND last_seen > ?
    `).all(now, staleThreshold) as { item_id: string; quality_level: number }[];

    const opportunities: ArbitrageOpportunity[] = [];
    const totalItems = items.length;

    for (let i = 0; i < items.length; i++) {
      const { item_id: itemId, quality_level: quality } = items[i];

      // Report progress
      if (onProgress && i % 50 === 0) {
        const percent = Math.round((i / totalItems) * 100);
        onProgress(percent, i, totalItems);
      }
      const depths = this.getMarketDepthAllCities(itemId, quality);

      // Find buy opportunities (lowest sell prices)
      const buyOptions: { city: City; price: number; amount: number }[] = [];
      // Find sell opportunities (highest buy prices)
      const sellOptions: { city: City; price: number; amount: number }[] = [];

      for (const [city, depth] of Object.entries(depths) as [City, MarketDepth][]) {
        if (depth.bestSellPrice !== null && depth.totalSellAmount >= minQuantity) {
          buyOptions.push({
            city,
            price: depth.bestSellPrice,
            amount: depth.totalSellAmount,
          });
        }
        if (depth.bestBuyPrice !== null && depth.totalBuyAmount >= minQuantity) {
          sellOptions.push({
            city,
            price: depth.bestBuyPrice,
            amount: depth.totalBuyAmount,
          });
        }
      }

      // Compare all buy/sell combinations
      for (const buy of buyOptions) {
        for (const sell of sellOptions) {
          if (buy.city === sell.city) continue; // Same city, no arbitrage

          const profitPerUnit = sell.price - buy.price;
          const profitPercent = (profitPerUnit / buy.price) * 100;

          if (profitPercent >= minProfitPercent) {
            const maxQuantity = Math.min(buy.amount, sell.amount);
            opportunities.push({
              itemId,
              itemName: itemId, // TODO: lookup from items.json
              quality,
              buyCity: buy.city,
              buyPrice: buy.price,
              buyAmount: buy.amount,
              sellCity: sell.city,
              sellPrice: sell.price,
              sellAmount: sell.amount,
              profitPerUnit,
              profitPercent,
              maxQuantity,
              totalProfit: profitPerUnit * maxQuantity,
            });
          }
        }
      }
    }

    // Report completion
    if (onProgress) {
      onProgress(100, totalItems, totalItems);
    }

    // Sort by total profit descending
    opportunities.sort((a, b) => b.totalProfit - a.totalProfit);

    return opportunities;
  }

  // ============================================================================
  // OPTIMAL ARBITRAGE CALCULATION
  // ============================================================================

  /**
   * Calculate the optimal arbitrage quantity by walking through order book depth.
   *
   * This method simulates buying from sell orders (ascending price) in the buy city
   * and selling to buy orders (descending price) in the sell city, calculating
   * the marginal profit for each item until:
   * 1. Marginal profit becomes <= 0
   * 2. We hit the carry capacity limit
   * 3. We run out of orders on either side
   *
   * @param itemId The item to analyze
   * @param buyCityLocations Location IDs for the buy city
   * @param sellCityLocations Location IDs for the sell city
   * @param quality Item quality level
   * @param itemWeight Weight per item in kg
   * @param carryCapacity Maximum weight we can carry in kg
   * @param taxRate Quick sell tax rate (default 4%)
   */
  calculateOptimalArbitrage(
    itemId: string,
    buyCityLocations: number[],
    sellCityLocations: number[],
    quality: number,
    itemWeight: number,
    carryCapacity: number,
    taxRate: number = 0.04
  ): OptimalArbitrageResult | null {
    // Get market depth for both cities
    const buyDepths = buyCityLocations.map(loc => this.getMarketDepth(itemId, loc, quality));
    const sellDepths = sellCityLocations.map(loc => this.getMarketDepth(itemId, loc, quality));

    // Combine and sort sell orders from buy city (we buy from these - ascending price)
    const allBuyFromOrders: OrderBookEntry[] = [];
    for (const depth of buyDepths) {
      allBuyFromOrders.push(...depth.sellOrders);
    }
    allBuyFromOrders.sort((a, b) => a.price - b.price);

    // Combine and sort buy orders from sell city (we sell to these - descending price)
    const allSellToOrders: OrderBookEntry[] = [];
    for (const depth of sellDepths) {
      allSellToOrders.push(...depth.buyOrders);
    }
    allSellToOrders.sort((a, b) => b.price - a.price);

    if (allBuyFromOrders.length === 0 || allSellToOrders.length === 0) {
      return null;
    }

    // Calculate max items by carry capacity
    const maxItemsByCapacity = Math.floor(carryCapacity / itemWeight);

    // Walk through both order books simultaneously
    let buyOrderIdx = 0;
    let sellOrderIdx = 0;
    let buyOrderRemaining = allBuyFromOrders[0]?.amount || 0;
    let sellOrderRemaining = allSellToOrders[0]?.amount || 0;

    let totalQuantity = 0;
    let totalBuyCost = 0;
    let totalSellRevenue = 0;
    let profitLimitedQuantity = 0;

    const buyOrdersUsed: Array<{ price: number; amount: number }> = [];
    const sellOrdersUsed: Array<{ price: number; amount: number }> = [];

    // Track which orders we're using
    const buyOrderAmounts = new Map<number, number>(); // price -> amount used
    const sellOrderAmounts = new Map<number, number>(); // price -> amount used

    while (
      buyOrderIdx < allBuyFromOrders.length &&
      sellOrderIdx < allSellToOrders.length &&
      totalQuantity < maxItemsByCapacity
    ) {
      const buyPrice = allBuyFromOrders[buyOrderIdx].price;
      const sellPrice = allSellToOrders[sellOrderIdx].price;

      // Calculate marginal profit for one more item
      const grossProfit = sellPrice - buyPrice;
      const tax = sellPrice * taxRate;
      const netProfit = grossProfit - tax;

      // Stop if marginal profit is not positive
      if (netProfit <= 0) {
        // Record the profit-limited quantity before we hit negative profit
        profitLimitedQuantity = totalQuantity;
        break;
      }

      // How many items can we take at these prices?
      const takeFromBuy = buyOrderRemaining;
      const takeFromSell = sellOrderRemaining;
      const takeByCapacity = maxItemsByCapacity - totalQuantity;
      const take = Math.min(takeFromBuy, takeFromSell, takeByCapacity);

      if (take <= 0) break;

      // Execute the trade
      totalQuantity += take;
      totalBuyCost += take * buyPrice;
      totalSellRevenue += take * sellPrice;

      // Track order usage
      buyOrderAmounts.set(buyPrice, (buyOrderAmounts.get(buyPrice) || 0) + take);
      sellOrderAmounts.set(sellPrice, (sellOrderAmounts.get(sellPrice) || 0) + take);

      // Update remaining amounts
      buyOrderRemaining -= take;
      sellOrderRemaining -= take;

      // Move to next order if exhausted
      if (buyOrderRemaining <= 0) {
        buyOrderIdx++;
        buyOrderRemaining = allBuyFromOrders[buyOrderIdx]?.amount || 0;
      }
      if (sellOrderRemaining <= 0) {
        sellOrderIdx++;
        sellOrderRemaining = allSellToOrders[sellOrderIdx]?.amount || 0;
      }
    }

    // If we exited due to capacity, profit was still positive
    if (profitLimitedQuantity === 0 && totalQuantity > 0) {
      profitLimitedQuantity = totalQuantity;
    }

    if (totalQuantity === 0) {
      return null;
    }

    // Convert order amounts maps to arrays
    for (const [price, amount] of buyOrderAmounts) {
      buyOrdersUsed.push({ price, amount });
    }
    for (const [price, amount] of sellOrderAmounts) {
      sellOrdersUsed.push({ price, amount });
    }

    // Sort for display
    buyOrdersUsed.sort((a, b) => a.price - b.price);
    sellOrdersUsed.sort((a, b) => b.price - a.price);

    const totalTax = totalSellRevenue * taxRate;
    const totalProfit = totalSellRevenue - totalBuyCost - totalTax;
    const avgBuyPrice = totalBuyCost / totalQuantity;
    const avgSellPrice = totalSellRevenue / totalQuantity;
    const avgProfitPerUnit = totalProfit / totalQuantity;
    const profitPercent = (totalProfit / totalBuyCost) * 100;

    return {
      itemId,
      quality,
      buyCity: '', // Will be filled in by caller
      sellCity: '', // Will be filled in by caller
      optimalQuantity: totalQuantity,
      capacityLimitedQuantity: maxItemsByCapacity,
      profitLimitedQuantity,
      totalBuyCost,
      totalSellRevenue,
      totalTax,
      totalProfit,
      avgBuyPrice,
      avgSellPrice,
      avgProfitPerUnit,
      profitPercent,
      buyOrdersUsed,
      sellOrdersUsed,
    };
  }

  /**
   * Find arbitrage opportunities using depth-aware optimal calculation.
   * This version walks through the order book to find true profitable quantities.
   *
   * OPTIMIZED: Pre-fetches all orders in a single query and builds an in-memory index.
   *
   * @param itemWeight Function to get item weight by ID
   * @param carryCapacity Total carry capacity in kg
   * @param taxRate Quick sell tax rate (default 4%)
   * @param onProgress Optional progress callback
   */
  findOptimalArbitrageOpportunities(
    getItemWeight: (itemId: string) => number,
    carryCapacity: number,
    taxRate: number = 0.04,
    onProgress?: (percent: number, current: number, total: number) => void
  ): OptimalArbitrageResult[] {
    const now = new Date().toISOString();
    const staleThreshold = Date.now() - STALE_ORDER_THRESHOLD_MS;

    // OPTIMIZATION: Fetch ALL orders in a single query and build in-memory index
    // This avoids thousands of individual SQL queries
    const allOrders = this.db.prepare(`
      SELECT item_id, quality_level, location_id, price_silver, amount, auction_type
      FROM orders
      WHERE expires > ? AND last_seen > ?
    `).all(now, staleThreshold) as Array<{
      item_id: string;
      quality_level: number;
      location_id: number;
      price_silver: number;
      amount: number;
      auction_type: 'offer' | 'request';
    }>;

    // Build index: itemId -> quality -> city -> { sellOrders, buyOrders }
    type OrderBook = {
      sellOrders: Array<{ price: number; amount: number }>; // offers - sorted ascending
      buyOrders: Array<{ price: number; amount: number }>;  // requests - sorted descending
    };
    const index = new Map<string, Map<number, Map<City, OrderBook>>>();

    for (const order of allOrders) {
      const city = LOCATION_TO_CITY[order.location_id];
      if (!city) continue;

      if (!index.has(order.item_id)) {
        index.set(order.item_id, new Map());
      }
      const qualityMap = index.get(order.item_id)!;

      if (!qualityMap.has(order.quality_level)) {
        qualityMap.set(order.quality_level, new Map());
      }
      const cityMap = qualityMap.get(order.quality_level)!;

      if (!cityMap.has(city)) {
        cityMap.set(city, { sellOrders: [], buyOrders: [] });
      }
      const book = cityMap.get(city)!;

      if (order.auction_type === 'offer') {
        book.sellOrders.push({ price: order.price_silver, amount: order.amount });
      } else {
        book.buyOrders.push({ price: order.price_silver, amount: order.amount });
      }
    }

    // Sort all order books once
    for (const qualityMap of index.values()) {
      for (const cityMap of qualityMap.values()) {
        for (const book of cityMap.values()) {
          book.sellOrders.sort((a, b) => a.price - b.price);   // Ascending for buying
          book.buyOrders.sort((a, b) => b.price - a.price);    // Descending for selling
        }
      }
    }

    const opportunities: OptimalArbitrageResult[] = [];
    const items = Array.from(index.entries());
    const totalItems = items.length;

    for (let i = 0; i < items.length; i++) {
      const [itemId, qualityMap] = items[i];
      const weight = getItemWeight(itemId);
      const maxItemsByCapacity = Math.floor(carryCapacity / weight);

      // Report progress
      if (onProgress && i % 100 === 0) {
        const percent = Math.round((i / totalItems) * 100);
        onProgress(percent, i, totalItems);
      }

      for (const [quality, cityMap] of qualityMap) {
        const citiesWithData = Array.from(cityMap.keys());

        // Only check city pairs that both have data
        for (const buyCity of citiesWithData) {
          const buyBook = cityMap.get(buyCity)!;
          if (buyBook.sellOrders.length === 0) continue; // No sell orders to buy from

          for (const sellCity of citiesWithData) {
            if (buyCity === sellCity) continue;

            const sellBook = cityMap.get(sellCity)!;
            if (sellBook.buyOrders.length === 0) continue; // No buy orders to sell to

            // INLINE: Calculate optimal arbitrage without function call overhead
            const allBuyFromOrders = buyBook.sellOrders;
            const allSellToOrders = sellBook.buyOrders;

            let buyOrderIdx = 0;
            let sellOrderIdx = 0;
            let buyOrderRemaining = allBuyFromOrders[0].amount;
            let sellOrderRemaining = allSellToOrders[0].amount;

            let totalQuantity = 0;
            let totalBuyCost = 0;
            let totalSellRevenue = 0;

            const buyOrderAmounts = new Map<number, number>();
            const sellOrderAmounts = new Map<number, number>();

            while (
              buyOrderIdx < allBuyFromOrders.length &&
              sellOrderIdx < allSellToOrders.length &&
              totalQuantity < maxItemsByCapacity
            ) {
              const buyPrice = allBuyFromOrders[buyOrderIdx].price;
              const sellPrice = allSellToOrders[sellOrderIdx].price;

              // Marginal profit check
              const netProfit = sellPrice * (1 - taxRate) - buyPrice;
              if (netProfit <= 0) break;

              const take = Math.min(
                buyOrderRemaining,
                sellOrderRemaining,
                maxItemsByCapacity - totalQuantity
              );
              if (take <= 0) break;

              totalQuantity += take;
              totalBuyCost += take * buyPrice;
              totalSellRevenue += take * sellPrice;

              buyOrderAmounts.set(buyPrice, (buyOrderAmounts.get(buyPrice) || 0) + take);
              sellOrderAmounts.set(sellPrice, (sellOrderAmounts.get(sellPrice) || 0) + take);

              buyOrderRemaining -= take;
              sellOrderRemaining -= take;

              if (buyOrderRemaining <= 0) {
                buyOrderIdx++;
                buyOrderRemaining = allBuyFromOrders[buyOrderIdx]?.amount || 0;
              }
              if (sellOrderRemaining <= 0) {
                sellOrderIdx++;
                sellOrderRemaining = allSellToOrders[sellOrderIdx]?.amount || 0;
              }
            }

            if (totalQuantity === 0) continue;

            const totalTax = totalSellRevenue * taxRate;
            const totalProfit = totalSellRevenue - totalBuyCost - totalTax;

            if (totalProfit <= 0) continue;

            // Build order arrays for display
            const buyOrdersUsed: Array<{ price: number; amount: number }> = [];
            const sellOrdersUsed: Array<{ price: number; amount: number }> = [];
            for (const [price, amount] of buyOrderAmounts) {
              buyOrdersUsed.push({ price, amount });
            }
            for (const [price, amount] of sellOrderAmounts) {
              sellOrdersUsed.push({ price, amount });
            }
            buyOrdersUsed.sort((a, b) => a.price - b.price);
            sellOrdersUsed.sort((a, b) => b.price - a.price);

            opportunities.push({
              itemId,
              quality,
              buyCity,
              sellCity,
              optimalQuantity: totalQuantity,
              capacityLimitedQuantity: maxItemsByCapacity,
              profitLimitedQuantity: totalQuantity,
              totalBuyCost,
              totalSellRevenue,
              totalTax,
              totalProfit,
              avgBuyPrice: totalBuyCost / totalQuantity,
              avgSellPrice: totalSellRevenue / totalQuantity,
              avgProfitPerUnit: totalProfit / totalQuantity,
              profitPercent: (totalProfit / totalBuyCost) * 100,
              buyOrdersUsed,
              sellOrdersUsed,
            });
          }
        }
      }
    }

    // Report completion
    if (onProgress) {
      onProgress(100, totalItems, totalItems);
    }

    // Sort by total profit descending
    opportunities.sort((a, b) => b.totalProfit - a.totalProfit);

    return opportunities;
  }

  // ============================================================================
  // STATS & MAINTENANCE
  // ============================================================================

  /**
   * Get database statistics (only counts fresh orders)
   */
  getStats(): {
    totalOrders: number;
    sellOrders: number;
    buyOrders: number;
    uniqueItems: number;
    oldestOrder: string | null;
    newestOrder: string | null;
  } {
    const now = new Date().toISOString();
    const staleThreshold = Date.now() - STALE_ORDER_THRESHOLD_MS;

    const totalOrders = this.db.prepare(
      'SELECT COUNT(*) as count FROM orders WHERE expires > ? AND last_seen > ?'
    ).get(now, staleThreshold) as { count: number };

    const sellOrders = this.db.prepare(
      "SELECT COUNT(*) as count FROM orders WHERE expires > ? AND last_seen > ? AND auction_type = 'offer'"
    ).get(now, staleThreshold) as { count: number };

    const buyOrders = this.db.prepare(
      "SELECT COUNT(*) as count FROM orders WHERE expires > ? AND last_seen > ? AND auction_type = 'request'"
    ).get(now, staleThreshold) as { count: number };

    const uniqueItems = this.db.prepare(
      'SELECT COUNT(DISTINCT item_id) as count FROM orders WHERE expires > ? AND last_seen > ?'
    ).get(now, staleThreshold) as { count: number };

    const oldest = this.db.prepare(
      'SELECT MIN(expires) as ts FROM orders WHERE expires > ? AND last_seen > ?'
    ).get(now, staleThreshold) as { ts: string | null };

    const newest = this.db.prepare(
      'SELECT MAX(expires) as ts FROM orders WHERE expires > ? AND last_seen > ?'
    ).get(now, staleThreshold) as { ts: string | null };

    return {
      totalOrders: totalOrders.count,
      sellOrders: sellOrders.count,
      buyOrders: buyOrders.count,
      uniqueItems: uniqueItems.count,
      oldestOrder: oldest.ts,
      newestOrder: newest.ts,
    };
  }

  /**
   * Get freshness percentage - orders expiring in > 1 hour (only counts non-stale orders)
   */
  getFreshness(): { freshPercent: number; freshCount: number; totalCount: number } {
    const now = new Date().toISOString();
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const staleThreshold = Date.now() - STALE_ORDER_THRESHOLD_MS;

    const totalOrders = this.db.prepare(
      'SELECT COUNT(*) as count FROM orders WHERE expires > ? AND last_seen > ?'
    ).get(now, staleThreshold) as { count: number };

    const freshOrders = this.db.prepare(
      'SELECT COUNT(*) as count FROM orders WHERE expires > ? AND last_seen > ?'
    ).get(oneHourFromNow, staleThreshold) as { count: number };

    const freshPercent = totalOrders.count > 0
      ? (freshOrders.count / totalOrders.count) * 100
      : 0;

    return {
      freshPercent,
      freshCount: freshOrders.count,
      totalCount: totalOrders.count,
    };
  }

  /**
   * Get order counts per city (only counts non-stale orders)
   */
  getOrderCountsByCity(): Record<City, number> {
    const now = new Date().toISOString();
    const staleThreshold = Date.now() - STALE_ORDER_THRESHOLD_MS;
    const result: Partial<Record<City, number>> = {};

    // Initialize all cities to 0
    for (const city of Object.keys(CITY_TO_LOCATION) as City[]) {
      result[city] = 0;
    }

    // Get counts per location (excluding stale orders)
    const locationCounts = this.db.prepare(`
      SELECT location_id, COUNT(*) as count
      FROM orders
      WHERE expires > ? AND last_seen > ?
      GROUP BY location_id
    `).all(now, staleThreshold) as { location_id: number; count: number }[];

    // Aggregate by city
    for (const { location_id, count } of locationCounts) {
      const city = LOCATION_TO_CITY[location_id];
      if (city) {
        result[city] = (result[city] || 0) + count;
      }
    }

    return result as Record<City, number>;
  }

  /**
   * Get count of cities with data
   */
  getCitiesWithData(): number {
    const counts = this.getOrderCountsByCity();
    return Object.values(counts).filter(count => count > 0).length;
  }

  /**
   * Update a stat value
   */
  updateStat(key: string, value: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO stats (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run(key, value, Date.now());
  }

  /**
   * Get a stat value
   */
  getStat(key: string): number | null {
    const row = this.db.prepare('SELECT value FROM stats WHERE key = ?').get(key) as
      | { value: number }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * Get the database file size in bytes
   * Returns the size of the main database file plus any WAL file
   */
  getDatabaseSize(): number {
    const dbPath = this.db.name;
    let totalSize = 0;

    // Main database file
    if (fs.existsSync(dbPath)) {
      totalSize += fs.statSync(dbPath).size;
    }

    // WAL file (Write-Ahead Log)
    const walPath = dbPath + '-wal';
    if (fs.existsSync(walPath)) {
      totalSize += fs.statSync(walPath).size;
    }

    // SHM file (Shared Memory)
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(shmPath)) {
      totalSize += fs.statSync(shmPath).size;
    }

    return totalSize;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  // ============================================================================
  // PRICE HISTORY OPERATIONS
  // ============================================================================

  /**
   * Get the latest date we have price history for
   * Returns null if no history exists
   */
  getLatestHistoryDate(): string | null {
    const row = this.db.prepare(
      'SELECT MAX(date) as latest FROM price_history'
    ).get() as { latest: string | null } | undefined;
    return row?.latest ?? null;
  }

  /**
   * Get list of dates we're missing from the last N days
   * Returns array of date strings (YYYY-MM-DD) that need to be fetched
   * Note: Starts from yesterday since today's data is incomplete
   */
  getMissingHistoryDates(daysToKeep: number = 30): string[] {
    const missingDates: string[] = [];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    for (let i = 0; i < daysToKeep; i++) {
      const date = new Date(yesterday);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      // Check if we have any records for this date
      const row = this.db.prepare(
        'SELECT 1 FROM price_history WHERE date = ? LIMIT 1'
      ).get(dateStr);

      if (!row) {
        missingDates.push(dateStr);
      }
    }

    return missingDates;
  }

  /**
   * Get count of price history records
   */
  getPriceHistoryCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM price_history'
    ).get() as { count: number };
    return row.count;
  }

  /**
   * Insert price history records in bulk
   */
  insertPriceHistory(records: Array<{
    itemId: string;
    locationId: number;
    date: string;
    avgPrice: number;
    itemCount: number;
  }>): void {
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO price_history
        (item_id, location_id, date, avg_price, item_count, fetched_at)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const transaction = this.db.transaction((records: typeof arguments[0]) => {
      for (const record of records) {
        insertStmt.run(
          record.itemId,
          record.locationId,
          record.date,
          record.avgPrice,
          record.itemCount,
          now
        );
      }
    });

    transaction(records);
  }

  /**
   * Get price history for an item across all cities for the last N days
   */
  getPriceHistory(itemId: string, days: number = 30): Array<{
    locationId: number;
    date: string;
    avgPrice: number;
    itemCount: number;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    return this.db.prepare(`
      SELECT location_id as locationId, date, avg_price as avgPrice, item_count as itemCount
      FROM price_history
      WHERE item_id = ? AND date >= ?
      ORDER BY date DESC
    `).all(itemId, cutoffStr) as Array<{
      locationId: number;
      date: string;
      avgPrice: number;
      itemCount: number;
    }>;
  }

  /**
   * Get 30-day average price for an item in a specific city
   */
  get30DayAverage(itemId: string, locationIds: number[]): { avgPrice: number; totalVolume: number; dataPoints: number } | null {
    const placeholders = locationIds.map(() => '?').join(',');
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const rows = this.db.prepare(`
      SELECT avg_price, item_count
      FROM price_history
      WHERE item_id = ? AND location_id IN (${placeholders}) AND date >= ?
    `).all(itemId, ...locationIds, cutoffStr) as Array<{ avg_price: number; item_count: number }>;

    if (rows.length === 0) {
      return null;
    }

    let totalPrice = 0;
    let totalVolume = 0;

    for (const row of rows) {
      totalPrice += row.avg_price;
      totalVolume += row.item_count;
    }

    return {
      avgPrice: Math.round(totalPrice / rows.length),
      totalVolume,
      dataPoints: rows.length,
    };
  }

  /**
   * Clean up old price history (older than N days)
   */
  cleanupOldHistory(daysToKeep: number = 30): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const result = this.db.prepare(
      'DELETE FROM price_history WHERE date < ?'
    ).run(cutoffStr);

    return result.changes;
  }

  // ============================================================================
  // HOURLY PRICE HISTORY OPERATIONS
  // ============================================================================

  /**
   * Get the latest timestamp we have hourly price history for
   * Returns null if no history exists
   */
  getLatestHourlyHistoryTimestamp(): string | null {
    const row = this.db.prepare(
      'SELECT MAX(timestamp) as latest FROM hourly_price_history'
    ).get() as { latest: string | null } | undefined;
    return row?.latest ?? null;
  }

  /**
   * Get count of hourly price history records
   */
  getHourlyPriceHistoryCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM hourly_price_history'
    ).get() as { count: number };
    return row.count;
  }

  /**
   * Insert hourly price history records in bulk
   */
  insertHourlyPriceHistory(records: Array<{
    itemId: string;
    locationId: number;
    timestamp: string;
    avgPrice: number;
    itemCount: number;
  }>): void {
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO hourly_price_history
        (item_id, location_id, timestamp, avg_price, item_count, fetched_at)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const transaction = this.db.transaction((records: typeof arguments[0]) => {
      for (const record of records) {
        insertStmt.run(
          record.itemId,
          record.locationId,
          record.timestamp,
          record.avgPrice,
          record.itemCount,
          now
        );
      }
    });

    transaction(records);
  }

  /**
   * Get hourly price history for an item across all cities for the last N hours
   */
  getHourlyPriceHistory(itemId: string, hours: number = 24): Array<{
    locationId: number;
    timestamp: string;
    avgPrice: number;
    itemCount: number;
  }> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);
    const cutoffStr = cutoffTime.toISOString();

    return this.db.prepare(`
      SELECT location_id as locationId, timestamp, avg_price as avgPrice, item_count as itemCount
      FROM hourly_price_history
      WHERE item_id = ? AND timestamp >= ?
      ORDER BY timestamp DESC
    `).all(itemId, cutoffStr) as Array<{
      locationId: number;
      timestamp: string;
      avgPrice: number;
      itemCount: number;
    }>;
  }

  /**
   * Get all hourly price history for the last N hours (for arbitrage scanning)
   */
  getAllHourlyPriceHistory(hours: number = 24): Array<{
    itemId: string;
    locationId: number;
    timestamp: string;
    avgPrice: number;
    itemCount: number;
  }> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);
    const cutoffStr = cutoffTime.toISOString();

    return this.db.prepare(`
      SELECT item_id as itemId, location_id as locationId, timestamp, avg_price as avgPrice, item_count as itemCount
      FROM hourly_price_history
      WHERE timestamp >= ?
      ORDER BY item_id, location_id, timestamp DESC
    `).all(cutoffStr) as Array<{
      itemId: string;
      locationId: number;
      timestamp: string;
      avgPrice: number;
      itemCount: number;
    }>;
  }

  /**
   * Clean up old hourly price history (older than N hours)
   */
  cleanupOldHourlyHistory(hoursToKeep: number = 48): number {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hoursToKeep);
    const cutoffStr = cutoffTime.toISOString();

    const result = this.db.prepare(
      'DELETE FROM hourly_price_history WHERE timestamp < ?'
    ).run(cutoffStr);

    return result.changes;
  }

  /**
   * Get unique item count in hourly history
   */
  getHourlyHistoryItemCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(DISTINCT item_id) as count FROM hourly_price_history'
    ).get() as { count: number };
    return row.count;
  }
}

// Export singleton for shared use
let _instance: OrderBookDatabase | null = null;

export function getOrderBookDb(): OrderBookDatabase {
  if (!_instance) {
    _instance = new OrderBookDatabase();
  }
  return _instance;
}

export function closeOrderBookDb(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
