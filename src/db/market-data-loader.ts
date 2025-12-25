/**
 * Market Data Loader
 *
 * Loads and structures market data from the database into a hierarchical format:
 * Item -> City -> Quality -> { latestPrices, orderBook, history }
 */

import { db } from './db'
import { ITEMS_BY_ID, type ItemEntry } from '../constants/items'

// ============================================================================
// Types
// ============================================================================

export interface HistoricalDataPoint {
	timestamp: string
	avgPrice: number
	volume: number
}

export interface OrderLevel {
	price: number
	amount: number
}

export interface OrderBook {
	sellLevels: OrderLevel[] // sorted by price ascending (cheapest first)
	buyLevels: OrderLevel[] // sorted by price descending (highest first)
}

export interface MarketData {
	latestPrices: {
		sellPriceMin: number
		buyPriceMax: number
	}
	orderBook: OrderBook
	history: {
		daily: HistoricalDataPoint[]
		sixHour: HistoricalDataPoint[]
		hourly: HistoricalDataPoint[]
	}
}

export interface CityMarketData {
	[quality: number]: MarketData
}

export interface ItemMarketData {
	itemId: string
	itemName: string
	cities: {
		[city: string]: CityMarketData
	}
}

// ============================================================================
// Internal row types (from database queries)
// ============================================================================

interface JoinedRow {
	item_id: string
	city: string
	quality: number
	sell_price_min: number
	buy_price_max: number
	da_timestamp: string | null
	da_avg_price: number | null
	da_volume: number | null
	sh_timestamp: string | null
	sh_avg_price: number | null
	sh_volume: number | null
	hr_timestamp: string | null
	hr_avg_price: number | null
	hr_volume: number | null
}

interface OrderBookRow {
	item_id: string
	city: string
	quality: number
	price: number
	total_amount: number
	order_type: string
}

// ============================================================================
// Query builders
// ============================================================================

function buildPricesAndHistoryQuery(itemIds: string[]): { sql: string; params: string[] } {
	const placeholders = itemIds.map(() => '?').join(', ')

	const sql = `
		SELECT
			lp.item_id,
			lp.city,
			lp.quality,
			lp.sell_price_min,
			lp.buy_price_max,
			da.timestamp AS da_timestamp,
			da.avg_price AS da_avg_price,
			da.item_count AS da_volume,
			sh.timestamp AS sh_timestamp,
			sh.avg_price AS sh_avg_price,
			sh.item_count AS sh_volume,
			hr.timestamp AS hr_timestamp,
			hr.avg_price AS hr_avg_price,
			hr.item_count AS hr_volume
		FROM latest_prices lp
		LEFT JOIN (
			SELECT item_id, city, quality, timestamp, avg_price, item_count,
				ROW_NUMBER() OVER (PARTITION BY item_id, city, quality ORDER BY timestamp DESC) as rn
			FROM daily_average_prices
			WHERE item_id IN (${placeholders})
		) da ON lp.item_id = da.item_id AND lp.city = da.city AND lp.quality = da.quality
		LEFT JOIN (
			SELECT item_id, city, quality, timestamp, avg_price, item_count,
				ROW_NUMBER() OVER (PARTITION BY item_id, city, quality ORDER BY timestamp DESC) as rn
			FROM six_hour_average_prices
			WHERE item_id IN (${placeholders})
		) sh ON lp.item_id = sh.item_id AND lp.city = sh.city AND lp.quality = sh.quality AND sh.rn = da.rn
		LEFT JOIN (
			SELECT item_id, city, quality, timestamp, avg_price, item_count,
				ROW_NUMBER() OVER (PARTITION BY item_id, city, quality ORDER BY timestamp DESC) as rn
			FROM hourly_average_prices
			WHERE item_id IN (${placeholders})
		) hr ON lp.item_id = hr.item_id AND lp.city = hr.city AND lp.quality = hr.quality AND hr.rn = da.rn
		WHERE lp.item_id IN (${placeholders})
		ORDER BY lp.item_id, lp.city, lp.quality, da.rn
	`

	// 4 copies of itemIds for the 4 placeholders in the query
	const params = [...itemIds, ...itemIds, ...itemIds, ...itemIds]

	return { sql, params }
}

function buildOrderBookQuery(itemIds: string[]): { sql: string; params: string[] } {
	const placeholders = itemIds.map(() => '?').join(', ')

	const sql = `
		SELECT
			item_id,
			city,
			quality,
			price,
			SUM(amount) as total_amount,
			order_type
		FROM order_book
		WHERE item_id IN (${placeholders})
		GROUP BY item_id, city, quality, price, order_type
		ORDER BY item_id, city, quality,
			CASE WHEN order_type = 'sell' THEN price END ASC,
			CASE WHEN order_type = 'buy' THEN price END DESC
	`

	return { sql, params: itemIds }
}

