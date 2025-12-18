// market-data-fetcher.ts
// Fetches market data (prices, volumes, trends) from AODP API for all craftable items

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseRateLimitHeaders,
  calculateWaitTime,
  displayCountdown,
  DEFAULT_RATE_LIMIT_WAIT,
  RateLimitInfo,
} from '../utils/rate-limiter';
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
  rateLimitInfo?: RateLimitInfo;
}

interface Progress {
  processedItems: string[];
  marketData: MarketData[];
  errors: Array<{
    items: string[];
    error: string;
    statusCode?: number;
  }>;
  itemFailures: Map<string, {
    missingDays: number[];  // Days 0-6 that have no data
    reason: string;         // Human-readable reason for the failure
    url: string;            // API URL to manually test the item
  }>;
}

interface AODPPriceRecord {
  item_id: string;
  city: string;
  sell_price_min: number;
  buy_price_max: number;
  sell_price_min_date: string;
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

// Raw API response format from /charts endpoint
interface AODPChartRawResponse {
  location: string;
  item_id: string;
  quality: number;
  data: {
    timestamps: string[];
    prices_avg: number[];
    item_count: number[];
  };
}

/**
 * Transform raw API response into grouped format by item ID
 * Aggregates all qualities for each item+city combination
 */
function transformChartsResponse(rawData: AODPChartRawResponse[]): Record<string, AODPChartLocationData[]> {
  const result: Record<string, AODPChartLocationData[]> = {};

  for (const record of rawData) {
    const { item_id, location, data } = record;

    if (!data || !data.timestamps || data.timestamps.length === 0) {
      continue;
    }

    // Convert arrays into data points
    const dataPoints: AODPChartDataPoint[] = data.timestamps.map((ts, i) => ({
      timestamp: new Date(ts).getTime(),
      avg_price: data.prices_avg[i] || 0,
      item_count: data.item_count[i] || 0,
    }));

    if (!result[item_id]) {
      result[item_id] = [];
    }

    // Find existing location data for this item
    const existingLocation = result[item_id].find((loc) => loc.location === location);

    if (existingLocation) {
      // Aggregate: sum item_count, weighted avg for price per timestamp
      for (const newPoint of dataPoints) {
        const existingPoint = existingLocation.data.find((p) => p.timestamp === newPoint.timestamp);
        if (existingPoint) {
          // Sum item counts across qualities
          existingPoint.item_count += newPoint.item_count;
          // Keep the lower price (more relevant for buyers)
          if (newPoint.avg_price > 0 && (existingPoint.avg_price === 0 || newPoint.avg_price < existingPoint.avg_price)) {
            existingPoint.avg_price = newPoint.avg_price;
          }
        } else {
          existingLocation.data.push({ ...newPoint });
        }
      }
    } else {
      result[item_id].push({
        location,
        data: dataPoints,
      });
    }
  }

  return result;
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
 * Split items into batches that respect URL length limit
 */
function createBatchesByUrlLength(items: string[], baseUrl: string, queryParams: string): string[][] {
  const batches: string[][] = [];
  const baseLength = baseUrl.length + queryParams.length;

  let currentBatch: string[] = [];
  let currentLength = baseLength;

  for (const itemId of items) {
    // +1 for comma separator (except for first item)
    const itemLength = itemId.length + (currentBatch.length > 0 ? 1 : 0);
    const newLength = currentLength + itemLength;

    if (newLength > MAX_URL_LENGTH && currentBatch.length > 0) {
      batches.push([...currentBatch]);
      currentBatch = [itemId];
      currentLength = baseLength + itemId.length;
    } else {
      currentBatch.push(itemId);
      currentLength = newLength;
    }
  }

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
          // Parse rate limit headers to know exactly when we can retry
          const rateLimitInfo = parseRateLimitHeaders(res.headers as Record<string, string | string[] | undefined>);
          resolve({
            success: false,
            error: 'Rate limited',
            statusCode: 429,
            retryable: true,
            rateLimitInfo: rateLimitInfo || undefined,
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
  attempt: number = 1
): Promise<FetchResult> {
  const result = await makeHttpsRequest(url);

  if (result.success) {
    return result;
  }

  // For rate limiting (429), always retry - don't count against maxRetries
  const isRateLimited = result.statusCode === 429;

  if (!result.retryable || (!isRateLimited && attempt >= CONFIG.maxRetries)) {
    return result;
  }

  if (isRateLimited) {
    // Use rate limit headers if available, otherwise use default wait
    const waitSeconds = result.rateLimitInfo
      ? calculateWaitTime(result.rateLimitInfo)
      : DEFAULT_RATE_LIMIT_WAIT;

    await displayCountdown(waitSeconds, 'Rate limited');
  } else {
    // Exponential backoff for other retryable errors (server errors, timeouts)
    const baseDelay = CONFIG.initialRetryDelay * Math.pow(CONFIG.backoffMultiplier, attempt - 1);
    const delayWithJitter = addJitter(Math.min(baseDelay, CONFIG.maxRetryDelay));
    const waitSeconds = Math.round(delayWithJitter / 1000);

    await displayCountdown(waitSeconds, `Retry ${attempt}/${CONFIG.maxRetries}`);
  }

  // For rate limiting, don't increment attempt counter so we retry indefinitely
  const nextAttempt = isRateLimited ? attempt : attempt + 1;
  return fetchWithRetry(url, nextAttempt);
}

// Small delay between requests to avoid hitting rate limits
const REQUEST_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCurrentPrices(itemsBatch: string[]): Promise<FetchResult<AODPPriceRecord[]>> {
  const itemsParam = itemsBatch.join(',');
  const locationsParam = CITIES.join(',');
  const url = `https://europe.albion-online-data.com/api/v2/stats/prices/${itemsParam}?locations=${locationsParam}`;

  console.log(`\n📡 [PRICES] ${itemsBatch.length} items | URL length: ${url.length}`);
  console.log(`   ${url.substring(0, 150)}${url.length > 150 ? '...' : ''}`);

  const result = await fetchWithRetry(url);
  await sleep(REQUEST_DELAY_MS);
  return result;
}

function buildHistoricalUrl(itemIds: string[]): string {
  const itemsParam = itemIds.join(',');
  const locationsParam = CITIES.join(',');
  const dateFrom = calculateDaysAgo(CONFIG.historyDays);
  const dateTo = new Date().toISOString().split('T')[0];
  return `https://europe.albion-online-data.com/api/v2/stats/charts/${itemsParam}?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;
}

async function fetchHistoricalPrices(itemIds: string[]): Promise<FetchResult<Record<string, AODPChartLocationData[]>>> {
  const url = buildHistoricalUrl(itemIds);

  console.log(`\n📡 [HISTORY] ${itemIds.length} items | URL length: ${url.length}`);
  console.log(`   ${url.substring(0, 150)}${url.length > 150 ? '...' : ''}`);

  const result = await fetchWithRetry(url);
  await sleep(REQUEST_DELAY_MS);

  // Transform raw API response into expected format
  if (result.success && result.data) {
    const rawData = result.data as AODPChartRawResponse[];
    const transformed = transformChartsResponse(rawData);
    return {
      ...result,
      data: transformed,
    };
  }

  return result;
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
      const raw = JSON.parse(fs.readFileSync(CONFIG.resumeFromFile, 'utf8')) as any;
      console.log(`\n✓ Resuming from ${CONFIG.resumeFromFile}`);
      console.log(`  Already processed: ${raw.processedItems.length} items`);
      console.log(`  Market records: ${raw.marketData.length}\n`);

      // Convert itemFailures from object to Map
      const itemFailures = new Map<string, { missingDays: number[]; reason: string; url: string }>(
        Object.entries(raw.itemFailures || {})
      );

      return {
        processedItems: raw.processedItems,
        marketData: raw.marketData,
        errors: raw.errors,
        itemFailures,
      };
    }
  } catch (e) {
    const error = e as Error;
    console.log(`⚠️  Could not load progress file: ${error.message}`);
  }

  return {
    processedItems: [],
    marketData: [],
    errors: [],
    itemFailures: new Map(),
  };
}

function saveProgress(data: Progress): void {
  // Convert Map to object for JSON serialization
  const serializable = {
    processedItems: data.processedItems,
    marketData: data.marketData,
    errors: data.errors,
    itemFailures: Object.fromEntries(data.itemFailures),
  };
  fs.writeFileSync(CONFIG.resumeFromFile, JSON.stringify(serializable, null, 2));
}

/**
 * Calculate failure metrics for progress display
 */
function calculateFailures(itemFailures: Map<string, { missingDays: number[]; reason: string; url: string }>): { itemsFailed: number; daysFailed: number } {
  if (itemFailures.size === 0) {
    return { itemsFailed: 0, daysFailed: 0 };
  }

  const itemsFailed = itemFailures.size;

  // Calculate total missing days across all items
  let totalMissingDays = 0;
  itemFailures.forEach((failure) => {
    totalMissingDays += failure.missingDays.length;
  });

  return {
    itemsFailed,
    daysFailed: totalMissingDays,
  };
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

// ============================================================================
// DEMAND/SUPPLY ONLY FETCH (Charts endpoint only)
// ============================================================================

export interface DemandSupplyData {
  itemId: string;
  city: City;
  dailyDemand: number;
  supplySignal: SupplySignal;
  price7dAvg: number;
  priceTrendPct: number;
  dataAgeHours: number;
}

export async function fetchDemandSupplyData(): Promise<DemandSupplyData[]> {
  console.log('\n--- FETCHING MARKET DEMAND & SUPPLY DATA ---\n');
  console.log(`Fetching charts data for ${ITEMS.length} items across ${CITIES.length} cities...`);
  console.log('(Going as fast as possible - will pause if rate limited)\n');

  // Create URL-length-aware batches for historical endpoint
  const dateFrom = calculateDaysAgo(CONFIG.historyDays);
  const dateTo = new Date().toISOString().split('T')[0];
  const locationsParam = CITIES.join(',');
  const historyBaseUrl = 'https://europe.albion-online-data.com/api/v2/stats/charts/';
  const historyQueryParams = `?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;
  const historyBatches = createBatchesByUrlLength(ITEMS, historyBaseUrl, historyQueryParams);

  console.log(`📊 Total: ${historyBatches.length} requests needed\n`);

  // Fetch ALL historical data
  const historicalDataMap = new Map<string, AODPChartLocationData[]>();
  for (let i = 0; i < historyBatches.length; i++) {
    const batch = historyBatches[i];
    const percentComplete = ((i / historyBatches.length) * 100).toFixed(1);
    process.stdout.write(`\r📡 Fetching charts data: batch ${i + 1}/${historyBatches.length} (${percentComplete}%)   `);

    const historyResult = await fetchHistoricalPrices(batch);

    if (historyResult.success && historyResult.data) {
      const histData = historyResult.data as Record<string, AODPChartLocationData[]>;
      Object.entries(histData).forEach(([itemId, locationData]) => {
        historicalDataMap.set(itemId, locationData);
      });
    }
  }
  console.log(`\n✅ Charts data: fetched for ${historicalDataMap.size} items\n`);

  // Process data into demand/supply records
  console.log('📊 Processing demand & supply data...\n');

  const demandSupplyData: DemandSupplyData[] = [];

  ITEMS.forEach((itemId) => {
    const historicalData = historicalDataMap.get(itemId) || [];

    CITIES.forEach((city) => {
      const trendAnalysis = analyzePriceTrend(historicalData, city);
      const dailyDemand = estimateDailyDemand(historicalData, city);

      demandSupplyData.push({
        itemId,
        city,
        dailyDemand,
        supplySignal: trendAnalysis.supplySignal,
        price7dAvg: trendAnalysis.price7dAvg,
        priceTrendPct: trendAnalysis.priceTrendPct,
        dataAgeHours: trendAnalysis.dataAgeHours,
      });
    });
  });

  // Ensure output directory exists
  const outputDir = path.join(process.cwd(), 'src', 'db');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write output file
  const outputPath = path.join(outputDir, 'demand-supply.json');
  fs.writeFileSync(outputPath, JSON.stringify(demandSupplyData, null, 2));

  console.log(`✅ Done! Saved ${demandSupplyData.length} demand/supply records`);
  console.log(`Output: ${outputPath}\n`);

  return demandSupplyData;
}

// ============================================================================
// FULL MARKET DATA FETCH (Prices + Charts)
// ============================================================================

/**
 * Check if demand-supply.json exists and is fresh (less than maxAgeHours old)
 */
function getDemandSupplyFreshness(maxAgeHours: number = 6): { exists: boolean; isFresh: boolean; ageHours: number } {
  const demandSupplyPath = path.join(process.cwd(), 'src', 'db', 'demand-supply.json');

  if (!fs.existsSync(demandSupplyPath)) {
    return { exists: false, isFresh: false, ageHours: Infinity };
  }

  const stats = fs.statSync(demandSupplyPath);
  const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

  return {
    exists: true,
    isFresh: ageHours < maxAgeHours,
    ageHours: Math.round(ageHours * 10) / 10,
  };
}

/**
 * Load existing demand-supply data and convert to map for quick lookup
 */
function loadDemandSupplyAsMap(): Map<string, DemandSupplyData> {
  const demandSupplyPath = path.join(process.cwd(), 'src', 'db', 'demand-supply.json');
  const data: DemandSupplyData[] = JSON.parse(fs.readFileSync(demandSupplyPath, 'utf8'));

  const map = new Map<string, DemandSupplyData>();
  for (const record of data) {
    const key = `${record.itemId}:${record.city}`;
    map.set(key, record);
  }

  return map;
}

export async function fetchAllMarketData(): Promise<void> {
  const progress = loadProgress();
  const processedSet = new Set(progress.processedItems);
  const itemsToProcess = ITEMS.filter((item) => !processedSet.has(item));

  if (itemsToProcess.length === 0) {
    console.log('✅ All market data already fetched');
    return;
  }

  // Check if we can reuse existing demand-supply data
  const demandSupplyStatus = getDemandSupplyFreshness(6); // 6 hours threshold
  let demandSupplyMap: Map<string, DemandSupplyData> | null = null;

  if (demandSupplyStatus.exists && demandSupplyStatus.isFresh) {
    console.log(`\n✅ Reusing existing demand-supply data (${demandSupplyStatus.ageHours}h old)`);
    console.log('   Skipping charts API fetch - will only fetch current prices\n');
    demandSupplyMap = loadDemandSupplyAsMap();
  } else if (demandSupplyStatus.exists) {
    console.log(`\n⚠️  Demand-supply data is stale (${demandSupplyStatus.ageHours}h old)`);
    console.log('   Will fetch fresh charts data\n');
  } else {
    console.log('\n⚠️  No demand-supply data found');
    console.log('   Will fetch charts data\n');
  }

  console.log(`Fetching market data for ${itemsToProcess.length} items across ${CITIES.length} cities...`);
  console.log('(Going as fast as possible - will pause if rate limited)\n');

  // Create URL-length-aware batches for prices endpoint
  const locationsParam = CITIES.join(',');
  const pricesBaseUrl = 'https://europe.albion-online-data.com/api/v2/stats/prices/';
  const pricesQueryParams = `?locations=${locationsParam}`;
  const priceBatches = createBatchesByUrlLength(itemsToProcess, pricesBaseUrl, pricesQueryParams);

  // Only create history batches if we don't have fresh demand-supply data
  let historyBatches: string[][] = [];
  if (!demandSupplyMap) {
    const dateFrom = calculateDaysAgo(CONFIG.historyDays);
    const dateTo = new Date().toISOString().split('T')[0];
    const historyBaseUrl = 'https://europe.albion-online-data.com/api/v2/stats/charts/';
    const historyQueryParams = `?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;
    historyBatches = createBatchesByUrlLength(itemsToProcess, historyBaseUrl, historyQueryParams);
  }

  console.log(`📊 Prices: ${priceBatches.length} requests needed`);
  if (demandSupplyMap) {
    console.log(`📊 History: 0 requests (reusing demand-supply.json)`);
  } else {
    console.log(`📊 History: ${historyBatches.length} requests needed`);
  }
  console.log(`📊 Total: ${priceBatches.length + historyBatches.length} requests\n`);

  // Step 1: Fetch ALL current prices
  const allPriceData: AODPPriceRecord[] = [];
  for (let i = 0; i < priceBatches.length; i++) {
    const batch = priceBatches[i];
    const percentComplete = ((i / priceBatches.length) * 100).toFixed(1);
    process.stdout.write(`\r📡 Fetching prices: batch ${i + 1}/${priceBatches.length} (${percentComplete}%)   `);

    const pricesResult = await fetchCurrentPrices(batch);

    if (pricesResult.success && pricesResult.data) {
      allPriceData.push(...pricesResult.data);
    } else {
      progress.errors.push({
        items: batch,
        error: pricesResult.error || 'Unknown error',
        statusCode: pricesResult.statusCode,
      });
    }
  }
  console.log(`\n✅ Prices: fetched ${allPriceData.length} records\n`);

  // Step 2: Get historical data (either from API or from existing demand-supply.json)
  let historicalDataMap = new Map<string, AODPChartLocationData[]>();

  if (demandSupplyMap) {
    // We already have demand-supply data, no need to fetch history
    console.log(`✅ History: using ${demandSupplyMap.size} records from demand-supply.json\n`);
  } else {
    // Fetch historical data from API
    for (let i = 0; i < historyBatches.length; i++) {
      const batch = historyBatches[i];
      const percentComplete = ((i / historyBatches.length) * 100).toFixed(1);
      process.stdout.write(`\r📡 Fetching history: batch ${i + 1}/${historyBatches.length} (${percentComplete}%)   `);

      const historyResult = await fetchHistoricalPrices(batch);

      if (historyResult.success && historyResult.data) {
        const histData = historyResult.data as Record<string, AODPChartLocationData[]>;
        Object.entries(histData).forEach(([itemId, locationData]) => {
          historicalDataMap.set(itemId, locationData);
        });
      }
    }
    console.log(`\n✅ History: fetched data for ${historicalDataMap.size} items\n`);
  }

  // Step 3: Combine price data with trend analysis and track missing days
  console.log('📊 Processing data...\n');

  allPriceData.forEach((priceRecord) => {
    const itemId = priceRecord.item_id;
    const city = priceRecord.city as City;

    let dailyDemand: number;
    let price7dAvg: number;
    let dataAgeHours: number;
    let priceTrendPct: number;
    let supplySignal: SupplySignal;

    if (demandSupplyMap) {
      // Use existing demand-supply data (no API call needed)
      const key = `${itemId}:${city}`;
      const existingData = demandSupplyMap.get(key);

      if (existingData) {
        dailyDemand = existingData.dailyDemand;
        price7dAvg = existingData.price7dAvg;
        dataAgeHours = existingData.dataAgeHours;
        priceTrendPct = existingData.priceTrendPct;
        supplySignal = existingData.supplySignal;
      } else {
        // Item not found in demand-supply data, use defaults
        dailyDemand = 0;
        price7dAvg = 0;
        dataAgeHours = 999;
        priceTrendPct = 0;
        supplySignal = '🟡 Stable';
      }
    } else {
      // Calculate from freshly fetched historical data
      const historicalData = historicalDataMap.get(itemId) || [];

      // Check how many days of data we got
      const cityLocation = historicalData.find((loc) => loc.location === city);
      const daysReceived = cityLocation?.data?.length || 0;
      const missingDays: number[] = [];

      // We expect 7 days (0-6), track which are missing
      for (let day = 0; day < CONFIG.historyDays; day++) {
        if (day >= daysReceived) {
          missingDays.push(day);
        }
      }

      // If any days are missing, track the failure
      if (missingDays.length > 0) {
        const existing = progress.itemFailures.get(itemId);
        let reason: string;
        if (daysReceived === 0) {
          reason = 'No historical data returned by API (item may be rarely traded or new)';
        } else {
          reason = `Partial historical data: only ${daysReceived} of ${CONFIG.historyDays} days returned`;
        }

        const url = buildHistoricalUrl([itemId]);

        if (existing) {
          const allMissing = new Set([...existing.missingDays, ...missingDays]);
          progress.itemFailures.set(itemId, {
            missingDays: Array.from(allMissing).sort((a, b) => a - b),
            reason: existing.reason,
            url: existing.url,
          });
        } else {
          progress.itemFailures.set(itemId, {
            missingDays,
            reason,
            url,
          });
        }
      }

      const trendAnalysis = analyzePriceTrend(historicalData, city);
      dailyDemand = estimateDailyDemand(historicalData, city);
      price7dAvg = trendAnalysis.price7dAvg;
      dataAgeHours = trendAnalysis.dataAgeHours;
      priceTrendPct = trendAnalysis.priceTrendPct;
      supplySignal = trendAnalysis.supplySignal;
    }

    const availableCapacity = dailyDemand > 0 ? Math.round(dailyDemand * 2.5) : 0;
    const confidence =
      dataAgeHours < 12
        ? 95
        : dataAgeHours < 24
        ? 80
        : dataAgeHours < 48
        ? 60
        : 40;
    const marketSignal =
      supplySignal === '🟢 Rising' ? 'GOOD' : supplySignal === '🟡 Stable' ? 'FAIR' : 'POOR';

    progress.marketData.push({
      itemId,
      city,
      dailyDemand,
      lowestSellPrice: priceRecord.sell_price_min || 0,
      price7dAvg,
      dataAgeHours,
      confidence,
      availableCapacity,
      priceTrendPct,
      supplySignal,
      marketSignal,
    });
  });

  // Mark all items as processed
  itemsToProcess.forEach((item) => progress.processedItems.push(item));
  saveProgress(progress);

  console.log('✅ Fetching complete!\n');

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

  // Write detailed failure report
  if (progress.itemFailures.size > 0) {
    console.log('\n========================================');
    console.log('FAILURE REPORT');
    console.log('========================================\n');
    console.log(`Total items with failures: ${progress.itemFailures.size}`);
    console.log(`Total missing days: ${calculateFailures(progress.itemFailures).daysFailed}\n`);

    console.log('Items with missing days:\n');
    const sortedFailures = Array.from(progress.itemFailures.entries()).sort((a, b) =>
      b[1].missingDays.length - a[1].missingDays.length
    );

    sortedFailures.slice(0, 50).forEach(([itemId, failure]) => {
      const daysStr = failure.missingDays.map(d => `Day ${d}`).join(', ');
      console.log(`  ${itemId}: Missing ${failure.missingDays.length} days [${daysStr}]`);
      console.log(`    Reason: ${failure.reason}`);
    });

    if (sortedFailures.length > 50) {
      console.log(`\n  ... and ${sortedFailures.length - 50} more items\n`);
    }

    // Write detailed failures to file
    const failuresForFile = Object.fromEntries(progress.itemFailures);
    fs.writeFileSync(
      path.join(outputDir, 'item-failures.json'),
      JSON.stringify(failuresForFile, null, 2)
    );
    console.log(`\nDetailed failure report saved to: ${path.join(outputDir, 'item-failures.json')}\n`);
  }

  // Clean up progress file
  if (fs.existsSync(CONFIG.resumeFromFile)) {
    fs.unlinkSync(CONFIG.resumeFromFile);
  }

  console.log(`✅ Done! Fetched ${progress.marketData.length} market records for ${progress.processedItems.length} items`);
  console.log(`Output: ${outputPath}`);
}
