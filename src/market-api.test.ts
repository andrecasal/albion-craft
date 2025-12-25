import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { setTestDatabase, initializeSchema } from './db/db'

// Import functions to test - they will use the test database via the proxy
import {
	getInstantBuyPrice,
	getInstantSellPrice,
	getPriceSpread,
	getBestPrices,
	getBaselinePrice,
	getPriceTrend,
	getDailyVolume,
	isLiquidMarket,
	getCostToBuy,
	getRevenueFromSelling,
	findArbitrageOpportunities,
	getCraftingInputCost,
	isDataFresh,
	getDataAge,
	getProfitableInstantSell,
	DEFAULT_MAX_AGE_MINUTES,
} from './market-api'

// ============================================================================
// TEST DATABASE SETUP
// ============================================================================

let testDb: Database

beforeAll(() => {
	// Create in-memory database for tests
	testDb = new Database(':memory:')
	initializeSchema(testDb)
	setTestDatabase(testDb)
})

afterAll(() => {
	setTestDatabase(null)
	testDb.close()
})

beforeEach(() => {
	// Clear all tables before each test
	testDb.run('DELETE FROM latest_prices')
	testDb.run('DELETE FROM daily_average_prices')
	testDb.run('DELETE FROM six_hour_average_prices')
	testDb.run('DELETE FROM hourly_average_prices')
	testDb.run('DELETE FROM order_book')
})

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function insertLatestPrice(data: {
	itemId: string
	city: string
	quality?: number
	sellPriceMin: number
	buyPriceMax: number
	fetchedAt?: number
}) {
	const now = Date.now()
	testDb
		.query(
			`
		INSERT INTO latest_prices
		(item_id, city, quality, sell_price_min, sell_price_min_date, sell_price_max, sell_price_max_date,
		 buy_price_min, buy_price_min_date, buy_price_max, buy_price_max_date, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		)
		.run(
			data.itemId,
			data.city,
			data.quality ?? 1,
			data.sellPriceMin,
			new Date().toISOString(),
			data.sellPriceMin + 100,
			new Date().toISOString(),
			data.buyPriceMax - 100,
			new Date().toISOString(),
			data.buyPriceMax,
			new Date().toISOString(),
			data.fetchedAt ?? now,
		)
}

function insertDailyPrice(data: {
	itemId: string
	city: string
	quality?: number
	avgPrice: number
	itemCount: number
	timestamp: string
}) {
	testDb
		.query(
			`
		INSERT INTO daily_average_prices
		(item_id, city, quality, timestamp, item_count, avg_price)
		VALUES (?, ?, ?, ?, ?, ?)
	`,
		)
		.run(
			data.itemId,
			data.city,
			data.quality ?? 1,
			data.timestamp,
			data.itemCount,
			data.avgPrice,
		)
}

function insertOrderBookOrder(data: {
	orderId: number
	itemId: string
	city: string
	quality?: number
	price: number // in raw units (10000 = 1 silver)
	amount: number
	orderType: 'sell' | 'buy'
	expires?: string
	updatedAt?: number
}) {
	const futureDate = new Date()
	futureDate.setDate(futureDate.getDate() + 7) // Expires in 7 days

	testDb
		.query(
			`
		INSERT INTO order_book
		(order_id, item_id, city, quality, price, amount, order_type, expires, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		)
		.run(
			data.orderId,
			data.itemId,
			data.city,
			data.quality ?? 1,
			data.price,
			data.amount,
			data.orderType,
			data.expires ?? futureDate.toISOString(),
			data.updatedAt ?? Date.now(),
		)
}

// ============================================================================
// UNIT TESTS - Pure calculations (no DB required)
// ============================================================================

describe('DEFAULT_MAX_AGE_MINUTES', () => {
	test('has correct default values', () => {
		expect(DEFAULT_MAX_AGE_MINUTES.latest).toBe(30)
		expect(DEFAULT_MAX_AGE_MINUTES.orderBook).toBe(15)
		expect(DEFAULT_MAX_AGE_MINUTES.sixHour).toBe(360)
		expect(DEFAULT_MAX_AGE_MINUTES.hourly).toBe(60)
		expect(DEFAULT_MAX_AGE_MINUTES.daily).toBe(1440)
	})
})

// ============================================================================
// INTEGRATION TESTS - Latest Prices
// ============================================================================

describe('getInstantBuyPrice', () => {
	test('returns null when no data exists', () => {
		const result = getInstantBuyPrice('T4_BAG')
		expect(result).toBeNull()
	})

	test('returns lowest sell price across cities', () => {
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 1000, buyPriceMax: 800 })
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Bridgewatch',
			sellPriceMin: 900,
			buyPriceMax: 700,
		})
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Martlock', sellPriceMin: 1100, buyPriceMax: 900 })

		const result = getInstantBuyPrice('T4_BAG')

		expect(result).not.toBeNull()
		expect(result!.price).toBe(900)
		expect(result!.city).toBe('Bridgewatch')
	})

	test('filters by city when specified', () => {
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 1000, buyPriceMax: 800 })
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Bridgewatch',
			sellPriceMin: 900,
			buyPriceMax: 700,
		})

		const result = getInstantBuyPrice('T4_BAG', { city: 'Caerleon' })

		expect(result).not.toBeNull()
		expect(result!.price).toBe(1000)
		expect(result!.city).toBe('Caerleon')
	})

	test('respects quality filter', () => {
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Caerleon',
			quality: 1,
			sellPriceMin: 1000,
			buyPriceMax: 800,
		})
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Caerleon',
			quality: 2,
			sellPriceMin: 1500,
			buyPriceMax: 1200,
		})

		const result = getInstantBuyPrice('T4_BAG', { quality: 2 })

		expect(result).not.toBeNull()
		expect(result!.price).toBe(1500)
		expect(result!.quality).toBe(2)
	})

	test('excludes stale data', () => {
		const oldTime = Date.now() - 60 * 60 * 1000 // 1 hour ago
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Caerleon',
			sellPriceMin: 1000,
			buyPriceMax: 800,
			fetchedAt: oldTime,
		})

		const result = getInstantBuyPrice('T4_BAG', { maxAgeMinutes: 30 })

		expect(result).toBeNull()
	})
})

