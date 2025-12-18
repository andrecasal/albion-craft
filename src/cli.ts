#!/usr/bin/env node
// CLI Application for Albion Craft Profitability Analysis

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { DataLoader } from './services/data-loader';
import { ProfitabilityCalculator } from './services/profitability-calculator';
import { fetchAllMaterialPrices } from './services/material-prices-fetcher';
import { fetchAllMarketData } from './services/market-data-fetcher';
import { UserStats, City, ProfitabilityResult } from './types';

// Default user stats (can be customized via config file)
const DEFAULT_USER_STATS: UserStats = {
  premiumStatus: true,
  baseReturnRate: 43.9, // With focus
  useFocus: true,
  specializationBonus: 0, // 0-100
  craftingTaxRate: 3.5,
};

// Cities for selection
const CITIES: City[] = [
  'Caerleon',
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
];

// Get data freshness indicator
function getDataFreshnessIndicator(): string {
  const marketDataPath = path.join(process.cwd(), 'src', 'db', 'market-data.json');

  if (!fs.existsSync(marketDataPath)) {
    return '⚫ Never'; // No data
  }

  const stats = fs.statSync(marketDataPath);
  const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

  if (ageHours < 6) {
    return `🟢 ${Math.floor(ageHours)}h ago`; // Fresh (< 6 hours)
  } else if (ageHours < 24) {
    return `🟡 ${Math.floor(ageHours)}h ago`; // Getting old (6-24 hours)
  } else {
    const days = Math.floor(ageHours / 24);
    return `🔴 ${days}d ago`; // Stale (> 24 hours)
  }
}

