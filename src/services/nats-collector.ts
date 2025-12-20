// nats-collector.ts
// Background service that ingests NATS market orders and stores them in SQLite

import { connect, StringCodec, NatsConnection, Subscription } from 'nats';
import { OrderBookDatabase, MarketOrder, getOrderBookDb, closeOrderBookDb, CITY_TO_LOCATION } from './order-book-db';
import { City } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================

const NATS_SERVERS = {
  europe: { host: 'nats.albion-online-data.com', port: 34222 },
  americas: { host: 'nats.albion-online-data.com', port: 4222 },
  asia: { host: 'nats.albion-online-data.com', port: 24222 },
};

const NATS_USER = 'public';
const NATS_PASS = 'thenewalbiondata';

// Use ingest for real-time, deduped for less frequent updates
const MARKET_ORDERS_TOPIC = 'marketorders.ingest';

// How often to clean up expired orders (in ms)
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// How often to log stats (in ms)
const STATS_INTERVAL = 1000; // 1 second

// ============================================================================
// TYPES
// ============================================================================

interface RawMarketOrder {
  Id: number;
  ItemTypeId: string;
  ItemGroupTypeId: string;
  LocationId: number;
  QualityLevel: number;
  EnchantmentLevel: number;
  UnitPriceSilver: number;
  Amount: number;
  AuctionType: string;
  Expires: string;
}

interface MarketOrdersMessage {
  Orders: RawMarketOrder[];
}

export type Region = 'europe' | 'americas' | 'asia';

// ============================================================================
// COLLECTOR SERVICE
// ============================================================================

export class NatsCollector {
  private db: OrderBookDatabase;
  private nc: NatsConnection | null = null;
  private subscription: Subscription | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private running = false;
  private region: Region;

  // Stats
  private messagesReceived = 0;
  private ordersProcessed = 0;
  private ordersProcessedTotal = 0; // Cumulative session total
  private ordersExpiredCleaned = 0;
  private lastStatsTime = Date.now();
  private startTime = Date.now();

  constructor(region: Region = 'europe', db?: OrderBookDatabase) {
    this.region = region;
    this.db = db || getOrderBookDb();
  }

  /**
   * Start the collector service
   */
  async start(): Promise<void> {
    if (this.running) {
      console.log('Collector is already running');
      return;
    }

    const server = NATS_SERVERS[this.region];

    try {
      this.nc = await connect({
        servers: `${server.host}:${server.port}`,
        user: NATS_USER,
        pass: NATS_PASS,
        reconnect: true,
        maxReconnectAttempts: -1, // Infinite reconnects
        reconnectTimeWait: 2000,
      });

      // Handle connection events
      (async () => {
        if (!this.nc) return;
        for await (const status of this.nc.status()) {
          switch (status.type) {
            case 'disconnect':
              console.log(`⚠️  Disconnected from NATS`);
              break;
            case 'reconnect':
              console.log(`✅ Reconnected to NATS`);
              break;
            case 'error':
              console.error(`❌ NATS error:`, status.data);
              break;
          }
        }
      })();

      this.running = true;
      this.startTime = Date.now();

      // Start subscription
      await this.subscribe();

      // Start cleanup timer
      this.startCleanupTimer();

      // Start stats timer
      this.startStatsTimer();

      // Show initial dashboard immediately
      this.logStats(false);
    } catch (err) {
      console.error(`❌ Failed to connect to NATS:`, err);
      throw err;
    }
  }

  /**
   * Stop the collector service
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    console.log(`\n🛑 Stopping collector...`);

    this.running = false;

    // Stop timers
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    // Unsubscribe
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }

    // Close NATS connection
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
    }

    // Final stats
    this.logStats(true);

    console.log(`👋 Collector stopped\n`);
  }

  /**
   * Subscribe to market orders topic
   */
  private async subscribe(): Promise<void> {
    if (!this.nc) return;

    const sc = StringCodec();
    this.subscription = this.nc.subscribe(MARKET_ORDERS_TOPIC);

    // Process messages
    (async () => {
      if (!this.subscription) return;

      for await (const msg of this.subscription) {
        if (!this.running) break;

        try {
          const data = sc.decode(msg.data);
          const message: MarketOrdersMessage = JSON.parse(data);

          if (message.Orders && message.Orders.length > 0) {
            this.processOrders(message.Orders);
          }
        } catch (err) {
          console.error(`❌ Error processing message:`, err);
        }
      }
    })();
  }

