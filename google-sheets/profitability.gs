// ============================================================================
// EXTRACT UNIQUE MATERIALS FROM RECIPES
// ============================================================================

function extractUniqueMaterials() {
  Logger.log('========================================');
  Logger.log('EXTRACTING UNIQUE MATERIALS');
  Logger.log('========================================');
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const recipesSheet = ss.getSheetByName('CRAFTING_RECIPES');
  
  if (!recipesSheet) {
    SpreadsheetApp.getUi().alert('Error', 'CRAFTING_RECIPES sheet not found!', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const lastRow = recipesSheet.getLastRow();
  if (lastRow <= 1) {
    SpreadsheetApp.getUi().alert('Error', 'CRAFTING_RECIPES sheet is empty!', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  Logger.log(`Reading ${lastRow - 1} recipes...`);
  
  // Get all recipe data (skip header)
  const data = recipesSheet.getRange(2, 1, lastRow - 1, 11).getValues();
  
  // Extract unique materials
  const materialsSet = new Set();
  
  data.forEach(row => {
    // Material_1 (column B, index 1)
    if (row[1] && row[1].toString().trim() !== '') {
      materialsSet.add(row[1].toString().trim());
    }
    // Material_2 (column D, index 3)
    if (row[3] && row[3].toString().trim() !== '') {
      materialsSet.add(row[3].toString().trim());
    }
    // Material_3 (column F, index 5)
    if (row[5] && row[5].toString().trim() !== '') {
      materialsSet.add(row[5].toString().trim());
    }
    // Material_4 (column H, index 7)
    if (row[7] && row[7].toString().trim() !== '') {
      materialsSet.add(row[7].toString().trim());
    }
  });
  
  const uniqueMaterials = Array.from(materialsSet).sort();
  
  Logger.log(`Found ${uniqueMaterials.length} unique materials`);
  
  // Create MATERIALS sheet
  let materialsSheet = ss.getSheetByName('MATERIALS');
  if (!materialsSheet) {
    materialsSheet = ss.insertSheet('MATERIALS');
  } else {
    materialsSheet.clear();
  }
  
  // Write header
  materialsSheet.appendRow(['Material_ID']);
  materialsSheet.getRange(1, 1, 1, 1)
    .setFontWeight('bold')
    .setBackground('#4285F4')
    .setFontColor('white');
  
  // Write materials
  const materialsData = uniqueMaterials.map(m => [m]);
  materialsSheet.getRange(2, 1, materialsData.length, 1).setValues(materialsData);
  
  materialsSheet.setColumnWidth(1, 220);
  materialsSheet.setFrozenRows(1);
  
  Logger.log('========================================');
  Logger.log('✅ EXTRACTION COMPLETE');
  Logger.log('========================================');
  
  SpreadsheetApp.getUi().alert(
    '✅ Materials Extracted!',
    `Found ${uniqueMaterials.length} unique materials from ${lastRow - 1} recipes.\n\n` +
    `Sheet: MATERIALS\n\n` +
    `Next: Fetch prices for these materials from AODP API.`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ============================================================================
// FETCH MATERIAL PRICES FROM AODP API
// ============================================================================

function fetchMaterialPrices() {
  Logger.log('========================================');
  Logger.log('FETCHING MATERIAL PRICES');
  Logger.log('========================================');
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Get materials list
  const materialsSheet = ss.getSheetByName('MATERIALS');
  if (!materialsSheet) {
    SpreadsheetApp.getUi().alert('Error', 'Run extractUniqueMaterials() first!', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const lastRow = materialsSheet.getLastRow();
  const materials = materialsSheet.getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .flat()
    .filter(m => m && m.toString().trim() !== '');
  
  Logger.log(`Fetching prices for ${materials.length} materials...`);
  
  const cities = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];
  
  // Create or clear MATERIAL_PRICES sheet
  let pricesSheet = ss.getSheetByName('MATERIAL_PRICES');
  if (!pricesSheet) {
    pricesSheet = ss.insertSheet('MATERIAL_PRICES');
  } else {
    pricesSheet.clear();
  }
  
  // Write headers
  const headers = ['Material_ID', 'City', 'Sell_Price_Min', 'Buy_Price_Max', 'Last_Updated'];
  pricesSheet.appendRow(headers);
  pricesSheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#4285F4')
    .setFontColor('white');
  pricesSheet.setFrozenRows(1);
  
  const priceData = [];
  let fetchedCount = 0;
  let errorCount = 0;
  
  // Fetch in batches (50 materials at a time to avoid URL length limits)
  const BATCH_SIZE = 50;
  
  for (let i = 0; i < materials.length; i += BATCH_SIZE) {
    const batch = materials.slice(i, Math.min(i + BATCH_SIZE, materials.length));
    
    Logger.log(`Batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(materials.length/BATCH_SIZE)}: ${batch.length} materials`);
    
    try {
      const itemsParam = batch.join(',');
      const locationsParam = cities.join(',');
      
      const url = `https://west.albion-online-data.com/api/v2/stats/prices/${itemsParam}?locations=${locationsParam}`;
      
      const response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true
      });
      
      if (response.getResponseCode() !== 200) {
        Logger.log(`  ⚠️ HTTP ${response.getResponseCode()}`);
        errorCount++;
        continue;
      }
      
      const data = JSON.parse(response.getContentText());
      
      data.forEach(item => {
        priceData.push([
          item.item_id,
          item.city,
          item.sell_price_min || 0,
          item.buy_price_max || 0,
          item.sell_price_min_date || ''
        ]);
        fetchedCount++;
      });
      
      Logger.log(`  ✓ Fetched ${data.length} price records`);
      
      // Small delay between batches
      if (i + BATCH_SIZE < materials.length) {
        Utilities.sleep(200);
      }
      
    } catch (e) {
      Logger.log(`  ❌ Error: ${e.toString()}`);
      errorCount++;
    }
  }
  
  // Write all price data
  if (priceData.length > 0) {
    Logger.log(`Writing ${priceData.length} price records to sheet...`);
    pricesSheet.getRange(2, 1, priceData.length, 5).setValues(priceData);
    SpreadsheetApp.flush();
  }
  
  // Format columns
  pricesSheet.setColumnWidth(1, 220);
  pricesSheet.setColumnWidth(2, 130);
  pricesSheet.setColumnWidth(3, 120);
  pricesSheet.setColumnWidth(4, 120);
  pricesSheet.setColumnWidth(5, 180);
  
  Logger.log('========================================');
  Logger.log('✅ MATERIAL PRICES COMPLETE');
  Logger.log('========================================');
  Logger.log(`Total price records: ${priceData.length}`);
  Logger.log(`Materials covered: ${materials.length}`);
  Logger.log(`Errors: ${errorCount}`);
  
  SpreadsheetApp.getUi().alert(
    '✅ Material Prices Fetched!',
    `Successfully fetched ${priceData.length.toLocaleString()} price records for ${materials.length} materials across 7 cities.\n\n` +
    `Sheet: MATERIAL_PRICES\n\n` +
    `Next: Create USER_STATS sheet with your crafting bonuses.`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ============================================================================
// CREATE USER STATS SHEET
// ============================================================================

function createUserStatsSheet() {
  Logger.log('Creating USER_STATS sheet...');
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  let sheet = ss.getSheetByName('USER_STATS');
  if (!sheet) {
    sheet = ss.insertSheet('USER_STATS');
  } else {
    sheet.clear();
  }
  
  // Headers
  sheet.appendRow(['Setting', 'Value', 'Notes']);
  sheet.getRange(1, 1, 1, 3)
    .setFontWeight('bold')
    .setBackground('#4285F4')
    .setFontColor('white');
  
  // Default values
  const data = [
    ['Premium_Status', 'TRUE', 'TRUE = +20% return rate, FALSE = no bonus'],
    ['Base_Return_Rate', 15.2, '15.2% without focus (default)'],
    ['Use_Focus', 'FALSE', 'TRUE = 43.9% base return, FALSE = 15.2%'],
    ['Specialization_Bonus', 0, 'Your specialization level (0-100) → adds 0.2% per level'],
    ['Crafting_Tax_Rate', 3.5, 'Market tax percentage (3.5% default)']
  ];
  
  sheet.getRange(2, 1, data.length, 3).setValues(data);
  
  // Format
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 350);
  sheet.setFrozenRows(1);
  
  // Add instructions
  sheet.getRange(data.length + 3, 1, 1, 3).merge();
  sheet.getRange(data.length + 3, 1).setValue(
    'INSTRUCTIONS: Edit the "Value" column to match your character stats. ' +
    'Premium_Status and Use_Focus should be TRUE or FALSE. ' +
    'Specialization_Bonus is your spec level (0-100).'
  ).setWrap(true);
  
  Logger.log('✓ USER_STATS sheet created');
  
  SpreadsheetApp.getUi().alert(
    '✅ USER_STATS Sheet Created!',
    'Please update your settings in the USER_STATS sheet:\n\n' +
    '- Premium_Status: TRUE/FALSE\n' +
    '- Use_Focus: TRUE/FALSE\n' +
    '- Specialization_Bonus: 0-100\n\n' +
    'Then run calculateProfitability() to calculate profits for all items!',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
