// Profitability Calculation Engine

import {
  Recipe,
  MaterialPrice,
  MarketData,
  UserStats,
  CraftingCost,
  ProfitabilityResult,
  City,
  SupplySignal,
} from '../types';

export class ProfitabilityCalculator {
  private materialPrices: Map<string, MaterialPrice[]>;
  private marketData: Map<string, MarketData[]>;
  private recipes: Map<string, Recipe>;

  constructor(
    materialPrices: MaterialPrice[],
    marketData: MarketData[],
    recipes: Recipe[]
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

    // Index recipes by item ID
    this.recipes = new Map();
    recipes.forEach((recipe) => {
      this.recipes.set(recipe.itemId, recipe);
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

    // Calculate profit rank (weighted by demand & supply signal)
    const supplyMultiplier = this.getSupplyMultiplier(marketData.supplySignal);
    const profitRank = (netProfit * marketData.dailyDemand * supplyMultiplier) / 1000;

    return {
      itemId,
      city,
      recipe,
      marketData,
      craftingCost,
      returnRate,
      grossRevenue,
      netProfit,
      roiPercent,
      profitRank,
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
}
