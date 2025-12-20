// Profitability Calculation Engine

import {
  Recipe,
  MaterialPrice,
  MarketData,
  DemandSupplyData,
  UserStats,
  CraftingCost,
  ProfitabilityResult,
  City,
  SupplySignal,
  TrendIndicator,
  MarketCondition,
  ReturnRates,
  Taxes,
  RefiningCategory,
  CraftingCategory,
  DailyBonus,
} from '../types';

// Item name lookup
interface ItemInfo {
  id: string;
  name: string;
  tier?: number;
  enchant?: number;
  category?: string;
}

const itemsData = require('../constants/items.json') as ItemInfo[];
const taxesData: Taxes = require('../constants/taxes.json');
const returnRatesData: ReturnRates = require('../constants/return-rates.json');

export class ProfitabilityCalculator {
  private materialPrices: Map<string, MaterialPrice[]>;
  private marketData: Map<string, MarketData[]>;
  private demandSupply: Map<string, DemandSupplyData[]>;
  private recipes: Map<string, Recipe>;
  private itemNames: Map<string, string>;

  constructor(
    materialPrices: MaterialPrice[],
    marketData: MarketData[],
    recipes: Recipe[],
    demandSupplyData?: DemandSupplyData[]
  ) {
    // Index material prices by material ID for fast lookup
    this.materialPrices = new Map();
    materialPrices.forEach((price) => {
      if (!this.materialPrices.has(price.materialId)) {
        this.materialPrices.set(price.materialId, []);
      }
      this.materialPrices.get(price.materialId)!.push(price);
    });

    // Index market data by item ID for fast lookup
    this.marketData = new Map();
    marketData.forEach((data) => {
      if (!this.marketData.has(data.itemId)) {
        this.marketData.set(data.itemId, []);
      }
      this.marketData.get(data.itemId)!.push(data);
    });

    // Index demand/supply data by item ID for fast lookup
    this.demandSupply = new Map();
    if (demandSupplyData) {
      demandSupplyData.forEach((data) => {
        if (!this.demandSupply.has(data.itemId)) {
          this.demandSupply.set(data.itemId, []);
        }
        this.demandSupply.get(data.itemId)!.push(data);
      });
    }

    // Index recipes by item ID
    this.recipes = new Map();
    recipes.forEach((recipe) => {
      this.recipes.set(recipe.itemId, recipe);
    });

    // Build item name lookup
    this.itemNames = new Map();
    itemsData.forEach((item) => {
      this.itemNames.set(item.id, item.name);
    });
  }

  /**
   * Calculate market tax rate based on premium status
   * Sales tax + listing fee
   */
  calculateMarketTaxRate(userStats: UserStats): number {
    const salesTax = userStats.premiumStatus
      ? taxesData.salesTax.withPremium
      : taxesData.salesTax.withoutPremium;
    return salesTax + taxesData.listingFee;
  }

  /**
   * Get the daily bonus percentage for an item based on its category
   * Returns 10% for refining bonus, 20% for crafting bonus, 0% if no bonus
   */
  getDailyBonusForItem(dailyBonus: DailyBonus, itemName: string): number {
    const nameLower = itemName.toLowerCase();

    // Check crafting daily bonus (20%)
    if (dailyBonus.craftingCategory) {
      const craftingCat = dailyBonus.craftingCategory.toLowerCase();
      if (nameLower.includes(craftingCat)) {
        return 20;
      }
    }

    // Note: Refining bonus applies to materials, not crafted items
    // This is handled separately when calculating material costs
    return 0;
  }

  /**
   * Check if a material matches the refining daily bonus category
   * Returns 10% bonus if it matches, 0% otherwise
   */
  getRefiningBonusForMaterial(dailyBonus: DailyBonus, materialId: string): number {
    if (!dailyBonus.refiningCategory) return 0;

    const materialIdLower = materialId.toLowerCase();

    // Map refining categories to material ID patterns
    const refiningPatterns: Record<RefiningCategory, string[]> = {
      'Ore': ['_metalbar'],
      'Wood': ['_planks'],
      'Hide': ['_leather'],
      'Fiber': ['_cloth'],
      'Stone': ['_stoneblock'],
    };

    const patterns = refiningPatterns[dailyBonus.refiningCategory];
    if (patterns) {
      for (const pattern of patterns) {
        if (materialIdLower.includes(pattern)) {
          return 10; // 10% refining bonus
        }
      }
    }

    return 0;
  }