describe('getInstantSellPrice', () => {
	test('returns highest buy price across cities', () => {
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 1000, buyPriceMax: 800 })
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Bridgewatch',
			sellPriceMin: 900,
			buyPriceMax: 950,
		})
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Martlock', sellPriceMin: 1100, buyPriceMax: 700 })

		const result = getInstantSellPrice('T4_BAG')

		expect(result).not.toBeNull()
		expect(result!.price).toBe(950)
		expect(result!.city).toBe('Bridgewatch')
	})
})

describe('getPriceSpread', () => {
	test('returns spread for a specific city', () => {
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 1000, buyPriceMax: 800 })

		const result = getPriceSpread('T4_BAG', { city: 'Caerleon' })

		expect(result).not.toBeNull()
		expect(result!.buyPrice).toBe(1000)
		expect(result!.sellPrice).toBe(800)
		expect(result!.spread).toBe(200)
		expect(result!.spreadPercent).toBe(25) // 200/800 * 100
	})
})

describe('getBestPrices', () => {
	test('returns prices from all cities', () => {
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 1000, buyPriceMax: 800 })
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Bridgewatch',
			sellPriceMin: 900,
			buyPriceMax: 700,
		})

		const result = getBestPrices('T4_BAG')

		expect(result).toHaveLength(2)
		// Should be sorted by sell price ascending
		expect(result[0].city).toBe('Bridgewatch')
		expect(result[0].buyPrice).toBe(900)
		expect(result[1].city).toBe('Caerleon')
		expect(result[1].buyPrice).toBe(1000)
	})
})

// ============================================================================
// INTEGRATION TESTS - Historical Baselines
// ============================================================================

describe('getBaselinePrice', () => {
	test('calculates average from daily data', () => {
		const today = new Date()
		// Insert 7 days of data with known prices
		const prices = [1000, 1000, 1000, 1000, 1000, 1000, 1000]
		for (let i = 1; i <= prices.length; i++) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			insertDailyPrice({
				itemId: 'T4_BAG',
				city: 'Caerleon',
				avgPrice: prices[i - 1],
				itemCount: 50,
				timestamp: date.toISOString(),
			})
		}

		const result = getBaselinePrice('T4_BAG', { city: 'Caerleon', days: 7 })

		expect(result).not.toBeNull()
		expect(result).toBe(1000)
	})

	test('returns null when no data exists', () => {
		const result = getBaselinePrice('T4_BAG')
		expect(result).toBeNull()
	})
})

