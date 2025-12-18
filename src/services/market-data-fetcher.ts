// market-data-fetcher.ts
// Fetches market data (prices, volumes, trends) from AODP API for all craftable items

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { RateLimiter } from '../utils/rate-limiter';
import { City, MarketData, SupplySignal } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================

const itemsData = require('../constants/items.json') as Array<{ id: string; name: string }>;
const ITEMS = itemsData.map((item) => item.id);

const CITIES: City[] = [
  'Caerleon',
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
];

interface FetchConfig {
  batchSize: number;
  delayBetweenBatches: number;
  maxRetries: number;
  initialRetryDelay: number;
  maxRetryDelay: number;
  backoffMultiplier: number;
  jitterRange: number;
  requestTimeout: number;
  resumeFromFile: string;
  historyDays: number;
}

const CONFIG: FetchConfig = {
  batchSize: 50,
  delayBetweenBatches: 1000,
  maxRetries: 5,
  initialRetryDelay: 2000,
  maxRetryDelay: 60000,
  backoffMultiplier: 2,
  jitterRange: 0.3,
  requestTimeout: 15000,
  resumeFromFile: path.join(process.cwd(), 'src', 'db', 'progress', 'market-data-progress.json'),
  historyDays: 7,
};

const MAX_URL_LENGTH = 2000;

// ============================================================================
// TYPES
// ============================================================================

interface FetchResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  retryable?: boolean;
}

interface Progress {
  processedItems: string[];
  marketData: MarketData[];
  errors: Array<{
    items: string[];
    error: string;
    statusCode?: number;
  }>;
}

interface AODPPriceRecord {
  item_id: string;
  city: string;
  sell_price_min: number;
  buy_price_max: number;
  sell_price_min_date: string;
}

interface AODPHistoricalRecord {
  location: string;
  timestamp: string;
  sell_price_min: number;
}

interface AODPChartDataPoint {
  item_count: number;
  avg_price: number;
  timestamp: number;
}

interface AODPChartLocationData {
  location: string;
  data: AODPChartDataPoint[];
}

