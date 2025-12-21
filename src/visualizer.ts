#!/usr/bin/env node
// CLI Application for Albion Craft Profitability Analysis
//
// NOTE: Some features in this file are temporarily disabled.
// The order book and hourly price history functionality has been removed
// in favor of daily price averages only. These features will be re-enabled
// when NATS real-time data is integrated.

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { DataLoader } from './services/data-loader';
import { ProfitabilityCalculator } from './services/profitability-calculator';
import { DemandSupplyData } from './services/market-data-fetcher';
import { CraftingRecommender, MaterialInventory } from './services/crafting-recommender';
import { trackMaterialPrices } from './services/material-buy-opportunities';
import { scanCityArbitrage } from './services/city-arbitrage-scanner';
import { getRealtimeCalculator, CraftFromMarketResult, CraftFromInventoryResult, MaterialInventory as RealtimeMaterialInventory, MaterialPriceComparison } from './services/realtime-profitability-calculator';
// DISABLED: Order book functions removed from db.ts
// import { CITY_TO_LOCATION, getRawDb, getStats, getPriceHistoryCount, get30DayAverage, getBestBuyPrices } from './db/db';
import { CITY_TO_LOCATION } from './db/locations';
import { db } from './db';
import { getDailyPriceCount, get30DayAverage } from './db/daily-prices';
import { getDailyPriceStatus } from './collector';
// DISABLED: Hourly fetcher has been deleted
// import { checkHourlyHistoryStatus } from './services/hourly-fetcher';
import { scanHourlyArbitrage } from './services/hourly-arbitrage-scanner';
import { UserStats, City, RefiningCategory, CraftingCategory, CraftingBonusEntry } from './types';

// DISABLED: Stub functions for removed functionality
function getStats(): { totalOrders: number; uniqueItems: number } {
  return { totalOrders: 0, uniqueItems: 0 };
}
function getPriceHistoryCount(): number {
  return getDailyPriceCount();
}
function getBestBuyPrices(_itemId: string): Record<City, number | null> {
  return {
    'Caerleon': null, 'Bridgewatch': null, 'Fort Sterling': null,
    'Lymhurst': null, 'Martlock': null, 'Thetford': null, 'Brecilien': null
  };
}
function checkHourlyHistoryStatus(): { totalRecords: number; uniqueItems: number; hoursOld: number | null } {
  return { totalRecords: 0, uniqueItems: 0, hoursOld: null };
}

// Material info for display
interface MaterialInfo {
  id: string;
  name: string;
}
// Load materials from separate category files
const rawMaterials = require('./constants/raw-materials.json') as MaterialInfo[];
const refinedMaterials = require('./constants/refined-materials.json') as MaterialInfo[];
const artifacts = require('./constants/artifacts.json') as MaterialInfo[];
const alchemyDrops = require('./constants/alchemy-drops.json') as MaterialInfo[];
const materialsData: MaterialInfo[] = [...rawMaterials, ...refinedMaterials, ...artifacts, ...alchemyDrops];

// Check if a material ID is a valid raw crafting material (not a finished item)
// Handles enchanted materials (e.g., T4_PLANKS@1)
function isValidCraftingMaterial(id: string): boolean {
  // Strip enchant suffix (@1, @2, @3, @4) for base material check
  const baseId = id.replace(/@[1-4]$/, '');

  // Refined resources (cloth, leather, metal bars, planks, stone blocks)
  if (/_CLOTH$|_LEATHER$|_METALBAR$|_PLANKS$|_STONEBLOCK$/.test(baseId)) return true;
  // Artifacts (used to craft artifact items) - artifacts don't have enchant variants
  if (baseId.includes('ARTEFACT_')) return true;
  // Rare alchemy drops - don't have enchant variants
  if (baseId.includes('ALCHEMY_RARE_')) return true;
  // Quest tokens (royal sigils, avalonian energy) - don't have enchant variants
  if (baseId.includes('QUESTITEM_TOKEN_')) return true;
  return false;
}

// Check if a material ID has a valid enchant suffix
function hasValidEnchant(id: string): boolean {
  // No enchant suffix = valid (base material)
  if (!id.includes('@')) return true;
  // Valid enchant suffixes: @1, @2, @3, @4
  return /@[1-4]$/.test(id);
}

// Check if the material type supports enchantment
function supportsEnchantment(id: string): boolean {
  const baseId = id.replace(/@[1-4]$/, '');
  // Only refined resources have enchant variants
  return /_CLOTH$|_LEATHER$|_METALBAR$|_PLANKS$|_STONEBLOCK$/.test(baseId);
}

// Settings file path
const SETTINGS_FILE = path.join(process.cwd(), 'src', 'db', 'settings.json');

// Load game constants
const taxesData = require('./constants/taxes.json');
const returnRatesData = require('./constants/return-rates.json');

// Refining categories for daily bonus selection
const REFINING_CATEGORIES: RefiningCategory[] = ['Ore', 'Wood', 'Hide', 'Fiber', 'Stone'];

// Crafting categories for daily bonus selection
const CRAFTING_CATEGORIES: CraftingCategory[] = [
  'Plate Armor', 'Plate Helmet', 'Plate Shoes',
  'Leather Armor', 'Leather Helmet', 'Leather Shoes',
  'Cloth Armor', 'Cloth Helmet', 'Cloth Shoes',
  'Sword', 'Axe', 'Mace', 'Hammer',
  'Crossbow', 'Bow', 'Spear', 'Dagger', 'Quarterstaff',
  'Fire Staff', 'Holy Staff', 'Arcane Staff', 'Froststaff', 'Cursed Staff', 'Nature Staff',
  'Off-hand', 'Shield', 'Cape', 'Bag', 'Tool', 'Gathering Gear', 'Mount', 'Food', 'Potion',
];

// Default user stats
const DEFAULT_USER_STATS: UserStats = {
  premiumStatus: true,
  useFocus: true,
  dailyBonus: {
    refiningCategory: null,
    craftingCategory: null,  // Deprecated, kept for backward compatibility
    craftingBonuses: [],     // New: supports up to 2 bonuses with percentages
  },
  targetDaysOfSupply: 3,  // Craft enough to satisfy 3 days of demand
};

// Load user settings from file, or return defaults
function loadSettings(): UserStats {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const saved = JSON.parse(data);
      // Merge with defaults in case new fields were added
      const settings = { ...DEFAULT_USER_STATS, ...saved };

      // Ensure dailyBonus has the new craftingBonuses array
      if (!settings.dailyBonus.craftingBonuses) {
        settings.dailyBonus.craftingBonuses = [];
        // Migrate old craftingCategory to new format if it exists
        if (settings.dailyBonus.craftingCategory) {
          settings.dailyBonus.craftingBonuses.push({
            category: settings.dailyBonus.craftingCategory,
            percentage: 20 as const,
          });
        }
      }
      return settings;
    }
  } catch (error) {
    console.error('Warning: Could not load settings, using defaults.');
  }
  return { ...DEFAULT_USER_STATS };
}

// Save user settings to file
function saveSettings(settings: UserStats): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Error: Could not save settings.');
  }
}

// Current user settings (loaded at startup)
let userSettings: UserStats = loadSettings();

// Calculate market tax rate based on premium status
function getMarketTaxRate(): number {
  const salesTax = userSettings.premiumStatus
    ? taxesData.salesTax.withPremium
    : taxesData.salesTax.withoutPremium;
  return salesTax + taxesData.listingFee;
}

