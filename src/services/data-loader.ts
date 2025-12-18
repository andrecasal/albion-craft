// Data Loading Service

import * as fs from 'fs';
import * as path from 'path';
import { Recipe, MaterialPrice, MarketData, ReturnRates, Taxes } from '../types';

export class DataLoader {
  private dataDir: string;

  constructor(dataDir: string = process.cwd()) {
    this.dataDir = dataDir;
  }

  /**
   * Load recipes from src/constants/recipes.json
   */
  loadRecipes(): Recipe[] {
    const recipesPath = path.join(__dirname, '../constants/recipes.json');
    if (!fs.existsSync(recipesPath)) {
      throw new Error(`Recipes file not found: ${recipesPath}`);
    }

    const data = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));
    return data as Recipe[];
  }

  /**
   * Load material prices from src/db/material-prices.json
   */
  loadMaterialPrices(): MaterialPrice[] {
    const pricesPath = path.join(this.dataDir, 'src', 'db', 'material-prices.json');
    if (!fs.existsSync(pricesPath)) {
      throw new Error(
        `Material prices file not found: ${pricesPath}\n` +
        'Run the CLI and select "Refresh market data" to fetch material prices.'
      );
    }

    const data = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
    return data as MaterialPrice[];
  }

  /**
   * Load market data from src/db/market-data.json
   */
  loadMarketData(): MarketData[] {
    const marketDataPath = path.join(this.dataDir, 'src', 'db', 'market-data.json');
    if (!fs.existsSync(marketDataPath)) {
      throw new Error(
        `Market data file not found: ${marketDataPath}\n` +
        'Run the CLI and select "Refresh market data" to fetch market data.'
      );
    }

    const data = JSON.parse(fs.readFileSync(marketDataPath, 'utf8'));
    return data as MarketData[];
  }

  /**
   * Load return rates from src/constants/return-rates.json
   */
  loadReturnRates(): ReturnRates {
    const returnRatesPath = path.join(__dirname, '../constants/return-rates.json');
    if (!fs.existsSync(returnRatesPath)) {
      throw new Error(`Return rates file not found: ${returnRatesPath}`);
    }

    const data = JSON.parse(fs.readFileSync(returnRatesPath, 'utf8'));
    return data as ReturnRates;
  }

  /**
   * Load taxes from src/constants/taxes.json
   */
  loadTaxes(): Taxes {
    const taxesPath = path.join(__dirname, '../constants/taxes.json');
    if (!fs.existsSync(taxesPath)) {
      throw new Error(`Taxes file not found: ${taxesPath}`);
    }

    const data = JSON.parse(fs.readFileSync(taxesPath, 'utf8'));
    return data as Taxes;
  }

  /**
   * Check if all required data files exist
   */
  checkDataFiles(): {
    recipes: boolean;
    materialPrices: boolean;
    marketData: boolean;
    returnRates: boolean;
    taxes: boolean;
  } {
    return {
      recipes: fs.existsSync(path.join(__dirname, '../constants/recipes.json')),
      materialPrices: fs.existsSync(path.join(this.dataDir, 'src', 'db', 'material-prices.json')),
      marketData: fs.existsSync(path.join(this.dataDir, 'src', 'db', 'market-data.json')),
      returnRates: fs.existsSync(path.join(__dirname, '../constants/return-rates.json')),
      taxes: fs.existsSync(path.join(__dirname, '../constants/taxes.json')),
    };
  }
}
