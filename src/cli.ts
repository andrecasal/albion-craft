#!/usr/bin/env node
// CLI Application for Albion Craft Profitability Analysis

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { DataLoader } from './services/data-loader';
import { ProfitabilityCalculator } from './services/profitability-calculator';
import { fetchAllMaterialPrices } from './services/material-prices-fetcher';
import { fetchAllMarketData, fetchDemandSupplyData, DemandSupplyData } from './services/market-data-fetcher';
import { UserStats, City } from './types';

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

// Get data freshness indicator for demand/supply data
function getDemandSupplyFreshnessIndicator(): string {
  const demandSupplyPath = path.join(process.cwd(), 'src', 'db', 'demand-supply.json');

  if (!fs.existsSync(demandSupplyPath)) {
    return '⚫ Never';
  }

  const stats = fs.statSync(demandSupplyPath);
  const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

  if (ageHours < 6) {
    return `🟢 ${Math.floor(ageHours)}h ago`;
  } else if (ageHours < 24) {
    return `🟡 ${Math.floor(ageHours)}h ago`;
  } else {
    const days = Math.floor(ageHours / 24);
    return `🔴 ${days}d ago`;
  }
}

// Get data freshness indicator for full market data
function getMarketDataFreshnessIndicator(): string {
  const marketDataPath = path.join(process.cwd(), 'src', 'db', 'market-data.json');

  if (!fs.existsSync(marketDataPath)) {
    return '⚫ Never';
  }

  const stats = fs.statSync(marketDataPath);
  const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

  if (ageHours < 6) {
    return `🟢 ${Math.floor(ageHours)}h ago`;
  } else if (ageHours < 24) {
    return `🟡 ${Math.floor(ageHours)}h ago`;
  } else {
    const days = Math.floor(ageHours / 24);
    return `🔴 ${days}d ago`;
  }
}

