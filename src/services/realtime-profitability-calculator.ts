// realtime-profitability-calculator.ts
// Calculates crafting profitability using real-time order book data from SQLite
// This replaces the JSON-based ProfitabilityCalculator for features that need live data
//
// NOTE: This file is temporarily disabled. The order book functionality
// has been removed from the database in favor of daily price averages only.
// The NATS real-time order book will be re-enabled in a future update.

import { Recipe, UserStats, City, CraftingCost } from '../types';
// DISABLED: Order book functions removed from db.ts
// import { CITY_TO_LOCATION, MarketDepth, getMarketDepth, getStats } from '../db/db';
import { CITY_TO_LOCATION } from '../db/db';

// Placeholder type for disabled MarketDepth
interface MarketDepth {
  bestSellPrice: number | null;
  bestBuyPrice: number | null;
  totalSellAmount: number;
  totalBuyAmount: number;
}

// DISABLED: Stub functions since order book is removed
function getMarketDepth(_itemId: string, _locationId: number, _quality?: number): MarketDepth {
  return { bestSellPrice: null, bestBuyPrice: null, totalSellAmount: 0, totalBuyAmount: 0 };
}

function getStats(): { totalOrders: number; uniqueItems: number } {
  return { totalOrders: 0, uniqueItems: 0 };
}

// ============================================================================
// TYPES
// ============================================================================

export interface RealtimeProfitabilityResult {
  itemId: string;
  itemName: string;
  city: City;
  recipe: Recipe;
  // Material costs from order book
  craftingCost: CraftingCost;
  returnRate: number;
  // Sell options
  sellPrice: number;        // Best buy order price (quick sell) - in silver
  sellAmount: number;       // Available buy order quantity
  // Profitability
  grossRevenue: number;     // After market tax
  netProfit: number;
  roiPercent: number;
  // Order book metadata
  hasOrderBookData: boolean;
  materialsMissing: string[];
}

export interface CraftFromMarketResult extends RealtimeProfitabilityResult {
  profitPerKg: number;
  // Investment required
  totalMaterialCost: number;
  totalCraftingFee: number;
  totalInvestment: number;
}

// Inventory of materials the user owns
export interface MaterialInventory {
  [materialId: string]: number; // materialId -> quantity available
}

// Material price comparison across cities
export type PriceSignal = '🟢 BUY' | '🟡 FAIR' | '🔴 HIGH';

export interface MaterialPriceComparison {
  materialId: string;
  materialName: string;
  category: 'raw' | 'refined' | 'artifact' | 'alchemy';
  // Best city to buy from
  bestCity: City;
  bestPrice: number;
  bestAmount: number;
  // All city prices
  cityPrices: Map<City, { price: number; amount: number } | null>;
  // Price spread
  worstPrice: number | null;
  priceDifference: number | null;  // Difference between worst and best
  priceDifferencePct: number | null;  // Percentage difference
}

