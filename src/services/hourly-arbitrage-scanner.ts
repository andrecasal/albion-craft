// hourly-arbitrage-scanner.ts
// Analyzes hourly price data to find arbitrage opportunities with trend analysis
// Uses high-resolution data to identify short-term price patterns
//
// NOTE: This file is temporarily disabled. The hourly price history functionality
// has been removed from the database in favor of daily price averages only.
// This feature will be re-enabled in a future update.

// DISABLED: Hourly price history functions removed from db.ts
// import { LOCATION_TO_CITY, CITY_TO_LOCATION, getAllHourlyPriceHistory, getHourlyPriceHistoryCount, getHourlyHistoryItemCount } from '../db/db';
import { LOCATION_TO_CITY, CITY_TO_LOCATION } from '../db/db';
import { City } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Load item names for display
const itemsData = require('../constants/items.json') as Array<{ id: string; name: string }>;
const refinedMaterials = require('../constants/refined-materials.json') as Array<{ id: string; name: string }>;

// Build item name lookup
const ITEM_NAMES = new Map<string, string>();
for (const item of itemsData) {
  ITEM_NAMES.set(item.id, item.name);
}
for (const item of refinedMaterials) {
  ITEM_NAMES.set(item.id, item.name);
}

// Cities for analysis (excluding Caerleon due to risk)
const SAFE_CITIES: City[] = [
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
];

// ============================================================================
// TYPES
// ============================================================================

export interface HourlyPriceStats {
  itemId: string;
  itemName: string;
  city: City;
  // Current price (most recent hour)
  currentPrice: number;
  // 24h stats
  avgPrice24h: number;
  minPrice24h: number;
  maxPrice24h: number;
  // Trend indicators
  priceChange24h: number;      // % change from 24h ago
  priceChange6h: number;       // % change from 6h ago
  priceChange1h: number;       // % change from 1h ago
  volatility: number;          // Standard deviation as % of avg
  // Volume
  totalVolume24h: number;
  dataPoints: number;
}

