// hourly-fetcher.ts
// Fetches hourly price data from AODP /charts endpoint with time-scale=1
// Used for intraday arbitrage analysis

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

// Load all items that need hourly data
const itemsData = require('../constants/items.json') as Array<{ id: string; name: string }>;
const rawMaterials = require('../constants/raw-materials.json') as Array<{ id: string; name: string }>;
const refinedMaterials = require('../constants/refined-materials.json') as Array<{ id: string; name: string }>;

// For hourly data, focus on tradeable items (finished goods + refined materials)
// Raw materials and artifacts change less frequently
const ALL_ITEMS = [
  ...itemsData.map((item) => item.id),
  ...refinedMaterials.map((item) => item.id),
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
}

const CONFIG: FetchConfig = {
  maxRetries: 5,
  initialRetryDelay: 2000,
  maxRetryDelay: 60000,
  backoffMultiplier: 2,
  jitterRange: 0.3,
  requestTimeout: 15000,
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

interface HourlyPriceRecord {
  itemId: string;
  locationId: number;
  timestamp: string;
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

function transformChartsResponse(rawData: AODPChartRawResponse[]): HourlyPriceRecord[] {
  const records: HourlyPriceRecord[] = [];

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
      const avgPrice = Math.round(data.prices_avg[i] || 0);
      const itemCount = data.item_count[i] || 0;

      if (avgPrice > 0) {
        records.push({
          itemId: item_id,
          locationId,
          timestamp,
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
 * Check if we need to fetch hourly data
 * Returns true if data is stale (older than 1 hour) or missing
 */
export function checkHourlyHistoryStatus(): {
  totalRecords: number;
  latestTimestamp: string | null;
  hoursOld: number | null;
  needsFetch: boolean;
  uniqueItems: number;
} {
  const db = getOrderBookDb();
  const totalRecords = db.getHourlyPriceHistoryCount();
  const latestTimestamp = db.getLatestHourlyHistoryTimestamp();
  const uniqueItems = db.getHourlyHistoryItemCount();

  let hoursOld: number | null = null;
  let needsFetch = true;

  if (latestTimestamp) {
    const latestDate = new Date(latestTimestamp);
    const now = new Date();
    hoursOld = Math.round((now.getTime() - latestDate.getTime()) / (1000 * 60 * 60));
    // Refresh if data is older than 1 hour
    needsFetch = hoursOld >= 1;
  }

  return {
    totalRecords,
    latestTimestamp,
    hoursOld,
    needsFetch,
    uniqueItems,
  };
}

/**
 * Fetch hourly data for the last 24 hours
 */
export async function fetchHourlyHistory(): Promise<{
  recordsAdded: number;
  skipped: boolean;
}> {
  const status = checkHourlyHistoryStatus();

  if (!status.needsFetch) {
    return {
      recordsAdded: 0,
      skipped: true,
    };
  }

  const db = getOrderBookDb();

  // Calculate date range for last 24 hours
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Format dates for API (YYYY-MM-DD)
  const dateFrom = yesterday.toISOString().split('T')[0];
  const dateTo = now.toISOString().split('T')[0];

  // Create item batches
  const locationsParam = CITIES.join(',');
  const baseUrl = 'https://europe.albion-online-data.com/api/v2/stats/charts/';
  const queryParams = `?time-scale=1&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`;
  const itemBatches = createBatchesByUrlLength(ITEMS, baseUrl, queryParams);

  console.log(`   Fetching hourly data for ${ITEMS.length} items across ${CITIES.length} cities...`);
  console.log(`   This requires ${itemBatches.length} API requests`);

  let totalRecordsAdded = 0;

  for (let i = 0; i < itemBatches.length; i++) {
    const batch = itemBatches[i];
    const itemsParam = batch.join(',');
    const url = `${baseUrl}${itemsParam}${queryParams}`;

    const progressMessage = `Fetching... batch ${i + 1}/${itemBatches.length}`;
    process.stdout.write(`\r   ${progressMessage}                    `);

    const result = await fetchWithRetry<AODPChartRawResponse[]>(url, progressMessage);

    if (result.success && result.data) {
      const records = transformChartsResponse(result.data);
      if (records.length > 0) {
        db.insertHourlyPriceHistory(records);
        totalRecordsAdded += records.length;
      }
    }
  }

  process.stdout.write('\r   Done!                                            \n');

  // Clean up old data (keep 48 hours for trend analysis)
  const cleaned = db.cleanupOldHourlyHistory(48);
  if (cleaned > 0) {
    console.log(`   Cleaned up ${cleaned.toLocaleString()} old hourly records`);
  }

  console.log(`   Added ${totalRecordsAdded.toLocaleString()} hourly price records`);

  return {
    recordsAdded: totalRecordsAdded,
    skipped: false,
  };
}

/**
 * Display a summary of the current hourly history data status
 */
export function displayHourlyHistoryStatus(): void {
  const status = checkHourlyHistoryStatus();

  console.log('\n--- HOURLY DATA STATUS ---');
  console.log(`   Total records: ${status.totalRecords.toLocaleString()}`);
  console.log(`   Unique items: ${status.uniqueItems.toLocaleString()}`);
  console.log(`   Latest timestamp: ${status.latestTimestamp || 'None'}`);
  if (status.hoursOld !== null) {
    console.log(`   Data age: ${status.hoursOld} hour(s) old`);
  }
  console.log(`   Needs refresh: ${status.needsFetch ? 'Yes' : 'No'}`);
}
