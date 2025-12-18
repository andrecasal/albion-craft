#!/usr/bin/env node
// CLI Application for Albion Craft Profitability Analysis

import { DataLoader } from './services/data-loader';
import { ProfitabilityCalculator } from './services/profitability-calculator';
import { ReportGenerator } from './services/report-generator';
import { UserStats } from './types';

// Default user stats (can be customized via config file)
const DEFAULT_USER_STATS: UserStats = {
  premiumStatus: true,
  baseReturnRate: 43.9, // With focus
  useFocus: true,
  specializationBonus: 0, // 0-100
  craftingTaxRate: 3.5,
};

async function main() {
  console.log('========================================');
  console.log('ALBION CRAFT PROFITABILITY ANALYZER');
  console.log('========================================\n');

  // Step 1: Check data files
  console.log('Step 1: Checking data files...');
  const loader = new DataLoader();
  const dataStatus = loader.checkDataFiles();

  console.log(`  Recipes: ${dataStatus.recipes ? '✓' : '❌'}`);
  console.log(`  Material Prices: ${dataStatus.materialPrices ? '✓' : '❌'}`);
  console.log(`  Market Data: ${dataStatus.marketData ? '✓' : '❌'}\n`);

  if (!dataStatus.recipes) {
    console.error('❌ recipes.json not found. Please ensure recipes data exists.');
    process.exit(1);
  }

  if (!dataStatus.materialPrices) {
    console.error('❌ material-prices.json not found.');
    console.error('Run: npm run fetch-material-prices');
    process.exit(1);
  }

  if (!dataStatus.marketData) {
    console.error('❌ market-data.json not found.');
    console.error('Please export market data from Google Sheets or create a market data fetcher.');
    process.exit(1);
  }

  // Step 2: Load data
  console.log('Step 2: Loading data...');
  const recipes = loader.loadRecipes();
  console.log(`  Loaded ${recipes.length} recipes`);

  const materialPrices = loader.loadMaterialPrices();
  console.log(`  Loaded ${materialPrices.length} material prices`);

  const marketData = loader.loadMarketData();
  console.log(`  Loaded ${marketData.length} market data records\n`);

  // Step 3: Initialize calculator
  console.log('Step 3: Initializing profitability calculator...');
  const calculator = new ProfitabilityCalculator(materialPrices, marketData, recipes);
  console.log('  ✓ Calculator initialized\n');

  // Step 4: Calculate profitability
  console.log('Step 4: Calculating profitability...');
  console.log('  User stats:');
  console.log(`    Premium: ${DEFAULT_USER_STATS.premiumStatus ? 'Yes' : 'No'}`);
  console.log(`    Base Return Rate: ${DEFAULT_USER_STATS.baseReturnRate}%`);
  console.log(`    Use Focus: ${DEFAULT_USER_STATS.useFocus ? 'Yes' : 'No'}`);
  console.log(`    Specialization Bonus: ${DEFAULT_USER_STATS.specializationBonus}`);
  console.log(`    Crafting Tax Rate: ${DEFAULT_USER_STATS.craftingTaxRate}%\n`);

  const startTime = Date.now();
  const results = calculator.calculateAll(DEFAULT_USER_STATS);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`  ✓ Calculated ${results.length} profitable opportunities in ${elapsed}s\n`);

  // Step 5: Generate reports
  console.log('Step 5: Generating reports...');
  const reportGen = new ReportGenerator('./reports');

  reportGen.generateSummaryReport(results, 100);
  reportGen.generateCityReports(results);

  // Print summary
  reportGen.printSummary(results);

  console.log('✅ Analysis complete! Check the ./reports directory for detailed results.\n');
}

// Run CLI
main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