// Result for crafting from inventory
export interface CraftFromInventoryResult {
  itemId: string;
  itemName: string;
  city: City;
  recipe: Recipe;
  // How many can be crafted
  quantityToCraft: number;
  materialsUsed: Array<{
    materialId: string;
    materialName: string;
    quantityUsed: number;
  }>;
  // Costs (only crafting fee since materials are owned)
  craftingFeePerItem: number;
  totalCraftingFee: number;
  // Sell info from order book
  sellPrice: number;        // Best buy order price (quick sell) - in silver
  sellAmount: number;       // Available buy order quantity
  // Profitability
  returnRate: number;
  grossRevenuePerItem: number;  // After market tax
  profitPerItem: number;        // Revenue - crafting fee
  totalProfit: number;
  roiPercent: number;           // Based on crafting fee only
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Load static data
const recipesData: Recipe[] = require('../constants/recipes.json');
const itemsData: Array<{ id: string; name: string; tier: number; enchant: number; category: string; weight?: number }> = require('../constants/items.json');
const taxesData = require('../constants/taxes.json');
const returnRatesData = require('../constants/return-rates.json');

// Load material data from separate category files
interface MaterialInfo { id: string; name: string; }
const rawMaterialsData: MaterialInfo[] = require('../constants/raw-materials.json');
const refinedMaterialsData: MaterialInfo[] = require('../constants/refined-materials.json');
const artifactsData: MaterialInfo[] = require('../constants/artifacts.json');
const alchemyDropsData: MaterialInfo[] = require('../constants/alchemy-drops.json');

// All materials with their categories
const ALL_MATERIALS: Array<MaterialInfo & { category: 'raw' | 'refined' | 'artifact' | 'alchemy' }> = [
  ...rawMaterialsData.map(m => ({ ...m, category: 'raw' as const })),
  ...refinedMaterialsData.map(m => ({ ...m, category: 'refined' as const })),
  ...artifactsData.map(m => ({ ...m, category: 'artifact' as const })),
  ...alchemyDropsData.map(m => ({ ...m, category: 'alchemy' as const })),
];

// Build lookup maps
const ITEM_NAMES = new Map(itemsData.map((item) => [item.id, item.name]));
const ITEM_CATEGORIES = new Map(itemsData.map((item) => [item.id, item.category]));
const ITEM_WEIGHTS = new Map(itemsData.map((item) => [item.id, item.weight || 1]));
const RECIPES_MAP = new Map(recipesData.map((r) => [r.itemId, r]));
const MATERIAL_NAMES = new Map(ALL_MATERIALS.map((m) => [m.id, m.name]));

// Market fees (with premium)
const SALES_TAX_PREMIUM = 0.04;      // 4% sales tax with premium
const LISTING_FEE = 0.025;           // 2.5% listing fee for sell orders
const QUICK_SELL_TAX = SALES_TAX_PREMIUM;  // Quick sell only pays sales tax

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getItemWeight(itemId: string): number {
  if (ITEM_WEIGHTS.has(itemId)) {
    return ITEM_WEIGHTS.get(itemId)!;
  }
  const baseId = itemId.replace(/@[1-4]$/, '');
  if (ITEM_WEIGHTS.has(baseId)) {
    return ITEM_WEIGHTS.get(baseId)!;
  }
  return 1;
}

/**
 * Calculate return rate based on user stats, city, and item category
 * Formula: Return Rate = 1 - 1/(1 + (Production Bonus/100))
 */
function calculateReturnRate(userStats: UserStats, city: City, itemCategory?: string): number {
  let productionBonus = returnRatesData.bonuses.base; // 18% base

  // Add city crafting bonus if item matches city specialization
  if (city && itemCategory) {
    const cityBonuses = returnRatesData.cityBonuses[city];
    if (cityBonuses?.crafting) {
      const hasBonus = cityBonuses.crafting.some((cat: string) =>
        itemCategory.toLowerCase().includes(cat.toLowerCase())
      );
      if (hasBonus) {
        productionBonus += returnRatesData.bonuses.crafting; // +15%
      }
    }
  }

  // Add focus bonus
  if (userStats.useFocus) {
    productionBonus += returnRatesData.bonuses.focus; // +59%
  }

  // Add daily crafting bonus if item matches any of the daily bonus categories
  if (itemCategory && userStats.dailyBonus.craftingBonuses) {
    for (const bonus of userStats.dailyBonus.craftingBonuses) {
      const craftingCat = bonus.category.toLowerCase();
      if (itemCategory.toLowerCase().includes(craftingCat)) {
        productionBonus += bonus.percentage;
        break; // Only apply one bonus per item
      }
    }
  }

  // Calculate return rate using game formula: 1 - 1/(1 + bonus/100)
  const returnRate = 1 - 1 / (1 + productionBonus / 100);
  return returnRate;
}

/**
 * Calculate market tax rate based on premium status
 */
function calculateMarketTaxRate(userStats: UserStats): number {
  const salesTax = userStats.premiumStatus
    ? taxesData.salesTax.withPremium
    : taxesData.salesTax.withoutPremium;
  return (salesTax + taxesData.listingFee) / 100; // Return as decimal
}

/**
 * Check if a material ID is a refined resource that has enchant variants
 */
function isRefinedResource(materialId: string): boolean {
  return /_CLOTH$|_LEATHER$|_METALBAR$|_PLANKS$|_STONEBLOCK$/.test(materialId);
}

// ============================================================================
// MAIN CALCULATOR CLASS
// ============================================================================

export class RealtimeProfitabilityCalculator {

