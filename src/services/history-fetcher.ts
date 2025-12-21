// history-fetcher.ts
// Incremental fetcher for historical price data from AODP /charts endpoint
// Only fetches missing days, stores in SQLite for fast access

import * as https from 'https';
import { getOrderBookDb, CITY_TO_LOCATION } from './order-book-db';
import {
  parseRateLimitHeaders,
  calculateWaitTime,
  displayCountdown,
  DEFAULT_RATE_LIMIT_WAIT,
  RateLimitInfo,
} from '../utils/rate-limiter';
import { City } from '../types';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Load all items that need historical data
const itemsData = require('../constants/items.json') as Array<{ id: string; name: string }>;
const rawMaterials = require('../constants/raw-materials.json') as Array<{ id: string; name: string }>;
const refinedMaterials = require('../constants/refined-materials.json') as Array<{ id: string; name: string }>;
const artifacts = require('../constants/artifacts.json') as Array<{ id: string; name: string }>;
const alchemyDrops = require('../constants/alchemy-drops.json') as Array<{ id: string; name: string }>;

// Combine all items that need historical data
const ALL_ITEMS = [
  ...itemsData.map((item) => item.id),
  ...rawMaterials.map((item) => item.id),
  ...refinedMaterials.map((item) => item.id),
  ...artifacts.map((item) => item.id),
  ...alchemyDrops.map((item) => item.id),
];

// Deduplicate
const ITEMS = [...new Set(ALL_ITEMS)];

const CITIES: City[] = [
  'Caerleon',
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
];

// City name to location ID mapping (primary market only)
const CITY_TO_PRIMARY_LOCATION: Record<City, number> = {
  'Thetford': 7,
  'Martlock': 301,
  'Fort Sterling': 1002,
  'Lymhurst': 1006,
  'Bridgewatch': 3003,
  'Caerleon': 4002,
  'Brecilien': 5003,
};

interface FetchConfig {
  maxRetries: number;
  initialRetryDelay: number;
  maxRetryDelay: number;
  backoffMultiplier: number;
  jitterRange: number;
  requestTimeout: number;
  historyDays: number;
}

const CONFIG: FetchConfig = {
  maxRetries: 5,
  initialRetryDelay: 2000,
  maxRetryDelay: 60000,
  backoffMultiplier: 2,
  jitterRange: 0.3,
  requestTimeout: 15000,
  historyDays: 30,
};

const MAX_URL_LENGTH = 8000;

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

