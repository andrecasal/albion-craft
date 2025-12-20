// city-arbitrage-scanner.ts
// Scans for profitable city-to-city arbitrage opportunities across all items
// Uses real-time order book data from SQLite (populated by NATS collector)

import * as readline from 'readline';
import { City } from '../types';
import { getOrderBookDb, ArbitrageOpportunity as DbArbitrageOpportunity } from './order-book-db';

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

const ITEM_NAMES = new Map(itemsData.map((item) => [item.id, item.name]));

// Build weight lookup from items.json
const itemWeightsData: Record<string, number> = {};
for (const item of itemsData) {
  if (item.weight) {
    itemWeightsData[item.id] = item.weight;
  }
}

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

// Base player inventory capacity (without bag/mount)
const BASE_PLAYER_CAPACITY = 200; // kg

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
const SALES_TAX_PREMIUM = 0.04;      // 4% sales tax with premium
const LISTING_FEE = 0.025;           // 2.5% listing fee for sell orders
const QUICK_SELL_TAX = SALES_TAX_PREMIUM;  // Quick sell only pays sales tax
const SELL_ORDER_TAX = SALES_TAX_PREMIUM + LISTING_FEE;  // Sell orders pay both

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
  buyPrice: number;  // Lowest sell order price (what we pay to buy) - in silver
  buyAmount: number; // Available quantity
  // Sell side - quick sell (instant, to buy orders)
  quickSellCity: City;
  quickSellPrice: number;  // Highest buy order price - in silver
  quickSellAmount: number; // Available quantity
  quickSellProfit: number;  // Net profit after 4% tax
  quickSellProfitPct: number;
  // Best option (for now, we only support quick sell from order book)
  bestMethod: 'quick';
  bestProfit: number;
  bestProfitPct: number;
  maxQuantity: number;
  totalProfit: number;
  profitPerKg: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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
  console.log(`\n🔍 City Arbitrage Scanner (Real-Time Order Book)`);
  console.log(`   Tax rate: Quick sell 4%\n`);

  // Get order book database
  const db = getOrderBookDb();
  const stats = db.getStats();

  if (stats.totalOrders === 0) {
    console.log('   ❌ No orders in the database.');
    console.log('   Please ensure the NATS collector is running: npm run collect\n');
    return [];
  }

  console.log(`   📊 Order book: ${stats.totalOrders.toLocaleString()} orders, ${stats.uniqueItems.toLocaleString()} items\n`);

  // Ask for minimum profit percentage
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });
  };

  let minProfitPct = 5;
  let minQuantity = 1;

  try {
    const minProfitAnswer = await question('   Minimum profit % [5]: ');
    if (minProfitAnswer) {
      const parsed = parseFloat(minProfitAnswer);
      if (!isNaN(parsed) && parsed > 0) {
        minProfitPct = parsed;
      }
    }

    const minQtyAnswer = await question('   Minimum quantity [1]: ');
    if (minQtyAnswer) {
      const parsed = parseInt(minQtyAnswer);
      if (!isNaN(parsed) && parsed > 0) {
        minQuantity = parsed;
      }
    }
  } finally {
    rl.close();
  }

  console.log(`\n   Searching for opportunities with ≥${minProfitPct}% profit, ≥${minQuantity} quantity...\n`);

  // Get arbitrage opportunities from order book
  const dbOpportunities = db.findArbitrageOpportunities(minProfitPct, minQuantity);

  // Filter to safe cities only and transform to our format
  const opportunities: ArbitrageOpportunity[] = [];

  for (const dbOpp of dbOpportunities) {
    // Filter: both cities must be in safe cities list
    if (!SAFE_CITIES.includes(dbOpp.buyCity as City) || !SAFE_CITIES.includes(dbOpp.sellCity as City)) {
      continue;
    }

    // Convert prices from cents to silver (divide by 100)
    const buyPrice = dbOpp.buyPrice / 100;
    const sellPrice = dbOpp.sellPrice / 100;

    // Calculate profit after quick sell tax (4%)
    const grossProfit = sellPrice - buyPrice;
    const tax = sellPrice * QUICK_SELL_TAX;
    const netProfit = grossProfit - tax;
    const profitPct = (netProfit / buyPrice) * 100;

    // Skip if not profitable after tax
    if (netProfit <= 0) continue;

    const weight = getItemWeight(dbOpp.itemId);
    const profitPerKg = netProfit / weight;
    const maxQty = Math.min(dbOpp.buyAmount, dbOpp.sellAmount);
    const totalProfit = netProfit * maxQty;

    opportunities.push({
      itemId: dbOpp.itemId,
      itemName: ITEM_NAMES.get(dbOpp.itemId) || dbOpp.itemId,
      weight,
      quality: dbOpp.quality,
      buyCity: dbOpp.buyCity as City,
      buyPrice: Math.round(buyPrice),
      buyAmount: dbOpp.buyAmount,
      quickSellCity: dbOpp.sellCity as City,
      quickSellPrice: Math.round(sellPrice),
      quickSellAmount: dbOpp.sellAmount,
      quickSellProfit: Math.round(netProfit),
      quickSellProfitPct: parseFloat(profitPct.toFixed(1)),
      bestMethod: 'quick',
      bestProfit: Math.round(netProfit),
      bestProfitPct: parseFloat(profitPct.toFixed(1)),
      maxQuantity: maxQty,
      totalProfit: Math.round(totalProfit),
      profitPerKg: Math.round(profitPerKg),
    });
  }

  // Sort by profit per kg (best first)
  opportunities.sort((a, b) => b.profitPerKg - a.profitPerKg);

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
    console.log('   Try lowering the minimum profit % or minimum quantity.\n');
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('                                           CITY ARBITRAGE OPPORTUNITIES (Real-Time)');
  console.log('                                           Sorted by profit/kg | Quick Sell (4% tax)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════\n');

  console.log('┌────┬────────────────────────────────┬──────────────┬───────────┬─────┬──────────────┬───────────┬─────┬────────────┬────────────┬────────────┐');
  console.log('│ #  │ Item                           │ Buy City     │ Buy Price │ Qty │ Sell City    │Sell Price │ Qty │ Profit/ea  │ Total Prof │ Profit/kg  │');
  console.log('├────┼────────────────────────────────┼──────────────┼───────────┼─────┼──────────────┼───────────┼─────┼────────────┼────────────┼────────────┤');

  const displayCount = Math.min(50, opportunities.length);

  for (let i = 0; i < displayCount; i++) {
    const opp = opportunities[i];
    const rank = (i + 1).toString().padStart(2);

    // Add quality indicator if not normal (1)
    const qualityIndicator = opp.quality > 1 ? ` Q${opp.quality}` : '';
    const name = (opp.itemName + qualityIndicator).substring(0, 30).padEnd(30);

    const buyCity = opp.buyCity.substring(0, 12).padEnd(12);
    const buyPrice = formatPrice(opp.buyPrice).padStart(9);
    const buyQty = opp.buyAmount.toString().padStart(4);

    const sellCity = opp.quickSellCity.substring(0, 12).padEnd(12);
    const sellPrice = formatPrice(opp.quickSellPrice).padStart(9);
    const sellQty = opp.quickSellAmount.toString().padStart(4);

    const profitEach = `${formatPrice(opp.quickSellProfit)} (${formatPct(opp.quickSellProfitPct)})`.padStart(10);
    const totalProfit = formatPrice(opp.totalProfit).padStart(10);
    const profitPerKg = formatPrice(opp.profitPerKg).padStart(10);

    console.log(`│ ${rank} │ ${name} │ ${buyCity} │ ${buyPrice} │${buyQty} │ ${sellCity} │${sellPrice} │${sellQty} │ ${profitEach} │ ${totalProfit} │ ${profitPerKg} │`);
  }

  console.log('└────┴────────────────────────────────┴──────────────┴───────────┴─────┴──────────────┴───────────┴─────┴────────────┴────────────┴────────────┘');

  if (opportunities.length > displayCount) {
    console.log(`\n   (Showing top ${displayCount} of ${opportunities.length} opportunities)`);
  }

  console.log('\n   Legend:');
  console.log('   • Buy Price: Lowest sell order (what you pay to buy)');
  console.log('   • Sell Price: Highest buy order (instant sell, 4% tax)');
  console.log('   • Qty: Available quantity at that price');
  console.log('   • Profit/kg: Best metric for transport efficiency');
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
      .slice(0, 15);

    mountsWithCapacity.forEach((mount, idx) => {
      const normalCapacity = mount.qualities?.normal?.maxWeight || 0;
      console.log(`   ${idx + 1}. ${mount.name} (${normalCapacity} kg)`);
    });

    const mountAnswer = await question('\n   Select mount #: ');
    const mountChoice = parseInt(mountAnswer);
    let mountCapacity = 0;

    if (mountChoice >= 1 && mountChoice <= mountsWithCapacity.length) {
      const selectedMount = mountsWithCapacity[mountChoice - 1];
      mountCapacity = selectedMount.qualities?.normal?.maxWeight || 0;
      console.log(`   ✓ Selected: ${selectedMount.name} (${mountCapacity} kg)`);
    }

    // Ask for bag
    console.log('\n   Available bags:');
    const bagsWithCapacity = bagsData
      .filter((b) => b.qualities.normal.maxWeight > 0)
      .slice(0, 10);

    bagsWithCapacity.forEach((bag, idx) => {
      console.log(`   ${idx + 1}. ${bag.name} (${bag.qualities.normal.maxWeight} kg)`);
    });

    const bagAnswer = await question('\n   Select bag # (or Enter for none): ');
    const bagChoice = parseInt(bagAnswer);
    let bagCapacity = 0;

    if (bagChoice >= 1 && bagChoice <= bagsWithCapacity.length) {
      const selectedBag = bagsWithCapacity[bagChoice - 1];
      bagCapacity = selectedBag.qualities.normal.maxWeight;
      console.log(`   ✓ Selected: ${selectedBag.name} (${bagCapacity} kg)`);
    }

    // Calculate total capacity and items
    const totalCapacity = BASE_PLAYER_CAPACITY + mountCapacity + bagCapacity;
    const itemsByCapacity = Math.floor(totalCapacity / selected.weight);
    // Limit by available quantity in market
    const itemsPerTrip = Math.min(itemsByCapacity, selected.maxQuantity);
    const totalInvestment = itemsPerTrip * selected.buyPrice;
    const totalProfit = itemsPerTrip * selected.bestProfit;

    // Display trip summary
    console.log('\n   ═══════════════════════════════════════════════════════════════');
    console.log('   TRANSPORT TRIP SUMMARY');
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
    console.log(`   Items available in market: ${selected.maxQuantity}`);
    console.log(`   Items per trip: ${itemsPerTrip}`);
    console.log(`   Investment: ${formatPrice(totalInvestment)} silver`);
    console.log('');
    console.log('   ───────────────────────────────────────────────────────────────');
    console.log('   ROUTE:');
    console.log(`   1. Go to ${selected.buyCity}`);
    console.log(`   2. Buy ${itemsPerTrip}x ${selected.itemName} at ${formatPrice(selected.buyPrice)} each`);
    console.log(`   3. Transport to ${selected.quickSellCity}`);
    console.log(`   4. Quick sell to buy orders at ${formatPrice(selected.quickSellPrice)} each`);
    console.log('');
    console.log('   ───────────────────────────────────────────────────────────────');
    console.log('   PROFIT:');
    console.log(`   Profit per item: ${formatPrice(selected.bestProfit)} (${formatPct(selected.bestProfitPct)})`);
    console.log(`   Total trip profit: ${formatPrice(totalProfit)} silver`);
    console.log(`   Method: Quick Sell (4% tax)`);
    console.log('   ═══════════════════════════════════════════════════════════════\n');

  } finally {
    rl.close();
  }
}