// Interactive menu
async function showMenu(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const dataFreshness = getDataFreshnessIndicator();

  return new Promise((resolve) => {
    console.log('\n========================================');
    console.log('ALBION CRAFT PROFITABILITY ANALYZER');
    console.log('========================================');
    console.log(`1. Refresh market data ${dataFreshness}`);
    console.log('2. Run full profitability analysis');
    console.log('3. View opportunities by city');
    console.log('4. Exit');
    console.log('========================================');

    rl.question('Choose an option (1-4): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Run full analysis
async function runFullAnalysis() {
  console.log('\n--- RUNNING FULL PROFITABILITY ANALYSIS ---\n');

  // Step 1: Check data files
  console.log('Step 1: Checking data files...');
  const loader = new DataLoader();
  const dataStatus = loader.checkDataFiles();

  console.log(`  Recipes: ${dataStatus.recipes ? '✓' : '❌'}`);
  console.log(`  Material Prices: ${dataStatus.materialPrices ? '✓' : '❌'}`);
  console.log(`  Market Data: ${dataStatus.marketData ? '✓' : '❌'}\n`);

  if (!dataStatus.recipes) {
    console.error('❌ recipes.json not found. Please ensure recipes data exists.');
    return;
  }

  if (!dataStatus.materialPrices) {
    console.error('❌ material-prices.json not found.');
    console.error('Select "Refresh market data" from the main menu to fetch prices.');
    return;
  }

  if (!dataStatus.marketData) {
    console.error('❌ market-data.json not found.');
    console.error('Select "Refresh market data" from the main menu to fetch market data.');
    return;
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

  // Step 5: Display summary
  console.log('Step 5: Summary...');
  printSummary(results);

  console.log('\n✅ Analysis complete!\n');
}

// Print profitability summary
function printSummary(results: ProfitabilityResult[]) {
  if (results.length === 0) {
    console.log('No profitable opportunities found.');
    return;
  }

  // Sort by profit rank
  const sorted = [...results].sort((a, b) => b.profitRank - a.profitRank);

  console.log('\n=== TOP 20 OPPORTUNITIES ===\n');
  console.log('Rank | Item ID                | City            | Net Profit | ROI%  | Daily Demand');
  console.log('-----|------------------------|-----------------|------------|-------|-------------');

  sorted.slice(0, 20).forEach((result, index) => {
    console.log(
      `${(index + 1).toString().padStart(4)} | ${result.itemId.padEnd(22)} | ${result.city.padEnd(15)} | ${result.netProfit.toFixed(0).padStart(10)} | ${result.roiPercent.toFixed(1).padStart(5)} | ${result.marketData.dailyDemand.toFixed(0).padStart(12)}`
    );
  });

  // Summary by city
  console.log('\n=== OPPORTUNITIES BY CITY ===\n');
  CITIES.forEach((city) => {
    const cityResults = results.filter((r) => r.city === city);
    const totalProfit = cityResults.reduce((sum, r) => sum + r.netProfit, 0);
    const avgROI =
      cityResults.length > 0 ? cityResults.reduce((sum, r) => sum + r.roiPercent, 0) / cityResults.length : 0;

    console.log(
      `${city.padEnd(15)} | ${cityResults.length.toString().padStart(3)} opportunities | Avg Profit: ${totalProfit.toFixed(0).padStart(8)} | Avg ROI: ${avgROI.toFixed(1).padStart(5)}%`
    );
  });
}

// Refresh market data
async function refreshMarketData() {
  console.log('\n--- REFRESHING MARKET DATA ---\n');
  console.log('Fetching both material prices and market data...\n');

  try {
    console.log('Step 1/2: Fetching material prices...');
    await fetchAllMaterialPrices();
    console.log('✓ Material prices updated\n');

    console.log('Step 2/2: Fetching market data...');
    await fetchAllMarketData();
    console.log('✓ Market data updated\n');

    console.log('✅ Market data refresh complete!\n');
  } catch (error) {
    console.error('❌ Error refreshing market data:', error);
  }
}

// View opportunities by city
async function viewOpportunitiesByCity() {
  console.log('\n--- VIEWING OPPORTUNITIES BY CITY ---\n');

  // First check if data exists
  const loader = new DataLoader();
  const dataStatus = loader.checkDataFiles();

  if (!dataStatus.recipes || !dataStatus.materialPrices || !dataStatus.marketData) {
    console.error('❌ Required data files not found. Please run full analysis first.');
    return;
  }

  // Load data
  const recipes = loader.loadRecipes();
  const materialPrices = loader.loadMaterialPrices();
  const marketData = loader.loadMarketData();

  const calculator = new ProfitabilityCalculator(materialPrices, marketData, recipes);
  const results = calculator.calculateAll(DEFAULT_USER_STATS);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<void>((resolve) => {
    console.log('Available cities:');
    CITIES.forEach((city, index) => {
      console.log(`${index + 1}. ${city}`);
    });
    console.log(`${CITIES.length + 1}. All cities`);

    rl.question(`Choose a city (1-${CITIES.length + 1}): `, (answer) => {
      rl.close();

      const choice = parseInt(answer.trim());
      if (choice >= 1 && choice <= CITIES.length) {
        const selectedCity = CITIES[choice - 1];
        showCityOpportunities(results, selectedCity);
      } else if (choice === CITIES.length + 1) {
        showAllCitiesOpportunities(results);
      } else {
        console.log('Invalid choice.');
      }

      resolve();
    });
  });
}

// Show opportunities for a specific city
function showCityOpportunities(results: any[], city: City) {
  const cityResults = results.filter((r) => r.city === city);

  console.log(`\n=== OPPORTUNITIES IN ${city.toUpperCase()} ===`);
  console.log(`Total opportunities: ${cityResults.length}`);

  if (cityResults.length === 0) {
    console.log('No profitable opportunities found in this city.');
    return;
  }

  // Sort by profit rank
  cityResults.sort((a, b) => b.profitRank - a.profitRank);

  console.log('\nTop 10 opportunities:');
  console.log('Rank | Item ID | Profit | ROI% | Daily Demand');
  console.log('-----|---------|--------|------|-------------');

  cityResults.slice(0, 10).forEach((result, index) => {
    console.log(
      `${(index + 1).toString().padStart(4)} | ${result.itemId.padEnd(7)} | ${result.netProfit.toFixed(0).padStart(6)} | ${result.roiPercent.toFixed(1).padStart(4)} | ${result.marketData.dailyDemand.toFixed(0).padStart(12)}`
    );
  });

  console.log('\n💡 Full reports are available in the ./reports directory');
}

// Show opportunities summary for all cities
function showAllCitiesOpportunities(results: any[]) {
  console.log('\n=== OPPORTUNITIES SUMMARY BY CITY ===');

  CITIES.forEach((city) => {
    const cityResults = results.filter((r) => r.city === city);
    const totalProfit = cityResults.reduce((sum, r) => sum + r.netProfit, 0);
    const avgROI = cityResults.length > 0
      ? cityResults.reduce((sum, r) => sum + r.roiPercent, 0) / cityResults.length
      : 0;

    console.log(`${city.padEnd(15)} | ${cityResults.length.toString().padStart(3)} opportunities | Avg Profit: ${totalProfit.toFixed(0).padStart(6)} | Avg ROI: ${avgROI.toFixed(1).padStart(5)}%`);
  });

  console.log('\n💡 Run full analysis to generate detailed CSV reports for each city');
}

async function main() {
  console.log('Welcome to the Albion Craft Profitability Analyzer!');

  let running = true;

  while (running) {
    const choice = await showMenu();

    switch (choice) {
      case '1':
        await refreshMarketData();
        break;
      case '2':
        await runFullAnalysis();
        break;
      case '3':
        await viewOpportunitiesByCity();
        break;
      case '4':
        console.log('\nGoodbye! 👋\n');
        running = false;
        break;
      default:
        console.log('\n❌ Invalid option. Please choose 1-4.\n');
    }
  }
}

// Run CLI
main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