describe('getPriceTrend', () => {
	test('detects rising trend', () => {
		const today = new Date()
		// Recent 7 days: higher prices
		for (let i = 0; i < 7; i++) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			insertDailyPrice({
				itemId: 'T4_BAG',
				city: 'Caerleon',
				avgPrice: 1500,
				itemCount: 50,
				timestamp: date.toISOString(),
			})
		}
		// Older 7 days: lower prices
		for (let i = 7; i < 14; i++) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			insertDailyPrice({
				itemId: 'T4_BAG',
				city: 'Caerleon',
				avgPrice: 1000,
				itemCount: 50,
				timestamp: date.toISOString(),
			})
		}

		const result = getPriceTrend('T4_BAG', { city: 'Caerleon' })

		expect(result).not.toBeNull()
		expect(result!.direction).toBe('rising')
		expect(result!.recentAvg).toBe(1500)
		expect(result!.olderAvg).toBe(1000)
		expect(result!.changePercent).toBe(50)
	})

	test('returns null with insufficient data', () => {
		// Only insert 3 days of data (need at least 7)
		const today = new Date()
		for (let i = 0; i < 3; i++) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			insertDailyPrice({
				itemId: 'T4_BAG',
				city: 'Caerleon',
				avgPrice: 1000,
				itemCount: 50,
				timestamp: date.toISOString(),
			})
		}

		const result = getPriceTrend('T4_BAG', { city: 'Caerleon' })

		expect(result).toBeNull()
	})
})

// ============================================================================
// INTEGRATION TESTS - Volume & Liquidity
// ============================================================================

describe('getDailyVolume', () => {
	test('calculates average daily volume', () => {
		const today = new Date()
		// Insert 5 days with equal volume
		for (let i = 1; i <= 5; i++) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			insertDailyPrice({
				itemId: 'T4_BAG',
				city: 'Caerleon',
				avgPrice: 1000,
				itemCount: 50,
				timestamp: date.toISOString(),
			})
		}

		const result = getDailyVolume('T4_BAG', { city: 'Caerleon', days: 5 })

		expect(result).toBe(50)
	})
})

describe('isLiquidMarket', () => {
	test('returns true for liquid market', () => {
		const today = new Date()
		for (let i = 1; i <= 7; i++) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			insertDailyPrice({
				itemId: 'T4_BAG',
				city: 'Caerleon',
				avgPrice: 1000,
				itemCount: 50,
				timestamp: date.toISOString(),
			})
		}

		const result = isLiquidMarket('T4_BAG', { city: 'Caerleon', minDailyVolume: 10 })

		expect(result).toBe(true)
	})

	test('returns false for illiquid market', () => {
		const today = new Date()
		for (let i = 1; i <= 7; i++) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			insertDailyPrice({
				itemId: 'T4_BAG',
				city: 'Caerleon',
				avgPrice: 1000,
				itemCount: 5,
				timestamp: date.toISOString(),
			})
		}

		const result = isLiquidMarket('T4_BAG', { city: 'Caerleon', minDailyVolume: 10 })

		expect(result).toBe(false)
	})
})

// ============================================================================
// INTEGRATION TESTS - Order Book / Slippage
// ============================================================================

