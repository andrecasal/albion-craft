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
   * Calculate resource return rate based on user stats
   */
  calculateReturnRate(userStats: UserStats): number {
    // Base return rate (15.2% without focus, 43.9% with focus)
    let returnRate = userStats.baseReturnRate;

    // Add premium bonus (20%)
    if (userStats.premiumStatus) {
      returnRate += 20;
    }

    // Add specialization bonus (0.2% per level, max 100 levels = 20%)
    const specializationBonus = Math.min(userStats.specializationBonus, 100) * 0.2;
    returnRate += specializationBonus;

    // Return as decimal (e.g., 0.152 for 15.2%)
    return returnRate / 100;
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

    // Calculate return rate
    const returnRate = this.calculateReturnRate(userStats);

    // Calculate material costs
    const craftingCost = this.calculateMaterialCost(recipe, city, returnRate);
    if (!craftingCost) {
      return null;
    }

    // Calculate gross revenue (after market tax)
    const grossRevenue = marketData.lowestSellPrice * (1 - userStats.craftingTaxRate / 100);

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

    for (const [itemId, recipe] of this.recipes) {
      for (const city of cities) {
        const result = this.calculateProfitability(itemId, city, userStats);
        if (result && result.netProfit > 0) {
          // Only include profitable items
          results.push(result);
        }
      }
    }

    return results;
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
   * Get top opportunities sorted by: supply signal, demand, then profit/day
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

    // Sort by: 1) Supply signal (low supply first), 2) Demand (high first), 3) Profit/Day (high first)
    results.sort((a, b) => {
      // 1. Supply signal (demandTrend: ↑ low supply first)
      const supplyDiff = this.getDemandTrendScore(b.demandTrend) - this.getDemandTrendScore(a.demandTrend);
      if (supplyDiff !== 0) return supplyDiff;

      // 2. Demand (higher demand first)
      const demandDiff = b.demandPerDay - a.demandPerDay;
      if (demandDiff !== 0) return demandDiff;

      // 3. Profit per day (tiebreaker)
      return b.profitPerDay - a.profitPerDay;
    });

    return results.slice(0, limit);
  }
}
