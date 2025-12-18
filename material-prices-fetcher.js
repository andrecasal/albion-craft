// material-prices-fetcher.js
// Fetches material prices from AODP API

const https = require('https');
const fs = require('fs');

// ============================================================================
// CONFIGURATION
// ============================================================================

const MATERIALS = require('./materials-list.js');

const CITIES = [
  'Caerleon',
  'Bridgewatch', 
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien'
];

const CONFIG = {
  batchSize: 50,              // Materials per API call
  delayBetweenBatches: 1000,  // 1 second between batches
  maxRetries: 5,
  initialRetryDelay: 2000,
  maxRetryDelay: 60000,
  backoffMultiplier: 2,
  jitterRange: 0.3,
  requestTimeout: 15000,
  resumeFromFile: 'material-prices-progress.json'
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addJitter(delay) {
  const jitter = delay * CONFIG.jitterRange;
  return delay + (Math.random() * 2 - 1) * jitter;
}

function fetchPrices(materialsBatch) {
  return new Promise((resolve) => {
    const itemsParam = materialsBatch.join(',');
    const locationsParam = CITIES.join(',');
    const url = `https://west.albion-online-data.com/api/v2/stats/prices/${itemsParam}?locations=${locationsParam}`;
    
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
              statusCode: 200
            });
          } catch (e) {
            resolve({ 
              success: false, 
              error: `Parse error: ${e.message}`,
              statusCode: 200,
              retryable: false
            });
          }
        } else if (res.statusCode === 429) {
          resolve({ 
            success: false, 
            error: 'Rate limited',
            statusCode: 429,
            retryable: true
          });
        } else if (res.statusCode >= 500) {
          resolve({ 
            success: false, 
            error: `Server error ${res.statusCode}`,
            statusCode: res.statusCode,
            retryable: true
          });
        } else {
          resolve({ 
            success: false, 
            error: `HTTP ${res.statusCode}`,
            statusCode: res.statusCode,
            retryable: false
          });
        }
      });
    });
    
    request.on('error', (err) => {
      resolve({ 
        success: false, 
        error: err.message,
        retryable: true
      });
    });
    
    request.setTimeout(CONFIG.requestTimeout, () => {
      request.destroy();
      resolve({ 
        success: false, 
        error: 'Timeout',
        retryable: true
      });
    });
  });
}

async function fetchPricesWithRetry(materialsBatch, attempt = 1) {
  const result = await fetchPrices(materialsBatch);
  
  if (result.success) {
    return result;
  }
  
  if (!result.retryable || attempt >= CONFIG.maxRetries) {
    return result;
  }
  
  const baseDelay = CONFIG.initialRetryDelay * Math.pow(CONFIG.backoffMultiplier, attempt - 1);
  const delayWithJitter = addJitter(Math.min(baseDelay, CONFIG.maxRetryDelay));
  
  console.log(`    🔄 Retry ${attempt}/${CONFIG.maxRetries} after ${(delayWithJitter/1000).toFixed(1)}s (${result.error})`);
  
  await sleep(delayWithJitter);
  
  return fetchPricesWithRetry(materialsBatch, attempt + 1);
}

function loadProgress() {
  try {
    if (fs.existsSync(CONFIG.resumeFromFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.resumeFromFile, 'utf8'));
      console.log(`\n✓ Resuming from ${CONFIG.resumeFromFile}`);
      console.log(`  Already processed: ${data.processedMaterials.length} materials`);
      console.log(`  Price records: ${data.prices.length}\n`);
      return data;
    }
  } catch (e) {
    console.log(`⚠️  Could not load progress file: ${e.message}`);
  }
  
  return {
    processedMaterials: [],
    prices: [],
    errors: []
  };
}

