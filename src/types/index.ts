// Type definitions for Albion Craft

export type City =
  | 'Caerleon'
  | 'Bridgewatch'
  | 'Fort Sterling'
  | 'Lymhurst'
  | 'Martlock'
  | 'Thetford'
  | 'Brecilien';

export type SupplySignal = '🟢 Rising' | '🟡 Stable' | '🔴 Falling';

export interface Recipe {
  itemId: string;
  material1: string;
  mat1Qty: number;
  material2: string;
  mat2Qty: number;
  material3: string;
  mat3Qty: number;
  material4: string;
  mat4Qty: number;
  craftingFee: number;
  focusCost: number;
}

export interface MaterialPrice {
  materialId: string;
  city: City;
  sellPriceMin: number;
  buyPriceMax: number;
  lastUpdated: string;
}

export interface MarketData {
  itemId: string;
  city: City;
  dailyDemand: number;
  lowestSellPrice: number;
  price7dAvg: number;
  dataAgeHours: number;
  confidence: number;
  availableCapacity: number;
  priceTrendPct: number;
  supplySignal: SupplySignal;
  marketSignal: string;
}

// Demand/supply data from charts endpoint (more accurate demand data)
export interface DemandSupplyData {
  itemId: string;
  city: City;
  dailyDemand: number;
  supplySignal: SupplySignal;
  price7dAvg: number;
  priceTrendPct: number;
  dataAgeHours: number;
}

// Daily bonus categories for refining (10% bonus)
export type RefiningCategory =
  | 'Ore'      // Metal bars
  | 'Wood'     // Planks
  | 'Hide'     // Leather
  | 'Fiber'    // Cloth
  | 'Stone';   // Stone blocks

// Daily bonus categories for crafting (20% bonus)
export type CraftingCategory =
  | 'Plate Armor'
  | 'Plate Helmet'
  | 'Plate Shoes'
  | 'Leather Armor'
  | 'Leather Helmet'
  | 'Leather Shoes'
  | 'Cloth Armor'
  | 'Cloth Helmet'
  | 'Cloth Shoes'
  | 'Sword'
  | 'Axe'
  | 'Mace'
  | 'Hammer'
  | 'Crossbow'
  | 'Bow'
  | 'Spear'
  | 'Dagger'
  | 'Quarterstaff'
  | 'Fire Staff'
  | 'Holy Staff'
  | 'Arcane Staff'
  | 'Froststaff'
  | 'Cursed Staff'
  | 'Nature Staff'
  | 'Off-hand'
  | 'Shield'
  | 'Cape'
  | 'Bag'
  | 'Tool'
  | 'Gathering Gear'
  | 'Mount'
  | 'Food'
  | 'Potion';

// Individual crafting bonus entry (category + percentage)
export interface CraftingBonusEntry {
  category: CraftingCategory;
  percentage: 10 | 20;  // Either +10% or +20%
}

// Daily bonus configuration
export interface DailyBonus {
  refiningCategory: RefiningCategory | null;  // 10% bonus for refining this material
  craftingCategory: CraftingCategory | null;  // DEPRECATED: Use craftingBonuses instead
  craftingBonuses: CraftingBonusEntry[];      // Up to 2 crafting bonuses with their percentages
}

export interface UserStats {
  premiumStatus: boolean;
  useFocus: boolean;
  dailyBonus: DailyBonus;  // Categories with active daily bonus
  targetDaysOfSupply: number;  // How many days of demand to craft for (default: 3)
}

// Calculated values derived from UserStats and game constants
export interface CalculatedStats {
  salesTaxPercent: number;      // 4% with premium, 8% without
  listingFeePercent: number;    // 2.5% always
  totalMarketFeePercent: number; // salesTax + listingFee
  baseProductionBonus: number;  // 18% base
  focusBonus: number;           // 59% if using focus
}

export interface CraftingCost {
  materialCosts: {
    materialId: string;
    quantity: number;
    pricePerUnit: number;
    totalCost: number;
  }[];
  totalMaterialCost: number;
  effectiveCost: number;  // After return rate
  craftingFee: number;
  totalCost: number;
}

export type TrendIndicator = '↑' | '→' | '↓';
export type MarketCondition = '🟢 Hot' | '🟡 Stable' | '🔴 Dying';

export interface ProfitabilityResult {
  itemId: string;
  itemName: string;
  city: City;
  recipe: Recipe;
  marketData: MarketData;
  craftingCost: CraftingCost;

  // Profitability metrics
  returnRate: number;
  grossRevenue: number;  // After market tax
  netProfit: number;
  roiPercent: number;
  profitRank: number;  // Weighted by demand & supply signal

  // Phase 2 metrics
  demandPerDay: number;      // Daily market demand
  demandTrend: TrendIndicator;  // ↑ Rising / → Stable / ↓ Falling
  priceTrend: TrendIndicator;   // ↑ Rising / → Stable / ↓ Falling
  priceTrendPct: number;     // Price trend as percentage
  marketCondition: MarketCondition;  // 🟢 Hot / 🟡 Stable / 🔴 Dying
  sellsInDays: number;       // Estimated days to sell
  liquidityRisk: 'Low' | 'Medium' | 'High';  // Risk indicator
  profitPerDay: number;      // Expected daily profit (PRIMARY SORT)

  // Metadata
  calculatedAt: Date;
}

export interface OpportunityReport {
  city: City;
  opportunities: ProfitabilityResult[];
  totalOpportunities: number;
  avgROI: number;
  topItem: string;
  generatedAt: Date;
}

// Game Constants Types
export interface CityBonuses {
  farming: string[];      // Array of item names with farming bonus (10%)
  refining: string[];     // Array of materials with refining bonus (40%)
  butchering: string[];   // Array of items with butchering bonus (10%)
  crafting: string[];     // Array of items with crafting bonus (15%)
}

export interface ReturnRates {
  bonuses: {
    base: number;
    focus: number;
    farming: number;
    refining: number;
    butchering: number;
    crafting: number;
  };
  cityBonuses: Record<City, CityBonuses>;
}

export interface Taxes {
  salesTax: {
    withoutPremium: number;
    withPremium: number;
  };
  listingFee: number;
}
