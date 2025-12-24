import { db } from './db'

// ============================================================================
// TYPES
// ============================================================================

export type DataSource = 'latest' | 'daily' | 'sixHour' | 'hourly' | 'orderBook'

export type PriceResult = {
	price: number // in silver
	city: string
	quality: number
	observedAt: Date
	ageMinutes: number
}

export type SpreadResult = {
	buyPrice: number // price to buy instantly (lowest sell order)
	sellPrice: number // price when selling instantly (highest buy order)
	spread: number // absolute difference
	spreadPercent: number
	city: string
	quality: number
}

export type CityPriceComparison = {
	city: string
	buyPrice: number | null
	sellPrice: number | null
	spread: number | null
	fetchedAt: number // timestamp in ms
}

export type PricePoint = {
	timestamp: Date
	avgPrice: number
	volume: number
}

export type VolumePoint = {
	timestamp: Date
	volume: number
}

export type TrendResult = {
	direction: 'rising' | 'stable' | 'falling'
	recentAvg: number
	olderAvg: number
	changePercent: number
}

export type OrderLevel = {
	price: number
	quantity: number
	updatedAt: Date
}

export type SlippageResult = {
	totalAmount: number // total silver cost/revenue
	avgPricePerUnit: number
	ordersUsed: number
	quantityFilled: number
	quantityUnfilled: number // if not enough orders
}

export type DataAgeResult = {
	source: DataSource
	lastUpdated: Date | null
	ageMinutes: number | null
}

export type ArbitrageOpportunity = {
	buyCity: string
	sellCity: string
	buyPrice: number
	// Instant sell (to highest buy order in destination)
	instantSellPrice: number | null
	instantProfit: number | null
	instantProfitPercent: number | null
	// Undercut sell (1 silver below lowest sell order in destination)
	undercutSellPrice: number | null
	undercutProfit: number | null
	undercutProfitPercent: number | null
	dataAgeMinutes: number // Age of the oldest price data used
	quality: number
}

export type CraftingCostResult = {
	city: string
	totalCost: number
	avgPricePerUnit: number
	quantityAvailable: number
	usedOrderBook: boolean // true if order book data was used, false if fell back to latest prices
}

// ============================================================================
// CONFIGURATION
// ============================================================================

export const DEFAULT_MAX_AGE_MINUTES: Record<DataSource, number> = {
	latest: 30, // Latest prices: 30 min
	orderBook: 15, // Order book: 15 min (real-time data)
	sixHour: 360, // 6-hour data: 6 hours
	hourly: 60, // Hourly data: 1 hour
	daily: 1440, // Daily data: 24 hours
}

const RAW_TO_SILVER = 10000 // Order book stores raw units (10000 = 1 silver)

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function rawToSilver(rawPrice: number): number {
	return Math.round(rawPrice / RAW_TO_SILVER)
}

function getAgeMinutes(date: Date | number): number {
	const timestamp = typeof date === 'number' ? date : date.getTime()
	return Math.floor((Date.now() - timestamp) / 60000)
}

function isFresh(date: Date | number, maxAgeMinutes: number): boolean {
	return getAgeMinutes(date) <= maxAgeMinutes
}

// ============================================================================
// 1. QUICK PRICE CHECKS (Latest Prices Table)
// ============================================================================

type LatestPriceRow = {
	item_id: string
	city: string
	quality: number
	sell_price_min: number
	sell_price_min_date: string
	buy_price_max: number
	buy_price_max_date: string
	fetched_at: number
}

/**
 * Get the lowest sell order price (what you pay to buy instantly).
 * Returns the best price across all cities if city is not specified.
 */
