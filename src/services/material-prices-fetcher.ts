// material-prices-fetcher.ts
// Fetches material prices from AODP API (current + 30-day historical for analysis)

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
import { City, MaterialPrice } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Load materials from separate category files
const rawMaterials = require('../constants/raw-materials.json') as Array<{ id: string; name: string }>;
const refinedMaterials = require('../constants/refined-materials.json') as Array<{ id: string; name: string }>;
const artifacts = require('../constants/artifacts.json') as Array<{ id: string; name: string }>;
const alchemyDrops = require('../constants/alchemy-drops.json') as Array<{ id: string; name: string }>;

const allMaterialsData = [...rawMaterials, ...refinedMaterials, ...artifacts, ...alchemyDrops];
const MATERIALS = allMaterialsData.map((m) => m.id);

// Create a lookup map for material names
const materialNameMap = new Map<string, string>();
allMaterialsData.forEach((m) => materialNameMap.set(m.id, m.name));

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
  maxRetries: 5,
  initialRetryDelay: 2000,
  maxRetryDelay: 60000,
  backoffMultiplier: 2,
  jitterRange: 0.3,
  requestTimeout: 15000,
  resumeFromFile: path.join(process.cwd(), 'src', 'db', 'progress', 'material-prices-progress.json'),
  historyDays: 30,
};

const MAX_URL_LENGTH = 8000; // Safety margin below 8192 limit

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

interface AODPPriceRecord {
  item_id: string;
  city: string;
  quality: number;
  sell_price_min: number;
  buy_price_max: number;
  sell_price_min_date: string;
}

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

interface AODPChartLocationData {
  location: string;
  data: Array<{
    timestamp: number;
    avg_price: number;
    item_count: number;
  }>;
}

