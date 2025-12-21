// city-arbitrage-scanner.ts
// Scans for profitable city-to-city arbitrage opportunities across all items
// Uses real-time order book data from SQLite (populated by NATS collector)

import * as readline from 'readline';
import { City } from '../types';
import { getOrderBookDb } from './order-book-db';

// Travel times between cities (in minutes)
const travelData = require('../constants/travel.json') as {
  description: string;
  travelTimes: Record<string, Record<string, number>>;
};
const TRAVEL_TIMES = travelData.travelTimes;

// ============================================================================
// CONFIGURATION
// ============================================================================

// Items data (all tradeable items with weights)
const itemsData = require('../constants/items.json') as Array<{
  id: string;
  name: string;
  tier: number;
  enchant: number;
  category: string;
  weight?: number;
}>;

// Mounts data (for capacity calculations)
const mountsData = require('../constants/mounts.json') as Array<{
  id: string;
  name: string;
  tier: number;
  enchantment: number;
  type: string;
  health?: number;
  moveSpeedBonus?: number;
  weight?: number;
  qualities?: Record<string, { maxWeight?: number }>;
}>;

// Bags data (for capacity calculations)
const bagsData = require('../constants/bags.json') as Array<{
  id: string;
  name: string;
  tier: number;
  enchantment: number;
  qualities: Record<string, { maxWeight: number }>;
}>;

// Food data (for name lookups)
const foodData = require('../constants/food.json') as Array<{
  id: string;
  name: string;
  tier: number;
  enchantment: number;
}>;

// Build unified ITEM_NAMES lookup from all sources (single source of truth per category)
const ITEM_NAMES = new Map<string, string>();
for (const item of itemsData) {
  ITEM_NAMES.set(item.id, item.name);
}
for (const mount of mountsData) {
  ITEM_NAMES.set(mount.id, mount.name);
}
for (const bag of bagsData) {
  ITEM_NAMES.set(bag.id, bag.name);
}
for (const food of foodData) {
  ITEM_NAMES.set(food.id, food.name);
}

// Build weight lookup from items.json
const itemWeightsData: Record<string, number> = {};
for (const item of itemsData) {
  if (item.weight) {
    itemWeightsData[item.id] = item.weight;
  }
}

// Base player inventory capacity (without bag/mount)
const BASE_PLAYER_CAPACITY = 200; // kg

// Default carry capacity: T8 Ox (normal) + T8 Bag (normal) + Base
// T8 Ox: 3200 kg, T8 Bag: 198 kg, Base: 200 kg = 3598 kg
const T8_OX_CAPACITY = 3200;
const T8_BAG_CAPACITY = 198;
const DEFAULT_CARRY_CAPACITY = BASE_PLAYER_CAPACITY + T8_OX_CAPACITY + T8_BAG_CAPACITY; // 3598 kg

// Cities for arbitrage (excluding Caerleon due to risk)
const SAFE_CITIES: City[] = [
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
];

// Market fees (with premium)
const QUICK_SELL_TAX = 0.04;  // 4% sales tax with premium (quick sell only pays sales tax)

// ============================================================================
// TYPES
// ============================================================================