// Interactive menu
async function showMenu(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const demandSupplyFreshness = getDemandSupplyFreshnessIndicator();
  const marketDataFreshness = getMarketDataFreshnessIndicator();

  return new Promise((resolve) => {
    console.log('\n========================================');
    console.log('ALBION CRAFT PROFITABILITY ANALYZER');
    console.log('========================================');
    console.log(`1. Refresh market demand + supply ${demandSupplyFreshness}`);
    console.log('2. View high demand / low supply items');
    console.log(`3. Fetch profitability data ${marketDataFreshness}`);
    console.log('4. Show best opportunities by city');
    console.log('5. Exit');
    console.log('========================================');

    rl.question('Choose an option (1-5): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Refresh demand + supply data only (charts endpoint)
async function refreshDemandSupply() {
  try {
    await fetchDemandSupplyData();
    console.log('✅ Demand & supply data refresh complete!\n');
  } catch (error) {
    console.error('❌ Error refreshing demand/supply data:', error);
  }
}

// Format number with K/M suffix for compact display
function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toFixed(0);
}

// Truncate string to max length with ellipsis
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str.padEnd(maxLen);
  return str.substring(0, maxLen - 1) + '…';
}

// Format percentage with sign
function formatPercent(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// Show best opportunities by city with formatted table
async function showBestOpportunities() {
  console.log('\n--- BEST OPPORTUNITIES BY CITY ---\n');

  // Check data files
  const loader = new DataLoader();
  const dataStatus = loader.checkDataFiles();

  if (!dataStatus.recipes || !dataStatus.materialPrices || !dataStatus.marketData) {
    console.error('❌ Required data files not found.');
    console.error('Please run "Fetch profitability data" (option 3) first.\n');
    return;
  }

  if (!dataStatus.demandSupply) {
    console.error('❌ Demand/supply data not found.');
    console.error('Please run "Refresh market demand + supply" (option 1) first.\n');
    return;
  }

  // Load data
  console.log('Loading data...');
  const recipes = loader.loadRecipes();
  const materialPrices = loader.loadMaterialPrices();
  const marketData = loader.loadMarketData();
  const demandSupplyData = loader.loadDemandSupplyData();

  const calculator = new ProfitabilityCalculator(materialPrices, marketData, recipes, demandSupplyData);

  // Let user select city
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<void>((resolve) => {
    console.log('\nSelect a city:');
    CITIES.forEach((city, index) => {
      console.log(`${index + 1}. ${city}`);
    });
    console.log(`${CITIES.length + 1}. All cities (combined)`);

    rl.question(`\nChoose (1-${CITIES.length + 1}): `, (answer) => {
      rl.close();

      const choice = parseInt(answer.trim());
      let selectedCity: City | undefined;

      if (choice >= 1 && choice <= CITIES.length) {
        selectedCity = CITIES[choice - 1];
      } else if (choice !== CITIES.length + 1) {
        console.log('Invalid choice.');
        resolve();
        return;
      }

      // Get top opportunities sorted by Profit/Day
      console.log('\nCalculating profitability...');
      const startTime = Date.now();
      const results = calculator.getTopByProfitPerDay(DEFAULT_USER_STATS, 50, selectedCity);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      if (results.length === 0) {
        console.log('\nNo profitable opportunities found.');
        resolve();
        return;
      }

      console.log(`\nCalculated in ${elapsed}s`);

      // Print table header
      const cityLabel = selectedCity || 'ALL CITIES';
      console.log(`\n=== TOP 50 OPPORTUNITIES - ${cityLabel} ===`);
      console.log('(Sorted by: Supply → Demand → Profit/Day)\n');

      // Table header
      console.log(
        '#   ' +
        'Item                         ' +
        'Sold/Day ' +
        '7d Price   ' +
        'Profit/Item ' +
        'Sells In  ' +
        'Profit/Day'
      );
      console.log('-'.repeat(95));

      // Print each row
      results.forEach((result, index) => {
        const rank = (index + 1).toString().padStart(2);
        const item = truncate(result.itemName, 28);
        const soldPerDay = result.demandPerDay.toString().padStart(8);
        // Green = good for me (low supply = opportunity), Red = bad for me (high supply = saturated)
        const priceEmoji = result.demandTrend === '↑' ? '🟢' : result.demandTrend === '↓' ? '🔴' : '🟡';
        const pricePct = formatPercent(result.priceTrendPct);
        const priceChange = `${priceEmoji} ${pricePct}`;
        const profit = formatNumber(result.netProfit).padStart(11);
        const sellsIn = `${result.sellsInDays}d (${result.liquidityRisk.charAt(0)})`.padStart(9);
        const profitDay = formatNumber(result.profitPerDay).padStart(10);

        console.log(
          `${rank}  ${item} ${soldPerDay} ${priceChange.padEnd(10)} ${profit} ${sellsIn} ${profitDay}`
        );
      });

      // Legend
      console.log('\n' + '-'.repeat(95));
      console.log('Legend:');
      console.log('  Sold/Day: Average items sold per day (last 7 days)');
      console.log('  7d Price: Current price vs 7-day avg (🟢 rising = low supply, 🔴 falling = high supply)');
      console.log('  Sells In: Estimated days to sell (L=Low risk, M=Medium, H=High)');
      console.log('  Sorting: 1) Rising prices first, 2) High sales, 3) Profit/Day');
      console.log('');

      resolve();
    });
  });
}

// View high demand / low supply items per city
async function viewHighDemandLowSupply() {
  console.log('\n--- HIGH DEMAND / LOW SUPPLY ITEMS ---\n');

  const demandSupplyPath = path.join(process.cwd(), 'src', 'db', 'demand-supply.json');

  if (!fs.existsSync(demandSupplyPath)) {
    console.error('❌ demand-supply.json not found.');
    console.error('Select "Refresh market demand + supply" from the main menu first.\n');
    return;
  }

  const demandSupplyData: DemandSupplyData[] = JSON.parse(fs.readFileSync(demandSupplyPath, 'utf8'));

  // Filter for items with meaningful demand and falling supply (price rising = supply falling)
  const highDemandLowSupply = demandSupplyData.filter((item) => {
    return item.dailyDemand > 0 && item.supplySignal === '🔴 Falling';
  });

  if (highDemandLowSupply.length === 0) {
    console.log('No items found with high demand and low supply signals.\n');
    console.log('This could mean:');
    console.log('  - Markets are well-supplied');
    console.log('  - Data is stale (refresh recommended)\n');
    return;
  }

  // Sort by daily demand descending
  highDemandLowSupply.sort((a, b) => b.dailyDemand - a.dailyDemand);

  // Group by city
  console.log('Items with HIGH DEMAND and FALLING SUPPLY (opportunity indicators):\n');

  CITIES.forEach((city) => {
    const cityItems = highDemandLowSupply.filter((item) => item.city === city);

    if (cityItems.length === 0) {
      console.log(`\n📍 ${city}: No opportunities found`);
      return;
    }

    console.log(`\n📍 ${city} (${cityItems.length} items):`);
    console.log('   Item ID                          | Daily Demand | Price Trend | 7d Avg Price');
    console.log('   ---------------------------------|--------------|-------------|-------------');

    cityItems.slice(0, 10).forEach((item) => {
      const trendStr = item.priceTrendPct >= 0 ? `+${item.priceTrendPct.toFixed(1)}%` : `${item.priceTrendPct.toFixed(1)}%`;
      console.log(
        `   ${item.itemId.padEnd(33)} | ${item.dailyDemand.toString().padStart(12)} | ${trendStr.padStart(11)} | ${item.price7dAvg.toString().padStart(12)}`
      );
    });

    if (cityItems.length > 10) {
      console.log(`   ... and ${cityItems.length - 10} more items`);
    }
  });

  // Summary
  const totalOpportunities = highDemandLowSupply.length;
  const topCity = CITIES.reduce((best, city) => {
    const count = highDemandLowSupply.filter((item) => item.city === city).length;
    return count > best.count ? { city, count } : best;
  }, { city: '' as City, count: 0 });

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`Total opportunities: ${totalOpportunities}`);
  console.log(`Best city: ${topCity.city} (${topCity.count} items)`);
  console.log('\n💡 These items have people buying but supply is decreasing - good crafting targets!\n');
}

// Refresh full market data (prices + charts)
async function refreshMarketData() {
  console.log('\n--- REFRESHING FULL MARKET DATA ---\n');
  console.log('Fetching both material prices and market data...\n');

  try {
    console.log('Step 1/2: Fetching material prices...');
    await fetchAllMaterialPrices();
    console.log('✓ Material prices updated\n');

    console.log('Step 2/2: Fetching market data...');
    await fetchAllMarketData();
    console.log('✓ Market data updated\n');

    console.log('✅ Full market data refresh complete!\n');
  } catch (error) {
    console.error('❌ Error refreshing market data:', error);
  }
}


async function main() {
  console.log('Welcome to the Albion Craft Profitability Analyzer!');

  let running = true;

  while (running) {
    const choice = await showMenu();

    switch (choice) {
      case '1':
        await refreshDemandSupply();
        break;
      case '2':
        await viewHighDemandLowSupply();
        break;
      case '3':
        await refreshMarketData();
        break;
      case '4':
        await showBestOpportunities();
        break;
      case '5':
        console.log('\nGoodbye!\n');
        running = false;
        break;
      default:
        console.log('\n❌ Invalid option. Please choose 1-5.\n');
    }
  }
}

// Run CLI
main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
