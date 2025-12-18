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

export interface UserStats {
  premiumStatus: boolean;
  baseReturnRate: number;  // 15.2% without focus, 43.9% with focus
  useFocus: boolean;
  specializationBonus: number;  // 0-100
  craftingTaxRate: number;  // Default 3.5%
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