export function getInstantBuyPrice(
	itemId: string,
	options?: { city?: string; quality?: number; maxAgeMinutes?: number },
): PriceResult | null {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.latest
	const minFetchedAt = Date.now() - maxAge * 60000

	let query = `
		SELECT city, quality, sell_price_min, sell_price_min_date, fetched_at
		FROM latest_prices
		WHERE item_id = ? AND quality = ? AND sell_price_min > 0 AND fetched_at > ?
	`
	const params: (string | number)[] = [itemId, quality, minFetchedAt]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	query += ' ORDER BY sell_price_min ASC LIMIT 1'

	const row = db.query(query).get(...params) as
		| {
				city: string
				quality: number
				sell_price_min: number
				sell_price_min_date: string
				fetched_at: number
		  }
		| undefined

	if (!row) return null

	const observedAt = new Date(row.sell_price_min_date)
	return {
		price: row.sell_price_min,
		city: row.city,
		quality: row.quality,
		observedAt,
		ageMinutes: getAgeMinutes(observedAt),
	}
}

/**
 * Get the highest buy order price (what you receive selling instantly).
 * Returns the best price across all cities if city is not specified.
 */
export function getInstantSellPrice(
	itemId: string,
	options?: { city?: string; quality?: number; maxAgeMinutes?: number },
): PriceResult | null {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.latest
	const minFetchedAt = Date.now() - maxAge * 60000

	let query = `
		SELECT city, quality, buy_price_max, buy_price_max_date, fetched_at
		FROM latest_prices
		WHERE item_id = ? AND quality = ? AND buy_price_max > 0 AND fetched_at > ?
	`
	const params: (string | number)[] = [itemId, quality, minFetchedAt]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	query += ' ORDER BY buy_price_max DESC LIMIT 1'

	const row = db.query(query).get(...params) as
		| {
				city: string
				quality: number
				buy_price_max: number
				buy_price_max_date: string
				fetched_at: number
		  }
		| undefined

	if (!row) return null

	const observedAt = new Date(row.buy_price_max_date)
	return {
		price: row.buy_price_max,
		city: row.city,
		quality: row.quality,
		observedAt,
		ageMinutes: getAgeMinutes(observedAt),
	}
}

/**
 * Get both prices + spread for arbitrage detection in a specific city.
 */
export function getPriceSpread(
	itemId: string,
	options?: { city?: string; quality?: number; maxAgeMinutes?: number },
): SpreadResult | null {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.latest
	const minFetchedAt = Date.now() - maxAge * 60000

	if (!options?.city) {
		// Without a city, we can't compute a meaningful spread
		// Return the spread from the city with the best buy price
		const buyResult = getInstantBuyPrice(itemId, options)
		if (!buyResult) return null
		return getPriceSpread(itemId, { ...options, city: buyResult.city })
	}

	const row = db
		.prepare(
			`
		SELECT city, quality, sell_price_min, buy_price_max
		FROM latest_prices
		WHERE item_id = ? AND city = ? AND quality = ? AND fetched_at > ?
	`,
		)
		.get(itemId, options.city, quality, minFetchedAt) as
		| {
				city: string
				quality: number
				sell_price_min: number
				buy_price_max: number
		  }
		| undefined

	if (!row || row.sell_price_min <= 0 || row.buy_price_max <= 0) return null

	const spread = row.sell_price_min - row.buy_price_max
	return {
		buyPrice: row.sell_price_min,
		sellPrice: row.buy_price_max,
		spread,
		spreadPercent: (spread / row.buy_price_max) * 100,
		city: row.city,
		quality: row.quality,
	}
}

/**
 * Find best prices across all cities for an item.
 */
export function getBestPrices(
	itemId: string,
	options?: { quality?: number; maxAgeMinutes?: number },
): CityPriceComparison[] {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.latest
	const minFetchedAt = Date.now() - maxAge * 60000

	const rows = db
		.prepare(
			`
		SELECT city, sell_price_min, buy_price_max, fetched_at
		FROM latest_prices
		WHERE item_id = ? AND quality = ? AND fetched_at > ?
		ORDER BY sell_price_min ASC
	`,
		)
		.all(itemId, quality, minFetchedAt) as {
		city: string
		sell_price_min: number
		buy_price_max: number
		fetched_at: number
	}[]

	return rows.map((row) => ({
		city: row.city,
		buyPrice: row.sell_price_min > 0 ? row.sell_price_min : null,
		sellPrice: row.buy_price_max > 0 ? row.buy_price_max : null,
		spread:
			row.sell_price_min > 0 && row.buy_price_max > 0
				? row.sell_price_min - row.buy_price_max
				: null,
		fetchedAt: row.fetched_at,
	}))
}