// Price analysis output structure
export interface MaterialPriceAnalysis {
  materialId: string;
  materialName: string;
  category: string;
  bestCity: City;
  currentPrice: number;
  price30dAvg: number;
  pctFromAvg: number;
  signal: '🟢 BUY' | '🟡 FAIR' | '🔴 HIGH';
  dataAgeHours: number;
  allCityPrices: Record<string, { price: number; avg: number; pct: number }>;
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

function makeHttpsRequest<T = any>(url: string): Promise<FetchResult<T>> {
  return new Promise((resolve) => {
    const request = https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data) as T;
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

async function fetchWithRetry<T = any>(
  url: string,
  progressMessage?: string,
  attempt: number = 1
): Promise<FetchResult<T>> {
  const result = await makeHttpsRequest<T>(url);

  if (result.success) {
    return result;
  }

  const isRateLimited = result.statusCode === 429;

  if (!result.retryable || (!isRateLimited && attempt >= CONFIG.maxRetries)) {
    return result;
  }

  if (isRateLimited) {
    const waitSeconds = result.rateLimitInfo
      ? calculateWaitTime(result.rateLimitInfo)
      : DEFAULT_RATE_LIMIT_WAIT;

    await displayCountdown(waitSeconds, progressMessage || 'Rate limited');
  } else {
    const baseDelay = CONFIG.initialRetryDelay * Math.pow(CONFIG.backoffMultiplier, attempt - 1);
    const delayWithJitter = addJitter(Math.min(baseDelay, CONFIG.maxRetryDelay));
    const waitSeconds = Math.round(delayWithJitter / 1000);

    await displayCountdown(waitSeconds, `Retry ${attempt}/${CONFIG.maxRetries}`);
  }

  const nextAttempt = isRateLimited ? attempt : attempt + 1;
  return fetchWithRetry<T>(url, progressMessage, nextAttempt);
}

async function fetchCurrentPrices(
  materialsBatch: string[],
  batchIndex?: number,
  totalBatches?: number
): Promise<FetchResult<AODPPriceRecord[]>> {
  const itemsParam = materialsBatch.join(',');
  const locationsParam = CITIES.join(',');
  const url = `https://europe.albion-online-data.com/api/v2/stats/prices/${itemsParam}?locations=${locationsParam}`;

  let progressMessage: string | undefined;
  if (batchIndex !== undefined && totalBatches !== undefined) {
    const percentComplete = Math.round(((batchIndex + 1) / totalBatches) * 100);
    progressMessage = `Fetching current prices... ${percentComplete}% (${batchIndex + 1}/${totalBatches})`;
    process.stdout.write(`\r   ${progressMessage}`);
  }

  return fetchWithRetry<AODPPriceRecord[]>(url, progressMessage);
}

async function fetchHistoricalPrices(
  materialsBatch: string[],
  batchIndex?: number,
  totalBatches?: number
): Promise<FetchResult<Record<string, AODPChartLocationData[]>>> {
  const itemsParam = materialsBatch.join(',');
  const locationsParam = CITIES.join(',');
  const dateFrom = calculateDaysAgo(CONFIG.historyDays);
  const dateTo = new Date().toISOString().split('T')[0];
  const url = `https://europe.albion-online-data.com/api/v2/stats/charts/${itemsParam}?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;

  let progressMessage: string | undefined;
  if (batchIndex !== undefined && totalBatches !== undefined) {
    const percentComplete = Math.round(((batchIndex + 1) / totalBatches) * 100);
    progressMessage = `Fetching 30-day history... ${percentComplete}% (${batchIndex + 1}/${totalBatches})`;
    process.stdout.write(`\r   ${progressMessage}`);
  }

  const result = await fetchWithRetry<AODPChartRawResponse[]>(url, progressMessage);

  if (result.success && result.data) {
    const transformed = transformChartsResponse(result.data);
    return {
      ...result,
      data: transformed,
    };
  }

  return result as unknown as FetchResult<Record<string, AODPChartLocationData[]>>;
}

function transformChartsResponse(rawData: AODPChartRawResponse[]): Record<string, AODPChartLocationData[]> {
  const result: Record<string, AODPChartLocationData[]> = {};

  for (const record of rawData) {
    const { item_id, location, data } = record;

    if (!data || !data.timestamps || data.timestamps.length === 0) {
      continue;
    }

    const dataPoints = data.timestamps.map((ts, i) => ({
      timestamp: new Date(ts).getTime(),
      avg_price: data.prices_avg[i] || 0,
      item_count: data.item_count[i] || 0,
    }));

    if (!result[item_id]) {
      result[item_id] = [];
    }

    const existingLocation = result[item_id].find((loc) => loc.location === location);

    if (existingLocation) {
      for (const newPoint of dataPoints) {
        const existingPoint = existingLocation.data.find((p) => p.timestamp === newPoint.timestamp);
        if (existingPoint) {
          existingPoint.item_count += newPoint.item_count;
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

function calculate30dAverage(historicalData: AODPChartLocationData[], city: City): { avg: number; dataAgeHours: number } {
  if (!historicalData || historicalData.length === 0) {
    return { avg: 0, dataAgeHours: 999 };
  }

  const cityLocation = historicalData.find((loc) => loc.location === city);

  if (!cityLocation || !cityLocation.data || cityLocation.data.length === 0) {
    return { avg: 0, dataAgeHours: 999 };
  }

  const sortedData = [...cityLocation.data].sort((a, b) => b.timestamp - a.timestamp);
  const prices = sortedData.map((d) => d.avg_price).filter((p) => p > 0);

  if (prices.length === 0) {
    return { avg: 0, dataAgeHours: 999 };
  }

  const avg = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
  const dataAgeHours = Math.round((Date.now() - sortedData[0].timestamp) / (1000 * 60 * 60));

  return { avg, dataAgeHours };
}

function determinePriceSignal(pctFromAvg: number): '🟢 BUY' | '🟡 FAIR' | '🔴 HIGH' {
  if (pctFromAvg <= -10) return '🟢 BUY';
  if (pctFromAvg >= 10) return '🔴 HIGH';
  return '🟡 FAIR';
}

function categorizeMaterial(id: string): string {
  const baseId = id.replace(/_LEVEL[1-3]@[1-3]$/, '').replace(/@[1-4]$/, '');

  if (/^T\d_(ORE|WOOD|ROCK|HIDE|FIBER)$/.test(baseId)) return 'raw';
  if (/_CLOTH$|_LEATHER$|_METALBAR$|_PLANKS$|_STONEBLOCK$/.test(baseId)) return 'refined';
  if (/^T\d_(CLOTH|LEATHER|METALBAR|PLANKS|STONEBLOCK)$/.test(baseId)) return 'refined';
  if (id.includes('ARTEFACT_')) return 'artifact';
  if (id.includes('ALCHEMY_RARE_')) return 'alchemy';
  return 'other';
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function fetchAllMaterialPrices(): Promise<void> {
  console.log(`\n📊 Fetching material prices for ${MATERIALS.length} materials across ${CITIES.length} cities...\n`);

  const locationsParam = CITIES.join(',');

  // Create URL-length-aware batches for prices endpoint
  const pricesBaseUrl = 'https://europe.albion-online-data.com/api/v2/stats/prices/';
  const pricesQueryParams = `?locations=${locationsParam}`;
  const priceBatches = createBatchesByUrlLength(MATERIALS, pricesBaseUrl, pricesQueryParams);

  // Create URL-length-aware batches for historical endpoint
  const dateFrom = calculateDaysAgo(CONFIG.historyDays);
  const dateTo = new Date().toISOString().split('T')[0];
  const historyBaseUrl = 'https://europe.albion-online-data.com/api/v2/stats/charts/';
  const historyQueryParams = `?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;
  const historyBatches = createBatchesByUrlLength(MATERIALS, historyBaseUrl, historyQueryParams);

  console.log(`📊 Current prices: ${priceBatches.length} requests`);
  console.log(`📊 30-day history: ${historyBatches.length} requests`);
  console.log(`📊 Total: ${priceBatches.length + historyBatches.length} requests\n`);

  // Step 1: Fetch current prices
  const allPriceData: AODPPriceRecord[] = [];
  for (let i = 0; i < priceBatches.length; i++) {
    const batch = priceBatches[i];
    const pricesResult = await fetchCurrentPrices(batch, i, priceBatches.length);

    if (pricesResult.success && pricesResult.data) {
      allPriceData.push(...pricesResult.data);
    }
  }
  console.log(`\n   ✅ Fetched ${allPriceData.length} price records\n`);

  // Step 2: Fetch historical prices
  const historicalDataMap = new Map<string, AODPChartLocationData[]>();
  for (let i = 0; i < historyBatches.length; i++) {
    const batch = historyBatches[i];
    const historyResult = await fetchHistoricalPrices(batch, i, historyBatches.length);

    if (historyResult.success && historyResult.data) {
      Object.entries(historyResult.data).forEach(([itemId, locationData]) => {
        historicalDataMap.set(itemId, locationData);
      });
    }
  }
  console.log(`\n   ✅ Fetched history for ${historicalDataMap.size} materials\n`);

  // Step 3: Process and analyze data
  console.log('📊 Analyzing price data...\n');

  // Filter for Normal quality (1) only
  const normalQualityPrices = allPriceData.filter((record) => record.quality === 1);

  // Build current price lookup: materialId -> city -> price
  const currentPriceMap = new Map<string, Map<City, number>>();
  for (const record of normalQualityPrices) {
    if (!currentPriceMap.has(record.item_id)) {
      currentPriceMap.set(record.item_id, new Map());
    }
    if (record.sell_price_min > 0) {
      currentPriceMap.get(record.item_id)!.set(record.city as City, record.sell_price_min);
    }
  }

  // Generate price analysis for each material
  const analyses: MaterialPriceAnalysis[] = [];

  for (const materialId of MATERIALS) {
    const cityPrices = currentPriceMap.get(materialId);
    const historicalData = historicalDataMap.get(materialId) || [];

    if (!cityPrices || cityPrices.size === 0) {
      continue; // Skip materials with no price data
    }

    // Calculate 30-day average for each city and find best opportunity
    const allCityPrices: Record<string, { price: number; avg: number; pct: number }> = {};
    let bestCity: City = 'Caerleon';
    let bestPctFromAvg = Infinity;
    let bestCurrentPrice = 0;
    let best30dAvg = 0;
    let bestDataAgeHours = 999;

    for (const city of CITIES) {
      const currentPrice = cityPrices.get(city);
      if (!currentPrice || currentPrice === 0) continue;

      const { avg, dataAgeHours } = calculate30dAverage(historicalData, city);

      if (avg > 0) {
        const pctFromAvg = ((currentPrice - avg) / avg) * 100;

        allCityPrices[city] = {
          price: currentPrice,
          avg,
          pct: parseFloat(pctFromAvg.toFixed(1)),
        };

        // Track best opportunity (lowest pct from avg)
        if (pctFromAvg < bestPctFromAvg) {
          bestPctFromAvg = pctFromAvg;
          bestCity = city;
          bestCurrentPrice = currentPrice;
          best30dAvg = avg;
          bestDataAgeHours = dataAgeHours;
        }
      }
    }

    // Only include materials where we have both current price and historical data
    if (bestCurrentPrice > 0 && best30dAvg > 0) {
      analyses.push({
        materialId,
        materialName: materialNameMap.get(materialId) || materialId,
        category: categorizeMaterial(materialId),
        bestCity,
        currentPrice: bestCurrentPrice,
        price30dAvg: best30dAvg,
        pctFromAvg: parseFloat(bestPctFromAvg.toFixed(1)),
        signal: determinePriceSignal(bestPctFromAvg),
        dataAgeHours: bestDataAgeHours,
        allCityPrices,
      });
    }
  }

  // Ensure output directory exists
  const outputDir = path.join(process.cwd(), 'src', 'db');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write material prices (basic data for other features)
  const basicPrices: MaterialPrice[] = [];
  for (const record of normalQualityPrices) {
    basicPrices.push({
      materialId: record.item_id,
      city: record.city as City,
      sellPriceMin: record.sell_price_min || 0,
      buyPriceMax: record.buy_price_max || 0,
      lastUpdated: record.sell_price_min_date || '',
    });
  }

  const pricesPath = path.join(outputDir, 'material-prices.json');
  fs.writeFileSync(pricesPath, JSON.stringify(basicPrices, null, 2));

  // Write price analysis (for material buy opportunities)
  const analysisPath = path.join(outputDir, 'material-price-analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analyses, null, 2));

  // Summary
  const buyCount = analyses.filter((a) => a.signal === '🟢 BUY').length;
  const fairCount = analyses.filter((a) => a.signal === '🟡 FAIR').length;
  const highCount = analyses.filter((a) => a.signal === '🔴 HIGH').length;

  console.log(`✅ Done! Analyzed ${analyses.length} materials`);
  console.log(`   🟢 BUY: ${buyCount} | 🟡 FAIR: ${fairCount} | 🔴 HIGH: ${highCount}`);
  console.log(`\n   Output:`);
  console.log(`   - ${pricesPath}`);
  console.log(`   - ${analysisPath}\n`);
}