export interface ArbitrageOpportunity {
  itemId: string;
  itemName: string;
  weight: number;
  quality: number;
  // Buy side
  buyCity: City;
  avgBuyPrice: number;  // Weighted average buy price (walking order book) - in silver
  // Sell side - quick sell (instant, to buy orders)
  quickSellCity: City;
  avgSellPrice: number;  // Weighted average sell price (walking order book) - in silver
  // Quantities
  optimalQuantity: number;        // Items to buy for max profit (within capacity)
  capacityLimitedQty: number;     // Max items we could carry
  profitLimitedQty: number;       // Items where marginal profit > 0
  // Profit metrics
  avgProfitPerUnit: number;       // Average profit per item after tax
  profitPct: number;              // ROI percentage
  totalProfit: number;            // Total profit for optimal quantity
  profitPerKg: number;            // Profit per kg of cargo
  // Investment
  totalInvestment: number;        // Total silver needed to buy
  // Time-based metrics
  travelTimeMinutes: number;      // One-way travel time in minutes
  silverPerHour: number;          // Profit per hour (accounting for round trip)
  // Order book depth used
  buyOrdersUsed: Array<{ price: number; amount: number }>;
  sellOrdersUsed: Array<{ price: number; amount: number }>;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get travel time between two cities in minutes
 * Returns null if route goes through Caerleon (risky) or cities not found
 */
function getTravelTime(fromCity: City, toCity: City): number | null {
  // Skip Caerleon routes - too risky
  if (fromCity === 'Caerleon' || toCity === 'Caerleon') {
    return null;
  }

  const fromTimes = TRAVEL_TIMES[fromCity];
  if (!fromTimes) return null;

  const time = fromTimes[toCity];
  return time !== undefined ? time : null;
}

function getItemWeight(itemId: string): number {
  if (itemWeightsData[itemId]) {
    return itemWeightsData[itemId];
  }

  const baseId = itemId.replace(/@[1-4]$/, '');
  if (itemWeightsData[baseId]) {
    return itemWeightsData[baseId];
  }

  return 1;
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

// ============================================================================
// MAIN SCANNER FUNCTION
// ============================================================================

export async function scanCityArbitrage(): Promise<ArbitrageOpportunity[]> {
  console.log(`\n🔍 City Arbitrage Scanner (Depth-Aware Order Book)`);
  console.log(`   Tax rate: Quick sell 4%`);
  console.log(`   Carry capacity: ${DEFAULT_CARRY_CAPACITY.toLocaleString()} kg (T8 Ox + T8 Bag + Base)\n`);

  // Get order book database
  const db = getOrderBookDb();
  const stats = db.getStats();

  if (stats.totalOrders === 0) {
    console.log('   ❌ No orders in the database.');
    console.log('   Please ensure the NATS collector is running: npm run collect\n');
    return [];
  }

  console.log(`   📊 Order book: ${stats.totalOrders.toLocaleString()} orders, ${stats.uniqueItems.toLocaleString()} items`);

  // Progress callback to show scanning progress
  const onProgress = (percent: number, current: number, total: number) => {
    process.stdout.write(`\r   ⏳ Scanning items... ${percent}% (${current.toLocaleString()}/${total.toLocaleString()})`);
  };

  // Get optimal arbitrage opportunities using depth-aware calculation
  const dbOpportunities = db.findOptimalArbitrageOpportunities(
    getItemWeight,
    DEFAULT_CARRY_CAPACITY,
    QUICK_SELL_TAX,
    onProgress
  );

  // Clear the progress line
  process.stdout.write('\r   ✅ Scan complete!                                            \n\n');

  // Filter to safe cities only and transform to our format
  const opportunities: ArbitrageOpportunity[] = [];

  for (const dbOpp of dbOpportunities) {
    // Filter: both cities must be in safe cities list
    if (!SAFE_CITIES.includes(dbOpp.buyCity as City) || !SAFE_CITIES.includes(dbOpp.sellCity as City)) {
      continue;
    }

    // Get travel time - skip if route is invalid (e.g., through Caerleon)
    const travelTime = getTravelTime(dbOpp.buyCity as City, dbOpp.sellCity as City);
    if (travelTime === null) continue;

    // Convert prices from hundredths of silver to silver (divide by 10000)
    // AODP API returns prices in hundredths of silver (e.g., 69040000 = 6904 silver)
    const avgBuyPrice = dbOpp.avgBuyPrice / 10000;
    const avgSellPrice = dbOpp.avgSellPrice / 10000;
    const totalProfit = dbOpp.totalProfit / 10000;
    const avgProfitPerUnit = dbOpp.avgProfitPerUnit / 10000;
    const totalInvestment = dbOpp.totalBuyCost / 10000;

    // Skip if not profitable
    if (totalProfit <= 0) continue;

    const weight = getItemWeight(dbOpp.itemId);
    const profitPerKg = totalProfit / (dbOpp.optimalQuantity * weight);

    // Calculate silver per hour
    // Round trip time = 2 * one-way travel time + ~2 min for buying + ~1 min for selling
    const roundTripMinutes = (travelTime * 2) + 3;
    const tripsPerHour = 60 / roundTripMinutes;
    const silverPerHour = Math.round(totalProfit * tripsPerHour);

    // Convert order book entries from hundredths to silver
    const buyOrdersUsed = dbOpp.buyOrdersUsed.map(o => ({
      price: Math.round(o.price / 10000),
      amount: o.amount,
    }));
    const sellOrdersUsed = dbOpp.sellOrdersUsed.map(o => ({
      price: Math.round(o.price / 10000),
      amount: o.amount,
    }));

    opportunities.push({
      itemId: dbOpp.itemId,
      itemName: ITEM_NAMES.get(dbOpp.itemId) || dbOpp.itemId,
      weight,
      quality: dbOpp.quality,
      buyCity: dbOpp.buyCity as City,
      avgBuyPrice: Math.round(avgBuyPrice),
      quickSellCity: dbOpp.sellCity as City,
      avgSellPrice: Math.round(avgSellPrice),
      optimalQuantity: dbOpp.optimalQuantity,
      capacityLimitedQty: dbOpp.capacityLimitedQuantity,
      profitLimitedQty: dbOpp.profitLimitedQuantity,
      avgProfitPerUnit: Math.round(avgProfitPerUnit),
      profitPct: parseFloat(dbOpp.profitPercent.toFixed(1)),
      totalProfit: Math.round(totalProfit),
      profitPerKg: Math.round(profitPerKg),
      totalInvestment: Math.round(totalInvestment),
      travelTimeMinutes: travelTime,
      silverPerHour,
      buyOrdersUsed,
      sellOrdersUsed,
    });
  }

  // Sort by silver per hour (best first)
  opportunities.sort((a, b) => b.silverPerHour - a.silverPerHour);

  // Display results
  displayArbitrageTable(opportunities);

  // Interactive selection
  await selectItemForTrip(opportunities);

  return opportunities;
}

// ============================================================================
// DISPLAY FUNCTIONS
// ============================================================================

function displayArbitrageTable(opportunities: ArbitrageOpportunity[]): void {
  if (opportunities.length === 0) {
    console.log('\n=== CITY ARBITRAGE OPPORTUNITIES ===');
    console.log('   No profitable opportunities found\n');
    console.log('   This can happen when:');
    console.log('   • The order book data is stale (run the NATS collector to refresh)');
    console.log('   • Market prices have converged across cities');
    console.log('   • Tax (4%) exceeds the price differences\n');
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('                                         CITY ARBITRAGE OPPORTUNITIES (Depth-Aware)');
  console.log('                                         Sorted by Silver/Hour | Quick Sell (4% tax)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════\n');

  console.log('┌────┬──────────────────────────────┬──────────────┬───────────┬──────────────┬───────────┬─────┬──────┬────────────┬────────────┬────────────┐');
  console.log('│ #  │ Item                         │ Buy City     │ Avg Buy   │ Sell City    │ Avg Sell  │ Qty │ Time │ Profit/ea  │ Total Prof │ Silver/hr  │');
  console.log('├────┼──────────────────────────────┼──────────────┼───────────┼──────────────┼───────────┼─────┼──────┼────────────┼────────────┼────────────┤');

  const displayCount = Math.min(50, opportunities.length);

  for (let i = 0; i < displayCount; i++) {
    const opp = opportunities[i];
    const rank = (i + 1).toString().padStart(2);

    // Add quality indicator if not normal (1)
    const qualityIndicator = opp.quality > 1 ? ` Q${opp.quality}` : '';
    const name = (opp.itemName + qualityIndicator).substring(0, 28).padEnd(28);

    const buyCity = opp.buyCity.substring(0, 12).padEnd(12);
    const avgBuyPrice = formatPrice(opp.avgBuyPrice).padStart(9);

    const sellCity = opp.quickSellCity.substring(0, 12).padEnd(12);
    const avgSellPrice = formatPrice(opp.avgSellPrice).padStart(9);

    const qty = opp.optimalQuantity.toString().padStart(4);
    const travelTime = `${opp.travelTimeMinutes}m`.padStart(5);
    const profitEach = `${formatPrice(opp.avgProfitPerUnit)} (${formatPct(opp.profitPct)})`.padStart(10);
    const totalProfit = formatPrice(opp.totalProfit).padStart(10);
    const silverPerHour = formatPrice(opp.silverPerHour).padStart(10);

    console.log(`│ ${rank} │ ${name} │ ${buyCity} │ ${avgBuyPrice} │ ${sellCity} │${avgSellPrice} │${qty} │${travelTime} │ ${profitEach} │ ${totalProfit} │ ${silverPerHour} │`);
  }

  console.log('└────┴──────────────────────────────┴──────────────┴───────────┴──────────────┴───────────┴─────┴──────┴────────────┴────────────┴────────────┘');

  if (opportunities.length > displayCount) {
    console.log(`\n   (Showing top ${displayCount} of ${opportunities.length} opportunities)`);
  }

  console.log('\n   Legend:');
  console.log('   • Avg Buy/Sell: Weighted average prices (walking through order book depth)');
  console.log('   • Qty: Optimal quantity (limited by carry capacity or profitable orders)');
  console.log('   • Time: One-way travel time between cities');
  console.log('   • Silver/hr: Estimated silver per hour (based on round trips)');
}

// ============================================================================
// INTERACTIVE TRIP CALCULATOR
// ============================================================================

async function selectItemForTrip(opportunities: ArbitrageOpportunity[]): Promise<void> {
  if (opportunities.length === 0) return;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });
  };