interface TrendAnalysis {
  price7dAvg: number;
  priceTrendPct: number;
  supplySignal: SupplySignal;
  dataAgeHours: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addJitter(delay: number): number {
  const jitter = delay * CONFIG.jitterRange;
  return delay + (Math.random() * 2 - 1) * jitter;
}

function calculateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

/**
 * Split items into sub-batches that respect URL length limit
 */
function createHistoricalBatches(items: string[]): string[][] {
  const batches: string[][] = [];
  const locationsParam = CITIES.join(',');
  const dateFrom = calculateDaysAgo(CONFIG.historyDays);
  const dateTo = new Date().toISOString().split('T')[0];

  // Build base URL without items parameter
  const baseUrl = `https://west.albion-online-data.com/api/v2/stats/charts/`;
  const queryParams = `?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;
  const baseLength = baseUrl.length + queryParams.length;

  let currentBatch: string[] = [];
  let currentLength = baseLength;

  for (const itemId of items) {
    // Calculate length if we add this item
    // +1 for comma separator (except for first item)
    const itemLength = itemId.length + (currentBatch.length > 0 ? 1 : 0);
    const newLength = currentLength + itemLength;

    if (newLength > MAX_URL_LENGTH && currentBatch.length > 0) {
      // Current batch would exceed limit, save it and start new batch
      batches.push([...currentBatch]);
      currentBatch = [itemId];
      currentLength = baseLength + itemId.length;
    } else {
      // Add item to current batch
      currentBatch.push(itemId);
      currentLength = newLength;
    }
  }

  // Add remaining batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function makeHttpsRequest(url: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const request = https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve({
              success: true,
              data: json,
              statusCode: 200,
            });
          } catch (e) {
            const error = e as Error;
            resolve({
              success: false,
              error: `Parse error: ${error.message}`,
              statusCode: 200,
              retryable: false,
            });
          }
        } else if (res.statusCode === 429) {
          resolve({
            success: false,
            error: 'Rate limited',
            statusCode: 429,
            retryable: true,
          });
        } else if (res.statusCode && res.statusCode >= 500) {
          resolve({
            success: false,
            error: `Server error ${res.statusCode}`,
            statusCode: res.statusCode,
            retryable: true,
          });
        } else {
          resolve({
            success: false,
            error: `HTTP ${res.statusCode}`,
            statusCode: res.statusCode,
            retryable: false,
          });
        }
      });
    });

    request.on('error', (err) => {
      resolve({
        success: false,
        error: err.message,
        retryable: true,
      });
    });

    request.setTimeout(CONFIG.requestTimeout, () => {
      request.destroy();
      resolve({
        success: false,
        error: 'Timeout',
        retryable: true,
      });
    });
  });
}

async function fetchWithRetry(
  url: string,
  attempt: number = 1,
  onRetry?: (attempt: number, delay: number, error: string) => void
): Promise<FetchResult> {
  const result = await makeHttpsRequest(url);

  if (result.success) {
    return result;
  }

  if (!result.retryable || attempt >= CONFIG.maxRetries) {
    return result;
  }

  const baseDelay = CONFIG.initialRetryDelay * Math.pow(CONFIG.backoffMultiplier, attempt - 1);
  const delayWithJitter = addJitter(Math.min(baseDelay, CONFIG.maxRetryDelay));

  if (onRetry) {
    onRetry(attempt, delayWithJitter, result.error || 'Unknown error');
  }

  await sleep(delayWithJitter);

  return fetchWithRetry(url, attempt + 1, onRetry);
}

async function fetchCurrentPrices(itemsBatch: string[]): Promise<FetchResult<AODPPriceRecord[]>> {
  const itemsParam = itemsBatch.join(',');
  const locationsParam = CITIES.join(',');
  const url = `https://west.albion-online-data.com/api/v2/stats/prices/${itemsParam}?locations=${locationsParam}`;

  return fetchWithRetry(url);
}

async function fetchHistoricalPrices(itemIds: string[]): Promise<FetchResult<Record<string, AODPChartLocationData[]>>> {
  const itemsParam = itemIds.join(',');
  const locationsParam = CITIES.join(',');
  const dateFrom = calculateDaysAgo(CONFIG.historyDays);
  const dateTo = new Date().toISOString().split('T')[0];
  const url = `https://west.albion-online-data.com/api/v2/stats/charts/${itemsParam}?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;

  return fetchWithRetry(url);
}

function analyzePriceTrend(historicalData: AODPChartLocationData[], city: City): TrendAnalysis {
  if (!historicalData || historicalData.length === 0) {
    return {
      price7dAvg: 0,
      priceTrendPct: 0,
      supplySignal: '🟡 Stable',
      dataAgeHours: 999,
    };
  }

  // Find data for specific city
  const cityLocation = historicalData.find((loc) => loc.location === city);

  if (!cityLocation || !cityLocation.data || cityLocation.data.length === 0) {
    return {
      price7dAvg: 0,
      priceTrendPct: 0,
      supplySignal: '🟡 Stable',
      dataAgeHours: 999,
    };
  }

  // Sort by timestamp descending (most recent first)
  const sortedData = [...cityLocation.data].sort((a, b) => b.timestamp - a.timestamp);

  if (sortedData.length < 2) {
    return {
      price7dAvg: Math.round(sortedData[0]?.avg_price || 0),
      priceTrendPct: 0,
      supplySignal: '🟡 Stable',
      dataAgeHours: calculateDataAgeFromTimestamp(sortedData[0]?.timestamp),
    };
  }

  // Calculate 7-day average from daily aggregated data
  const prices = sortedData.map((d) => d.avg_price || 0).filter((p) => p > 0);
  const price7dAvg = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);

  // Calculate trend: compare most recent price to 7-day average
  const currentPrice = sortedData[0].avg_price || 0;
  const priceTrendPct = price7dAvg > 0 ? ((currentPrice - price7dAvg) / price7dAvg) * 100 : 0;

  // Determine supply signal based on price trend
  // Rising prices = falling supply (🔴)
  // Falling prices = rising supply (🟢)
  // Stable prices = stable supply (🟡)
  let supplySignal: SupplySignal = '🟡 Stable';
  if (priceTrendPct > 5) {
    supplySignal = '🔴 Falling'; // Prices up = supply down
  } else if (priceTrendPct < -5) {
    supplySignal = '🟢 Rising'; // Prices down = supply up
  }

  const dataAgeHours = calculateDataAgeFromTimestamp(sortedData[0].timestamp);

  return {
    price7dAvg: Math.round(price7dAvg),
    priceTrendPct: parseFloat(priceTrendPct.toFixed(2)),
    supplySignal,
    dataAgeHours,
  };
}

function calculateDataAge(timestamp: string): number {
  if (!timestamp) return 999;
  const now = new Date();
  const dataTime = new Date(timestamp);
  const ageMs = now.getTime() - dataTime.getTime();
  return Math.round(ageMs / (1000 * 60 * 60)); // Convert to hours
}

function calculateDataAgeFromTimestamp(timestamp: number): number {
  if (!timestamp) return 999;
  const now = Date.now();
  const ageMs = now - timestamp;
  return Math.round(ageMs / (1000 * 60 * 60)); // Convert to hours
}

function estimateDailyDemand(historicalData: AODPChartLocationData[], city: City): number {
  if (!historicalData || historicalData.length === 0) return 0;

  // Find data for specific city
  const cityLocation = historicalData.find((loc) => loc.location === city);

  if (!cityLocation || !cityLocation.data || cityLocation.data.length === 0) {
    return 0;
  }

  // Use actual item_count field from charts data
  // Calculate average daily sales volume
  const dailySales = cityLocation.data.map((d) => d.item_count || 0).filter((count) => count > 0);

  if (dailySales.length === 0) return 0;

  const avgDailyDemand = dailySales.reduce((sum, count) => sum + count, 0) / dailySales.length;

  return Math.round(avgDailyDemand);
}

function loadProgress(): Progress {
  try {
    if (fs.existsSync(CONFIG.resumeFromFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.resumeFromFile, 'utf8')) as Progress;
      console.log(`\n✓ Resuming from ${CONFIG.resumeFromFile}`);
      console.log(`  Already processed: ${data.processedItems.length} items`);
      console.log(`  Market records: ${data.marketData.length}\n`);
      return data;
    }
  } catch (e) {
    const error = e as Error;
    console.log(`⚠️  Could not load progress file: ${error.message}`);
  }

  return {
    processedItems: [],
    marketData: [],
    errors: [],
  };
}

function saveProgress(data: Progress): void {
  fs.writeFileSync(CONFIG.resumeFromFile, JSON.stringify(data, null, 2));
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function fetchAllMarketData(): Promise<void> {
  const progress = loadProgress();
  const processedSet = new Set(progress.processedItems);
  const itemsToProcess = ITEMS.filter((item) => !processedSet.has(item));

  if (itemsToProcess.length === 0) {
    console.log('✅ All market data already fetched');
    return;
  }

  console.log(`Fetching market data for ${itemsToProcess.length} items across ${CITIES.length} cities...`);
  console.log('(This includes price history for trend analysis - may take a few minutes)\n');

  // Table header
  console.log('┌──────────┬──────────┬─────────┬─────────────────────┬────────────────────────────────────┐');
  console.log('│  Batch   │ Complete │ Success │    Rate Limits      │ Status                             │');
  console.log('│          │          │         │   1m  │     5m      │                                    │');
  console.log('├──────────┼──────────┼─────────┼───────┼─────────────┼────────────────────────────────────┤');

  const rateLimiter = new RateLimiter();
  const totalBatches = Math.ceil(itemsToProcess.length / CONFIG.batchSize);

  for (let i = 0; i < itemsToProcess.length; i += CONFIG.batchSize) {
    const batch = itemsToProcess.slice(i, Math.min(i + CONFIG.batchSize, itemsToProcess.length));
    const batchNum = Math.floor(i / CONFIG.batchSize) + 1;

    // Check rate limits before making request
    const waitTime = await rateLimiter.waitIfNeeded();
    const rateStats = rateLimiter.getStats();

    // Always show progress row so user knows we're running
    const batchStr = `${batchNum}/${totalBatches}`.padEnd(8);
    const totalProcessed = progress.processedItems.length;
    const percentComplete = ((totalProcessed / ITEMS.length) * 100).toFixed(1);
    const completeStr = `${percentComplete}%`.padEnd(8);
    const successRate =
      totalProcessed > 0
        ? (
            ((totalProcessed - progress.errors.reduce((sum, e) => sum + e.items.length, 0)) / totalProcessed) *
            100
          ).toFixed(0)
        : '100';
    const successStr = `${successRate}%`.padEnd(7);
    const rate1mStr = `${rateStats.last1min}/180`.padEnd(5);
    const rate5mStr = `${rateStats.last5min}/300`.padEnd(11);

    if (waitTime > 0) {
      const statusStr = `⏸ Waiting ${(waitTime / 1000).toFixed(0)}s (rate limit)`.padEnd(34);
      console.log(`│ ${batchStr} │ ${completeStr} │ ${successStr} │ ${rate1mStr} │ ${rate5mStr} │ ${statusStr} │`);
      await sleep(waitTime);
    } else {
      // Show starting status
      const statusStr = `▶ Starting batch...`.padEnd(34);
      console.log(`│ ${batchStr} │ ${completeStr} │ ${successStr} │ ${rate1mStr} │ ${rate5mStr} │ ${statusStr} │`);
    }

    // Step 1: Fetch current prices
    const pricesResult = await fetchCurrentPrices(batch);
    rateLimiter.recordRequest();

    if (!pricesResult.success) {
      progress.errors.push({
        items: batch,
        error: pricesResult.error || 'Unknown error',
        statusCode: pricesResult.statusCode,
      });

      const errorRateStats = rateLimiter.getStats();
      const errorTotalProcessed = progress.processedItems.length;
      const errorPercentComplete = ((errorTotalProcessed / ITEMS.length) * 100).toFixed(1);
      const errorSuccessRate =
        errorTotalProcessed > 0
          ? (
              ((errorTotalProcessed - progress.errors.reduce((sum, e) => sum + e.items.length, 0)) /
                errorTotalProcessed) *
              100
            ).toFixed(0)
          : '100';

      const errorBatchStr = `${batchNum}/${totalBatches}`.padEnd(8);
      const errorCompleteStr = `${errorPercentComplete}%`.padEnd(8);
      const errorSuccessStr = `${errorSuccessRate}%`.padEnd(7);
      const errorRate1mStr = `${errorRateStats.last1min}/180`.padEnd(5);
      const errorRate5mStr = `${errorRateStats.last5min}/300`.padEnd(11);
      const statusStr = `✗ ${pricesResult.error}`.padEnd(34);

      console.log(
        `│ ${errorBatchStr} │ ${errorCompleteStr} │ ${errorSuccessStr} │ ${errorRate1mStr} │ ${errorRate5mStr} │ ${statusStr} │`
      );

      saveProgress(progress);
      continue;
    }

    // Step 2: Fetch historical data for trend analysis (URL-length-aware batching)
    const historicalBatches = createHistoricalBatches(batch);
    const historicalDataMap = new Map<string, AODPChartLocationData[]>();

    for (let histBatchIdx = 0; histBatchIdx < historicalBatches.length; histBatchIdx++) {
      const histBatch = historicalBatches[histBatchIdx];

      const histWaitTime = await rateLimiter.waitIfNeeded();
      const histRateStats = rateLimiter.getStats();
      const histBatchStr = `${batchNum}/${totalBatches}`.padEnd(8);
      const histTotalProcessed = progress.processedItems.length;
      const histPercentComplete = ((histTotalProcessed / ITEMS.length) * 100).toFixed(1);
      const histCompleteStr = `${histPercentComplete}%`.padEnd(8);
      const histSuccessRate =
        histTotalProcessed > 0
          ? (
              ((histTotalProcessed - progress.errors.reduce((sum, e) => sum + e.items.length, 0)) /
                histTotalProcessed) *
              100
            ).toFixed(0)
          : '100';
      const histSuccessStr = `${histSuccessRate}%`.padEnd(7);
      const histRate1mStr = `${histRateStats.last1min}/180`.padEnd(5);
      const histRate5mStr = `${histRateStats.last5min}/300`.padEnd(11);

      if (histWaitTime > 0) {
        const statusStr = `⏸ Wait ${(histWaitTime / 1000).toFixed(0)}s (history ${histBatchIdx + 1}/${historicalBatches.length})`.padEnd(34);
        console.log(
          `│ ${histBatchStr} │ ${histCompleteStr} │ ${histSuccessStr} │ ${histRate1mStr} │ ${histRate5mStr} │ ${statusStr} │`
        );
        await sleep(histWaitTime);
      } else {
        const statusStr = `⏳ History ${histBatchIdx + 1}/${historicalBatches.length} (${histBatch.length} items)`.padEnd(34);
        console.log(
          `│ ${histBatchStr} │ ${histCompleteStr} │ ${histSuccessStr} │ ${histRate1mStr} │ ${histRate5mStr} │ ${statusStr} │`
        );
      }

      const historyResult = await fetchHistoricalPrices(histBatch);
      rateLimiter.recordRequest();

      if (historyResult.success && historyResult.data) {
        const histData = historyResult.data as Record<string, AODPChartLocationData[]>;
        Object.entries(histData).forEach(([itemId, locationData]) => {
          historicalDataMap.set(itemId, locationData);
        });
      }

      await sleep(200);
    }

    // Step 3: Combine price data with trend analysis
    const priceData = pricesResult.data as AODPPriceRecord[];
    priceData.forEach((priceRecord) => {
      const itemId = priceRecord.item_id;
      const city = priceRecord.city as City;
      const historicalData = historicalDataMap.get(itemId) || [];

      const trendAnalysis = analyzePriceTrend(historicalData, city);
      const dailyDemand = estimateDailyDemand(historicalData, city);
      const availableCapacity = dailyDemand > 0 ? Math.round(dailyDemand * 2.5) : 0;
      const confidence =
        trendAnalysis.dataAgeHours < 12
          ? 95
          : trendAnalysis.dataAgeHours < 24
          ? 80
          : trendAnalysis.dataAgeHours < 48
          ? 60
          : 40;
      const marketSignal =
        trendAnalysis.supplySignal === '🟢 Rising' ? 'GOOD' : trendAnalysis.supplySignal === '🟡 Stable' ? 'FAIR' : 'POOR';

      progress.marketData.push({
        itemId,
        city,
        dailyDemand,
        lowestSellPrice: priceRecord.sell_price_min || 0,
        price7dAvg: trendAnalysis.price7dAvg,
        dataAgeHours: trendAnalysis.dataAgeHours,
        confidence,
        availableCapacity,
        priceTrendPct: trendAnalysis.priceTrendPct,
        supplySignal: trendAnalysis.supplySignal,
        marketSignal,
      });
    });

    // Mark items as processed
    batch.forEach((item) => progress.processedItems.push(item));

    const finalRateStats = rateLimiter.getStats();
    const finalTotalProcessed = progress.processedItems.length;
    const finalPercentComplete = ((finalTotalProcessed / ITEMS.length) * 100).toFixed(1);
    const finalSuccessRate =
      finalTotalProcessed > 0
        ? (
            ((finalTotalProcessed - progress.errors.reduce((sum, e) => sum + e.items.length, 0)) /
              finalTotalProcessed) *
            100
          ).toFixed(0)
        : '100';

    const finalBatchStr = `${batchNum}/${totalBatches}`.padEnd(8);
    const finalCompleteStr = `${finalPercentComplete}%`.padEnd(8);
    const finalSuccessStr = `${finalSuccessRate}%`.padEnd(7);
    const finalRate1mStr = `${finalRateStats.last1min}/180`.padEnd(5);
    const finalRate5mStr = `${finalRateStats.last5min}/300`.padEnd(11);
    const recordsCount = priceData.length;
    const statusStr = `✓ Analyzed ${recordsCount} records`.padEnd(34);

    console.log(
      `│ ${finalBatchStr} │ ${finalCompleteStr} │ ${finalSuccessStr} │ ${finalRate1mStr} │ ${finalRate5mStr} │ ${statusStr} │`
    );

    saveProgress(progress);

    // Delay between batches
    if (i + CONFIG.batchSize < itemsToProcess.length) {
      await sleep(CONFIG.delayBetweenBatches);
    }
  }

  console.log('└──────────┴──────────┴─────────┴───────┴─────────────┴────────────────────────────────────┘');

  console.log(''); // New line after progress

  // Ensure output directory exists
  const outputDir = path.join(process.cwd(), 'src', 'db');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write output files
  const outputPath = path.join(outputDir, 'market-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(progress.marketData, null, 2));

  if (progress.errors.length > 0) {
    fs.writeFileSync('market-data-errors.json', JSON.stringify(progress.errors, null, 2));
  }

  // Create summary statistics
  const summary = {
    totalRecords: progress.marketData.length,
    recordsByCity: {} as Record<City, number>,
    avgConfidence: 0,
    supplySignalDistribution: {
      rising: 0,
      stable: 0,
      falling: 0,
    },
    generatedAt: new Date().toISOString(),
  };

  CITIES.forEach((city) => {
    summary.recordsByCity[city] = progress.marketData.filter((r) => r.city === city).length;
  });

  progress.marketData.forEach((record) => {
    summary.avgConfidence += record.confidence;
    if (record.supplySignal.includes('Rising')) summary.supplySignalDistribution.rising++;
    else if (record.supplySignal.includes('Falling')) summary.supplySignalDistribution.falling++;
    else summary.supplySignalDistribution.stable++;
  });

  summary.avgConfidence = Math.round(summary.avgConfidence / progress.marketData.length);

  fs.writeFileSync('market-data-summary.json', JSON.stringify(summary, null, 2));

  // Clean up progress file
  if (fs.existsSync(CONFIG.resumeFromFile)) {
    fs.unlinkSync(CONFIG.resumeFromFile);
  }

  console.log(`✅ Done! Fetched ${progress.marketData.length} market records for ${progress.processedItems.length} items`);
  console.log(`Output: ${outputPath}`);
}
