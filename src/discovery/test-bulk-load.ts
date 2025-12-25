/**
 * Test script for the market data loader.
 */

import { ALL_ITEMS } from '../constants/items'
import { loadMarketDataArray } from '../db/market-data-loader'

// Pick 1 item
const TEST_ITEMS = ALL_ITEMS.slice(0, 1)
const TEST_ITEM_IDS = TEST_ITEMS.map((i) => i.id)

console.log('=== TEST ITEMS ===')
TEST_ITEMS.forEach((item) => console.log(`  ${item.id} -> ${item.name}`))
console.log()

const marketData = loadMarketDataArray(TEST_ITEM_IDS)

console.log('=== ORGANIZED MARKET DATA ===')
console.log(JSON.stringify(marketData, null, 2))

console.log('\n=== DONE ===')