describe('getCostToBuy', () => {
	test('calculates cost with single order', () => {
		// Price in raw units: 10000 raw = 1 silver
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 10000000, // 1000 silver
			amount: 100,
			orderType: 'sell',
		})

		const result = getCostToBuy('T4_BAG', 'Caerleon', 10)

		expect(result).not.toBeNull()
		expect(result!.totalAmount).toBe(10000) // 10 items * 1000 silver
		expect(result!.avgPricePerUnit).toBe(1000)
		expect(result!.quantityFilled).toBe(10)
		expect(result!.quantityUnfilled).toBe(0)
		expect(result!.ordersUsed).toBe(1)
	})

	test('walks order book for slippage', () => {
		// Multiple orders at different prices
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 10000000, // 1000 silver
			amount: 5,
			orderType: 'sell',
		})
		insertOrderBookOrder({
			orderId: 2,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 12000000, // 1200 silver
			amount: 5,
			orderType: 'sell',
		})

		const result = getCostToBuy('T4_BAG', 'Caerleon', 10)

		expect(result).not.toBeNull()
		// 5 * 1000 + 5 * 1200 = 11000
		expect(result!.totalAmount).toBe(11000)
		expect(result!.avgPricePerUnit).toBe(1100)
		expect(result!.quantityFilled).toBe(10)
		expect(result!.ordersUsed).toBe(2)
	})

	test('handles partial fill when not enough orders', () => {
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 10000000,
			amount: 5,
			orderType: 'sell',
		})

		const result = getCostToBuy('T4_BAG', 'Caerleon', 10)

		expect(result).not.toBeNull()
		expect(result!.quantityFilled).toBe(5)
		expect(result!.quantityUnfilled).toBe(5)
	})

	test('returns null when no orders exist', () => {
		const result = getCostToBuy('T4_BAG', 'Caerleon', 10)
		expect(result).toBeNull()
	})
})

describe('getRevenueFromSelling', () => {
	test('calculates revenue from buy orders', () => {
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 9000000, // 900 silver
			amount: 10,
			orderType: 'buy',
		})

		const result = getRevenueFromSelling('T4_BAG', 'Caerleon', 5)

		expect(result).not.toBeNull()
		expect(result!.totalAmount).toBe(4500) // 5 * 900
		expect(result!.avgPricePerUnit).toBe(900)
	})
})

// ============================================================================
// INTEGRATION TESTS - Strategic Functions
// ============================================================================

describe('findArbitrageOpportunities', () => {
	test('finds profitable city pairs', () => {
		// Buy cheap in Bridgewatch
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Bridgewatch',
			sellPriceMin: 800,
			buyPriceMax: 700,
		})
		// Sell high in Caerleon
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 1000, buyPriceMax: 950 })

		const result = findArbitrageOpportunities('T4_BAG', { minProfitPercent: 5 })

		expect(result.length).toBeGreaterThan(0)
		const opportunity = result[0]
		expect(opportunity.buyCity).toBe('Bridgewatch')
		expect(opportunity.sellCity).toBe('Caerleon')
		expect(opportunity.buyPrice).toBe(800)
		expect(opportunity.instantSellPrice).toBe(950)
		expect(opportunity.instantProfit).toBe(150)
		expect(opportunity.instantProfitPercent).toBeCloseTo(18.8, 0)
		expect(opportunity.dailyVolume).toBe(0) // No historical data in test
		expect(opportunity.avgPrice).toBeNull() // No historical data in test
	})

	test('filters out low profit opportunities', () => {
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Bridgewatch', sellPriceMin: 950, buyPriceMax: 900 })
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 990, buyPriceMax: 960 })

		// Instant profit: (960-950)/950 = 1.05%
		// Undercut profit: (989-950)/950 = 4.1% (undercut = 990-1 = 989)
		// Both below 5% threshold
		const result = findArbitrageOpportunities('T4_BAG', { minProfitPercent: 5 })

		expect(result).toHaveLength(0)
	})
})

describe('getCraftingInputCost', () => {
	test('uses order book when available', () => {
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_PLANKS',
			city: 'Caerleon',
			price: 5000000, // 500 silver
			amount: 100,
			orderType: 'sell',
		})

		const result = getCraftingInputCost('T4_PLANKS', 20, { preferredCity: 'Caerleon' })

		expect(result).not.toBeNull()
		expect(result!.city).toBe('Caerleon')
		expect(result!.totalCost).toBe(10000) // 20 * 500
		expect(result!.usedOrderBook).toBe(true)
	})

	test('falls back to latest prices', () => {
		insertLatestPrice({
			itemId: 'T4_PLANKS',
			city: 'Caerleon',
			sellPriceMin: 500,
			buyPriceMax: 400,
		})

		const result = getCraftingInputCost('T4_PLANKS', 20)

		expect(result).not.toBeNull()
		expect(result!.totalCost).toBe(10000) // 20 * 500
		expect(result!.usedOrderBook).toBe(false)
	})
})