  /**
   * Process and store incoming orders
   */
  private processOrders(rawOrders: RawMarketOrder[]): void {
    this.messagesReceived++;

    const orders: MarketOrder[] = rawOrders.map((raw) => ({
      id: raw.Id,
      itemId: raw.ItemTypeId,
      itemGroupId: raw.ItemGroupTypeId,
      locationId: raw.LocationId,
      qualityLevel: raw.QualityLevel,
      enchantmentLevel: raw.EnchantmentLevel,
      priceSilver: raw.UnitPriceSilver, // Stored as-is (cents); divide by 100 for display
      amount: raw.Amount,
      auctionType: raw.AuctionType === 'offer' ? 'offer' : 'request',
      expires: raw.Expires,
    }));

    // Bulk insert for performance
    this.db.upsertOrders(orders);
    this.ordersProcessed += orders.length;
    this.ordersProcessedTotal += orders.length;
  }

  /**
   * Start periodic cleanup of expired orders
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const deleted = this.db.cleanupExpired();
      if (deleted > 0) {
        this.ordersExpiredCleaned += deleted;
        console.log(`🧹 Cleaned up ${deleted} expired orders`);
      }
    }, CLEANUP_INTERVAL);
  }

  /**
   * Start periodic stats logging
   */
  private startStatsTimer(): void {
    this.statsTimer = setInterval(() => {
      this.logStats(false);
    }, STATS_INTERVAL);
  }