// ============================================================================
// 2. HISTORICAL BASELINES (Daily/6h/Hourly Tables)
// ============================================================================

/**
 * Get volume-weighted average from daily data (stable reference for material costs).
 * Uses the last N days of data.
 */
export function getBaselinePrice(
	itemId: string,
	options?: { city?: string; quality?: number; days?: number },
): number | null {
	const quality = options?.quality ?? 1
	const days = options?.days ?? 28

	const cutoffDate = new Date()
	cutoffDate.setDate(cutoffDate.getDate() - days)
	const cutoffStr = cutoffDate.toISOString()

	let query = `
		SELECT AVG(avg_price) as avg_price, SUM(item_count) as total_volume
		FROM daily_average_prices
		WHERE item_id = ? AND quality = ? AND timestamp > ?
	`
	const params: (string | number)[] = [itemId, quality, cutoffStr]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	const row = db.query(query).get(...params) as {
		avg_price: number | null
		total_volume: number | null
	}

	return row?.avg_price ? Math.round(row.avg_price) : null
}

/**
 * Get recent price from 6-hour data (for crafted item expected sell price).
 * Returns the most recent 6-hour average.
 */
export function getRecentPrice(
	itemId: string,
	options?: { city?: string; quality?: number },
): number | null {
	const quality = options?.quality ?? 1

	let query = `
		SELECT avg_price, timestamp
		FROM six_hour_average_prices
		WHERE item_id = ? AND quality = ?
	`
	const params: (string | number)[] = [itemId, quality]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	query += ' ORDER BY timestamp DESC LIMIT 1'

	const row = db.query(query).get(...params) as
		| { avg_price: number; timestamp: string }
		| undefined

	return row?.avg_price ?? null
}

/**
 * Get hourly prices for intraday timing analysis.
 */
export function getHourlyPrices(
	itemId: string,
	options?: { city?: string; quality?: number; hours?: number },
): PricePoint[] {
	const quality = options?.quality ?? 1
	const hours = options?.hours ?? 24

	const cutoffDate = new Date()
	cutoffDate.setHours(cutoffDate.getHours() - hours)
	const cutoffStr = cutoffDate.toISOString()

	let query = `
		SELECT timestamp, avg_price, item_count
		FROM hourly_average_prices
		WHERE item_id = ? AND quality = ? AND timestamp > ?
	`
	const params: (string | number)[] = [itemId, quality, cutoffStr]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	query += ' ORDER BY timestamp ASC'

	const rows = db.query(query).all(...params) as {
		timestamp: string
		avg_price: number
		item_count: number
	}[]

	return rows.map((row) => ({
		timestamp: new Date(row.timestamp),
		avgPrice: row.avg_price,
		volume: row.item_count,
	}))
}

/**
 * Analyze price trend from historical data.
 * Compares recent period vs older period to determine direction.
 */
export function getPriceTrend(
	itemId: string,
	options?: { city?: string; quality?: number },
): TrendResult | null {
	const quality = options?.quality ?? 1

	let query = `
		SELECT avg_price, timestamp
		FROM daily_average_prices
		WHERE item_id = ? AND quality = ?
	`
	const params: (string | number)[] = [itemId, quality]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	query += ' ORDER BY timestamp DESC LIMIT 28'

	const rows = db.query(query).all(...params) as {
		avg_price: number
		timestamp: string
	}[]

	if (rows.length < 7) return null

	const prices = rows.map((r) => r.avg_price)
	const recentPrices = prices.slice(0, 7)
	const olderPrices = prices.slice(7)

	const recentAvg =
		recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length
	const olderAvg =
		olderPrices.length > 0
			? olderPrices.reduce((a, b) => a + b, 0) / olderPrices.length
			: recentAvg

	const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100

	let direction: 'rising' | 'stable' | 'falling' = 'stable'
	if (changePercent > 5) direction = 'rising'
	else if (changePercent < -5) direction = 'falling'

	return {
		direction,
		recentAvg: Math.round(recentAvg),
		olderAvg: Math.round(olderAvg),
		changePercent: Math.round(changePercent * 10) / 10,
	}
}