// ============================================================================
// INTEGRATION TESTS - Data Freshness
// ============================================================================

describe('isDataFresh', () => {
	test('returns true for fresh data', () => {
		insertLatestPrice({ itemId: 'T4_BAG', city: 'Caerleon', sellPriceMin: 1000, buyPriceMax: 800 })

		const result = isDataFresh('T4_BAG', { source: 'latest' })

		expect(result).toBe(true)
	})

	test('returns false for stale data', () => {
		const oldTime = Date.now() - 60 * 60 * 1000 // 1 hour ago
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Caerleon',
			sellPriceMin: 1000,
			buyPriceMax: 800,
			fetchedAt: oldTime,
		})

		const result = isDataFresh('T4_BAG', { source: 'latest', maxAgeMinutes: 30 })

		expect(result).toBe(false)
	})

	test('returns false when no data exists', () => {
		const result = isDataFresh('NONEXISTENT_ITEM')
		expect(result).toBe(false)
	})
})

describe('getDataAge', () => {
	test('returns age in minutes', () => {
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
		insertLatestPrice({
			itemId: 'T4_BAG',
			city: 'Caerleon',
			sellPriceMin: 1000,
			buyPriceMax: 800,
			fetchedAt: fiveMinutesAgo,
		})

		const result = getDataAge('T4_BAG', { source: 'latest' })

		expect(result.source).toBe('latest')
		expect(result.lastUpdated).not.toBeNull()
		expect(result.ageMinutes).toBeGreaterThanOrEqual(5)
		expect(result.ageMinutes).toBeLessThan(6)
	})

	test('returns null values when no data exists', () => {
		const result = getDataAge('NONEXISTENT_ITEM')

		expect(result.source).toBe('latest')
		expect(result.lastUpdated).toBeNull()
		expect(result.ageMinutes).toBeNull()
	})
})

// ============================================================================
// INTEGRATION TESTS - Profitable Instant Sell
// ============================================================================