  /**
   * Format number with K/M suffix
   */
  private formatNumber(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  /**
   * Format uptime as human-readable string
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Log current statistics as a rich dashboard
   */
  private logStats(final: boolean): void {
    const now = Date.now();
    const elapsed = (now - this.lastStatsTime) / 1000;
    const totalElapsed = now - this.startTime;

    const dbStats = this.db.getStats();
    const freshness = this.db.getFreshness();
    const cityCounts = this.db.getOrderCountsByCity();
    const citiesWithData = this.db.getCitiesWithData();
    const totalCities = Object.keys(CITY_TO_LOCATION).length;

    const ordersPerSecond = elapsed > 0 ? (this.ordersProcessed / elapsed).toFixed(1) : '0';

    if (final) {
      console.log(`\n📊 Final Statistics:`);
      console.log(`   Runtime: ${this.formatUptime(totalElapsed)}`);
      console.log(`   Messages received: ${this.messagesReceived}`);
      console.log(`   Orders processed: ${this.formatNumber(this.ordersProcessedTotal)}`);
      console.log(`   Orders expired/cleaned: ${this.formatNumber(this.ordersExpiredCleaned)}`);
      console.log(`   Active orders in DB: ${this.formatNumber(dbStats.totalOrders)}`);
      console.log(`   Unique items tracked: ${this.formatNumber(dbStats.uniqueItems)}`);
    } else {
      // Move cursor to top-left and clear from cursor to end of screen
      process.stdout.write('\x1B[H\x1B[J');

      const uptime = this.formatUptime(totalElapsed);

      // Table with emojis - each emoji takes 2 visual chars but varies in string length
      // Strategy: pad the text part only, then prepend emoji
      const W = '─'.repeat(70);
      const lines: string[] = [];

      // Header
      lines.push(`┌${W}┐`);
      const titleText = `ALBION MARKET COLLECTOR                         > ${this.region.toUpperCase()}`;
      lines.push(`│  📡 ${titleText.padEnd(63)}  │`);
      const statusIcon = this.nc ? '🟢' : '🔴';
      const statusText = `${this.nc ? 'Connected' : 'Disconnected'}                                       Uptime: ${uptime}`;
      lines.push(`│  ${statusIcon} ${statusText.padEnd(65)}│`);
      lines.push(`├${W}┤`);

      // Stats rows - emoji + text, pad text portion to align
      const r1c1 = `Rate: ${ordersPerSecond}/s`.padEnd(19);
      const r1c2 = `Total: ${this.formatNumber(dbStats.totalOrders)}`.padEnd(21);
      const r1c3 = `Items: ${this.formatNumber(dbStats.uniqueItems)}`.padEnd(17);
      lines.push(`│  ⚡ ${r1c1} 📦 ${r1c2} 🏷️  ${r1c3}│`);

      const r2c1 = `Session: ${this.formatNumber(this.ordersProcessedTotal)}`.padEnd(19);
      const r2c2 = `Sell: ${this.formatNumber(dbStats.sellOrders)}`.padEnd(21);
      const r2c3 = `Cities: ${citiesWithData}/${totalCities}`.padEnd(17);
      lines.push(`│  📊 ${r2c1} 💰 ${r2c2} 🏙️  ${r2c3}│`);

      const r3c1 = `Cleaned: ${this.formatNumber(this.ordersExpiredCleaned)}`.padEnd(19);
      const r3c2 = `Buy: ${this.formatNumber(dbStats.buyOrders)}`.padEnd(21);
      const r3c3 = `Fresh: ${freshness.freshPercent.toFixed(0)}%`.padEnd(17);
      lines.push(`│  🧹 ${r3c1} 🛒 ${r3c2} ✨ ${r3c3}│`);

      lines.push(`├${W}┤`);
      lines.push(`│  🗺️  ${'CITY BREAKDOWN'.padEnd(65)}│`);

      // City data with emojis
      const allCities = Object.keys(CITY_TO_LOCATION) as City[];
      const cityEmojis: Record<City, string> = {
        'Thetford': '🌿', 'Martlock': '⛰️', 'Fort Sterling': '❄️',
        'Lymhurst': '🌲', 'Bridgewatch': '🏜️', 'Caerleon': '👑', 'Brecilien': '🌳',
      };

      const fmtCity = (city: City, padLen: number): string => {
        const count = cityCounts[city] || 0;
        const name = city === 'Fort Sterling' ? 'FortSterling' : city;
        const text = `${name}: ${this.formatNumber(count)}`.padEnd(padLen);
        return `${cityEmojis[city]} ${text}`;
      };

      lines.push(`│  ${fmtCity(allCities[0], 19)} ${fmtCity(allCities[1], 19)} ${fmtCity(allCities[2], 21)}│`);
      lines.push(`│  ${fmtCity(allCities[3], 19)} ${fmtCity(allCities[4], 18)} ${fmtCity(allCities[5], 21)}│`);
      if (allCities[6]) {
        const lastCity = allCities[6];
        const count = cityCounts[lastCity] || 0;
        const text = `${lastCity}: ${this.formatNumber(count)}`.padEnd(65);
        lines.push(`│  ${cityEmojis[lastCity]} ${text}│`);
      }

      lines.push(`└${W}┘`);

      console.log(lines.join('\n'));
    }

    // Reset interval counters (not cumulative ones)
    this.lastStatsTime = now;
    this.ordersProcessed = 0;
  }

  /**
   * Get current database instance
   */
  getDatabase(): OrderBookDatabase {
    return this.db;
  }

  /**
   * Check if collector is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

// ============================================================================
// STANDALONE RUNNER
// ============================================================================

async function main(): Promise<void> {
  const region = (process.env.ALBION_REGION as Region) || 'europe';
  const collector = new NatsCollector(region);

  // Handle graceful shutdown
  const shutdown = async () => {
    await collector.stop();
    closeOrderBookDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await collector.start();

    // Keep running
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to start collector:', err);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { main as runCollector };
