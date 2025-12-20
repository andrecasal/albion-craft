// order-book-db.ts
// SQLite-based order book storage for real-time market data

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { City } from '../types';

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
  priceSilver: number; // In cents (raw value); divide by 100 for silver
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
    const defaultPath = path.join(process.cwd(), 'src', 'db', 'order-book.sqlite');
    const finalPath = dbPath || defaultPath;

    // Ensure directory exists
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrent access
    this.db.pragma('synchronous = NORMAL'); // Faster writes, still safe

    this.initSchema();
    this.insertStmt = this.prepareInsert();
    this.updateStmt = this.prepareUpdate();
    this.deleteExpiredStmt = this.prepareDeleteExpired();
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
        expires TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_item_location
        ON orders(item_id, location_id);

      CREATE INDEX IF NOT EXISTS idx_item_type_location
        ON orders(item_id, auction_type, location_id);

      CREATE INDEX IF NOT EXISTS idx_expires
        ON orders(expires);

      CREATE INDEX IF NOT EXISTS idx_location
        ON orders(location_id);

      -- Stats table to track ingestion metrics
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private prepareInsert(): Database.Statement {
    return this.db.prepare(`
      INSERT OR REPLACE INTO orders
        (id, item_id, item_group_id, location_id, quality_level, enchantment_level,
         price_silver, amount, auction_type, expires)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      order.expires
    );
  }

  /**
   * Bulk upsert orders (much faster for batch inserts)
   */
  upsertOrders(orders: MarketOrder[]): void {
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
          order.expires
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
    const result = this.deleteExpiredStmt.run(now);
    return result.changes;
  }

  // ============================================================================
  // READ OPERATIONS
  // ============================================================================

  /**
   * Get market depth for an item at a location
   */
  getMarketDepth(itemId: string, locationId: number, quality?: number): MarketDepth {
    const now = new Date().toISOString();

    let whereClause = 'item_id = ? AND location_id = ? AND expires > ?';
    const params: (string | number)[] = [itemId, locationId, now];

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
   */
  findArbitrageOpportunities(
    minProfitPercent: number = 5,
    minQuantity: number = 1
  ): ArbitrageOpportunity[] {
    const now = new Date().toISOString();

    // Get all unique items with orders
    const items = this.db.prepare(`
      SELECT DISTINCT item_id, quality_level
      FROM orders
      WHERE expires > ?
    `).all(now) as { item_id: string; quality_level: number }[];

    const opportunities: ArbitrageOpportunity[] = [];

    for (const { item_id: itemId, quality_level: quality } of items) {
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

    // Sort by total profit descending
    opportunities.sort((a, b) => b.totalProfit - a.totalProfit);

    return opportunities;
  }

  // ============================================================================
  // STATS & MAINTENANCE
  // ============================================================================

  /**
   * Get database statistics
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

    const totalOrders = this.db.prepare(
      'SELECT COUNT(*) as count FROM orders WHERE expires > ?'
    ).get(now) as { count: number };

    const sellOrders = this.db.prepare(
      "SELECT COUNT(*) as count FROM orders WHERE expires > ? AND auction_type = 'offer'"
    ).get(now) as { count: number };

    const buyOrders = this.db.prepare(
      "SELECT COUNT(*) as count FROM orders WHERE expires > ? AND auction_type = 'request'"
    ).get(now) as { count: number };

    const uniqueItems = this.db.prepare(
      'SELECT COUNT(DISTINCT item_id) as count FROM orders WHERE expires > ?'
    ).get(now) as { count: number };

    const oldest = this.db.prepare(
      'SELECT MIN(expires) as ts FROM orders WHERE expires > ?'
    ).get(now) as { ts: string | null };

    const newest = this.db.prepare(
      'SELECT MAX(expires) as ts FROM orders WHERE expires > ?'
    ).get(now) as { ts: string | null };

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
   * Get freshness percentage - orders expiring in > 1 hour
   */
  getFreshness(): { freshPercent: number; freshCount: number; totalCount: number } {
    const now = new Date().toISOString();
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const totalOrders = this.db.prepare(
      'SELECT COUNT(*) as count FROM orders WHERE expires > ?'
    ).get(now) as { count: number };

    const freshOrders = this.db.prepare(
      'SELECT COUNT(*) as count FROM orders WHERE expires > ?'
    ).get(oneHourFromNow) as { count: number };

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
   * Get order counts per city
   */
  getOrderCountsByCity(): Record<City, number> {
    const now = new Date().toISOString();
    const result: Partial<Record<City, number>> = {};

    // Initialize all cities to 0
    for (const city of Object.keys(CITY_TO_LOCATION) as City[]) {
      result[city] = 0;
    }

    // Get counts per location
    const locationCounts = this.db.prepare(`
      SELECT location_id, COUNT(*) as count
      FROM orders
      WHERE expires > ?
      GROUP BY location_id
    `).all(now) as { location_id: number; count: number }[];

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
   * Close the database connection
   */
  close(): void {
    this.db.close();
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