describe('getProfitableInstantSell', () => {
	test('returns null when no buy orders exist', () => {
		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)
		expect(result).toBeNull()
	})

	test('returns zero quantity when no orders are profitable', () => {
		// Buy order at 1000 silver, after 4% tax = 960 silver net
		// minSellPrice is 1000, so 960 < 1000 = not profitable
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 10000000, // 1000 silver in raw units
			amount: 10,
			orderType: 'buy',
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)

		expect(result).not.toBeNull()
		expect(result!.quantity).toBe(0)
		expect(result!.totalProfit).toBe(0)
	})

	test('calculates profitable quantity with single order', () => {
		// Buy order at 1100 silver, after 4% tax = 1056 silver net
		// minSellPrice is 1000, so profit per item = 1056 - 1000 = 56 silver
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 11000000, // 1100 silver in raw units
			amount: 10,
			orderType: 'buy',
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)

		expect(result).not.toBeNull()
		expect(result!.quantity).toBe(10)
		// Profit = (1100 * 0.96 - 1000) * 10 = (1056 - 1000) * 10 = 560
		expect(result!.totalProfit).toBe(560)
	})

	test('stops at unprofitable orders when walking order book', () => {
		// High price order: 1200 silver, net after 4% tax = 1152
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 12000000, // 1200 silver
			amount: 5,
			orderType: 'buy',
		})
		// Lower price order: 1000 silver, net after 4% tax = 960 (not profitable)
		insertOrderBookOrder({
			orderId: 2,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 10000000, // 1000 silver
			amount: 10,
			orderType: 'buy',
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)

		expect(result).not.toBeNull()
		// Only the first 5 items are profitable
		expect(result!.quantity).toBe(5)
		// Profit = (1200 * 0.96 - 1000) * 5 = (1152 - 1000) * 5 = 760
		expect(result!.totalProfit).toBe(760)
	})

	test('aggregates profit from multiple profitable orders', () => {
		// Order 1: 1500 silver, net = 1440, profit per item = 440
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 15000000, // 1500 silver
			amount: 3,
			orderType: 'buy',
		})
		// Order 2: 1200 silver, net = 1152, profit per item = 152
		insertOrderBookOrder({
			orderId: 2,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 12000000, // 1200 silver
			amount: 7,
			orderType: 'buy',
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)

		expect(result).not.toBeNull()
		expect(result!.quantity).toBe(10) // 3 + 7
		// Total profit = (1440 - 1000) * 3 + (1152 - 1000) * 7 = 440*3 + 152*7 = 1320 + 1064 = 2384
		expect(result!.totalProfit).toBe(2384)
	})

	test('respects custom tax rate', () => {
		// Buy order at 1100 silver
		// With 6.5% tax: net = 1100 * 0.935 = 1028.5
		// minSellPrice = 1000, profit per item = 28.5
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 11000000, // 1100 silver
			amount: 10,
			orderType: 'buy',
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000, {
			taxRate: 0.065,
		})

		expect(result).not.toBeNull()
		expect(result!.quantity).toBe(10)
		// Profit = (1100 * 0.935 - 1000) * 10 = (1028.5 - 1000) * 10 = 285
		expect(result!.totalProfit).toBe(285)
	})

	test('respects quality filter - includes lower quality buy orders', () => {
		// Quality 1 buy order (accepts quality 1, 2, 3, etc.)
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			quality: 1,
			price: 12000000, // 1200 silver
			amount: 5,
			orderType: 'buy',
		})
		// Quality 2 buy order (accepts quality 2, 3, etc.)
		insertOrderBookOrder({
			orderId: 2,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			quality: 2,
			price: 13000000, // 1300 silver
			amount: 5,
			orderType: 'buy',
		})
		// Quality 3 buy order (accepts quality 3+, so not applicable for quality 2 items)
		insertOrderBookOrder({
			orderId: 3,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			quality: 3,
			price: 14000000, // 1400 silver
			amount: 5,
			orderType: 'buy',
		})

		// Selling quality 2 items - should match quality 1 and 2 buy orders
		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000, {
			quality: 2,
		})

		expect(result).not.toBeNull()
		// Should include both quality 1 and quality 2 orders (10 items total)
		expect(result!.quantity).toBe(10)
	})

	test('excludes stale orders', () => {
		const oldTime = Date.now() - 20 * 60 * 1000 // 20 minutes ago

		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 12000000,
			amount: 10,
			orderType: 'buy',
			updatedAt: oldTime,
		})

		// Default maxAge is 15 minutes, so this order should be excluded
		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)

		expect(result).toBeNull()
	})

	test('includes orders within maxAgeMinutes', () => {
		const tenMinutesAgo = Date.now() - 10 * 60 * 1000

		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 12000000,
			amount: 10,
			orderType: 'buy',
			updatedAt: tenMinutesAgo,
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000, {
			maxAgeMinutes: 15,
		})

		expect(result).not.toBeNull()
		expect(result!.quantity).toBe(10)
	})

	test('excludes expired orders', () => {
		const pastDate = new Date()
		pastDate.setDate(pastDate.getDate() - 1) // Expired yesterday

		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 12000000,
			amount: 10,
			orderType: 'buy',
			expires: pastDate.toISOString(),
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)

		expect(result).toBeNull()
	})

	test('handles edge case where net equals minSellPrice exactly', () => {
		// If net after tax equals minSellPrice exactly, there's no profit
		// For minSellPrice = 960 and taxRate = 0.04:
		// We need net = 960, so sellPrice * 0.96 = 960, sellPrice = 1000
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 10000000, // 1000 silver, net = 960
			amount: 10,
			orderType: 'buy',
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 960)

		expect(result).not.toBeNull()
		// netAfterTax (960) <= minSellPrice (960), so no profit
		expect(result!.quantity).toBe(0)
		expect(result!.totalProfit).toBe(0)
	})

	test('rounds total profit to nearest integer', () => {
		// Create a scenario with fractional profit
		// 1050 silver * 0.96 = 1008 net, profit = 1008 - 1000 = 8 per item
		// 8 * 3 = 24 (clean division)
		insertOrderBookOrder({
			orderId: 1,
			itemId: 'T4_BAG',
			city: 'Caerleon',
			price: 10500000, // 1050 silver
			amount: 3,
			orderType: 'buy',
		})

		const result = getProfitableInstantSell('T4_BAG', 'Caerleon', 1000)

		expect(result).not.toBeNull()
		expect(Number.isInteger(result!.totalProfit)).toBe(true)
	})
})