// Calculate production bonus for a given city and item type
// Formula: Return Rate = 1 - 1/(1 + (Production Bonus/100))
function calculateReturnRate(city: City, itemType?: string): number {
  let productionBonus = returnRatesData.bonuses.base; // 18% base

  // Add city crafting bonus if item matches city specialization
  const cityBonuses = returnRatesData.cityBonuses[city];
  if (cityBonuses && itemType) {
    // Check if this item type has a crafting bonus in this city
    if (cityBonuses.crafting.some((cat: string) => itemType.toLowerCase().includes(cat.toLowerCase()))) {
      productionBonus += returnRatesData.bonuses.crafting; // +15%
    }
  }

  // Add focus bonus
  if (userSettings.useFocus) {
    productionBonus += returnRatesData.bonuses.focus; // +59%
  }

  // Add daily crafting bonus if item matches any of the daily bonus categories
  if (itemType && userSettings.dailyBonus.craftingBonuses) {
    for (const bonus of userSettings.dailyBonus.craftingBonuses) {
      const craftingCat = bonus.category.toLowerCase();
      if (itemType.toLowerCase().includes(craftingCat)) {
        productionBonus += bonus.percentage;
        break;  // Only apply one bonus per item (use the first matching)
      }
    }
  }

  // Calculate return rate: 1 - 1/(1 + bonus/100)
  const returnRate = 1 - 1 / (1 + productionBonus / 100);
  return returnRate * 100; // Return as percentage
}

// Get settings summary for menu display
function getSettingsSummary(): string {
  const premium = userSettings.premiumStatus ? '✓' : '✗';
  const focus = userSettings.useFocus ? '✓' : '✗';
  const dailyParts: string[] = [];
  if (userSettings.dailyBonus.refiningCategory) {
    dailyParts.push(`${userSettings.dailyBonus.refiningCategory}+10%`);
  }
  // Use new craftingBonuses array
  if (userSettings.dailyBonus.craftingBonuses && userSettings.dailyBonus.craftingBonuses.length > 0) {
    for (const bonus of userSettings.dailyBonus.craftingBonuses) {
      dailyParts.push(`${bonus.category}+${bonus.percentage}%`);
    }
  }
  const dailyStr = dailyParts.length > 0 ? ` Daily:${dailyParts.join(',')}` : '';
  return `[Premium:${premium} Focus:${focus}${dailyStr}]`;
}

// Cities for selection
const CITIES: City[] = [
  'Caerleon',
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
];

// Get data freshness indicator for historical price data
function getHistoryDataFreshnessIndicator(): string {
  const status = getDailyPriceStatus();

  if (status.totalRecords === 0) {
    return '⚫ No data';
  }

  if (status.missingDates.length === 0) {
    return `🟢 Complete`;
  } else if (status.missingDates.length <= 3) {
    return `🟡 ${status.missingDates.length} days missing`;
  } else {
    return `🔴 ${status.missingDates.length} days missing`;
  }
}

// Get data freshness indicator for hourly price data
function getHourlyDataFreshnessIndicator(): string {
  const status = checkHourlyHistoryStatus();

  if (status.totalRecords === 0) {
    return '⚫ No data';
  }

  if (status.hoursOld === null) {
    return '⚫ No data';
  }

  if (status.hoursOld < 1) {
    return `🟢 Fresh (${status.uniqueItems} items)`;
  } else if (status.hoursOld < 3) {
    return `🟡 ${status.hoursOld}h old`;
  } else {
    return `🔴 ${status.hoursOld}h old`;
  }
}