// ============================================================================
// Data organization
// ============================================================================

function organizeMarketData(
	priceRows: JoinedRow[],
	orderRows: OrderBookRow[],
): Map<string, ItemMarketData> {
	const itemsMap = new Map<string, ItemMarketData>()

	// Process price and history data
	for (const row of priceRows) {
		let item = itemsMap.get(row.item_id)
		if (!item) {
			const itemEntry = ITEMS_BY_ID.get(row.item_id)
			item = {
				itemId: row.item_id,
				itemName: itemEntry?.name ?? 'Unknown',
				cities: {},
			}
			itemsMap.set(row.item_id, item)
		}

		if (!item.cities[row.city]) {
			item.cities[row.city] = {}
		}

		if (!item.cities[row.city][row.quality]) {
			item.cities[row.city][row.quality] = {
				latestPrices: {
					sellPriceMin: row.sell_price_min,
					buyPriceMax: row.buy_price_max,
				},
				orderBook: {
					sellLevels: [],
					buyLevels: [],
				},
				history: {
					daily: [],
					sixHour: [],
					hourly: [],
				},
			}
		}

		const marketData = item.cities[row.city][row.quality]

		// Add historical data points (avoid duplicates)
		if (row.da_timestamp && row.da_avg_price !== null && row.da_volume !== null) {
			const exists = marketData.history.daily.some((d) => d.timestamp === row.da_timestamp)
			if (!exists) {
				marketData.history.daily.push({
					timestamp: row.da_timestamp,
					avgPrice: row.da_avg_price,
					volume: row.da_volume,
				})
			}
		}

		if (row.sh_timestamp && row.sh_avg_price !== null && row.sh_volume !== null) {
			const exists = marketData.history.sixHour.some((d) => d.timestamp === row.sh_timestamp)
			if (!exists) {
				marketData.history.sixHour.push({
					timestamp: row.sh_timestamp,
					avgPrice: row.sh_avg_price,
					volume: row.sh_volume,
				})
			}
		}

		if (row.hr_timestamp && row.hr_avg_price !== null && row.hr_volume !== null) {
			const exists = marketData.history.hourly.some((d) => d.timestamp === row.hr_timestamp)
			if (!exists) {
				marketData.history.hourly.push({
					timestamp: row.hr_timestamp,
					avgPrice: row.hr_avg_price,
					volume: row.hr_volume,
				})
			}
		}
	}

	// Add order book data
	for (const order of orderRows) {
		const item = itemsMap.get(order.item_id)
		if (!item) continue

		const cityData = item.cities[order.city]
		if (!cityData) continue

		const marketData = cityData[order.quality]
		if (!marketData) continue

		const level: OrderLevel = {
			price: order.price,
			amount: order.total_amount,
		}

		if (order.order_type === 'sell') {
			marketData.orderBook.sellLevels.push(level)
		} else {
			marketData.orderBook.buyLevels.push(level)
		}
	}

	return itemsMap
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load market data for specific items
 * @param itemIds Array of item IDs to load
 * @returns Map of item ID to ItemMarketData
 */
export function loadMarketData(itemIds: string[]): Map<string, ItemMarketData> {
	if (itemIds.length === 0) {
		return new Map()
	}

	const pricesQuery = buildPricesAndHistoryQuery(itemIds)
	const orderBookQuery = buildOrderBookQuery(itemIds)

	const priceRows = db.prepare(pricesQuery.sql).all(...pricesQuery.params) as JoinedRow[]
	const orderRows = db.prepare(orderBookQuery.sql).all(...orderBookQuery.params) as OrderBookRow[]

	return organizeMarketData(priceRows, orderRows)
}

/**
 * Load market data for specific items (returns array)
 * @param itemIds Array of item IDs to load
 * @returns Array of ItemMarketData
 */
export function loadMarketDataArray(itemIds: string[]): ItemMarketData[] {
	return Array.from(loadMarketData(itemIds).values())
}

/**
 * Load market data for a single item
 * @param itemId Item ID to load
 * @returns ItemMarketData or undefined if not found
 */
export function loadItemMarketData(itemId: string): ItemMarketData | undefined {
	return loadMarketData([itemId]).get(itemId)
}

/**
 * Load market data for items by their entries
 * @param items Array of ItemEntry objects
 * @returns Map of item ID to ItemMarketData
 */
export function loadMarketDataForItems(items: ItemEntry[]): Map<string, ItemMarketData> {
	return loadMarketData(items.map((i) => i.id))
}