  /**
   * Calculate resource return rate based on user stats, city, and item type
   * Formula: Return Rate = 1 - 1/(1 + (Production Bonus/100))
   *
   * Production bonus components:
   * - Base: 18% (all cities)
   * - City crafting bonus: 15% (if item matches city specialization)
   * - Focus: 59% (if using focus)
   * - Daily crafting bonus: 20% (if item matches daily bonus category)
   */
  calculateReturnRate(userStats: UserStats, city?: City, itemCategory?: string): number {
    let productionBonus = returnRatesData.bonuses.base; // 18% base

    // Add city crafting bonus if item matches city specialization
    if (city && itemCategory) {
      const cityBonuses = returnRatesData.cityBonuses[city];
      if (cityBonuses?.crafting) {
        // Check if this item category has a crafting bonus in this city
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

    // Add daily crafting bonus (20%) if item matches the daily bonus category
    if (itemCategory) {
      productionBonus += this.getDailyBonusForItem(userStats.dailyBonus, itemCategory);
    }

    // Calculate return rate using game formula: 1 - 1/(1 + bonus/100)
    const returnRate = 1 - 1 / (1 + productionBonus / 100);
    return returnRate; // Return as decimal (e.g., 0.439 for 43.9%)
  }

  /**
   * Calculate material costs for a recipe in a specific city
   */
  calculateMaterialCost(
    recipe: Recipe,
    city: City,
    returnRate: number
  ): CraftingCost | null {
    const materials = [
      { id: recipe.material1, qty: recipe.mat1Qty },
      { id: recipe.material2, qty: recipe.mat2Qty },
      { id: recipe.material3, qty: recipe.mat3Qty },
      { id: recipe.material4, qty: recipe.mat4Qty },
    ].filter((m) => m.id && m.id.trim() !== '' && m.qty > 0);

    const materialCosts = [];
    let totalMaterialCost = 0;

    for (const material of materials) {
      const prices = this.materialPrices.get(material.id);
      if (!prices) {
        // Material price not found
        return null;
      }

      // Find price for this city
      const cityPrice = prices.find((p) => p.city === city);
      if (!cityPrice || cityPrice.sellPriceMin === 0) {
        // No price data for this city
        return null;
      }

      const totalCost = cityPrice.sellPriceMin * material.qty;
      materialCosts.push({
        materialId: material.id,
        quantity: material.qty,
        pricePerUnit: cityPrice.sellPriceMin,
        totalCost,
      });

      totalMaterialCost += totalCost;
    }

    // Calculate effective cost after resource return
    const effectiveCost = totalMaterialCost * (1 - returnRate);

    return {
      materialCosts,
      totalMaterialCost,
      effectiveCost,
      craftingFee: recipe.craftingFee,
      totalCost: effectiveCost + recipe.craftingFee,
    };
  }

  /**
   * Get supply multiplier based on supply signal
   */
  private getSupplyMultiplier(supplySignal: SupplySignal): number {
    switch (supplySignal) {
      case '🟢 Rising':
        return 1.5;
      case '🟡 Stable':
        return 1.0;
      case '🔴 Falling':
        return 0.5;
      default:
        return 1.0;
    }
  }

  /**
   * Convert price trend percentage to trend indicator
   * Rising prices = supply falling (bad for sellers), Falling prices = supply rising (good competition)
   */
  private getPriceTrend(priceTrendPct: number): TrendIndicator {
    if (priceTrendPct > 5) return '↑';  // Prices rising
    if (priceTrendPct < -5) return '↓'; // Prices falling
    return '→';  // Stable
  }

  /**
   * Get demand trend indicator based on supply signal
   * Note: Supply signal is inverse to demand trend for crafters
   * 🟢 Rising supply = more competition = stable/falling demand opportunity
   * 🔴 Falling supply = high demand = good opportunity
   */
  private getDemandTrend(supplySignal: SupplySignal): TrendIndicator {
    // Inverse relationship: falling supply means rising demand opportunity
    switch (supplySignal) {
      case '🔴 Falling':
        return '↑';  // Supply falling = demand opportunity rising
      case '🟢 Rising':
        return '↓';  // Supply rising = demand opportunity falling
      default:
        return '→';  // Stable
    }
  }

  /**
   * Synthesize market condition from multiple factors
   * 🟢 Hot = High demand + favorable price trend + good liquidity
   * 🟡 Stable = Moderate conditions
   * 🔴 Dying = Low demand, bad trends, or poor liquidity
   */
  private getMarketCondition(
    demandPerDay: number,
    priceTrendPct: number,
    supplySignal: SupplySignal,
    confidence: number
  ): MarketCondition {
    // Hot market: Falling supply (high demand) + stable/rising prices + good confidence
    if (
      supplySignal === '🔴 Falling' &&
      priceTrendPct >= 0 &&
      demandPerDay >= 10 &&
      confidence >= 60
    ) {
      return '🟢 Hot';
    }

    // Dying market: Rising supply (oversupplied) + falling prices + low demand
    if (
      supplySignal === '🟢 Rising' &&
      priceTrendPct < -10 &&
      demandPerDay < 5
    ) {
      return '🔴 Dying';
    }

    // Also dying if very low demand regardless of other factors
    if (demandPerDay < 2) {
      return '🔴 Dying';
    }

    // Default to stable
    return '🟡 Stable';
  }

  /**
   * Calculate estimated days to sell and liquidity risk
   * Based on daily demand and typical listing behavior
   */
  private calculateLiquidity(
    demandPerDay: number,
    netProfit: number
  ): { sellsInDays: number; liquidityRisk: 'Low' | 'Medium' | 'High' } {
    // If no demand, very high risk
    if (demandPerDay <= 0) {
      return { sellsInDays: 999, liquidityRisk: 'High' };
    }

    // Assume we're selling 1 item, calculate how many days to sell
    // High demand items sell faster
    const sellsInDays = Math.max(1, Math.ceil(1 / demandPerDay * 10));

    // Liquidity risk based on demand and sell time
    let liquidityRisk: 'Low' | 'Medium' | 'High';
    if (demandPerDay >= 50 && sellsInDays <= 1) {
      liquidityRisk = 'Low';
    } else if (demandPerDay >= 10 && sellsInDays <= 3) {
      liquidityRisk = 'Medium';
    } else {
      liquidityRisk = 'High';
    }

    return { sellsInDays, liquidityRisk };
  }

  /**
   * Calculate profit per day based on demand velocity
   * This is the PRIMARY SORT metric
   */
  private calculateProfitPerDay(
    netProfit: number,
    demandPerDay: number,
    sellsInDays: number
  ): number {
    if (sellsInDays <= 0 || demandPerDay <= 0) return 0;
    // Expected profit per day = (profit per item) * (items sold per day)
    // Capped by demand - can't sell more than market demands
    const itemsPerDay = Math.min(demandPerDay, 1 / sellsInDays);
    return netProfit * itemsPerDay;
  }

  /**
   * Calculate profitability for a single item in a single city
   */
  calculateProfitability(
    itemId: string,
    city: City,
    userStats: UserStats
  ): ProfitabilityResult | null {
    // Get recipe
    const recipe = this.recipes.get(itemId);
    if (!recipe) {
      return null;
    }

    // Get market data
    const marketDataList = this.marketData.get(itemId);
    if (!marketDataList) {
      return null;
    }

    const marketData = marketDataList.find((m) => m.city === city);
    if (!marketData || marketData.lowestSellPrice === 0) {
      return null;
    }

    // Get demand/supply data (more accurate demand from charts endpoint)
    const demandSupplyList = this.demandSupply.get(itemId);
    const demandSupplyData = demandSupplyList?.find((d) => d.city === city);

    // Get item category for city bonus calculation
    const itemCategory = this.getItemCategory(itemId);

    // Calculate return rate (auto-calculated based on city, item, focus, etc.)
    const returnRate = this.calculateReturnRate(userStats, city, itemCategory);

    // Calculate material costs
    const craftingCost = this.calculateMaterialCost(recipe, city, returnRate);
    if (!craftingCost) {
      return null;
    }

    // Calculate market tax (auto-calculated based on premium status)
    const marketTaxRate = this.calculateMarketTaxRate(userStats);

    // Calculate gross revenue (after market tax)
    const grossRevenue = marketData.lowestSellPrice * (1 - marketTaxRate / 100);

    // Calculate net profit
    const netProfit = grossRevenue - craftingCost.totalCost;

    // Calculate ROI %
    const roiPercent = (netProfit / craftingCost.totalCost) * 100;

    // Use demand/supply data if available (more accurate), otherwise fall back to market data
    const demandPerDay = demandSupplyData?.dailyDemand ?? marketData.dailyDemand;
    const supplySignal = demandSupplyData?.supplySignal ?? marketData.supplySignal;
    const priceTrendPct = demandSupplyData?.priceTrendPct ?? marketData.priceTrendPct;
    const dataAgeHours = demandSupplyData?.dataAgeHours ?? marketData.dataAgeHours;
    const confidence = dataAgeHours < 12 ? 95 : dataAgeHours < 24 ? 80 : dataAgeHours < 48 ? 60 : 40;

    // Calculate profit rank (weighted by demand & supply signal)
    const supplyMultiplier = this.getSupplyMultiplier(supplySignal);
    const profitRank = (netProfit * demandPerDay * supplyMultiplier) / 1000;

    // Phase 2 metrics
    const demandTrend = this.getDemandTrend(supplySignal);
    const priceTrend = this.getPriceTrend(priceTrendPct);
    const marketCondition = this.getMarketCondition(
      demandPerDay,
      priceTrendPct,
      supplySignal,
      confidence
    );
    const { sellsInDays, liquidityRisk } = this.calculateLiquidity(demandPerDay, netProfit);
    const profitPerDay = this.calculateProfitPerDay(netProfit, demandPerDay, sellsInDays);

    // Get item name
    const itemName = this.itemNames.get(itemId) || itemId;

    return {
      itemId,
      itemName,
      city,
      recipe,
      marketData,
      craftingCost,
      returnRate,
      grossRevenue,
      netProfit,
      roiPercent,
      profitRank,
      // Phase 2 metrics
      demandPerDay,
      demandTrend,
      priceTrend,
      priceTrendPct,
      marketCondition,
      sellsInDays,
      liquidityRisk,
      profitPerDay,
      calculatedAt: new Date(),
    };
  }

  /**
   * Calculate profitability for all items in all cities
   * Includes enchanted variants (@1, @2, @3, @4) of each base item
   */
  calculateAll(userStats: UserStats): ProfitabilityResult[] {
    const results: ProfitabilityResult[] = [];
    const cities: City[] = [
      'Caerleon',
      'Bridgewatch',
      'Fort Sterling',
      'Lymhurst',
      'Martlock',
      'Thetford',
      'Brecilien',
    ];
    const enchantLevels = ['', '@1', '@2', '@3', '@4']; // '' = base item (.0)

    for (const [baseItemId, recipe] of this.recipes) {
      for (const enchant of enchantLevels) {
        const itemId = baseItemId + enchant;
        for (const city of cities) {
          const result = this.calculateProfitabilityForEnchant(itemId, baseItemId, enchant, city, userStats);
          if (result && result.netProfit > 0) {
            // Only include profitable items
            results.push(result);
          }
        }
      }
    }

    return results;
  }

  /**
   * Calculate profitability for a specific enchant level of an item
   * Uses the base recipe but looks up enchanted material prices
   */
  private calculateProfitabilityForEnchant(
    itemId: string,
    baseItemId: string,
    enchant: string,
    city: City,
    userStats: UserStats
  ): ProfitabilityResult | null {
    // Get base recipe
    const recipe = this.recipes.get(baseItemId);
    if (!recipe) {
      return null;
    }

    // Get market data for the enchanted item
    const marketDataList = this.marketData.get(itemId);
    if (!marketDataList) {
      return null;
    }

    const marketData = marketDataList.find((m) => m.city === city);
    if (!marketData || marketData.lowestSellPrice === 0) {
      return null;
    }

    // Get demand/supply data (more accurate demand from charts endpoint)
    const demandSupplyList = this.demandSupply.get(itemId);
    const demandSupplyData = demandSupplyList?.find((d) => d.city === city);

    // Get item category for city bonus calculation (use base item for category)
    const itemCategory = this.getItemCategory(baseItemId);

    // Calculate return rate (auto-calculated based on city, item, focus, etc.)
    const returnRate = this.calculateReturnRate(userStats, city, itemCategory);

    // Calculate material costs (using enchanted materials if applicable)
    const craftingCost = this.calculateMaterialCostForEnchant(recipe, enchant, city, returnRate);
    if (!craftingCost) {
      return null;
    }

    // Calculate market tax (auto-calculated based on premium status)
    const marketTaxRate = this.calculateMarketTaxRate(userStats);

    // Calculate gross revenue (after market tax)
    const grossRevenue = marketData.lowestSellPrice * (1 - marketTaxRate / 100);

    // Calculate net profit
    const netProfit = grossRevenue - craftingCost.totalCost;

    // Calculate ROI %
    const roiPercent = (netProfit / craftingCost.totalCost) * 100;

    // Use demand/supply data if available (more accurate), otherwise fall back to market data
    const demandPerDay = demandSupplyData?.dailyDemand ?? marketData.dailyDemand;
    const supplySignal = demandSupplyData?.supplySignal ?? marketData.supplySignal;
    const priceTrendPct = demandSupplyData?.priceTrendPct ?? marketData.priceTrendPct;
    const dataAgeHours = demandSupplyData?.dataAgeHours ?? marketData.dataAgeHours;
    const confidence = dataAgeHours < 12 ? 95 : dataAgeHours < 24 ? 80 : dataAgeHours < 48 ? 60 : 40;

    // Calculate profit rank (weighted by demand & supply signal)
    const supplyMultiplier = this.getSupplyMultiplier(supplySignal);
    const profitRank = (netProfit * demandPerDay * supplyMultiplier) / 1000;

    // Phase 2 metrics
    const demandTrend = this.getDemandTrend(supplySignal);
    const priceTrend = this.getPriceTrend(priceTrendPct);
    const marketCondition = this.getMarketCondition(
      demandPerDay,
      priceTrendPct,
      supplySignal,
      confidence
    );
    const { sellsInDays, liquidityRisk } = this.calculateLiquidity(demandPerDay, netProfit);
    const profitPerDay = this.calculateProfitPerDay(netProfit, demandPerDay, sellsInDays);

    // Get item name
    const itemName = this.itemNames.get(itemId) || this.itemNames.get(baseItemId) || itemId;

    return {
      itemId,
      itemName,
      city,
      recipe,
      marketData,
      craftingCost,
      returnRate,
      grossRevenue,
      netProfit,
      roiPercent,
      profitRank,
      // Phase 2 metrics
      demandPerDay,
      demandTrend,
      priceTrend,
      priceTrendPct,
      marketCondition,
      sellsInDays,
      liquidityRisk,
      profitPerDay,
      calculatedAt: new Date(),
    };
  }

  /**
   * Calculate material costs for a recipe with a specific enchant level
   * Enchanted items use enchanted materials (e.g., T4_PLANKS@1 for a .1 item)
   */
  private calculateMaterialCostForEnchant(
    recipe: Recipe,
    enchant: string,
    city: City,
    returnRate: number
  ): CraftingCost | null {
    const materials = [
      { id: recipe.material1, qty: recipe.mat1Qty },
      { id: recipe.material2, qty: recipe.mat2Qty },
      { id: recipe.material3, qty: recipe.mat3Qty },
      { id: recipe.material4, qty: recipe.mat4Qty },
    ].filter((m) => m.id && m.id.trim() !== '' && m.qty > 0);

    const materialCosts = [];
    let totalMaterialCost = 0;

    for (const material of materials) {
      // For enchanted items, use enchanted materials
      // Only add enchant suffix to refined resources (CLOTH, LEATHER, METALBAR, PLANKS)
      // Artifacts and other special materials don't have enchant variants
      let materialId = material.id;
      if (enchant && this.isRefinedResource(material.id)) {
        materialId = material.id + enchant;
      }

      const prices = this.materialPrices.get(materialId);
      if (!prices) {
        // Try base material if enchanted not found
        const basePrices = this.materialPrices.get(material.id);
        if (!basePrices) {
          return null;
        }
        // Use base material price (enchanted material might not have price data)
        const cityPrice = basePrices.find((p) => p.city === city);
        if (!cityPrice || cityPrice.sellPriceMin === 0) {
          return null;
        }
        const totalCost = cityPrice.sellPriceMin * material.qty;
        materialCosts.push({
          materialId: material.id,
          quantity: material.qty,
          pricePerUnit: cityPrice.sellPriceMin,
          totalCost,
        });
        totalMaterialCost += totalCost;
        continue;
      }

      // Find price for this city
      const cityPrice = prices.find((p) => p.city === city);
      if (!cityPrice || cityPrice.sellPriceMin === 0) {
        return null;
      }

      const totalCost = cityPrice.sellPriceMin * material.qty;
      materialCosts.push({
        materialId,
        quantity: material.qty,
        pricePerUnit: cityPrice.sellPriceMin,
        totalCost,
      });

      totalMaterialCost += totalCost;
    }

    // Calculate effective cost after resource return
    const effectiveCost = totalMaterialCost * (1 - returnRate);

    return {
      materialCosts,
      totalMaterialCost,
      effectiveCost,
      craftingFee: recipe.craftingFee,
      totalCost: effectiveCost + recipe.craftingFee,
    };
  }

  /**
   * Check if a material ID is a refined resource that has enchant variants
   */
  private isRefinedResource(materialId: string): boolean {
    return /_CLOTH$|_LEATHER$|_METALBAR$|_PLANKS$|_STONEBLOCK$/.test(materialId);
  }

  /**
   * Extract item category from item ID for city bonus matching
   * E.g., T4_HEAD_CLOTH_SET1 -> "cloth" (for matching Lymhurst's cloth bonus)
   * E.g., T4_2H_CROSSBOW -> "crossbow" (for matching Bridgewatch's crossbow bonus)
   */
  private getItemCategory(itemId: string): string {
    // Get item name for better category detection
    const itemName = this.itemNames.get(itemId)?.toLowerCase() || itemId.toLowerCase();
    return itemName;
  }

  /**
   * Get top opportunities by profit rank
   */
  getTopOpportunities(
    userStats: UserStats,
    limit: number = 100,
    city?: City
  ): ProfitabilityResult[] {
    let results = this.calculateAll(userStats);

    // Filter by city if specified
    if (city) {
      results = results.filter((r) => r.city === city);
    }

    // Sort by profit rank (descending)
    results.sort((a, b) => b.profitRank - a.profitRank);

    return results.slice(0, limit);
  }

  /**
   * Get top opportunities by ROI
   */
  getTopROI(
    userStats: UserStats,
    limit: number = 100,
    city?: City
  ): ProfitabilityResult[] {
    let results = this.calculateAll(userStats);

    // Filter by city if specified
    if (city) {
      results = results.filter((r) => r.city === city);
    }

    // Sort by ROI (descending)
    results.sort((a, b) => b.roiPercent - a.roiPercent);

    return results.slice(0, limit);
  }

  /**
   * Convert demand trend to numeric value for sorting
   * ↑ (low supply/opportunity) = 3, → (stable) = 2, ↓ (high supply) = 1
   */
  private getDemandTrendScore(trend: TrendIndicator): number {
    switch (trend) {
      case '↑':
        return 3; // Low supply = best opportunity
      case '→':
        return 2; // Stable
      case '↓':
        return 1; // High supply = saturated
      default:
        return 2;
    }
  }

  /**
   * Get top opportunities sorted by profit per day
   * This accounts for how quickly items sell, not just profit per item
   */
  getTopByProfitPerDay(
    userStats: UserStats,
    limit: number = 50,
    city?: City
  ): ProfitabilityResult[] {
    let results = this.calculateAll(userStats);

    // Filter by city if specified
    if (city) {
      results = results.filter((r) => r.city === city);
    }

    // Sort by profit per day (highest first)
    results.sort((a, b) => b.profitPerDay - a.profitPerDay);

    return results.slice(0, limit);
  }
}
