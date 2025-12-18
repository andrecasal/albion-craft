// create-sample-market-data.js
// Creates a sample market-data.json for testing the profitability calculator

const fs = require('fs');

// Sample market data for common craftable items
const sampleMarketData = [
  {
    "itemId": "T4_BAG",
    "city": "Caerleon",
    "dailyDemand": 15.2,
    "lowestSellPrice": 8500,
    "price7dAvg": 8200,
    "dataAgeHours": 2.5,
    "confidence": 0.95,
    "availableCapacity": 152,
    "priceTrendPct": 3.66,
    "supplySignal": "🟢 Rising",
    "marketSignal": "Strong"
  },
  {
    "itemId": "T4_BAG",
    "city": "Bridgewatch",
    "dailyDemand": 12.3,
    "lowestSellPrice": 8800,
    "price7dAvg": 8300,
    "dataAgeHours": 1.8,
    "confidence": 0.92,
    "availableCapacity": 123,
    "priceTrendPct": 6.02,
    "supplySignal": "🟢 Rising",
    "marketSignal": "Strong"
  },
  {
    "itemId": "T5_BAG",
    "city": "Caerleon",
    "dailyDemand": 8.7,
    "lowestSellPrice": 15200,
    "price7dAvg": 15800,
    "dataAgeHours": 3.2,
    "confidence": 0.88,
    "availableCapacity": 87,
    "priceTrendPct": -3.8,
    "supplySignal": "🟡 Stable",
    "marketSignal": "Moderate"
  },
  {
    "itemId": "T6_BAG",
    "city": "Caerleon",
    "dailyDemand": 5.2,
    "lowestSellPrice": 28500,
    "price7dAvg": 32000,
    "dataAgeHours": 4.1,
    "confidence": 0.75,
    "availableCapacity": 52,
    "priceTrendPct": -10.94,
    "supplySignal": "🔴 Falling",
    "marketSignal": "Weak"
  }
];

// Instructions
console.log('========================================');
console.log('MARKET DATA SAMPLE CREATOR');
console.log('========================================\n');

console.log('This creates a minimal market-data.json file for testing.');
console.log('For production use, you need to export full market data from Google Sheets.\n');

console.log('Creating sample market-data.json...');
fs.writeFileSync('market-data.json', JSON.stringify(sampleMarketData, null, 2));
console.log('✓ market-data.json created with 4 sample items\n');

console.log('Sample items:');
sampleMarketData.forEach(item => {
  console.log(`  - ${item.itemId} in ${item.city}`);
});

console.log('\n========================================');
console.log('NEXT STEPS FOR PRODUCTION');
console.log('========================================\n');

console.log('To get full market data, you have two options:\n');

console.log('Option 1: MANUAL EXPORT FROM GOOGLE SHEETS');
console.log('  1. Open your Google Sheet');
console.log('  2. Go to MARKET_DATA sheet');
console.log('  3. File → Download → Comma-separated values (.csv)');
console.log('  4. Convert CSV to JSON using a tool or script\n');

console.log('Option 2: CREATE A MARKET DATA FETCHER (Recommended)');
console.log('  Create a script similar to material-prices-fetcher.js that:');
console.log('  1. Fetches price history from AODP API');
console.log('  2. Calculates daily demand from volume data');
console.log('  3. Calculates 7-day price average');
console.log('  4. Determines price trend & supply signal');
console.log('  5. Exports to market-data.json\n');

console.log('For now, you can test the profitability calculator with this sample data.');
console.log('Run: npm run dev\n');