  try {
    console.log('\n   Enter an item number (1-50) to calculate a transport trip, or press Enter to skip.\n');
    const itemAnswer = await question('   Select item #: ');

    if (!itemAnswer) {
      return;
    }

    const itemChoice = parseInt(itemAnswer);
    if (isNaN(itemChoice) || itemChoice < 1 || itemChoice > Math.min(50, opportunities.length)) {
      console.log('   Invalid choice.');
      return;
    }

    const selected = opportunities[itemChoice - 1];

    // Ask for mount
    console.log('\n   Available mounts with carry capacity:');
    const mountsWithCapacity = mountsData
      .filter((m) => m.qualities && Object.values(m.qualities).some((q) => q.maxWeight && q.maxWeight > 0))
      .sort((a, b) => (b.qualities?.normal?.maxWeight || 0) - (a.qualities?.normal?.maxWeight || 0))
      .slice(0, 15);

    // Format: T#.# Name (min-max kg)
    mountsWithCapacity.forEach((mount, idx) => {
      const enchant = mount.enchantment > 0 ? `.${mount.enchantment}` : '';
      const minWeight = mount.qualities?.normal?.maxWeight || 0;
      const maxWeight = mount.qualities?.masterpiece?.maxWeight || minWeight;
      console.log(`   ${(idx + 1).toString().padStart(2)}. T${mount.tier}${enchant} ${mount.name} (${minWeight}-${maxWeight} kg)`);
    });

    const mountAnswer = await question('\n   Select mount # (or Enter for none): ');
    const mountChoice = parseInt(mountAnswer);
    let mountCapacity = 0;
    let selectedMountName = '';

    if (mountChoice >= 1 && mountChoice <= mountsWithCapacity.length) {
      const selectedMount = mountsWithCapacity[mountChoice - 1];

      // Ask for quality
      console.log('\n   Select mount quality:');
      const qualities = ['normal', 'good', 'outstanding', 'excellent', 'masterpiece'] as const;
      qualities.forEach((q, idx) => {
        const weight = selectedMount.qualities?.[q]?.maxWeight || 0;
        console.log(`   ${idx + 1}. ${q.charAt(0).toUpperCase() + q.slice(1)} (${weight} kg)`);
      });

      const qualityAnswer = await question('\n   Select quality # [1]: ');
      const qualityChoice = parseInt(qualityAnswer) || 1;

      if (qualityChoice >= 1 && qualityChoice <= qualities.length) {
        const selectedQuality = qualities[qualityChoice - 1];
        mountCapacity = selectedMount.qualities?.[selectedQuality]?.maxWeight || 0;
        const enchant = selectedMount.enchantment > 0 ? `.${selectedMount.enchantment}` : '';
        selectedMountName = `T${selectedMount.tier}${enchant} ${selectedMount.name} (${selectedQuality})`;
        console.log(`   ✓ Selected: ${selectedMountName} (${mountCapacity} kg)`);
      }
    }

    // Ask for bag
    console.log('\n   Available bags (T8 only have carry capacity):');
    const bagsWithCapacity = bagsData
      .filter((b) => b.qualities.normal.maxWeight > 0);

    // Format: T8.0, T8.1, T8.2, T8.3, T8.4 with quality range
    bagsWithCapacity.forEach((bag, idx) => {
      const enchant = bag.enchantment > 0 ? `.${bag.enchantment}` : '.0';
      const minWeight = bag.qualities.normal.maxWeight;
      const maxWeight = bag.qualities.masterpiece.maxWeight;
      console.log(`   ${idx + 1}. T${bag.tier}${enchant} ${bag.name} (${minWeight}-${maxWeight} kg)`);
    });

    const bagAnswer = await question('\n   Select bag # (or Enter for none): ');
    const bagChoice = parseInt(bagAnswer);
    let bagCapacity = 0;
    let selectedBagName = '';

    if (bagChoice >= 1 && bagChoice <= bagsWithCapacity.length) {
      const selectedBag = bagsWithCapacity[bagChoice - 1];

      // Ask for quality
      console.log('\n   Select bag quality:');
      const qualities = ['normal', 'good', 'outstanding', 'excellent', 'masterpiece'] as const;
      qualities.forEach((q, idx) => {
        const weight = selectedBag.qualities[q].maxWeight;
        console.log(`   ${idx + 1}. ${q.charAt(0).toUpperCase() + q.slice(1)} (${weight} kg)`);
      });

      const qualityAnswer = await question('\n   Select quality # [1]: ');
      const qualityChoice = parseInt(qualityAnswer) || 1;

      if (qualityChoice >= 1 && qualityChoice <= qualities.length) {
        const selectedQuality = qualities[qualityChoice - 1];
        bagCapacity = selectedBag.qualities[selectedQuality].maxWeight;
        const enchant = selectedBag.enchantment > 0 ? `.${selectedBag.enchantment}` : '.0';
        selectedBagName = `T${selectedBag.tier}${enchant} ${selectedBag.name} (${selectedQuality})`;
        console.log(`   ✓ Selected: ${selectedBagName} (${bagCapacity} kg)`);
      }
    }

    // Calculate total capacity and items
    const totalCapacity = BASE_PLAYER_CAPACITY + mountCapacity + bagCapacity;
    const itemsByCapacity = Math.floor(totalCapacity / selected.weight);
    // The optimal quantity already accounts for profitable orders, but re-limit by custom capacity
    const itemsPerTrip = Math.min(itemsByCapacity, selected.optimalQuantity);

    // Calculate time and silver/hour for this specific trip
    const oneWayTime = selected.travelTimeMinutes;
    const roundTripMinutes = (oneWayTime * 2) + 3; // +3 min for buy/sell actions
    const tripsPerHour = 60 / roundTripMinutes;

    // For custom capacity, we need to recalculate profit based on limited quantity
    // Use the average profit per unit since we're taking from the same order book
    const tripProfit = itemsPerTrip * selected.avgProfitPerUnit;
    const tripInvestment = itemsPerTrip * selected.avgBuyPrice;
    const silverPerHourTrip = Math.round(tripProfit * tripsPerHour);

    // Display trip summary
    console.log('\n   ═══════════════════════════════════════════════════════════════');
    console.log('   TRANSPORT TRIP SUMMARY (Depth-Aware)');
    console.log('   ═══════════════════════════════════════════════════════════════');
    const qualityStr = selected.quality > 1 ? ` (Quality ${selected.quality})` : '';
    console.log(`   Item: ${selected.itemName}${qualityStr}`);
    console.log(`   Weight per item: ${selected.weight} kg`);
    console.log('');
    console.log(`   Your capacity: ${totalCapacity} kg`);
    console.log(`     - Base inventory: ${BASE_PLAYER_CAPACITY} kg`);
    console.log(`     - Mount: ${mountCapacity} kg`);
    console.log(`     - Bag: ${bagCapacity} kg`);
    console.log('');
    console.log(`   Items you can carry: ${itemsByCapacity}`);
    console.log(`   Optimal profitable qty: ${selected.optimalQuantity}`);
    console.log(`   Items per trip: ${itemsPerTrip}`);
    console.log(`   Investment: ${formatPrice(tripInvestment)} silver`);
    console.log('');
    console.log('   ───────────────────────────────────────────────────────────────');
    console.log('   ORDER BOOK DEPTH:');
    console.log('   Buy orders used:');
    for (const order of selected.buyOrdersUsed.slice(0, 5)) {
      console.log(`     ${order.amount}x @ ${formatPrice(order.price)} each`);
    }
    if (selected.buyOrdersUsed.length > 5) {
      console.log(`     ... and ${selected.buyOrdersUsed.length - 5} more price levels`);
    }
    console.log('   Sell orders used:');
    for (const order of selected.sellOrdersUsed.slice(0, 5)) {
      console.log(`     ${order.amount}x @ ${formatPrice(order.price)} each`);
    }
    if (selected.sellOrdersUsed.length > 5) {
      console.log(`     ... and ${selected.sellOrdersUsed.length - 5} more price levels`);
    }
    console.log('');
    console.log('   ───────────────────────────────────────────────────────────────');
    console.log('   ROUTE:');
    console.log(`   1. Go to ${selected.buyCity}`);
    console.log(`   2. Buy ${itemsPerTrip}x ${selected.itemName} (avg ${formatPrice(selected.avgBuyPrice)} each)`);
    console.log(`   3. Transport to ${selected.quickSellCity} (${oneWayTime} min travel)`);
    console.log(`   4. Quick sell to buy orders (avg ${formatPrice(selected.avgSellPrice)} each)`);
    console.log('');
    console.log('   ───────────────────────────────────────────────────────────────');
    console.log('   TIME & PROFIT:');
    console.log(`   One-way travel time: ${oneWayTime} minutes`);
    console.log(`   Round trip time: ~${roundTripMinutes} minutes (incl. buy/sell)`);
    console.log(`   Trips per hour: ${tripsPerHour.toFixed(1)}`);
    console.log('');
    console.log(`   Avg profit per item: ${formatPrice(selected.avgProfitPerUnit)} (${formatPct(selected.profitPct)})`);
    console.log(`   Total trip profit: ${formatPrice(tripProfit)} silver`);
    console.log(`   Silver per hour: ${formatPrice(silverPerHourTrip)} silver/hr`);
    console.log(`   Method: Quick Sell (4% tax)`);
    console.log('   ═══════════════════════════════════════════════════════════════\n');

  } finally {
    rl.close();
  }
}