interface PriceHistoryRecord {
  itemId: string;
  locationId: number;
  date: string;
  avgPrice: number;
  itemCount: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function addJitter(delay: number): number {
  const jitter = delay * CONFIG.jitterRange;
  return delay + (Math.random() * 2 - 1) * jitter;
}

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

function transformChartsResponse(rawData: AODPChartRawResponse[]): PriceHistoryRecord[] {
  const records: PriceHistoryRecord[] = [];

  for (const response of rawData) {
    const { item_id, location, quality, data } = response;

    // Only process Normal quality (1)
    if (quality !== 1) continue;

    if (!data || !data.timestamps || data.timestamps.length === 0) {
      continue;
    }

    // Find the location ID for this city name
    const locationId = CITY_TO_PRIMARY_LOCATION[location as City];
    if (!locationId) continue;

    // Convert each timestamp to a record
    for (let i = 0; i < data.timestamps.length; i++) {
      const timestamp = data.timestamps[i];
      const date = timestamp.split('T')[0]; // Extract YYYY-MM-DD
      const avgPrice = Math.round(data.prices_avg[i] || 0);
      const itemCount = data.item_count[i] || 0;

      if (avgPrice > 0) {
        records.push({
          itemId: item_id,
          locationId,
          date,
          avgPrice,
          itemCount,
        });
      }
    }
  }

  return records;
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Check if we need to fetch historical data
 * Returns the dates that are missing
 */
export function checkHistoryStatus(): {
  totalRecords: number;
  latestDate: string | null;
  missingDates: string[];
  needsFetch: boolean;
} {
  const db = getOrderBookDb();
  const totalRecords = db.getPriceHistoryCount();
  const latestDate = db.getLatestHistoryDate();
  const missingDates = db.getMissingHistoryDates(CONFIG.historyDays);

  return {
    totalRecords,
    latestDate,
    missingDates,
    needsFetch: missingDates.length > 0,
  };
}

/**
 * Fetch historical data for specific date range
 */
async function fetchHistoricalData(
  dateFrom: string,
  dateTo: string,
  batchIndex: number,
  totalBatches: number,
  itemBatches: string[][]
): Promise<PriceHistoryRecord[]> {
  const locationsParam = CITIES.join(',');
  const allRecords: PriceHistoryRecord[] = [];
  const totalRequests = totalBatches * itemBatches.length;

  for (let i = 0; i < itemBatches.length; i++) {
    const batch = itemBatches[i];
    const itemsParam = batch.join(',');
    const url = `https://europe.albion-online-data.com/api/v2/stats/charts/${itemsParam}?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;

    const currentRequest = batchIndex * itemBatches.length + i + 1;
    const progressMessage = `Fetching... request ${currentRequest}/${totalRequests}`;
    process.stdout.write(`\r   ${progressMessage}                    `);

    const result = await fetchWithRetry<AODPChartRawResponse[]>(url, progressMessage);

    if (result.success && result.data) {
      const records = transformChartsResponse(result.data);
      allRecords.push(...records);
    }
  }

  return allRecords;
}

/**
 * Fetch and store missing historical data
 * This is the main entry point called on CLI startup
 */
export async function fetchMissingHistory(): Promise<{
  fetchedDates: string[];
  recordsAdded: number;
  skipped: boolean;
}> {
  const status = checkHistoryStatus();

  if (!status.needsFetch) {
    return {
      fetchedDates: [],
      recordsAdded: 0,
      skipped: true,
    };
  }

  const db = getOrderBookDb();
  const missingDates = status.missingDates.sort(); // Oldest first

  // Create item batches first to know how many API requests we need
  const locationsParam = CITIES.join(',');
  const historyBaseUrl = 'https://europe.albion-online-data.com/api/v2/stats/charts/';
  // Use the longest possible query params for batch calculation
  const historyQueryParams = `?time-scale=24&locations=${locationsParam}&date=2024-01-01&end_date=2024-01-31`;
  const itemBatches = createBatchesByUrlLength(ITEMS, historyBaseUrl, historyQueryParams);

  // Display what we're fetching
  console.log(`\n   Missing dates: ${missingDates.join(', ')}`);
  console.log(`   This requires ${itemBatches.length} API requests (${ITEMS.length} items across ${CITIES.length} cities)`);

  // Group missing dates into contiguous ranges for efficient fetching
  const dateRanges: Array<{ from: string; to: string }> = [];
  let rangeStart = missingDates[0];
  let rangeEnd = missingDates[0];

  for (let i = 1; i < missingDates.length; i++) {
    const prevDate = new Date(missingDates[i - 1]);
    const currDate = new Date(missingDates[i]);
    const diffDays = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);

    if (diffDays === 1) {
      // Contiguous, extend the range
      rangeEnd = missingDates[i];
    } else {
      // Gap found, save current range and start new one
      dateRanges.push({ from: rangeStart, to: rangeEnd });
      rangeStart = missingDates[i];
      rangeEnd = missingDates[i];
    }
  }
  // Don't forget the last range
  dateRanges.push({ from: rangeStart, to: rangeEnd });

  let totalRecordsAdded = 0;
  const fetchedDates: string[] = [];

  for (let rangeIdx = 0; rangeIdx < dateRanges.length; rangeIdx++) {
    const range = dateRanges[rangeIdx];
    const records = await fetchHistoricalData(
      range.from,
      range.to,
      rangeIdx,
      dateRanges.length,
      itemBatches
    );

    if (records.length > 0) {
      db.insertPriceHistory(records);
      totalRecordsAdded += records.length;

      // Track which dates were fetched
      const datesInRange = missingDates.filter(d => d >= range.from && d <= range.to);
      fetchedDates.push(...datesInRange);
    }
  }

  console.log(`\n   Done! Added ${totalRecordsAdded.toLocaleString()} records for ${fetchedDates.length} date(s)`);

  // Clean up old data
  const cleaned = db.cleanupOldHistory(CONFIG.historyDays);
  if (cleaned > 0) {
    console.log(`   Cleaned up ${cleaned.toLocaleString()} old records`);
  }

  return {
    fetchedDates,
    recordsAdded: totalRecordsAdded,
    skipped: false,
  };
}

/**
 * Display a summary of the current history data status
 */
export function displayHistoryStatus(): void {
  const status = checkHistoryStatus();

  console.log('\n--- HISTORICAL DATA STATUS ---');
  console.log(`   Total records: ${status.totalRecords.toLocaleString()}`);
  console.log(`   Latest date: ${status.latestDate || 'None'}`);
  console.log(`   Missing dates: ${status.missingDates.length}`);

  if (status.missingDates.length > 0 && status.missingDates.length <= 5) {
    console.log(`   Missing: ${status.missingDates.join(', ')}`);
  } else if (status.missingDates.length > 5) {
    console.log(`   Missing: ${status.missingDates.slice(0, 3).join(', ')} ... and ${status.missingDates.length - 3} more`);
  }
}