// ============================================================================
// 3. VOLUME & DEMAND ANALYSIS
// ============================================================================

/**
 * Get average items traded per day from daily data.
 */
export function getDailyVolume(
	itemId: string,
	options?: { city?: string; quality?: number; days?: number },
): number {
	const quality = options?.quality ?? 1
	const days = options?.days ?? 28

	const cutoffDate = new Date()
	cutoffDate.setDate(cutoffDate.getDate() - days)
	const cutoffStr = cutoffDate.toISOString()

	let query = `
		SELECT AVG(item_count) as avg_volume
		FROM daily_average_prices
		WHERE item_id = ? AND quality = ? AND timestamp > ?
	`
	const params: (string | number)[] = [itemId, quality, cutoffStr]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	const row = db.query(query).get(...params) as { avg_volume: number | null }

	return Math.round(row?.avg_volume ?? 0)
}

/**
 * Get volume history over time.
 */
export function getVolumeHistory(
	itemId: string,
	options?: { city?: string; quality?: number; days?: number },
): VolumePoint[] {
	const quality = options?.quality ?? 1
	const days = options?.days ?? 28

	const cutoffDate = new Date()
	cutoffDate.setDate(cutoffDate.getDate() - days)
	const cutoffStr = cutoffDate.toISOString()

	let query = `
		SELECT timestamp, item_count
		FROM daily_average_prices
		WHERE item_id = ? AND quality = ? AND timestamp > ?
	`
	const params: (string | number)[] = [itemId, quality, cutoffStr]

	if (options?.city) {
		query += ' AND city = ?'
		params.push(options.city)
	}

	query += ' ORDER BY timestamp ASC'

	const rows = db.query(query).all(...params) as {
		timestamp: string
		item_count: number
	}[]

	return rows.map((row) => ({
		timestamp: new Date(row.timestamp),
		volume: row.item_count,
	}))
}

/**
 * Check if market has sufficient liquidity.
 */
export function isLiquidMarket(
	itemId: string,
	options?: { city?: string; quality?: number; minDailyVolume?: number },
): boolean {
	const minVolume = options?.minDailyVolume ?? 10
	const avgVolume = getDailyVolume(itemId, options)
	return avgVolume >= minVolume
}

// ============================================================================
// 4. ORDER BOOK (Quantity-Aware Trading)
// ============================================================================

/**
 * Get how many items are available at or below a max price.
 */
export function getBuyableQuantity(
	itemId: string,
	city: string,
	maxPrice: number,
	options?: { quality?: number; maxAgeMinutes?: number },
): number {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.orderBook
	const minUpdatedAt = Date.now() - maxAge * 60000

	// Convert silver price to raw units for comparison
	const maxPriceRaw = maxPrice * RAW_TO_SILVER

	const row = db
		.prepare(
			`
		SELECT COALESCE(SUM(amount), 0) as total
		FROM order_book
		WHERE item_id = ? AND city = ? AND quality = ?
			AND order_type = 'sell' AND price <= ?
			AND updated_at > ? AND expires > datetime('now')
	`,
		)
		.get(itemId, city, quality, maxPriceRaw, minUpdatedAt) as { total: number }

	return row.total
}

/**
 * Calculate actual cost to buy N items (accounts for slippage).
 * Walks up the order book from lowest to highest price.
 */