function saveProgress(data) {
  fs.writeFileSync(CONFIG.resumeFromFile, JSON.stringify(data, null, 2));
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function fetchAllMaterialPrices() {
  console.log('========================================');
  console.log('MATERIAL PRICES FETCHER');
  console.log('========================================');
  console.log(`Total materials: ${MATERIALS.length}`);
  console.log(`Cities: ${CITIES.length}`);
  console.log(`Batch size: ${CONFIG.batchSize}`);
  console.log(`Max expected records: ${MATERIALS.length * CITIES.length}`);
  console.log('');
  
  const progress = loadProgress();
  const processedSet = new Set(progress.processedMaterials);
  
  const materialsToProcess = MATERIALS.filter(m => !processedSet.has(m));
  
  if (materialsToProcess.length === 0) {
    console.log('✅ All materials already processed!');
    return;
  }
  
  console.log(`Materials remaining: ${materialsToProcess.length}`);
  console.log(`Progress: ${((progress.processedMaterials.length / MATERIALS.length) * 100).toFixed(1)}%`);
  console.log('');
  
  const startTime = Date.now();
  
  for (let i = 0; i < materialsToProcess.length; i += CONFIG.batchSize) {
    const batch = materialsToProcess.slice(i, Math.min(i + CONFIG.batchSize, materialsToProcess.length));
    const batchNum = Math.floor(i / CONFIG.batchSize) + 1;
    const totalBatches = Math.ceil(materialsToProcess.length / CONFIG.batchSize);
    
    console.log(`[Batch ${batchNum}/${totalBatches}] Fetching prices for ${batch.length} materials...`);
    
    const result = await fetchPricesWithRetry(batch);
    
    if (result.success) {
      // Process the price data
      result.data.forEach(priceRecord => {
        progress.prices.push({
          materialId: priceRecord.item_id,
          city: priceRecord.city,
          sellPriceMin: priceRecord.sell_price_min || 0,
          buyPriceMax: priceRecord.buy_price_max || 0,
          lastUpdated: priceRecord.sell_price_min_date || ''
        });
      });
      
      // Mark all materials in batch as processed
      batch.forEach(material => {
        progress.processedMaterials.push(material);
      });
      
      console.log(`  ✓ Fetched ${result.data.length} price records`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
      progress.errors.push({
        materials: batch,
        error: result.error,
        statusCode: result.statusCode
      });
    }
    
    const totalProcessed = progress.processedMaterials.length;
    const percentComplete = ((totalProcessed / MATERIALS.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    
    console.log(`  Progress: ${totalProcessed}/${MATERIALS.length} (${percentComplete}%) | Elapsed: ${elapsed}s`);
    console.log(`  Total price records: ${progress.prices.length}`);
    
    // Save progress
    saveProgress(progress);
    console.log(`  💾 Progress saved`);
    console.log('');
    
    // Delay between batches
    if (i + CONFIG.batchSize < materialsToProcess.length) {
      await sleep(CONFIG.delayBetweenBatches);
    }
  }
  
  console.log('========================================');
  console.log('FETCH COMPLETE');
  console.log('========================================');
  console.log(`Materials processed: ${progress.processedMaterials.length}`);
  console.log(`Price records: ${progress.prices.length}`);
  console.log(`Errors: ${progress.errors.length}`);
  console.log('');
  
  // Write output files
  console.log('Writing output files...');
  
  fs.writeFileSync('material-prices.json', JSON.stringify(progress.prices, null, 2));
  console.log('✓ material-prices.json created');
  
  if (progress.errors.length > 0) {
    fs.writeFileSync('material-prices-errors.json', JSON.stringify(progress.errors, null, 2));
    console.log('✓ material-prices-errors.json created');
  }
  
  // Create CSV
  const csv = progress.prices.map(p => 
    `${p.materialId},${p.city},${p.sellPriceMin},${p.buyPriceMax},${p.lastUpdated}`
  ).join('\n');
  
  fs.writeFileSync('material-prices.csv',
    'Material_ID,City,Sell_Price_Min,Buy_Price_Max,Last_Updated\n' + csv
  );
  console.log('✓ material-prices.csv created');
  
  // Clean up progress file
  if (fs.existsSync(CONFIG.resumeFromFile)) {
    fs.unlinkSync(CONFIG.resumeFromFile);
    console.log('✓ Progress file cleaned up');
  }
  
  console.log('\n✅ Done! Import material-prices.csv or material-prices.json into Google Sheets.');
}

// ============================================================================
// RUN
// ============================================================================

fetchAllMaterialPrices().catch(err => {
  console.error('Fatal error:', err);
  console.error('\n⚠️  Progress has been saved. Run again to resume.');
  process.exit(1);
});
