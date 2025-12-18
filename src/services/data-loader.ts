// Data Loading Service

import * as fs from 'fs';
import * as path from 'path';
import { Recipe, MaterialPrice, MarketData } from '../types';

export class DataLoader {
  private dataDir: string;

  constructor(dataDir: string = process.cwd()) {
    this.dataDir = dataDir;
  }

  /**
   * Load recipes from recipes.json
   */
  loadRecipes(): Recipe[] {
    const recipesPath = path.join(this.dataDir, 'recipes.json');
    if (!fs.existsSync(recipesPath)) {
      throw new Error(`Recipes file not found: ${recipesPath}`);
    }

    const data = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
    return data as Recipe[];
  }

  /**
   * Load material prices from material-prices.json
   */
  loadMaterialPrices(): MaterialPrice[] {
    const pricesPath = path.join(this.dataDir, 'material-prices.json');
    if (!fs.existsSync(pricesPath)) {
      throw new Error(
        `Material prices file not found: ${pricesPath}\n` +
        'Run "npm run fetch-material-prices" to fetch material prices first.'
      );
    }

    const data = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
    return data as MaterialPrice[];
  }

  /**
   * Load market data from market-data.json
   * Note: You'll need to export this from Google Sheets or create a fetcher
   */
  loadMarketData(): MarketData[] {
    const marketDataPath = path.join(this.dataDir, 'market-data.json');
    if (!fs.existsSync(marketDataPath)) {
      throw new Error(
        `Market data file not found: ${marketDataPath}\n` +
        'Please export market data from Google Sheets or run market data fetcher.'
      );
    }

    const data = JSON.parse(fs.readFileSync(marketDataPath, 'utf8'));
    return data as MarketData[];
  }

  /**
   * Check if all required data files exist
   */
  checkDataFiles(): { recipes: boolean; materialPrices: boolean; marketData: boolean } {
    return {
      recipes: fs.existsSync(path.join(this.dataDir, 'recipes.json')),
      materialPrices: fs.existsSync(path.join(this.dataDir, 'material-prices.json')),
      marketData: fs.existsSync(path.join(this.dataDir, 'market-data.json')),
    };
  }
}