export function getCostToBuy(
	itemId: string,
	city: string,
	quantity: number,
	options?: { quality?: number; maxAgeMinutes?: number },
): SlippageResult | null {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.orderBook
	const minUpdatedAt = Date.now() - maxAge * 60000

	const orders = db
		.prepare(
			`
		SELECT price, amount
		FROM order_book
		WHERE item_id = ? AND city = ? AND quality = ?
			AND order_type = 'sell'
			AND updated_at > ? AND expires > datetime('now')
		ORDER BY price ASC
	`,
		)
		.all(itemId, city, quality, minUpdatedAt) as {
		price: number
		amount: number
	}[]

	if (orders.length === 0) return null

	let totalCost = 0
	let quantityFilled = 0
	let ordersUsed = 0

	for (const order of orders) {
		if (quantityFilled >= quantity) break

		const take = Math.min(order.amount, quantity - quantityFilled)
		totalCost += rawToSilver(order.price) * take
		quantityFilled += take
		ordersUsed++
	}

	return {
		totalAmount: totalCost,
		avgPricePerUnit: quantityFilled > 0 ? Math.round(totalCost / quantityFilled) : 0,
		ordersUsed,
		quantityFilled,
		quantityUnfilled: Math.max(0, quantity - quantityFilled),
	}
}

/**
 * Calculate expected revenue from selling N items (accounts for slippage).
 * Walks down the order book from highest to lowest buy price.
 */
export function getRevenueFromSelling(
	itemId: string,
	city: string,
	quantity: number,
	options?: { quality?: number; maxAgeMinutes?: number },
): SlippageResult | null {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.orderBook
	const minUpdatedAt = Date.now() - maxAge * 60000

	const orders = db
		.prepare(
			`
		SELECT price, amount
		FROM order_book
		WHERE item_id = ? AND city = ? AND quality = ?
			AND order_type = 'buy'
			AND updated_at > ? AND expires > datetime('now')
		ORDER BY price DESC
	`,
		)
		.all(itemId, city, quality, minUpdatedAt) as {
		price: number
		amount: number
	}[]

	if (orders.length === 0) return null

	let totalRevenue = 0
	let quantityFilled = 0
	let ordersUsed = 0

	for (const order of orders) {
		if (quantityFilled >= quantity) break

		const take = Math.min(order.amount, quantity - quantityFilled)
		totalRevenue += rawToSilver(order.price) * take
		quantityFilled += take
		ordersUsed++
	}

	return {
		totalAmount: totalRevenue,
		avgPricePerUnit:
			quantityFilled > 0 ? Math.round(totalRevenue / quantityFilled) : 0,
		ordersUsed,
		quantityFilled,
		quantityUnfilled: Math.max(0, quantity - quantityFilled),
	}
}

/**
 * Get full order book depth (all orders at each price level).
 */
export function getOrderBookDepth(
	itemId: string,
	city: string,
	options?: {
		quality?: number
		orderType?: 'sell' | 'buy'
		maxAgeMinutes?: number
	},
): OrderLevel[] {
	const quality = options?.quality ?? 1
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES.orderBook
	const minUpdatedAt = Date.now() - maxAge * 60000

	let query = `
		SELECT price, SUM(amount) as quantity, MAX(updated_at) as updated_at
		FROM order_book
		WHERE item_id = ? AND city = ? AND quality = ?
			AND updated_at > ? AND expires > datetime('now')
	`
	const params: (string | number)[] = [itemId, city, quality, minUpdatedAt]

	if (options?.orderType) {
		query += ' AND order_type = ?'
		params.push(options.orderType)
	}

	query += ' GROUP BY price ORDER BY price ASC'

	const rows = db.query(query).all(...params) as {
		price: number
		quantity: number
		updated_at: number
	}[]

	return rows.map((row) => ({
		price: rawToSilver(row.price),
		quantity: row.quantity,
		updatedAt: new Date(row.updated_at),
	}))
}

// ============================================================================
// 5. FRESHNESS & DATA QUALITY
// ============================================================================

/**
 * Check if price data is fresh enough to trust.
 */
