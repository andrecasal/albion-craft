// material-prices-fetcher.ts
// Fetches material prices from AODP API

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

const materialsData = require('../constants/materials.json') as Array<{ id: string; name: string }>;
const MATERIALS = materialsData.map((m) => m.id);

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
};

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
  processedMaterials: string[];
  prices: MaterialPrice[];
  errors: Array<{
    materials: string[];
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

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function addJitter(delay: number): number {
  const jitter = delay * CONFIG.jitterRange;
  return delay + (Math.random() * 2 - 1) * jitter;
}

function makeHttpsRequest(url: string): Promise<FetchResult<AODPPriceRecord[]>> {
  return new Promise((resolve) => {
    const request = https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data) as AODPPriceRecord[];
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
): Promise<FetchResult<AODPPriceRecord[]>> {
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

async function fetchPrices(materialsBatch: string[]): Promise<FetchResult<AODPPriceRecord[]>> {
  const itemsParam = materialsBatch.join(',');
  const locationsParam = CITIES.join(',');
  const url = `https://europe.albion-online-data.com/api/v2/stats/prices/${itemsParam}?locations=${locationsParam}`;

  return fetchWithRetry(url);
}

function loadProgress(): Progress {
  try {
    if (fs.existsSync(CONFIG.resumeFromFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.resumeFromFile, 'utf8')) as Progress;
      console.log(`\n✓ Resuming from ${CONFIG.resumeFromFile}`);
      console.log(`  Already processed: ${data.processedMaterials.length} materials`);
      console.log(`  Price records: ${data.prices.length}\n`);
      return data;
    }
  } catch (e) {
    const error = e as Error;
    console.log(`⚠️  Could not load progress file: ${error.message}`);
  }

  return {
    processedMaterials: [],
    prices: [],
    errors: [],
  };
}

function saveProgress(data: Progress): void {
  fs.writeFileSync(CONFIG.resumeFromFile, JSON.stringify(data, null, 2));
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export async function fetchAllMaterialPrices(): Promise<void> {
  const progress = loadProgress();
  const processedSet = new Set(progress.processedMaterials);
  const materialsToProcess = MATERIALS.filter((m) => !processedSet.has(m));

  if (materialsToProcess.length === 0) {
    console.log('✅ All materials already fetched');
    return;
  }

  console.log(`Fetching prices for ${materialsToProcess.length} materials across ${CITIES.length} cities...`);
  console.log('(Going as fast as possible - will pause if rate limited)\n');

  const totalBatches = Math.ceil(materialsToProcess.length / CONFIG.batchSize);

  for (let i = 0; i < materialsToProcess.length; i += CONFIG.batchSize) {
    const batch = materialsToProcess.slice(i, Math.min(i + CONFIG.batchSize, materialsToProcess.length));
    const batchNum = Math.floor(i / CONFIG.batchSize) + 1;

    // Show progress
    const totalProcessed = progress.processedMaterials.length;
    const percentComplete = ((totalProcessed / MATERIALS.length) * 100).toFixed(1);
    const errorCount = progress.errors.reduce((sum, e) => sum + e.materials.length, 0);

    process.stdout.write(`\r📦 Batch ${batchNum}/${totalBatches} | ${percentComplete}% complete | ${errorCount} errors   `);

    const result = await fetchPrices(batch);

    if (result.success && result.data) {
      // Process the price data
      result.data.forEach((priceRecord) => {
        progress.prices.push({
          materialId: priceRecord.item_id,
          city: priceRecord.city as City,
          sellPriceMin: priceRecord.sell_price_min || 0,
          buyPriceMax: priceRecord.buy_price_max || 0,
          lastUpdated: priceRecord.sell_price_min_date || '',
        });
      });

      // Mark all materials in batch as processed
      batch.forEach((material) => {
        progress.processedMaterials.push(material);
      });
    } else {
      progress.errors.push({
        materials: batch,
        error: result.error || 'Unknown error',
        statusCode: result.statusCode,
      });
    }

    // Save progress
    saveProgress(progress);
  }

  // Clear the progress line and show completion
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  console.log('✅ Fetching complete!\n');

  // Ensure output directory exists
  const outputDir = path.join(process.cwd(), 'src', 'db');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write output files
  const outputPath = path.join(outputDir, 'material-prices.json');
  fs.writeFileSync(outputPath, JSON.stringify(progress.prices, null, 2));

  if (progress.errors.length > 0) {
    fs.writeFileSync('material-prices-errors.json', JSON.stringify(progress.errors, null, 2));
  }

  // Create CSV for easy import to Google Sheets
  const csv = progress.prices.map((p) => `${p.materialId},${p.city},${p.sellPriceMin},${p.buyPriceMax},${p.lastUpdated}`).join('\n');
  const csvPath = path.join(process.cwd(), 'src', 'db', 'material-prices.csv');

  fs.writeFileSync(csvPath, 'Material_ID,City,Sell_Price_Min,Buy_Price_Max,Last_Updated\n' + csv);

  // Clean up progress file
  if (fs.existsSync(CONFIG.resumeFromFile)) {
    fs.unlinkSync(CONFIG.resumeFromFile);
  }

  console.log(`✅ Done! Fetched ${progress.prices.length} prices for ${progress.processedMaterials.length} materials`);
  console.log(`Output: ${outputPath}`);
}
