// Market Analysis Service
// Analyzes market data to determine demand and supply conditions

import { MarketData, City } from '../types';

export interface DemandAnalysis {
  itemId: string;
  city: City;
  dailyDemand: number;
  targetQuantity: number;  // Based on target days of supply
  supplySignal: string;
  marketSignal: string;
  confidence: number;
  isViableMarket: boolean;  // Whether market is worth entering
}

export interface MarketAnalyzerConfig {
  targetDaysOfSupply: number;  // How many days of supply to craft for
  minDailyDemand: number;      // Minimum daily demand to consider viable
  minConfidence: number;        // Minimum confidence score (0-100)
  excludeFallingSupply: boolean; // Exclude items with falling supply signal
}

export class MarketAnalyzer {
  private config: MarketAnalyzerConfig;

  constructor(config: Partial<MarketAnalyzerConfig> = {}) {
    this.config = {
      targetDaysOfSupply: config.targetDaysOfSupply ?? 3,
      minDailyDemand: config.minDailyDemand ?? 5,
      minConfidence: config.minConfidence ?? 60,
      excludeFallingSupply: config.excludeFallingSupply ?? true
    };
  }

  /**
   * Analyze market data to determine viable crafting opportunities
   */
  analyzeDemand(marketData: MarketData[]): DemandAnalysis[] {
    return marketData.map(data => this.analyzeSingleMarket(data));
  }

  /**
   * Filter market data to only include viable markets
   */
  filterViableMarkets(analysis: DemandAnalysis[]): DemandAnalysis[] {
    return analysis.filter(a => a.isViableMarket);
  }

  /**
   * Get top opportunities by city
   */
  getTopOpportunitiesByCity(
    analysis: DemandAnalysis[],
    city: City,
    limit: number = 50
  ): DemandAnalysis[] {
    return analysis
      .filter(a => a.city === city && a.isViableMarket)
      .sort((a, b) => {
        // Sort by demand weighted by confidence
        const scoreA = a.dailyDemand * (a.confidence / 100);
        const scoreB = b.dailyDemand * (b.confidence / 100);
        return scoreB - scoreA;
      })
      .slice(0, limit);
  }

  /**
   * Calculate total market opportunity for a specific item across all cities
   */
  calculateTotalDemand(analysis: DemandAnalysis[], itemId: string): number {
    return analysis
      .filter(a => a.itemId === itemId && a.isViableMarket)
      .reduce((sum, a) => sum + a.dailyDemand, 0);
  }

  /**
   * Find best city for a specific item
   */
  findBestCityForItem(analysis: DemandAnalysis[], itemId: string): DemandAnalysis | null {
    const itemAnalyses = analysis.filter(a => a.itemId === itemId && a.isViableMarket);

    if (itemAnalyses.length === 0) return null;

    // Find city with highest demand and good supply signal
    return itemAnalyses.reduce((best, current) => {
      const bestScore = best.dailyDemand * (best.confidence / 100);
      const currentScore = current.dailyDemand * (current.confidence / 100);
      return currentScore > bestScore ? current : best;
    });
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MarketAnalyzerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): MarketAnalyzerConfig {
    return { ...this.config };
  }

  /**
   * Analyze a single market data point
   */
  private analyzeSingleMarket(data: MarketData): DemandAnalysis {
    const targetQuantity = Math.round(data.dailyDemand * this.config.targetDaysOfSupply);

    // Determine if market is viable based on config
    const isViableMarket = this.isMarketViable(data);

    return {
      itemId: data.itemId,
      city: data.city,
      dailyDemand: data.dailyDemand,
      targetQuantity,
      supplySignal: data.supplySignal,
      marketSignal: data.marketSignal,
      confidence: data.confidence,
      isViableMarket
    };
  }

  /**
   * Determine if a market is viable based on configuration
   */
  private isMarketViable(data: MarketData): boolean {
    // Check minimum demand
    if (data.dailyDemand < this.config.minDailyDemand) {
      return false;
    }

    // Check confidence
    if (data.confidence < this.config.minConfidence) {
      return false;
    }

    // Check supply signal if configured to exclude falling supply
    if (this.config.excludeFallingSupply && data.supplySignal === '🔴 Falling') {
      return false;
    }

    // Check if price is valid
    if (data.lowestSellPrice <= 0) {
      return false;
    }

    return true;
  }

  /**
   * Generate market summary statistics
   */
  generateSummary(analysis: DemandAnalysis[]): {
    totalMarkets: number;
    viableMarkets: number;
    averageDemand: number;
    averageConfidence: number;
    supplySignalDistribution: {
      rising: number;
      stable: number;
      falling: number;
    };
    marketsByCity: Record<City, number>;
  } {
    const viable = analysis.filter(a => a.isViableMarket);

    const summary = {
      totalMarkets: analysis.length,
      viableMarkets: viable.length,
      averageDemand: viable.length > 0
        ? Math.round(viable.reduce((sum, a) => sum + a.dailyDemand, 0) / viable.length)
        : 0,
      averageConfidence: viable.length > 0
        ? Math.round(viable.reduce((sum, a) => sum + a.confidence, 0) / viable.length)
        : 0,
      supplySignalDistribution: {
        rising: analysis.filter(a => a.supplySignal.includes('Rising')).length,
        stable: analysis.filter(a => a.supplySignal.includes('Stable')).length,
        falling: analysis.filter(a => a.supplySignal.includes('Falling')).length
      },
      marketsByCity: {} as Record<City, number>
    };

    // Count viable markets by city
    const cities: City[] = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];
    cities.forEach(city => {
      summary.marketsByCity[city] = viable.filter(a => a.city === city).length;
    });

    return summary;
  }
}

/**
 * Helper function to create a market analyzer with common configurations
 */
export function createMarketAnalyzer(preset: 'conservative' | 'balanced' | 'aggressive'): MarketAnalyzer {
  const configs = {
    conservative: {
      targetDaysOfSupply: 3,
      minDailyDemand: 10,
      minConfidence: 80,
      excludeFallingSupply: true
    },
    balanced: {
      targetDaysOfSupply: 5,
      minDailyDemand: 5,
      minConfidence: 60,
      excludeFallingSupply: true
    },
    aggressive: {
      targetDaysOfSupply: 7,
      minDailyDemand: 2,
      minConfidence: 40,
      excludeFallingSupply: false
    }
  };

  return new MarketAnalyzer(configs[preset]);
}