// Interactive menu
async function showMenu(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const historyDataFreshness = getHistoryDataFreshnessIndicator();
  const hourlyDataFreshness = getHourlyDataFreshnessIndicator();

  return new Promise((resolve) => {
    console.log('\n========================================');
    console.log('ALBION CRAFT PROFITABILITY ANALYZER');
    console.log('========================================');
    console.log('1. Below average sell orders');
    console.log('0. Exit');
    console.log('----------------------------------------');
    console.log(`9. Settings ${getSettingsSummary()}`);
    console.log(`   Historical data: ${historyDataFreshness}`);
    console.log(`   Hourly data: ${hourlyDataFreshness}`);
    console.log('========================================');

    rl.question('Choose an option: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}


// Format number with K/M suffix for compact display
function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toFixed(0);
}

// Parse number with K/M suffix (e.g., "500k" -> 500000, "2.5M" -> 2500000)
function parseNumberWithSuffix(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^([\d.]+)\s*([km])?$/);
  if (!match) return NaN;

  const num = parseFloat(match[1]);
  const suffix = match[2];

  if (suffix === 'k') return num * 1000;
  if (suffix === 'm') return num * 1000000;
  return num;
}

// Truncate string to max length with ellipsis
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str.padEnd(maxLen);
  return str.substring(0, maxLen - 1) + '…';
}

// Format percentage with sign
function formatPercent(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// Extract tier and enchant level from item ID (e.g., "T4_OFF_SHIELD@2" -> "T4.2")
function getTierEnchant(itemId: string): string {
  // Extract tier (T4, T5, etc.)
  const tierMatch = itemId.match(/^T(\d)/);
  const tier = tierMatch ? tierMatch[1] : '?';

  // Extract enchant level (@1, @2, @3, @4) - default to 0 if not present
  const enchantMatch = itemId.match(/@(\d)$/);
  const enchant = enchantMatch ? enchantMatch[1] : '0';

  return `T${tier}.${enchant}`;
}

// View high demand / low supply items per city
async function viewHighDemandLowSupply() {
  console.log('\n--- HIGH DEMAND / LOW SUPPLY ITEMS ---\n');

  const demandSupplyPath = path.join(process.cwd(), 'src', 'db', 'demand-supply.json');

  if (!fs.existsSync(demandSupplyPath)) {
    console.error('❌ demand-supply.json not found.');
    console.error('Select "Refresh market demand + supply" from the main menu first.\n');
    return;
  }

  const demandSupplyData: DemandSupplyData[] = JSON.parse(fs.readFileSync(demandSupplyPath, 'utf8'));

  // Filter for items with meaningful demand and falling supply (price rising = supply falling)
  const highDemandLowSupply = demandSupplyData.filter((item) => {
    return item.dailyDemand > 0 && item.supplySignal === '🔴 Falling';
  });

  if (highDemandLowSupply.length === 0) {
    console.log('No items found with high demand and low supply signals.\n');
    console.log('This could mean:');
    console.log('  - Markets are well-supplied');
    console.log('  - Data is stale (refresh recommended)\n');
    return;
  }

  // Sort by daily demand descending
  highDemandLowSupply.sort((a, b) => b.dailyDemand - a.dailyDemand);

  // Group by city
  console.log('Items with HIGH DEMAND and FALLING SUPPLY (opportunity indicators):\n');

  CITIES.forEach((city) => {
    const cityItems = highDemandLowSupply.filter((item) => item.city === city);

    if (cityItems.length === 0) {
      console.log(`\n📍 ${city}: No opportunities found`);
      return;
    }

    console.log(`\n📍 ${city} (${cityItems.length} items):`);
    console.log('   Item ID                          | Daily Demand | Price Trend  | 7d Avg Price');
    console.log('   ---------------------------------|--------------|--------------|-------------');

    cityItems.slice(0, 10).forEach((item) => {
      // 🟢 = rising prices (low supply, good opportunity)
      // 🟡 = stable prices
      // 🔴 = falling prices (high supply)
      const trendEmoji = item.priceTrendPct > 5 ? '🟢' : item.priceTrendPct < -5 ? '🔴' : '🟡';
      const trendStr = formatPercent(item.priceTrendPct).padStart(7);
      const trendDisplay = `${trendEmoji} ${trendStr}`;
      console.log(
        `   ${item.itemId.padEnd(33)} | ${item.dailyDemand.toString().padStart(12)} | ${trendDisplay} | ${formatNumber(item.price7dAvg).padStart(12)}`
      );
    });

    if (cityItems.length > 10) {
      console.log(`   ... and ${cityItems.length - 10} more items`);
    }
  });

  // Summary
  const totalOpportunities = highDemandLowSupply.length;
  const topCity = CITIES.reduce((best, city) => {
    const count = highDemandLowSupply.filter((item) => item.city === city).length;
    return count > best.count ? { city, count } : best;
  }, { city: '' as City, count: 0 });

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`Total opportunities: ${totalOpportunities}`);
  console.log(`Best city: ${topCity.city} (${topCity.count} items)`);
  console.log('');
  console.log('Legend:');
  console.log('  Price Trend: Current price vs 7-day avg (🟢 rising = low supply, 🔴 falling = high supply)');
  console.log('\n💡 These items have people buying but supply is decreasing - good crafting targets!\n');
}

// Craft from inventory - get recommendations based on available materials
// Uses REAL-TIME order book data from SQLite (populated by NATS collector)
async function craftFromInventory() {
  console.log('\n--- CRAFT FROM INVENTORY (Real-Time Order Book) ---\n');

  // Check order book database
  const stats = getStats();

  if (stats.totalOrders === 0) {
    console.log('❌ No orders in the database.');
    console.log('Please ensure the NATS collector is running: npm run collect\n');
    return;
  }

  console.log(`📊 Order book: ${stats.totalOrders.toLocaleString()} orders, ${stats.uniqueItems.toLocaleString()} items\n`);

  const calculator = getRealtimeCalculator();

  // Let user select city
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<void>((resolve) => {
    console.log('Select a city to craft and sell in:');
    // Exclude Caerleon (too risky for transport)
    const safeCities: City[] = ['Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];
    safeCities.forEach((city, index) => {
      console.log(`${index + 1}. ${city}`);
    });

    rl.question(`\nChoose (1-${safeCities.length}): `, async (cityAnswer) => {
      const cityChoice = parseInt(cityAnswer.trim());

      if (cityChoice < 1 || cityChoice > safeCities.length) {
        console.log('Invalid choice.');
        rl.close();
        resolve();
        return;
      }

      const selectedCity = safeCities[cityChoice - 1];
      console.log(`\n📍 Selected city: ${selectedCity}\n`);

      // Now ask for materials
      console.log('Enter your available materials.');
      console.log('Format: MATERIAL_ID QUANTITY (one per line)');
      console.log('');
      console.log('For enchanted materials, add @1, @2, @3, or @4:');
      console.log('  T4_PLANKS 100      → Base (.0) planks');
      console.log('  T4_PLANKS@1 50     → Enchanted .1 planks');
      console.log('  T4_PLANKS@2 25     → Enchanted .2 planks');
      console.log('');
      console.log('Type "done" when finished, or "list" to see available materials.\n');

      const inventory: RealtimeMaterialInventory = {};

      const askForMaterial = () => {
        rl.question('Material: ', (input) => {
          const trimmed = input.trim().toLowerCase();

          if (trimmed === 'done') {
            rl.close();

            if (Object.keys(inventory).length === 0) {
              console.log('\n❌ No materials entered. Returning to menu.\n');
              resolve();
              return;
            }

            // Show what was entered
            console.log('\n--- YOUR INVENTORY ---');
            for (const [materialId, qty] of Object.entries(inventory)) {
              const baseMaterialId = materialId.replace(/@[1-4]$/, '');
              const materialInfo = materialsData.find((m) => m.id === baseMaterialId);
              const enchantSuffix = materialId.includes('@') ? ` (${materialId.slice(-2)})` : '';
              const name = (materialInfo?.name || baseMaterialId) + enchantSuffix;
              console.log(`  ${name}: ${qty}`);
            }

            // Get recommendations using real-time order book
            console.log('\n--- CRAFTING RECOMMENDATIONS (Real-Time) ---');
            console.log('(Sorted by total profit | Quick Sell to buy orders)\n');

            const recommendations = calculator.findCraftFromInventoryOpportunities(inventory, selectedCity, userSettings);

            if (recommendations.length === 0) {
              console.log('❌ No items can be crafted with these materials.\n');
              console.log('Possible reasons:');
              console.log('  - Materials don\'t match any recipes');
              console.log('  - Not enough quantity of each material');
              console.log('  - No buy orders exist for craftable items');
              console.log('  - No profitable items can be made (after 4% tax)\n');
              resolve();
              return;
            }

            // Print table header
            console.log('┌────┬────────────────────────────────┬───────┬───────────┬────────────┬────────────┬────────────┐');
            console.log('│ #  │ Item                           │ Qty   │ Sell Price│ Profit/ea  │ Total Prof │ Craft Fee  │');
            console.log('├────┼────────────────────────────────┼───────┼───────────┼────────────┼────────────┼────────────┤');

            // Print each recommendation
            const displayCount = Math.min(50, recommendations.length);
            for (let i = 0; i < displayCount; i++) {
              const rec = recommendations[i];
              const rank = (i + 1).toString().padStart(2);
              const tierEnchant = getTierEnchant(rec.itemId);
              const name = `${rec.itemName} (${tierEnchant})`.substring(0, 30).padEnd(30);
              const qty = rec.quantityToCraft.toString().padStart(5);
              const sellPrice = formatNumber(rec.sellPrice).padStart(9);
              const profitItem = formatNumber(rec.profitPerItem).padStart(10);
              const totalProfit = formatNumber(rec.totalProfit).padStart(10);
              const craftFee = formatNumber(rec.totalCraftingFee).padStart(10);

              console.log(`│ ${rank} │ ${name} │ ${qty} │ ${sellPrice} │ ${profitItem} │ ${totalProfit} │ ${craftFee} │`);
            }

            console.log('└────┴────────────────────────────────┴───────┴───────────┴────────────┴────────────┴────────────┘');

            if (recommendations.length > displayCount) {
              console.log(`\n   (Showing top ${displayCount} of ${recommendations.length} opportunities)`);
            }

            // Summary
            const totalItems = recommendations.reduce((sum, r) => sum + r.quantityToCraft, 0);
            const totalProfit = recommendations.reduce((sum, r) => sum + r.totalProfit, 0);
            const totalCraftingFee = recommendations.reduce((sum, r) => sum + r.totalCraftingFee, 0);

            console.log('\n═══════════════════════════════════════════════════════════════════');
            console.log('SUMMARY');
            console.log('═══════════════════════════════════════════════════════════════════');
            console.log(`Total items to craft: ${totalItems}`);
            console.log(`Total profit: ${formatNumber(totalProfit)} silver (after 4% quick sell tax)`);
            console.log(`Total crafting fees: ${formatNumber(totalCraftingFee)} silver`);
            console.log('');
            console.log('Note: Profits are based on selling to current buy orders (instant sale).');
            console.log('═══════════════════════════════════════════════════════════════════\n');

            resolve();
            return;
          }

          if (trimmed === 'list') {
            console.log('\n--- AVAILABLE MATERIALS ---');
            console.log('(Showing raw materials and artifacts only)\n');

            // Group raw materials by type
            console.log('REFINED RESOURCES (support @1, @2, @3, @4 enchants):');
            const refinedTypes = ['CLOTH', 'LEATHER', 'METALBAR', 'PLANKS', 'STONEBLOCK'];
            for (const type of refinedTypes) {
              const materials = materialsData.filter((m) => m.id.endsWith('_' + type));
              if (materials.length > 0) {
                materials.forEach((m) => {
                  console.log(`  ${m.id.padEnd(20)} ${m.name}`);
                });
              }
            }

            console.log('\nARTIFACTS & SPECIAL MATERIALS (no enchants):');
            const artifacts = materialsData.filter((m) =>
              m.id.includes('ARTEFACT_') ||
              m.id.includes('ALCHEMY_RARE_') ||
              m.id.includes('QUESTITEM_TOKEN_')
            );
            // Group by tier
            const tiers = ['T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
            for (const tier of tiers) {
              const tierArtifacts = artifacts.filter((m) => m.id.startsWith(tier + '_') || m.id.startsWith('QUESTITEM'));
              tierArtifacts.forEach((m) => {
                if (m.id.startsWith(tier + '_')) {
                  console.log(`  ${m.id.padEnd(45)} ${m.name}`);
                }
              });
            }
            // Quest items (no tier prefix)
            const questItems = artifacts.filter((m) => m.id.startsWith('QUESTITEM'));
            if (questItems.length > 0) {
              questItems.forEach((m) => {
                console.log(`  ${m.id.padEnd(45)} ${m.name}`);
              });
            }

            console.log('');
            askForMaterial();
            return;
          }

          // Parse input
          const parts = input.trim().split(/\s+/);
          if (parts.length !== 2) {
            console.log('❌ Invalid format. Use: MATERIAL_ID QUANTITY');
            askForMaterial();
            return;
          }

          const [materialId, qtyStr] = parts;
          const qty = parseInt(qtyStr);

          if (isNaN(qty) || qty <= 0) {
            console.log('❌ Invalid quantity. Must be a positive number.');
            askForMaterial();
            return;
          }

          // Validate material exists and is a valid crafting material
          const materialIdUpper = materialId.toUpperCase();

          // Check for valid enchant suffix format
          if (!hasValidEnchant(materialIdUpper)) {
            console.log(`❌ Invalid enchant suffix. Use @1, @2, @3, or @4.`);
            console.log('Example: T4_PLANKS@2 for .2 enchanted planks');
            askForMaterial();
            return;
          }

          // Strip enchant suffix to check if base material exists
          const baseMaterialId = materialIdUpper.replace(/@[1-4]$/, '');
          const materialExists = materialsData.some((m) => m.id === baseMaterialId);

          if (!materialExists) {
            console.log(`❌ Unknown material: ${baseMaterialId}`);
            console.log('Type "list" to see available materials.');
            askForMaterial();
            return;
          }

          if (!isValidCraftingMaterial(materialIdUpper)) {
            console.log(`❌ "${baseMaterialId}" is a finished item, not a crafting material.`);
            console.log('Type "list" to see valid materials (refined resources and artifacts).');
            askForMaterial();
            return;
          }

          // Check if trying to use enchant on a material that doesn't support it
          if (materialIdUpper.includes('@') && !supportsEnchantment(materialIdUpper)) {
            console.log(`❌ "${baseMaterialId}" doesn't have enchanted variants.`);
            console.log('Only refined resources (cloth, leather, metal bars, planks, stone) have enchant levels.');
            askForMaterial();
            return;
          }

          // Add to inventory (accumulate if already exists)
          inventory[materialIdUpper] = (inventory[materialIdUpper] || 0) + qty;
          const materialInfo = materialsData.find((m) => m.id === baseMaterialId);
          const enchantSuffix = materialIdUpper.includes('@') ? ` (${materialIdUpper.slice(-2)})` : '';
          console.log(`✓ Added ${qty}x ${materialInfo?.name || baseMaterialId}${enchantSuffix}`);

          askForMaterial();
        });
      };

      askForMaterial();
    });
  });
}

// Craft from market - show profitable items when buying materials from market
// Uses REAL-TIME order book data from SQLite (populated by NATS collector)
async function craftFromMarket() {
  console.log('\n--- CRAFT FROM MARKET (Real-Time Order Book) ---\n');
  console.log('Calculate profit when buying ALL materials from the market.\n');

  // Check order book database
  const stats = getStats();

  if (stats.totalOrders === 0) {
    console.log('❌ No orders in the database.');
    console.log('Please ensure the NATS collector is running: npm run collect\n');
    return;
  }

  console.log(`📊 Order book: ${stats.totalOrders.toLocaleString()} orders, ${stats.uniqueItems.toLocaleString()} items\n`);

  const calculator = getRealtimeCalculator();

  // Let user select city
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
    console.log('Select a city to craft in (materials will be bought in the same city):');
    console.log('0. All cities (compare across all markets)');
    // Exclude Caerleon (too risky for transport)
    const safeCities: City[] = ['Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];
    safeCities.forEach((city, index) => {
      console.log(`${index + 1}. ${city}`);
    });

    const cityAnswer = await question(`\nChoose (0-${safeCities.length}): `);
    const cityChoice = parseInt(cityAnswer);

    if (isNaN(cityChoice) || cityChoice < 0 || cityChoice > safeCities.length) {
      console.log('Invalid choice.');
      return;
    }

    // cityChoice 0 = all cities, 1-6 = specific city
    const selectedCity: City | undefined = cityChoice === 0 ? undefined : safeCities[cityChoice - 1];
    const isAllCities = cityChoice === 0;

    // Get top opportunities sorted by profit/kg (best for transport efficiency)
    console.log('\nCalculating profitability from real-time order book...');
    const startTime = Date.now();
    const results = calculator.findCraftFromMarketOpportunities(userSettings, selectedCity);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    if (results.length === 0) {
      console.log('\nNo profitable opportunities found when buying materials from market.');
      console.log('This could mean:');
      console.log('  - Material prices are too high relative to finished item prices');
      console.log('  - Order book lacks data for some materials');
      console.log('  - No buy orders exist for crafted items\n');
      return;
    }

    console.log(`\nFound ${results.length} profitable opportunities in ${elapsed}s`);

    // Display top 50
    const displayCount = Math.min(50, results.length);

    // Print table header
    if (isAllCities) {
      console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
      console.log('                                    CRAFT FROM MARKET - ALL CITIES (Real-Time)');
      console.log('                                    Sorted by profit/kg | Quick Sell (4% tax)');
      console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════\n');

      console.log('┌────┬────────────────────────────────┬──────────────┬───────────┬───────────┬────────────┬────────────┬────────────┐');
      console.log('│ #  │ Item                           │ City         │ Mat Cost  │ Sell Price│ Profit/ea  │ ROI %      │ Profit/kg  │');
      console.log('├────┼────────────────────────────────┼──────────────┼───────────┼───────────┼────────────┼────────────┼────────────┤');

      for (let i = 0; i < displayCount; i++) {
        const result = results[i];
        const rank = (i + 1).toString().padStart(2);
        const tierEnchant = getTierEnchant(result.itemId);
        const name = `${result.itemName} (${tierEnchant})`.substring(0, 30).padEnd(30);
        const city = result.city.substring(0, 12).padEnd(12);
        const matCost = formatNumber(result.totalMaterialCost).padStart(9);
        const sellPrice = formatNumber(result.sellPrice).padStart(9);
        const profit = formatNumber(result.netProfit).padStart(10);
        const roi = `${result.roiPercent.toFixed(1)}%`.padStart(10);
        const profitKg = formatNumber(result.profitPerKg).padStart(10);

        console.log(`│ ${rank} │ ${name} │ ${city} │ ${matCost} │ ${sellPrice} │ ${profit} │ ${roi} │ ${profitKg} │`);
      }

      console.log('└────┴────────────────────────────────┴──────────────┴───────────┴───────────┴────────────┴────────────┴────────────┘');
    } else {
      console.log(`\n═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════`);
      console.log(`                                    CRAFT FROM MARKET - ${selectedCity} (Real-Time)`);
      console.log(`                                    Sorted by profit/kg | Quick Sell (4% tax)`);
      console.log(`═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════\n`);

      console.log('┌────┬────────────────────────────────┬───────────┬───────────┬────────────┬────────────┬────────────┐');
      console.log('│ #  │ Item                           │ Mat Cost  │ Sell Price│ Profit/ea  │ ROI %      │ Profit/kg  │');
      console.log('├────┼────────────────────────────────┼───────────┼───────────┼────────────┼────────────┼────────────┤');

      for (let i = 0; i < displayCount; i++) {
        const result = results[i];
        const rank = (i + 1).toString().padStart(2);
        const tierEnchant = getTierEnchant(result.itemId);
        const name = `${result.itemName} (${tierEnchant})`.substring(0, 30).padEnd(30);
        const matCost = formatNumber(result.totalMaterialCost).padStart(9);
        const sellPrice = formatNumber(result.sellPrice).padStart(9);
        const profit = formatNumber(result.netProfit).padStart(10);
        const roi = `${result.roiPercent.toFixed(1)}%`.padStart(10);
        const profitKg = formatNumber(result.profitPerKg).padStart(10);

        console.log(`│ ${rank} │ ${name} │ ${matCost} │ ${sellPrice} │ ${profit} │ ${roi} │ ${profitKg} │`);
      }

      console.log('└────┴────────────────────────────────┴───────────┴───────────┴────────────┴────────────┴────────────┘');
    }

    if (results.length > displayCount) {
      console.log(`\n   (Showing top ${displayCount} of ${results.length} opportunities)`);
    }

    console.log('\n   Legend:');
    console.log('   • Mat Cost: Total material cost from order book (before return rate)');
    console.log('   • Sell Price: Highest buy order (quick sell price)');
    console.log('   • Profit/kg: Best metric for transport efficiency');

    console.log('\n   Enter an item number (1-50) to see a detailed crafting guide, or press Enter to go back.\n');

    const itemAnswer = await question('   Select item #: ');

    if (!itemAnswer) {
      return;
    }

    const itemChoice = parseInt(itemAnswer);

    if (isNaN(itemChoice) || itemChoice < 1 || itemChoice > Math.min(50, results.length)) {
      console.log('Invalid choice.');
      return;
    }

    const selected = results[itemChoice - 1];

    // Show detailed crafting guide for real-time result
    showRealtimeCraftingGuide(selected, userSettings);

  } finally {
    rl.close();
  }
}

// Show detailed crafting guide for a real-time profitability result
function showRealtimeCraftingGuide(result: CraftFromMarketResult, userStats: UserStats) {
  const { itemName, itemId, craftingCost, sellPrice, netProfit, returnRate, roiPercent, city } = result;

  console.log('\n' + '='.repeat(70));
  console.log(`CRAFTING GUIDE: ${itemName} (${getTierEnchant(itemId)})`);
  console.log('='.repeat(70));
  console.log(`📍 City: ${city}`);
  console.log(`📊 Data: Real-time order book`);
  console.log('');

  // Step 1: Buy materials
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 1: BUY MATERIALS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  console.log('  Material                            Qty       Price/Unit   Total Cost');
  console.log('  ' + '-'.repeat(70));

  for (const mat of craftingCost.materialCosts) {
    const materialInfo = materialsData.find((m) => m.id === mat.materialId.replace(/@[1-4]$/, ''));
    const enchantSuffix = mat.materialId.includes('@') ? ` (${mat.materialId.slice(-2)})` : '';
    const name = (materialInfo?.name || mat.materialId) + enchantSuffix;
    const qty = mat.quantity.toString().padStart(8);
    const pricePerUnit = formatNumber(mat.pricePerUnit).padStart(12);
    const totalCost = formatNumber(mat.totalCost).padStart(12);

    console.log(`  ${truncate(name, 35).padEnd(35)} ${qty} ${pricePerUnit} ${totalCost}`);
  }

  console.log('  ' + '-'.repeat(70));
  console.log(`  ${'TOTAL MATERIAL COST'.padEnd(35)} ${' '.repeat(8)} ${' '.repeat(12)} ${formatNumber(craftingCost.totalMaterialCost).padStart(12)}`);
  console.log('');

  // Step 2: Craft
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 2: CRAFT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const returnRatePct = (returnRate * 100).toFixed(1);

  console.log(`  Crafting fee:                 ${formatNumber(craftingCost.craftingFee)} silver`);
  console.log(`  Return rate:                  ${returnRatePct}%`);
  console.log(`  Material cost after returns:  ${formatNumber(craftingCost.effectiveCost)} silver`);
  console.log('');
  console.log(`  TOTAL CRAFTING COST:          ${formatNumber(craftingCost.totalCost)} silver`);
  console.log('');

  // Step 3: Sell
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 3: QUICK SELL (to buy orders)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const taxAmount = sellPrice * 0.04;
  const netSellPrice = sellPrice - taxAmount;

  console.log(`  Best buy order price:         ${formatNumber(sellPrice)} silver`);
  console.log(`  Market tax (4%):             -${formatNumber(taxAmount)} silver`);
  console.log(`  Net receive:                  ${formatNumber(netSellPrice)} silver`);
  console.log('');

  // Profit summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PROFIT BREAKDOWN');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  console.log(`  Revenue (after tax):          ${formatNumber(netSellPrice)} silver`);
  console.log(`  Total cost:                  -${formatNumber(craftingCost.totalCost)} silver`);
  console.log('  ' + '-'.repeat(40));
  console.log(`  PROFIT:                       ${formatNumber(netProfit)} silver`);
  console.log(`  ROI:                          ${roiPercent.toFixed(1)}%`);
  console.log('');

  // Quick summary box
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`  💰 Invest:  ${formatNumber(result.totalInvestment)} silver (materials + crafting fee)`);
  console.log(`  📈 Receive: ${formatNumber(netSellPrice)} silver (after 4% tax)`);
  console.log(`  ✨ Profit:  ${formatNumber(netProfit)} silver (${roiPercent.toFixed(1)}% ROI)`);
  console.log('='.repeat(70));
  console.log('');

  // Show missing materials warning if any
  if (result.materialsMissing.length > 0) {
    console.log('⚠️  Warning: Some materials had no order book data:');
    for (const mat of result.materialsMissing) {
      console.log(`   - ${mat}`);
    }
    console.log('');
  }
}

// Show detailed crafting guide for a selected item
function showCraftingGuide(result: import('./types').ProfitabilityResult, quantity: number, city: City) {
  const { itemName, itemId, craftingCost, grossRevenue, netProfit, returnRate, roiPercent, demandPerDay, sellsInDays } = result;

  console.log('\n' + '='.repeat(70));
  console.log(`CRAFTING GUIDE: ${itemName} (${getTierEnchant(itemId)})`);
  console.log('='.repeat(70));
  console.log(`📍 City: ${city}`);
  console.log(`📦 Quantity: ${quantity}`);
  console.log('');

  // Step 1: Buy materials
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 1: BUY MATERIALS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Get material names from materialsData
  let totalMaterialCost = 0;

  console.log('  Material                            Qty/Item   Total Qty   Price/Unit   Total Cost');
  console.log('  ' + '-'.repeat(85));

  for (const mat of craftingCost.materialCosts) {
    const materialInfo = materialsData.find((m) => m.id === mat.materialId.replace(/@[1-4]$/, ''));
    const enchantSuffix = mat.materialId.includes('@') ? ` (${mat.materialId.slice(-2)})` : '';
    const name = (materialInfo?.name || mat.materialId) + enchantSuffix;
    const qtyPerItem = mat.quantity;
    const totalQty = qtyPerItem * quantity;
    const pricePerUnit = mat.pricePerUnit;
    const totalCost = totalQty * pricePerUnit;
    totalMaterialCost += totalCost;

    console.log(
      `  ${truncate(name, 35).padEnd(35)} ${qtyPerItem.toString().padStart(8)}   ${totalQty.toString().padStart(9)}   ${formatNumber(pricePerUnit).padStart(10)}   ${formatNumber(totalCost).padStart(10)}`
    );
  }

  console.log('  ' + '-'.repeat(85));
  console.log(`  ${'TOTAL MATERIAL COST'.padEnd(35)} ${' '.repeat(8)}   ${' '.repeat(9)}   ${' '.repeat(10)}   ${formatNumber(totalMaterialCost).padStart(10)}`);
  console.log('');

  // Step 2: Craft
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 2: CRAFT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const craftingFeePerItem = craftingCost.craftingFee;
  const totalCraftingFee = craftingFeePerItem * quantity;
  const returnRatePct = (returnRate * 100).toFixed(1);
  const effectiveMaterialCost = craftingCost.effectiveCost * quantity;

  console.log(`  Crafting fee per item:        ${formatNumber(craftingFeePerItem)} silver`);
  console.log(`  Total crafting fee:           ${formatNumber(totalCraftingFee)} silver`);
  console.log('');
  console.log(`  Return rate:                  ${returnRatePct}%`);
  console.log(`  Material cost after returns:  ${formatNumber(effectiveMaterialCost)} silver`);
  console.log('');

  const totalCraftCost = effectiveMaterialCost + totalCraftingFee;
  console.log(`  TOTAL CRAFTING COST:          ${formatNumber(totalCraftCost)} silver`);
  console.log('');

  // Step 3: Sell
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('STEP 3: PUT UP FOR SALE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const sellPricePerItem = result.marketData.lowestSellPrice;
  const totalSellPrice = sellPricePerItem * quantity;
  const revenueAfterTax = grossRevenue * quantity;

  console.log(`  Sell price per item:          ${formatNumber(sellPricePerItem)} silver`);
  console.log(`  Total sell price:             ${formatNumber(totalSellPrice)} silver`);
  console.log(`  After market tax (6.5%):      ${formatNumber(revenueAfterTax)} silver`);
  console.log('');
  console.log(`  Estimated time to sell:       ${sellsInDays} day(s) (${demandPerDay} sold/day avg)`);
  console.log('');

  // Profit summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PROFIT BREAKDOWN');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const totalProfit = netProfit * quantity;

  console.log(`  Revenue (after tax):          ${formatNumber(revenueAfterTax)} silver`);
  console.log(`  Total cost:                  -${formatNumber(totalCraftCost)} silver`);
  console.log('  ' + '-'.repeat(40));
  console.log(`  TOTAL PROFIT:                 ${formatNumber(totalProfit)} silver`);
  console.log('');
  console.log(`  Profit per item:              ${formatNumber(netProfit)} silver`);
  console.log(`  ROI:                          ${roiPercent.toFixed(1)}%`);
  console.log('');

  // Quick summary box
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`  💰 Invest:  ${formatNumber(totalMaterialCost + totalCraftingFee)} silver (materials + crafting fee)`);
  console.log(`  📈 Receive: ${formatNumber(revenueAfterTax)} silver (after tax)`);
  console.log(`  ✨ Profit:  ${formatNumber(totalProfit)} silver (${roiPercent.toFixed(1)}% ROI)`);
  console.log('='.repeat(70));
  console.log('');
}

// Scan material buy opportunities using real-time order book
async function scanMaterialBuyOpportunities() {
  console.log('\n--- MATERIAL BUY OPPORTUNITIES (Real-Time Order Book) ---\n');
  console.log('Compare material prices across all cities to find the best deals.\n');

  // Check order book database
  const stats = getStats();

  if (stats.totalOrders === 0) {
    console.log('❌ No orders in the database.');
    console.log('Please ensure the NATS collector is running: npm run collect\n');
    return;
  }

  console.log(`📊 Order book: ${stats.totalOrders.toLocaleString()} orders, ${stats.uniqueItems.toLocaleString()} items\n`);

  const calculator = getRealtimeCalculator();

  // Get all materials with prices
  console.log('Analyzing material prices across all cities...\n');
  const startTime = Date.now();
  const allPrices = calculator.getAllMaterialPrices();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  const totalMaterials = allPrices.raw.length + allPrices.refined.length + allPrices.artifact.length + allPrices.alchemy.length;
  console.log(`Found prices for ${totalMaterials} materials in ${elapsed}s\n`);

  // Display each category
  const categories: Array<{ key: 'raw' | 'refined' | 'artifact' | 'alchemy'; title: string }> = [
    { key: 'raw', title: 'RAW MATERIALS' },
    { key: 'refined', title: 'REFINED MATERIALS' },
    { key: 'artifact', title: 'ARTIFACTS' },
    { key: 'alchemy', title: 'ALCHEMY DROPS' },
  ];

  for (const { key, title } of categories) {
    const materials = allPrices[key];
    if (materials.length === 0) continue;

    console.log(`\n═══════════════════════════════════════════════════════════════════════════════════════`);
    console.log(`  ${title} (${materials.length} items)`);
    console.log(`═══════════════════════════════════════════════════════════════════════════════════════\n`);

    console.log('┌─────────────────────────────────────┬──────────────┬───────────┬───────────┬───────────┐');
    console.log('│ Material                            │ Best City    │ Price     │ Worst     │ Spread %  │');
    console.log('├─────────────────────────────────────┼──────────────┼───────────┼───────────┼───────────┤');

    for (const material of materials) {
      // Add enchant suffix to name for enchanted materials
      const enchantMatch = material.materialId.match(/@([1-4])$/);
      const enchantSuffix = enchantMatch ? ` (.${enchantMatch[1]})` : '';
      const name = (material.materialName + enchantSuffix).substring(0, 35).padEnd(35);
      const city = material.bestCity.substring(0, 12).padEnd(12);
      const price = formatNumber(material.bestPrice).padStart(9);
      const worstPrice = material.worstPrice ? formatNumber(material.worstPrice).padStart(9) : '     N/A ';
      const spreadPct = material.priceDifferencePct !== null
        ? `+${material.priceDifferencePct.toFixed(1)}%`.padStart(9)
        : '     N/A ';

      console.log(`│ ${name} │ ${city} │ ${price} │ ${worstPrice} │ ${spreadPct} │`);
    }

    console.log('└─────────────────────────────────────┴──────────────┴───────────┴───────────┴───────────┘');
  }

  // Show arbitrage opportunities (materials with high price spread)
  console.log('\n\n═══════════════════════════════════════════════════════════════════════════════════════');
  console.log('  TOP ARBITRAGE OPPORTUNITIES (Materials with highest price spread between cities)');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════\n');

  const arbitrageOpportunities = calculator.findMaterialBuyOpportunities(10); // At least 10% spread
  const topArbitrage = arbitrageOpportunities.slice(0, 20);

  if (topArbitrage.length === 0) {
    console.log('   No significant arbitrage opportunities found (>10% spread).\n');
  } else {
    console.log('┌─────────────────────────────────────┬──────────────┬───────────┬───────────┬───────────┐');
    console.log('│ Material                            │ Buy City     │ Buy Price │ Worst     │ Spread %  │');
    console.log('├─────────────────────────────────────┼──────────────┼───────────┼───────────┼───────────┤');

    for (const opp of topArbitrage) {
      const enchantMatch = opp.materialId.match(/@([1-4])$/);
      const enchantSuffix = enchantMatch ? ` (.${enchantMatch[1]})` : '';
      const name = (opp.materialName + enchantSuffix).substring(0, 35).padEnd(35);
      const city = opp.bestCity.substring(0, 12).padEnd(12);
      const price = formatNumber(opp.bestPrice).padStart(9);
      const worstPrice = opp.worstPrice ? formatNumber(opp.worstPrice).padStart(9) : '     N/A ';
      const spreadPct = opp.priceDifferencePct !== null
        ? `+${opp.priceDifferencePct.toFixed(1)}%`.padStart(9)
        : '     N/A ';

      console.log(`│ ${name} │ ${city} │ ${price} │ ${worstPrice} │ ${spreadPct} │`);
    }

    console.log('└─────────────────────────────────────┴──────────────┴───────────┴───────────┴───────────┘');
    console.log('\n   💡 Buy materials in "Buy City" and sell/use in cities with higher prices.');
  }

  console.log('\n');
}


// View items with sell orders significantly below their 30-day average price
async function viewBelowAverageSellOrders() {
  console.log('\n--- BELOW AVERAGE SELL ORDERS (30-Day Data) ---\n');
  console.log('Find items currently priced below their 30-day average.\n');

  // Check order book database
  const stats = getStats();

  if (stats.totalOrders === 0) {
    console.log('❌ No orders in the database.');
    console.log('Please ensure the NATS collector is running: npm run collect\n');
    return;
  }

  // Check price history data
  const historyCount = getPriceHistoryCount();
  if (historyCount === 0) {
    console.log('❌ No price history available.');
    console.log('Run the history fetcher to collect 30-day price data.\n');
    return;
  }

  console.log(`📊 Order book: ${stats.totalOrders.toLocaleString()} orders`);
  console.log(`📊 Price history: ${historyCount.toLocaleString()} records\n`);

  // Get all unique items from order book
  const now = new Date().toISOString();
  const staleThreshold = Date.now() - 5 * 60 * 1000; // 5 minutes

  // Build item index from current orders
  interface ItemCityData {
    itemId: string;
    city: City;
    currentSellPrice: number;
  }

  const itemCityPrices: ItemCityData[] = [];

  // Get all sell orders grouped by item and city
  for (const [city, locationIds] of Object.entries(CITY_TO_LOCATION) as [City, number[]][]) {
    const placeholders = locationIds.map(() => '?').join(',');
    const orders = db.prepare(`
      SELECT item_id, MIN(price_silver) as best_sell_price
      FROM orders
      WHERE location_id IN (${placeholders})
        AND auction_type = 'offer'
        AND expires > ?
        AND last_seen > ?
      GROUP BY item_id
    `).all(...locationIds, now, staleThreshold) as Array<{ item_id: string; best_sell_price: number }>;

    for (const order of orders) {
      itemCityPrices.push({
        itemId: order.item_id,
        city,
        currentSellPrice: order.best_sell_price,
      });
    }
  }

  if (itemCityPrices.length === 0) {
    console.log('❌ No sell orders found in the order book.\n');
    return;
  }

  // Load item names
  const itemsPath = path.join(process.cwd(), 'src', 'constants', 'items.json');
  let itemNames: Record<string, string> = {};
  if (fs.existsSync(itemsPath)) {
    const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8')) as Array<{ id: string; name: string }>;
    for (const item of items) {
      itemNames[item.id] = item.name;
    }
  }

  // Find items below their 30-day average and calculate best sell city
  interface BelowAverageItem {
    itemId: string;
    itemName: string;
    buyCity: City;
    avg30Day: number;
    currentPrice: number;
    pctBelowAvg: number;
    bestSellCity: City;
    bestSellCityAvg30Day: number;
    bestSellCityBuyPrice: number;
    profitPerItem: number;
  }

  const belowAverageItems: BelowAverageItem[] = [];
  const processedItems = new Set<string>(); // Track processed item+city combos

  for (const { itemId, city, currentSellPrice } of itemCityPrices) {
    const key = `${itemId}:${city}`;
    if (processedItems.has(key)) continue;
    processedItems.add(key);

    // Get 30-day average for this item in this city
    const locationIds = CITY_TO_LOCATION[city];
    const avg30Data = get30DayAverage(itemId, locationIds);

    if (!avg30Data || avg30Data.avgPrice <= 0) continue;

    // Calculate how far below average
    const pctBelowAvg = ((avg30Data.avgPrice - currentSellPrice) / avg30Data.avgPrice) * 100;

    // Only include items at least 5% below average
    if (pctBelowAvg < 5) continue;

    // Find best city to sell (highest buy order price)
    const buyPrices = getBestBuyPrices(itemId);
    let bestSellCity: City | null = null;
    let bestSellCityBuyPrice = 0;

    for (const [sellCity, buyPrice] of Object.entries(buyPrices) as [City, number | null][]) {
      if (buyPrice !== null && buyPrice > bestSellCityBuyPrice) {
        bestSellCityBuyPrice = buyPrice;
        bestSellCity = sellCity;
      }
    }

    if (!bestSellCity || bestSellCityBuyPrice === 0) continue;

    // Get 30-day average for the best sell city
    const sellCityLocationIds = CITY_TO_LOCATION[bestSellCity];
    const sellCityAvg30Data = get30DayAverage(itemId, sellCityLocationIds);
    const bestSellCityAvg30Day = sellCityAvg30Data?.avgPrice || 0;

    // Calculate profit (sell price after 4% tax - buy price)
    const netSellPrice = bestSellCityBuyPrice * 0.96;
    const profitPerItem = netSellPrice - currentSellPrice;

    // Only include if there's positive profit
    if (profitPerItem <= 0) continue;

    const itemName = itemNames[itemId] || itemId;

    belowAverageItems.push({
      itemId,
      itemName,
      buyCity: city,
      avg30Day: avg30Data.avgPrice,
      currentPrice: currentSellPrice,
      pctBelowAvg,
      bestSellCity,
      bestSellCityAvg30Day,
      bestSellCityBuyPrice,
      profitPerItem,
    });
  }

  if (belowAverageItems.length === 0) {
    console.log('No items found with prices significantly below their 30-day average (>5%).\n');
    console.log('This could mean:');
    console.log('  - Markets are fairly priced');
    console.log('  - Not enough historical data');
    console.log('  - Prices are currently at or above average\n');
    return;
  }

  // Sort by percentage below average (biggest discount first)
  belowAverageItems.sort((a, b) => b.pctBelowAvg - a.pctBelowAvg);

  console.log(`Found ${belowAverageItems.length} items priced below their 30-day average.\n`);

  // Display table
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('                                                     ITEMS BELOW 30-DAY AVERAGE PRICE');
  console.log('                                                     Potential buying opportunities');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════\n');

  console.log('┌────┬─────────────────────────────────┬──────────────┬───────────┬───────────┬───────────┬──────────────┬───────────┬───────────┬───────────┐');
  console.log('│ #  │ Item                            │ Buy City     │ 30d Avg   │ Current   │ % Below   │ Sell City    │ 30d Avg   │ Buy Order │ Profit/ea │');
  console.log('├────┼─────────────────────────────────┼──────────────┼───────────┼───────────┼───────────┼──────────────┼───────────┼───────────┼───────────┤');

  const displayCount = Math.min(50, belowAverageItems.length);
  for (let i = 0; i < displayCount; i++) {
    const item = belowAverageItems[i];
    const rank = (i + 1).toString().padStart(2);
    const tierEnchant = getTierEnchant(item.itemId);
    const name = `${item.itemName} (${tierEnchant})`.substring(0, 31).padEnd(31);
    const buyCity = item.buyCity.substring(0, 12).padEnd(12);
    const avg30Day = formatNumber(item.avg30Day).padStart(9);
    const current = formatNumber(item.currentPrice).padStart(9);
    const pctBelow = `-${item.pctBelowAvg.toFixed(1)}%`.padStart(9);
    const sellCity = item.bestSellCity.substring(0, 12).padEnd(12);
    const sellCityAvg = formatNumber(item.bestSellCityAvg30Day).padStart(9);
    const buyOrder = formatNumber(item.bestSellCityBuyPrice).padStart(9);
    const profit = formatNumber(item.profitPerItem).padStart(9);

    console.log(`│ ${rank} │ ${name} │ ${buyCity} │ ${avg30Day} │ ${current} │ ${pctBelow} │ ${sellCity} │ ${sellCityAvg} │ ${buyOrder} │ ${profit} │`);
  }

  console.log('└────┴─────────────────────────────────┴──────────────┴───────────┴───────────┴───────────┴──────────────┴───────────┴───────────┴───────────┘');

  if (belowAverageItems.length > displayCount) {
    console.log(`\n   (Showing top ${displayCount} of ${belowAverageItems.length} items)`);
  }

  console.log('\n   Legend:');
  console.log('   • Buy City: City where the item is currently cheap');
  console.log('   • 30d Avg: 30-day average price in that city');
  console.log('   • Current: Current lowest sell order price');
  console.log('   • % Below: How far below the 30-day average');
  console.log('   • Sell City: City with the highest buy orders');
  console.log('   • Buy Order: Highest buy order price (quick sell)');
  console.log('   • Profit/ea: Profit per item after 4% tax');
  console.log('\n   💡 Buy in "Buy City" and quick sell in "Sell City" for instant profit!\n');
}

async function main() {
  console.log('Welcome to the Albion Craft Profitability Analyzer!');

  let running = true;

  while (running) {
    const choice = await showMenu();

    switch (choice) {
      case '0':
        console.log('\nGoodbye!\n');
        running = false;
        break;
      case '1':
        await viewBelowAverageSellOrders();
        break;
      case '9':
        await configureSettings();
        break;
      default:
        console.log('\n❌ Invalid option.\n');
    }
  }
}

// Configure user settings
async function configureSettings() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });
  };

  // Calculate current effective values for display
  const currentMarketTax = getMarketTaxRate();
  const currentReturnRate = calculateReturnRate('Caerleon'); // Base rate without city bonus

  console.log('\n--- SETTINGS ---\n');
  console.log('Configure your crafting parameters.\n');
  console.log('Current settings:');
  console.log(`  Premium status: ${userSettings.premiumStatus ? 'Yes' : 'No'}`);
  console.log(`  Use focus: ${userSettings.useFocus ? 'Yes' : 'No'}`);
  console.log(`  Daily refining bonus: ${userSettings.dailyBonus.refiningCategory || 'None'}`);
  // Display crafting bonuses
  const craftingBonuses = userSettings.dailyBonus.craftingBonuses || [];
  if (craftingBonuses.length === 0) {
    console.log('  Daily crafting bonuses: None');
  } else {
    console.log('  Daily crafting bonuses:');
    craftingBonuses.forEach((bonus, idx) => {
      console.log(`    ${idx + 1}. ${bonus.category} (+${bonus.percentage}%)`);
    });
  }
  console.log('');
  console.log('Auto-calculated values:');
  console.log(`  Market tax: ${currentMarketTax.toFixed(1)}% (${userSettings.premiumStatus ? '4% sales + 2.5% listing' : '8% sales + 2.5% listing'})`);
  console.log(`  Base return rate: ${currentReturnRate.toFixed(1)}% (18% base${userSettings.useFocus ? ' + 59% focus' : ''})`);
  console.log('  Note: +15% crafting bonus in city with specialization');
  console.log('  Note: +10% or +20% crafting bonus when daily bonus matches');
  console.log('');

  try {
    // Premium status
    const premiumInput = await question(`Premium status? (y/n) [${userSettings.premiumStatus ? 'y' : 'n'}]: `);
    if (premiumInput.toLowerCase() === 'y') {
      userSettings.premiumStatus = true;
    } else if (premiumInput.toLowerCase() === 'n') {
      userSettings.premiumStatus = false;
    }
    // If empty, keep current value

    // Use focus
    const focusInput = await question(`Use focus when crafting? (y/n) [${userSettings.useFocus ? 'y' : 'n'}]: `);
    if (focusInput.toLowerCase() === 'y') {
      userSettings.useFocus = true;
    } else if (focusInput.toLowerCase() === 'n') {
      userSettings.useFocus = false;
    }

    // Daily refining bonus
    console.log('\n--- DAILY REFINING BONUS (10%) ---');
    console.log('Check in-game journal for today\'s refining bonus.\n');
    console.log('0. None');
    REFINING_CATEGORIES.forEach((cat, idx) => {
      console.log(`${idx + 1}. ${cat}`);
    });
    const currentRefIdx = userSettings.dailyBonus.refiningCategory
      ? REFINING_CATEGORIES.indexOf(userSettings.dailyBonus.refiningCategory) + 1
      : 0;
    const refiningInput = await question(`\nSelect refining bonus [${currentRefIdx}]: `);
    if (refiningInput) {
      const refIdx = parseInt(refiningInput);
      if (refIdx === 0) {
        userSettings.dailyBonus.refiningCategory = null;
      } else if (refIdx >= 1 && refIdx <= REFINING_CATEGORIES.length) {
        userSettings.dailyBonus.refiningCategory = REFINING_CATEGORIES[refIdx - 1];
      } else {
        console.log('Invalid choice, keeping current.');
      }
    }

    // Daily crafting bonuses (up to 2)
    console.log('\n--- DAILY CRAFTING BONUSES ---');
    console.log('You can set up to 2 daily crafting bonuses (check in-game journal).');
    console.log('Each bonus can be +10% or +20%.\n');

    // Helper function to display categories
    const displayCategories = () => {
      console.log('0. None / Clear all');
      // Group crafting categories for easier display
      console.log('\nArmor:');
      const armorCats = CRAFTING_CATEGORIES.filter(c => c.includes('Armor') || c.includes('Helmet') || c.includes('Shoes'));
      armorCats.forEach((cat) => {
        const idx = CRAFTING_CATEGORIES.indexOf(cat) + 1;
        console.log(`  ${idx}. ${cat}`);
      });
      console.log('\nWeapons:');
      const weaponCats = CRAFTING_CATEGORIES.filter(c =>
        ['Sword', 'Axe', 'Mace', 'Hammer', 'Crossbow', 'Bow', 'Spear', 'Dagger', 'Quarterstaff'].includes(c) ||
        c.includes('Staff')
      );
      weaponCats.forEach((cat) => {
        const idx = CRAFTING_CATEGORIES.indexOf(cat) + 1;
        console.log(`  ${idx}. ${cat}`);
      });
      console.log('\nAccessories & Other:');
      const otherCats = CRAFTING_CATEGORIES.filter(c =>
        ['Off-hand', 'Shield', 'Cape', 'Bag', 'Tool', 'Gathering Gear', 'Mount', 'Food', 'Potion'].includes(c)
      );
      otherCats.forEach((cat) => {
        const idx = CRAFTING_CATEGORIES.indexOf(cat) + 1;
        console.log(`  ${idx}. ${cat}`);
      });
    };

    // Helper function to ask for a single bonus
    const askForBonus = async (bonusNum: number, existingBonus?: CraftingBonusEntry): Promise<CraftingBonusEntry | null> => {
      const currentIdx = existingBonus ? CRAFTING_CATEGORIES.indexOf(existingBonus.category) + 1 : 0;
      const currentPct = existingBonus?.percentage || 20;

      const categoryInput = await question(`\nBonus ${bonusNum} - Select category [${currentIdx}]: `);
      if (!categoryInput && existingBonus) {
        // Keep existing
        return existingBonus;
      }

      const catIdx = parseInt(categoryInput);
      if (catIdx === 0 || isNaN(catIdx)) {
        return null;  // No bonus / cleared
      }

      if (catIdx < 1 || catIdx > CRAFTING_CATEGORIES.length) {
        console.log('Invalid choice.');
        return existingBonus || null;
      }

      const selectedCategory = CRAFTING_CATEGORIES[catIdx - 1];

      // Ask for percentage
      const pctInput = await question(`Bonus percentage for ${selectedCategory}? (10 or 20) [${currentPct}]: `);
      let percentage: 10 | 20 = currentPct as 10 | 20;
      if (pctInput) {
        const pctValue = parseInt(pctInput);
        if (pctValue === 10 || pctValue === 20) {
          percentage = pctValue;
        } else {
          console.log('Invalid percentage, using 20%.');
          percentage = 20;
        }
      }

      return { category: selectedCategory, percentage };
    };

    // Initialize craftingBonuses if needed
    if (!userSettings.dailyBonus.craftingBonuses) {
      userSettings.dailyBonus.craftingBonuses = [];
    }

    displayCategories();

    // Ask for first bonus
    const bonus1 = await askForBonus(1, userSettings.dailyBonus.craftingBonuses[0]);

    // Ask for second bonus only if first was set
    let bonus2: CraftingBonusEntry | null = null;
    if (bonus1) {
      bonus2 = await askForBonus(2, userSettings.dailyBonus.craftingBonuses[1]);
    }

    // Update the bonuses array
    userSettings.dailyBonus.craftingBonuses = [];
    if (bonus1) {
      userSettings.dailyBonus.craftingBonuses.push(bonus1);
    }
    if (bonus2) {
      userSettings.dailyBonus.craftingBonuses.push(bonus2);
    }

    // Clear deprecated field
    userSettings.dailyBonus.craftingCategory = null;

    // Save settings
    saveSettings(userSettings);

    // Recalculate values after save
    const newMarketTax = getMarketTaxRate();
    const newReturnRate = calculateReturnRate('Caerleon');

    console.log('\n✅ Settings saved!\n');
    console.log('Updated settings:');
    console.log(`  Premium status: ${userSettings.premiumStatus ? 'Yes' : 'No'}`);
    console.log(`  Use focus: ${userSettings.useFocus ? 'Yes' : 'No'}`);
    console.log(`  Daily refining bonus: ${userSettings.dailyBonus.refiningCategory || 'None'} ${userSettings.dailyBonus.refiningCategory ? '(+10%)' : ''}`);
    // Display crafting bonuses
    if (userSettings.dailyBonus.craftingBonuses.length === 0) {
      console.log('  Daily crafting bonuses: None');
    } else {
      console.log('  Daily crafting bonuses:');
      userSettings.dailyBonus.craftingBonuses.forEach((bonus, idx) => {
        console.log(`    ${idx + 1}. ${bonus.category} (+${bonus.percentage}%)`);
      });
    }
    console.log('');
    console.log('Calculated values:');
    console.log(`  Market tax: ${newMarketTax.toFixed(1)}%`);
    console.log(`  Base return rate: ${newReturnRate.toFixed(1)}%`);
    console.log('');

  } finally {
    rl.close();
  }
}

// Run CLI
main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