  /**
   * Calculate material costs from order book for a recipe in a city
   * Returns cost to buy all materials at current market prices
   */
  calculateMaterialCostFromOrderBook(
    recipe: Recipe,
    city: City,
    enchant: string,
    quantity: number = 1
  ): { cost: CraftingCost; missingMaterials: string[] } | null {
    const materials = [
      { id: recipe.material1, qty: recipe.mat1Qty },
      { id: recipe.material2, qty: recipe.mat2Qty },
      { id: recipe.material3, qty: recipe.mat3Qty },
      { id: recipe.material4, qty: recipe.mat4Qty },
    ].filter((m) => m.id && m.id.trim() !== '' && m.qty > 0);

    const materialCosts = [];
    let totalMaterialCost = 0;
    const missingMaterials: string[] = [];

    // Get all location IDs for this city
    const locationIds = CITY_TO_LOCATION[city];

    for (const material of materials) {
      // For enchanted items, use enchanted materials for refined resources
      let materialId = material.id;
      if (enchant && isRefinedResource(material.id)) {
        materialId = material.id + enchant;
      }

      // Get market depth across all locations in this city
      let bestPrice: number | null = null;
      let totalAvailable = 0;

      for (const locId of locationIds) {
        const depth = getMarketDepth(materialId, locId);
        if (depth.bestSellPrice !== null) {
          // Prices in DB are in cents, convert to silver
          const priceInSilver = depth.bestSellPrice / 100;
          if (bestPrice === null || priceInSilver < bestPrice) {
            bestPrice = priceInSilver;
          }
          totalAvailable += depth.totalSellAmount;
        }
      }

      if (bestPrice === null || totalAvailable < material.qty * quantity) {
        missingMaterials.push(materialId);
        continue;
      }

      const totalCost = bestPrice * material.qty * quantity;
      materialCosts.push({
        materialId,
        quantity: material.qty * quantity,
        pricePerUnit: bestPrice,
        totalCost,
      });

      totalMaterialCost += totalCost;
    }

    if (materialCosts.length === 0) {
      return null;
    }

    return {
      cost: {
        materialCosts,
        totalMaterialCost,
        effectiveCost: totalMaterialCost, // Will be adjusted by return rate later
        craftingFee: recipe.craftingFee * quantity,
        totalCost: totalMaterialCost + recipe.craftingFee * quantity,
      },
      missingMaterials,
    };
  }

  /**
   * Get best sell price (highest buy order) for an item in a city
   * This is the "quick sell" price - instant sell to existing buy orders
   */
  getBestSellPrice(itemId: string, city: City, quality: number = 1): { price: number; amount: number } | null {
    const locationIds = CITY_TO_LOCATION[city];
    let bestPrice: number | null = null;
    let totalAmount = 0;

    for (const locId of locationIds) {
      const depth = getMarketDepth(itemId, locId, quality);
      if (depth.bestBuyPrice !== null) {
        // Prices in DB are in cents, convert to silver
        const priceInSilver = depth.bestBuyPrice / 100;
        if (bestPrice === null || priceInSilver > bestPrice) {
          bestPrice = priceInSilver;
        }
        totalAmount += depth.totalBuyAmount;
      }
    }

    if (bestPrice === null) {
      return null;
    }

    return { price: bestPrice, amount: totalAmount };
  }

  /**
   * Calculate profitability for crafting an item and quick-selling it
   */
  calculateCraftFromMarket(
    itemId: string,
    city: City,
    userStats: UserStats,
    quantity: number = 1
  ): CraftFromMarketResult | null {
    // Get base item ID and enchant level
    const enchantMatch = itemId.match(/@([1-4])$/);
    const enchant = enchantMatch ? `@${enchantMatch[1]}` : '';
    const baseItemId = itemId.replace(/@[1-4]$/, '');

    // Get recipe
    const recipe = RECIPES_MAP.get(baseItemId);
    if (!recipe) {
      return null;
    }

    // Get item info
    const itemName = ITEM_NAMES.get(itemId) || ITEM_NAMES.get(baseItemId) || itemId;
    const itemCategory = ITEM_CATEGORIES.get(itemId) || ITEM_CATEGORIES.get(baseItemId) || '';
    const itemWeight = getItemWeight(itemId);

    // Calculate return rate
    const returnRate = calculateReturnRate(userStats, city, itemCategory);

    // Get material costs from order book
    const materialResult = this.calculateMaterialCostFromOrderBook(recipe, city, enchant, quantity);
    if (!materialResult) {
      return null;
    }

    // Apply return rate to effective cost
    const effectiveCost = materialResult.cost.totalMaterialCost * (1 - returnRate);
    const craftingCost: CraftingCost = {
      ...materialResult.cost,
      effectiveCost,
      totalCost: effectiveCost + materialResult.cost.craftingFee,
    };

    // Get sell price (best buy order for quick sell)
    const sellInfo = this.getBestSellPrice(itemId, city);
    if (!sellInfo) {
      return null;
    }

    // Calculate profit (quick sell with 4% tax)
    const marketTax = sellInfo.price * QUICK_SELL_TAX;
    const grossRevenue = (sellInfo.price - marketTax) * quantity;
    const netProfit = grossRevenue - craftingCost.totalCost;
    const roiPercent = (netProfit / craftingCost.totalCost) * 100;
    const profitPerUnit = netProfit / quantity;
    const profitPerKg = profitPerUnit / itemWeight;

    return {
      itemId,
      itemName,
      city,
      recipe,
      craftingCost,
      returnRate,
      sellPrice: sellInfo.price,
      sellAmount: sellInfo.amount,
      grossRevenue,
      netProfit,
      roiPercent,
      hasOrderBookData: materialResult.missingMaterials.length === 0,
      materialsMissing: materialResult.missingMaterials,
      profitPerKg,
      totalMaterialCost: materialResult.cost.totalMaterialCost,
      totalCraftingFee: materialResult.cost.craftingFee,
      totalInvestment: materialResult.cost.totalMaterialCost + materialResult.cost.craftingFee,
    };
  }