export interface HourlyArbitrageOpportunity {
  itemId: string;
  itemName: string;
  // Buy side
  buyCity: City;
  buyPrice: number;
  buyTrend: 'rising' | 'stable' | 'falling';
  buyChange24h: number;
  // Sell side
  sellCity: City;
  sellPrice: number;
  sellTrend: 'rising' | 'stable' | 'falling';
  sellChange24h: number;
  // Profit metrics (after 4% tax)
  grossProfit: number;
  netProfit: number;
  profitPercent: number;
  // Timing recommendation
  timingSignal: 'strong_buy' | 'buy' | 'hold' | 'weak';
  timingReason: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function calculateStats(prices: number[]): { avg: number; min: number; max: number; stdDev: number } {
  if (prices.length === 0) {
    return { avg: 0, min: 0, max: 0, stdDev: 0 };
  }

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  const squaredDiffs = prices.map(p => Math.pow(p - avg, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / prices.length;
  const stdDev = Math.sqrt(variance);

  return { avg, min, max, stdDev };
}

function getTrend(change: number): 'rising' | 'stable' | 'falling' {
  if (change > 3) return 'rising';
  if (change < -3) return 'falling';
  return 'stable';
}

function formatPrice(price: number): string {
  if (price >= 1000000) {
    return (price / 1000000).toFixed(1) + 'M';
  }
  if (price >= 1000) {
    return (price / 1000).toFixed(1) + 'K';
  }
  return price.toString();
}

function formatPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function getTrendEmoji(trend: 'rising' | 'stable' | 'falling'): string {
  switch (trend) {
    case 'rising': return '📈';
    case 'falling': return '📉';
    default: return '➡️';
  }
}

// ============================================================================
// MAIN SCANNER FUNCTIONS
// ============================================================================

/**
 * Analyze hourly price data for all items across all cities
 * DISABLED: Hourly price history has been removed from the database.
 */
export function analyzeHourlyPrices(): Map<string, Map<City, HourlyPriceStats>> {
  // DISABLED: Return empty map since hourly data functions are removed
  console.warn('analyzeHourlyPrices is disabled - hourly price history has been removed');
  return new Map();
}

/* DISABLED: Original implementation requires hourly price history functions
function _analyzeHourlyPrices_DISABLED(): Map<string, Map<City, HourlyPriceStats>> {
  const allData = getAllHourlyPriceHistory(24);

  if (allData.length === 0) {
    return new Map();
  }

  // Group data by item -> location -> timestamps
  const grouped = new Map<string, Map<number, Array<{ timestamp: string; avgPrice: number; itemCount: number }>>>();

  for (const record of allData) {
    if (!grouped.has(record.itemId)) {
      grouped.set(record.itemId, new Map());
    }
    const itemMap = grouped.get(record.itemId)!;

    if (!itemMap.has(record.locationId)) {
      itemMap.set(record.locationId, []);
    }
    itemMap.get(record.locationId)!.push({
      timestamp: record.timestamp,
      avgPrice: record.avgPrice,
      itemCount: record.itemCount,
    });
  }

  // Calculate stats for each item/city combination
  const results = new Map<string, Map<City, HourlyPriceStats>>();
  const now = new Date();

  for (const [itemId, locationMap] of grouped) {
    const cityStats = new Map<City, HourlyPriceStats>();

    for (const [locationId, records] of locationMap) {
      const city = LOCATION_TO_CITY[locationId];
      if (!city || !SAFE_CITIES.includes(city)) continue;

      // Sort by timestamp (newest first)
      records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      if (records.length === 0) continue;

      const prices = records.map(r => r.avgPrice);
      const stats = calculateStats(prices);

      // Get prices at different time points
      const currentPrice = records[0].avgPrice;
      const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
      const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Find closest prices to those timestamps
      const findClosestPrice = (targetTime: Date): number | null => {
        let closest: { price: number; diff: number } | null = null;
        for (const record of records) {
          const recordTime = new Date(record.timestamp);
          const diff = Math.abs(recordTime.getTime() - targetTime.getTime());
          if (!closest || diff < closest.diff) {
            closest = { price: record.avgPrice, diff };
          }
        }
        return closest?.price || null;
      };

      const price1hAgo = findClosestPrice(oneHourAgo);
      const price6hAgo = findClosestPrice(sixHoursAgo);
      const price24hAgo = findClosestPrice(twentyFourHoursAgo);

      // Calculate changes
      const change1h = price1hAgo ? ((currentPrice - price1hAgo) / price1hAgo) * 100 : 0;
      const change6h = price6hAgo ? ((currentPrice - price6hAgo) / price6hAgo) * 100 : 0;
      const change24h = price24hAgo ? ((currentPrice - price24hAgo) / price24hAgo) * 100 : 0;

      // Calculate volatility as % of average
      const volatility = stats.avg > 0 ? (stats.stdDev / stats.avg) * 100 : 0;

      // Total volume
      const totalVolume = records.reduce((sum, r) => sum + r.itemCount, 0);

      cityStats.set(city, {
        itemId,
        itemName: ITEM_NAMES.get(itemId) || itemId,
        city,
        currentPrice,
        avgPrice24h: Math.round(stats.avg),
        minPrice24h: stats.min,
        maxPrice24h: stats.max,
        priceChange24h: change24h,
        priceChange6h: change6h,
        priceChange1h: change1h,
        volatility,
        totalVolume24h: totalVolume,
        dataPoints: records.length,
      });
    }

    if (cityStats.size > 0) {
      results.set(itemId, cityStats);
    }
  }

  return results;
}
*/

/**
 * Find arbitrage opportunities using hourly price trends
 */
export function findHourlyArbitrageOpportunities(): HourlyArbitrageOpportunity[] {
  const priceData = analyzeHourlyPrices();
  const opportunities: HourlyArbitrageOpportunity[] = [];

  const TAX_RATE = 0.04; // 4% quick sell tax

  for (const [itemId, cityStats] of priceData) {
    // Find cities with both buy and sell potential
    const cities = Array.from(cityStats.entries());

    for (let i = 0; i < cities.length; i++) {
      for (let j = 0; j < cities.length; j++) {
        if (i === j) continue;

        const [buyCity, buyStats] = cities[i];
        const [sellCity, sellStats] = cities[j];

        // Calculate profit
        const grossProfit = sellStats.currentPrice - buyStats.currentPrice;
        const tax = sellStats.currentPrice * TAX_RATE;
        const netProfit = grossProfit - tax;

        // Only include profitable opportunities
        if (netProfit <= 0) continue;

        const profitPercent = (netProfit / buyStats.currentPrice) * 100;

        // Minimum 5% profit to be worth considering
        if (profitPercent < 5) continue;

        // Determine trends
        const buyTrend = getTrend(buyStats.priceChange24h);
        const sellTrend = getTrend(sellStats.priceChange24h);

        // Determine timing signal based on trends
        let timingSignal: 'strong_buy' | 'buy' | 'hold' | 'weak';
        let timingReason: string;

        if (buyTrend === 'falling' && sellTrend === 'rising') {
          timingSignal = 'strong_buy';
          timingReason = 'Buy prices falling, sell prices rising - optimal window';
        } else if (buyTrend === 'falling' && sellTrend === 'stable') {
          timingSignal = 'buy';
          timingReason = 'Buy prices falling, good entry point';
        } else if (buyTrend === 'stable' && sellTrend === 'rising') {
          timingSignal = 'buy';
          timingReason = 'Sell prices rising, capture increasing spread';
        } else if (buyTrend === 'rising' && sellTrend === 'falling') {
          timingSignal = 'weak';
          timingReason = 'Spread may be closing - consider waiting';
        } else {
          timingSignal = 'hold';
          timingReason = 'Stable spread - monitor for changes';
        }

        opportunities.push({
          itemId,
          itemName: buyStats.itemName,
          buyCity,
          buyPrice: buyStats.currentPrice,
          buyTrend,
          buyChange24h: buyStats.priceChange24h,
          sellCity,
          sellPrice: sellStats.currentPrice,
          sellTrend,
          sellChange24h: sellStats.priceChange24h,
          grossProfit,
          netProfit,
          profitPercent,
          timingSignal,
          timingReason,
        });
      }
    }
  }

  // Sort by timing signal priority, then by profit
  const signalPriority = { 'strong_buy': 0, 'buy': 1, 'hold': 2, 'weak': 3 };
  opportunities.sort((a, b) => {
    const priorityDiff = signalPriority[a.timingSignal] - signalPriority[b.timingSignal];
    if (priorityDiff !== 0) return priorityDiff;
    return b.profitPercent - a.profitPercent;
  });

  return opportunities;
}

/**
 * Display hourly arbitrage opportunities in the console
 * DISABLED: Hourly price history has been removed from the database.
 */
export function displayHourlyArbitrageOpportunities(): void {
  console.log('\n⚠️  Hourly Arbitrage Scanner is temporarily disabled.');
  console.log('   The hourly price history functionality has been removed in favor of daily price averages.');
  console.log('   This feature will be re-enabled in a future update.\n');
  return;
}

/* DISABLED: Original implementation requires hourly price history functions
function _displayHourlyArbitrageOpportunities_DISABLED(): void {
  const status = {
    totalRecords: getHourlyPriceHistoryCount(),
    uniqueItems: getHourlyHistoryItemCount(),
  };

  if (status.totalRecords === 0) {
    console.log('\n=== HOURLY ARBITRAGE OPPORTUNITIES ===');
    console.log('   No hourly data available.');
    console.log('   Run the application to fetch hourly data first.\n');
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('                                         HOURLY ARBITRAGE OPPORTUNITIES');
  console.log('                                         Based on 24h price trends | Quick Sell (4% tax)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`\n   Data: ${status.totalRecords.toLocaleString()} hourly records across ${status.uniqueItems.toLocaleString()} items\n`);

  const opportunities = findHourlyArbitrageOpportunities();

  if (opportunities.length === 0) {
    console.log('   No profitable opportunities found (minimum 5% profit required).\n');
    return;
  }

  // Group by timing signal
  const strongBuy = opportunities.filter(o => o.timingSignal === 'strong_buy');
  const buy = opportunities.filter(o => o.timingSignal === 'buy');
  const hold = opportunities.filter(o => o.timingSignal === 'hold');

  if (strongBuy.length > 0) {
    console.log('\n   🔥 STRONG BUY - Optimal Timing (buy falling, sell rising)');
    console.log('   ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────');
    displayOpportunityTable(strongBuy.slice(0, 15));
  }

  if (buy.length > 0) {
    console.log('\n   ✅ BUY - Good Timing');
    console.log('   ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────');
    displayOpportunityTable(buy.slice(0, 15));
  }

  if (hold.length > 0) {
    console.log('\n   ⏸️  HOLD - Stable Spread (monitor for changes)');
    console.log('   ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────');
    displayOpportunityTable(hold.slice(0, 10));
  }

  console.log('\n   Legend:');
  console.log('   • Buy/Sell Trend: 24h price movement (📈 rising >3%, 📉 falling <-3%, ➡️ stable)');
  console.log('   • Net Profit: After 4% quick sell tax');
  console.log('   • Timing signals based on trend convergence/divergence\n');
}
*/

function displayOpportunityTable(opportunities: HourlyArbitrageOpportunity[]): void {
  console.log('   ┌─────────────────────────────────┬──────────────┬─────────────────┬──────────────┬─────────────────┬────────────┬────────────┐');
  console.log('   │ Item                            │ Buy City     │ Buy Price       │ Sell City    │ Sell Price      │ Net Profit │ ROI %      │');
  console.log('   ├─────────────────────────────────┼──────────────┼─────────────────┼──────────────┼─────────────────┼────────────┼────────────┤');

  for (const opp of opportunities) {
    const name = opp.itemName.substring(0, 31).padEnd(31);
    const buyCity = opp.buyCity.substring(0, 12).padEnd(12);
    const buyTrendEmoji = getTrendEmoji(opp.buyTrend);
    const buyPriceStr = `${formatPrice(opp.buyPrice)} ${buyTrendEmoji}${formatPct(opp.buyChange24h)}`.padEnd(15);
    const sellCity = opp.sellCity.substring(0, 12).padEnd(12);
    const sellTrendEmoji = getTrendEmoji(opp.sellTrend);
    const sellPriceStr = `${formatPrice(opp.sellPrice)} ${sellTrendEmoji}${formatPct(opp.sellChange24h)}`.padEnd(15);
    const netProfit = formatPrice(opp.netProfit).padStart(10);
    const roi = `${opp.profitPercent.toFixed(1)}%`.padStart(10);

    console.log(`   │ ${name} │ ${buyCity} │ ${buyPriceStr} │ ${sellCity} │ ${sellPriceStr} │ ${netProfit} │ ${roi} │`);
  }

  console.log('   └─────────────────────────────────┴──────────────┴─────────────────┴──────────────┴─────────────────┴────────────┴────────────┘');
}

/**
 * Main entry point for scanning hourly arbitrage
 * DISABLED: Hourly price history has been removed from the database.
 */
export async function scanHourlyArbitrage(): Promise<HourlyArbitrageOpportunity[]> {
  displayHourlyArbitrageOpportunities();
  return [];  // Return empty array since hourly data is disabled
}
