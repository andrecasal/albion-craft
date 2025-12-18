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

export interface ProfitabilityResult {
  itemId: string;
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