  /**
   * Find all profitable craft-from-market opportunities across all items
   */
  findCraftFromMarketOpportunities(
    userStats: UserStats,
    city?: City,
    minProfitPercent: number = 0
  ): CraftFromMarketResult[] {
    const opportunities: CraftFromMarketResult[] = [];
    const cities: City[] = city
      ? [city]
      : ['Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];

    const enchantLevels = ['', '@1', '@2', '@3', '@4'];

    for (const [baseItemId] of RECIPES_MAP) {
      for (const enchant of enchantLevels) {
        const itemId = baseItemId + enchant;
        for (const c of cities) {
          const result = this.calculateCraftFromMarket(itemId, c, userStats);
          if (result && result.netProfit > 0 && result.roiPercent >= minProfitPercent) {
            opportunities.push(result);
          }
        }
      }
    }

    // Sort by profit per kg (best transport efficiency)
    opportunities.sort((a, b) => b.profitPerKg - a.profitPerKg);

    return opportunities;
  }

  /**
   * Get database stats for display
   */
  getOrderBookStats() {
    return getStats();
  }

  // ============================================================================
  // CRAFT FROM INVENTORY
  // ============================================================================

  /**
   * Calculate how many items can be crafted with available materials
   */
  private calculateMaxCraftable(
    recipe: Recipe,
    enchant: string,
    availableMaterials: MaterialInventory
  ): number {
    const materials = [
      { id: recipe.material1, qty: recipe.mat1Qty },
      { id: recipe.material2, qty: recipe.mat2Qty },
      { id: recipe.material3, qty: recipe.mat3Qty },
      { id: recipe.material4, qty: recipe.mat4Qty },
    ].filter((m) => m.id && m.id.trim() !== '' && m.qty > 0);

    if (materials.length === 0) return 0;

    let maxCraftable = Infinity;

    for (const material of materials) {
      // For enchanted items, use enchanted materials for refined resources
      let materialId = material.id;
      if (enchant && isRefinedResource(material.id)) {
        materialId = material.id + enchant;
      }

      const available = availableMaterials[materialId] || 0;
      const canCraft = Math.floor(available / material.qty);
      maxCraftable = Math.min(maxCraftable, canCraft);
    }

    return maxCraftable === Infinity ? 0 : maxCraftable;
  }

  /**
   * Get materials used for crafting and update available inventory
   */
  private getMaterialsUsed(
    recipe: Recipe,
    enchant: string,
    quantity: number
  ): Array<{ materialId: string; materialName: string; quantityUsed: number }> {
    const materials = [
      { id: recipe.material1, qty: recipe.mat1Qty },
      { id: recipe.material2, qty: recipe.mat2Qty },
      { id: recipe.material3, qty: recipe.mat3Qty },
      { id: recipe.material4, qty: recipe.mat4Qty },
    ].filter((m) => m.id && m.id.trim() !== '' && m.qty > 0);

    const used: Array<{ materialId: string; materialName: string; quantityUsed: number }> = [];

    for (const material of materials) {
      let materialId = material.id;
      if (enchant && isRefinedResource(material.id)) {
        materialId = material.id + enchant;
      }

      const quantityUsed = material.qty * quantity;
      const baseId = materialId.replace(/@[1-4]$/, '');
      const materialName = ITEM_NAMES.get(baseId) || materialId;

      used.push({
        materialId,
        materialName,
        quantityUsed,
      });
    }

    return used;
  }

  /**
   * Find craftable items from inventory with real-time sell prices
   */
  findCraftFromInventoryOpportunities(
    inventory: MaterialInventory,
    city: City,
    userStats: UserStats
  ): CraftFromInventoryResult[] {
    const results: CraftFromInventoryResult[] = [];

    // Create a working copy of inventory
    const availableMaterials = { ...inventory };
    const enchantLevels = ['', '@1', '@2', '@3', '@4'];

    // Build list of all items that can be crafted
    const craftableItems: Array<{
      itemId: string;
      baseItemId: string;
      enchant: string;
      maxCraftable: number;
    }> = [];

    for (const [baseItemId, recipe] of RECIPES_MAP) {
      for (const enchant of enchantLevels) {
        const itemId = baseItemId + enchant;
        const maxCraftable = this.calculateMaxCraftable(recipe, enchant, availableMaterials);
        if (maxCraftable > 0) {
          craftableItems.push({ itemId, baseItemId, enchant, maxCraftable });
        }
      }
    }

    // For each craftable item, get real-time sell price and calculate profit
    for (const { itemId, baseItemId, enchant, maxCraftable } of craftableItems) {
      const recipe = RECIPES_MAP.get(baseItemId)!;
      const itemName = ITEM_NAMES.get(itemId) || ITEM_NAMES.get(baseItemId) || itemId;
      const itemCategory = ITEM_CATEGORIES.get(itemId) || ITEM_CATEGORIES.get(baseItemId) || '';

      // Get sell price from order book
      const sellInfo = this.getBestSellPrice(itemId, city);
      if (!sellInfo || sellInfo.price <= 0) {
        continue; // No buy orders for this item
      }

      // Calculate return rate
      const returnRate = calculateReturnRate(userStats, city, itemCategory);

      // Calculate profit
      const marketTax = sellInfo.price * QUICK_SELL_TAX;
      const grossRevenuePerItem = sellInfo.price - marketTax;
      const craftingFeePerItem = recipe.craftingFee;
      const profitPerItem = grossRevenuePerItem - craftingFeePerItem;

      // Skip if not profitable
      if (profitPerItem <= 0) {
        continue;
      }

      // Limit quantity by available buy orders
      const quantityToCraft = Math.min(maxCraftable, sellInfo.amount);
      const totalProfit = profitPerItem * quantityToCraft;
      const totalCraftingFee = craftingFeePerItem * quantityToCraft;
      const roiPercent = (profitPerItem / craftingFeePerItem) * 100;

      const materialsUsed = this.getMaterialsUsed(recipe, enchant, quantityToCraft);

      results.push({
        itemId,
        itemName,
        city,
        recipe,
        quantityToCraft,
        materialsUsed,
        craftingFeePerItem,
        totalCraftingFee,
        sellPrice: sellInfo.price,
        sellAmount: sellInfo.amount,
        returnRate,
        grossRevenuePerItem,
        profitPerItem,
        totalProfit,
        roiPercent,
      });
    }

    // Sort by total profit (highest first)
    results.sort((a, b) => b.totalProfit - a.totalProfit);

    return results;
  }

  // ============================================================================
  // MATERIAL BUY OPPORTUNITIES
  // ============================================================================

  /**
   * Get the lowest sell order price for a material in a city
   * This is what you'd pay to buy the material
   */
  getMaterialPrice(materialId: string, city: City): { price: number; amount: number } | null {
    const locationIds = CITY_TO_LOCATION[city];
    let bestPrice: number | null = null;
    let totalAmount = 0;

    for (const locId of locationIds) {
      const depth = getMarketDepth(materialId, locId);
      if (depth.bestSellPrice !== null) {
        // Prices in DB are in cents, convert to silver
        const priceInSilver = depth.bestSellPrice / 100;
        if (bestPrice === null || priceInSilver < bestPrice) {
          bestPrice = priceInSilver;
        }
        totalAmount += depth.totalSellAmount;
      }
    }

    if (bestPrice === null) {
      return null;
    }

    return { price: bestPrice, amount: totalAmount };
  }

  /**
   * Compare material prices across all cities
   */
  compareMaterialPrices(materialId: string, category: 'raw' | 'refined' | 'artifact' | 'alchemy'): MaterialPriceComparison | null {
    const cities: City[] = ['Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien', 'Caerleon'];
    const cityPrices = new Map<City, { price: number; amount: number } | null>();

    let bestCity: City | null = null;
    let bestPrice: number | null = null;
    let bestAmount = 0;
    let worstPrice: number | null = null;

    for (const city of cities) {
      const priceInfo = this.getMaterialPrice(materialId, city);
      cityPrices.set(city, priceInfo);

      if (priceInfo) {
        if (bestPrice === null || priceInfo.price < bestPrice) {
          bestPrice = priceInfo.price;
          bestCity = city;
          bestAmount = priceInfo.amount;
        }
        if (worstPrice === null || priceInfo.price > worstPrice) {
          worstPrice = priceInfo.price;
        }
      }
    }

    if (bestCity === null || bestPrice === null) {
      return null; // No prices found for this material
    }

    const materialName = MATERIAL_NAMES.get(materialId) || materialId;
    const priceDifference = worstPrice !== null ? worstPrice - bestPrice : null;
    const priceDifferencePct = priceDifference !== null && bestPrice > 0
      ? (priceDifference / bestPrice) * 100
      : null;

    return {
      materialId,
      materialName,
      category,
      bestCity,
      bestPrice,
      bestAmount,
      cityPrices,
      worstPrice,
      priceDifference,
      priceDifferencePct,
    };
  }

  /**
   * Find all material buy opportunities - materials with significant price differences between cities
   */
  findMaterialBuyOpportunities(
    minPriceDifferencePct: number = 0
  ): MaterialPriceComparison[] {
    const opportunities: MaterialPriceComparison[] = [];

    // Check all materials (base versions only, plus enchanted refined materials)
    for (const material of ALL_MATERIALS) {
      // Check base material
      const comparison = this.compareMaterialPrices(material.id, material.category);
      if (comparison && (comparison.priceDifferencePct || 0) >= minPriceDifferencePct) {
        opportunities.push(comparison);
      }

      // For refined materials, also check enchanted versions
      if (material.category === 'refined') {
        for (const enchant of ['@1', '@2', '@3', '@4']) {
          const enchantedId = material.id + enchant;
          const enchantedComparison = this.compareMaterialPrices(enchantedId, 'refined');
          if (enchantedComparison && (enchantedComparison.priceDifferencePct || 0) >= minPriceDifferencePct) {
            opportunities.push(enchantedComparison);
          }
        }
      }
    }

    // Sort by price difference percentage (highest first = best arbitrage opportunity)
    opportunities.sort((a, b) => (b.priceDifferencePct || 0) - (a.priceDifferencePct || 0));

    return opportunities;
  }

  /**
   * Get all materials with their best prices organized by category
   */
  getAllMaterialPrices(): {
    raw: MaterialPriceComparison[];
    refined: MaterialPriceComparison[];
    artifact: MaterialPriceComparison[];
    alchemy: MaterialPriceComparison[];
  } {
    const result = {
      raw: [] as MaterialPriceComparison[],
      refined: [] as MaterialPriceComparison[],
      artifact: [] as MaterialPriceComparison[],
      alchemy: [] as MaterialPriceComparison[],
    };

    for (const material of ALL_MATERIALS) {
      const comparison = this.compareMaterialPrices(material.id, material.category);
      if (comparison) {
        result[material.category].push(comparison);
      }

      // For refined materials, also check enchanted versions
      if (material.category === 'refined') {
        for (const enchant of ['@1', '@2', '@3', '@4']) {
          const enchantedId = material.id + enchant;
          const enchantedComparison = this.compareMaterialPrices(enchantedId, 'refined');
          if (enchantedComparison) {
            result.refined.push(enchantedComparison);
          }
        }
      }
    }

    // Sort each category by best price
    for (const category of ['raw', 'refined', 'artifact', 'alchemy'] as const) {
      result[category].sort((a, b) => a.bestPrice - b.bestPrice);
    }

    return result;
  }
}

// Export singleton
let _calculator: RealtimeProfitabilityCalculator | null = null;

export function getRealtimeCalculator(): RealtimeProfitabilityCalculator {
  if (!_calculator) {
    _calculator = new RealtimeProfitabilityCalculator();
  }
  return _calculator;
}