export function isDataFresh(
	itemId: string,
	options?: { city?: string; source?: DataSource; maxAgeMinutes?: number },
): boolean {
	const source = options?.source ?? 'latest'
	const maxAge = options?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES[source]
	const ageResult = getDataAge(itemId, options)

	if (ageResult.ageMinutes === null) return false
	return ageResult.ageMinutes <= maxAge
}

/**
 * Get age of most recent data for an item.
 */
export function getDataAge(
	itemId: string,
	options?: { city?: string; source?: DataSource },
): DataAgeResult {
	const source = options?.source ?? 'latest'

	let query: string
	let dateField: string

	switch (source) {
		case 'latest':
			query = 'SELECT MAX(fetched_at) as last_updated FROM latest_prices WHERE item_id = ?'
			dateField = 'fetched_at'
			break
		case 'orderBook':
			query = 'SELECT MAX(updated_at) as last_updated FROM order_book WHERE item_id = ?'
			dateField = 'updated_at'
			break
		case 'daily':
			query = 'SELECT MAX(timestamp) as last_updated FROM daily_average_prices WHERE item_id = ?'
			dateField = 'timestamp'
			break
		case 'sixHour':
			query = 'SELECT MAX(timestamp) as last_updated FROM six_hour_average_prices WHERE item_id = ?'
			dateField = 'timestamp'
			break
		case 'hourly':
			query = 'SELECT MAX(timestamp) as last_updated FROM hourly_average_prices WHERE item_id = ?'
			dateField = 'timestamp'
			break
	}

	const params: string[] = [itemId]
	if (options?.city) {
		query = query.replace('WHERE', 'WHERE city = ? AND')
		params.unshift(options.city)
	}

	const row = db.query(query).get(...params) as {
		last_updated: number | string | null
	}

	if (!row?.last_updated) {
		return { source, lastUpdated: null, ageMinutes: null }
	}

	const lastUpdated =
		typeof row.last_updated === 'number'
			? new Date(row.last_updated)
			: new Date(row.last_updated)

	return {
		source,
		lastUpdated,
		ageMinutes: getAgeMinutes(lastUpdated),
	}
}

// ============================================================================
// 6. STRATEGIC / COMPOUND FUNCTIONS
// ============================================================================

/**
 * Find cross-city arbitrage opportunities for an item.
 * Returns pairs of cities where you can buy low and sell high.
 * Each opportunity includes both instant sell and undercut options.
 */
export function findArbitrageOpportunities(
	itemId: string,
	options?: { minProfitPercent?: number; quality?: number; maxAgeMinutes?: number },
): ArbitrageOpportunity[] {
	const minProfit = options?.minProfitPercent ?? 5
	const quality = options?.quality ?? 1
	const prices = getBestPrices(itemId, {
		quality,
		maxAgeMinutes: options?.maxAgeMinutes,
	})

	const opportunities: ArbitrageOpportunity[] = []

	// Find all profitable city pairs
	for (const buyCity of prices) {
		if (buyCity.buyPrice === null) continue

		for (const sellCity of prices) {
			if (buyCity.city === sellCity.city) continue

			// Use the older of the two timestamps to show worst-case data age
			const oldestFetchedAt = Math.min(buyCity.fetchedAt, sellCity.fetchedAt)
			const dataAgeMinutes = Math.round((Date.now() - oldestFetchedAt) / 60000)

			// Calculate instant sell profit (sell to highest buy order)
			let instantSellPrice: number | null = null
			let instantProfit: number | null = null
			let instantProfitPercent: number | null = null

			if (sellCity.sellPrice !== null) {
				instantSellPrice = sellCity.sellPrice
				instantProfit = instantSellPrice - buyCity.buyPrice
				instantProfitPercent = Math.round((instantProfit / buyCity.buyPrice) * 1000) / 10
			}

			// Calculate undercut profit (place sell order 1 silver below lowest sell order in sell city)
			let undercutSellPrice: number | null = null
			let undercutProfit: number | null = null
			let undercutProfitPercent: number | null = null

			const lowestSellInDestination = sellCity.buyPrice // buyPrice in CityPriceComparison is the lowest sell order
			if (lowestSellInDestination !== null) {
				undercutSellPrice = lowestSellInDestination - 1
				undercutProfit = undercutSellPrice - buyCity.buyPrice
				undercutProfitPercent = Math.round((undercutProfit / buyCity.buyPrice) * 1000) / 10
			}

			// Include if either strategy meets the minimum profit threshold
			const instantMeetsThreshold = instantProfitPercent !== null && instantProfitPercent >= minProfit
			const undercutMeetsThreshold = undercutProfitPercent !== null && undercutProfitPercent >= minProfit

			if (instantMeetsThreshold || undercutMeetsThreshold) {
				opportunities.push({
					buyCity: buyCity.city,
					sellCity: sellCity.city,
					buyPrice: buyCity.buyPrice,
					instantSellPrice,
					instantProfit,
					instantProfitPercent,
					undercutSellPrice,
					undercutProfit,
					undercutProfitPercent,
					dataAgeMinutes,
					quality,
				})
			}
		}
	}

	// Sort by best available profit percentage descending
	return opportunities.sort((a, b) => {
		const aMax = Math.max(a.instantProfitPercent ?? -Infinity, a.undercutProfitPercent ?? -Infinity)
		const bMax = Math.max(b.instantProfitPercent ?? -Infinity, b.undercutProfitPercent ?? -Infinity)
		return bMax - aMax
	})
}

