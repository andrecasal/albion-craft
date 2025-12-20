// Crafting Recommender Service
// Given available materials in inventory, recommends items to craft ordered by profit/day

import {
  Recipe,
  MaterialPrice,
  MarketData,
  DemandSupplyData,
  UserStats,
  City,
  ProfitabilityResult,
} from '../types';
import { ProfitabilityCalculator } from './profitability-calculator';

// Material inventory for a specific city
export interface MaterialInventory {
  [materialId: string]: number; // materialId -> quantity available
}

// Crafting recommendation result
export interface CraftingRecommendation {
  itemId: string;
  itemName: string;
  city: City;
  quantityToCraft: number;
  materialsUsed: Array<{
    materialId: string;
    materialName: string;
    quantityUsed: number;
  }>;
  profitPerItem: number;
  totalProfit: number;
  profitPerDay: number;
  totalProfitPerDay: number;
  craftingFee: number;
  totalCraftingFee: number;
}

// Material name lookup
interface MaterialInfo {
  id: string;
  name: string;
}

// Load materials from separate category files
const rawMaterials = require('../constants/raw-materials.json') as MaterialInfo[];
const refinedMaterials = require('../constants/refined-materials.json') as MaterialInfo[];
const artifacts = require('../constants/artifacts.json') as MaterialInfo[];
const alchemyDrops = require('../constants/alchemy-drops.json') as MaterialInfo[];
const materialsData: MaterialInfo[] = [...rawMaterials, ...refinedMaterials, ...artifacts, ...alchemyDrops];

export class CraftingRecommender {
  private calculator: ProfitabilityCalculator;
  private recipes: Recipe[];
  private materialNames: Map<string, string>;

  constructor(
    materialPrices: MaterialPrice[],
    marketData: MarketData[],
    recipes: Recipe[],
    demandSupplyData?: DemandSupplyData[]
  ) {
    this.calculator = new ProfitabilityCalculator(
      materialPrices,
      marketData,
      recipes,
      demandSupplyData
    );
    this.recipes = recipes;

    // Build material name lookup
    this.materialNames = new Map();
    materialsData.forEach((m) => {
      this.materialNames.set(m.id, m.name);
    });
  }

  /**
   * Get craftable items from available inventory, sorted by profit/day
   */
  getRecommendations(
    inventory: MaterialInventory,
    city: City,
    userStats: UserStats
  ): CraftingRecommendation[] {
    const recommendations: CraftingRecommendation[] = [];

    // Create a working copy of inventory that we'll deplete as we assign materials
    const availableMaterials = { ...inventory };

    // Get all profitable items for this city
    const allProfitable = this.calculator
      .calculateAll(userStats)
      .filter((r) => r.city === city && r.netProfit > 0);

    // Sort by profit per day (highest first)
    allProfitable.sort((a, b) => b.profitPerDay - a.profitPerDay);

    // For each profitable item, check if we have materials to craft it
    for (const result of allProfitable) {
      const recipe = this.recipes.find((r) => r.itemId === result.itemId);
      if (!recipe) continue;

      // Calculate how many we can craft with available materials
      const maxCraftable = this.calculateMaxCraftable(recipe, availableMaterials);

      if (maxCraftable > 0) {
        // Deduct materials from available inventory
        const materialsUsed = this.deductMaterials(recipe, availableMaterials, maxCraftable);

        recommendations.push({
          itemId: result.itemId,
          itemName: result.itemName,
          city,
          quantityToCraft: maxCraftable,
          materialsUsed,
          profitPerItem: result.netProfit,
          totalProfit: result.netProfit * maxCraftable,
          profitPerDay: result.profitPerDay,
          totalProfitPerDay: result.profitPerDay * maxCraftable,
          craftingFee: recipe.craftingFee,
          totalCraftingFee: recipe.craftingFee * maxCraftable,
        });
      }
    }

    return recommendations;
  }

  /**
   * Calculate the maximum number of items that can be crafted with available materials
   */
  private calculateMaxCraftable(
    recipe: Recipe,
    availableMaterials: MaterialInventory
  ): number {
    const materials = [
      { id: recipe.material1, qty: recipe.mat1Qty },
      { id: recipe.material2, qty: recipe.mat2Qty },
      { id: recipe.material3, qty: recipe.mat3Qty },
      { id: recipe.material4, qty: recipe.mat4Qty },
    ].filter((m) => m.id && m.id.trim() !== '' && m.qty > 0);

    if (materials.length === 0) return 0;

    // Find the limiting material (the one that allows fewest crafts)
    let maxCraftable = Infinity;

    for (const material of materials) {
      const available = availableMaterials[material.id] || 0;
      const canCraft = Math.floor(available / material.qty);
      maxCraftable = Math.min(maxCraftable, canCraft);
    }

    return maxCraftable === Infinity ? 0 : maxCraftable;
  }

  /**
   * Deduct materials from inventory and return what was used
   */
  private deductMaterials(
    recipe: Recipe,
    availableMaterials: MaterialInventory,
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
      const quantityUsed = material.qty * quantity;
      availableMaterials[material.id] = (availableMaterials[material.id] || 0) - quantityUsed;

      used.push({
        materialId: material.id,
        materialName: this.materialNames.get(material.id) || material.id,
        quantityUsed,
      });
    }

    return used;
  }

  /**
   * Get a summary of total profits from recommendations
   */
  getSummary(recommendations: CraftingRecommendation[]): {
    totalItems: number;
    totalProfit: number;
    totalCraftingFee: number;
    netProfit: number;
  } {
    const totalItems = recommendations.reduce((sum, r) => sum + r.quantityToCraft, 0);
    const totalProfit = recommendations.reduce((sum, r) => sum + r.totalProfit, 0);
    const totalCraftingFee = recommendations.reduce((sum, r) => sum + r.totalCraftingFee, 0);

    return {
      totalItems,
      totalProfit,
      totalCraftingFee,
      netProfit: totalProfit, // Crafting fee is already deducted in profitability calc
    };
  }
}