/**
 * Calculate best price to acquire materials for crafting.
 * Prefers order book for quantity awareness, falls back to latest prices.
 */
export function getCraftingInputCost(
	itemId: string,
	quantity: number,
	options?: { preferredCity?: string; quality?: number },
): CraftingCostResult | null {
	const quality = options?.quality ?? 1

	// If preferred city specified, try order book there first
	if (options?.preferredCity) {
		const orderBookResult = getCostToBuy(itemId, options.preferredCity, quantity, {
			quality,
		})
		if (orderBookResult && orderBookResult.quantityFilled >= quantity) {
			return {
				city: options.preferredCity,
				totalCost: orderBookResult.totalAmount,
				avgPricePerUnit: orderBookResult.avgPricePerUnit,
				quantityAvailable: orderBookResult.quantityFilled,
				usedOrderBook: true,
			}
		}
	}

	// Try all cities' order books
	const cities = [
		'Caerleon',
		'Bridgewatch',
		'Fort Sterling',
		'Lymhurst',
		'Martlock',
		'Thetford',
	]

	let bestResult: CraftingCostResult | null = null

	for (const city of cities) {
		const result = getCostToBuy(itemId, city, quantity, { quality })
		if (result && result.quantityFilled >= quantity) {
			if (!bestResult || result.avgPricePerUnit < bestResult.avgPricePerUnit) {
				bestResult = {
					city,
					totalCost: result.totalAmount,
					avgPricePerUnit: result.avgPricePerUnit,
					quantityAvailable: result.quantityFilled,
					usedOrderBook: true,
				}
			}
		}
	}

	if (bestResult) return bestResult

	// Fall back to latest prices (no quantity awareness)
	const latestPrice = getInstantBuyPrice(itemId, { quality })
	if (latestPrice) {
		return {
			city: latestPrice.city,
			totalCost: latestPrice.price * quantity,
			avgPricePerUnit: latestPrice.price,
			quantityAvailable: 1, // Unknown quantity
			usedOrderBook: false,
		}
	}

	return null
}

/**
 * Get expected sell price for crafted items.
 * Uses 6-hour recent data per the market data guide recommendation.
 */
export function getExpectedSellPrice(
	itemId: string,
	options?: { city?: string; quality?: number },
): number | null {
	// Try 6-hour data first (recommended for crafted items)
	const recentPrice = getRecentPrice(itemId, options)
	if (recentPrice) return recentPrice

	// Fall back to daily baseline
	return getBaselinePrice(itemId, options)
}
