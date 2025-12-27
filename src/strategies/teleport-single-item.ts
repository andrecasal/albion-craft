/**
 * Teleport + Instant Sell Arbitrage Strategy (Single Item)
 *
 * Fast scan using latest prices to find arbitrage opportunities.
 * Shows the best single-item price discrepancy between cities.
 *
 * Use case: Quick overview of current market opportunities.
 * Limitation: Doesn't account for order book depth or carry capacity.
 */

import { db } from '../db/db'
import { getBaselinePrice, getDailyVolume } from '../market-api'
import { ITEMS_BY_ID, ALL_ITEMS } from '../constants/items'
import { calculateUnitProfitInstantSell } from '../trading-economics'
import { type RoyalCity } from '../constants/locations'

// ============================================================================
// TYPES
// ============================================================================

export interface SingleItemArbitrageOpportunity {
	itemId: string
	itemName: string
	buyCity: string
	sellCity: string
	quality: number
	itemWeight: number
	dataAgeMinutes: number
	baselinePrice: number | null
	dailyVolume: number
	// Single price points (best available)
	buyPrice: number
	instantSellPrice: number
	buyPriceVsBaseline: number | null
	sellPriceVsBaseline: number | null
	// Profit calculations (per unit)
	grossProfit: number
	netProfit: number
	profitPercent: number
	profitPerHour: number
	taxPaid: number
	teleportCost: number
}

export interface SingleItemArbitrageScanOptions {
	/** Maximum number of results to return (default: 50) */
	limit?: number
	/** Minimum profit percentage to include (default: 0) */
	minProfitPercent?: number
	/** Cities to exclude from buy/sell (default: ['Black Market']) */
	excludeCities?: string[]
	/** Specific item IDs to scan (default: all items) */
	itemIds?: string[]
	/** Whether player has premium (affects tax rate, default: true) */
	hasPremium?: boolean
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Royal cities that support teleport (RoyalCity type from locations.ts)
const ROYAL_CITIES: RoyalCity[] = [
	'Caerleon',
	'Bridgewatch',
	'Fort Sterling',
	'Lymhurst',
	'Martlock',
	'Thetford',
]

// Default item weight when not specified (in kg)
const DEFAULT_ITEM_WEIGHT = 1.0

// Estimated time per transaction in minutes (buy + teleport + sell)
// This is used to calculate profit/hour
const TRANSACTION_TIME_MINUTES = 2

// All quality levels to scan
const ALL_QUALITIES = [1, 2, 3, 4, 5] as const

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Find teleport + instant sell arbitrage opportunities using latest prices.
 * Scans ALL items across ALL quality levels (1-5) to find the best opportunities.
 *
 * This is a fast scan that uses the best single price point from each city.
 * It does NOT account for order book depth or carry capacity.
 *
 * Profit calculation includes:
 * - Sales tax (4% with premium, 8% without)
 * - Teleport cost (based on item weight and distance)
 *
 * Results are always sorted by profit/hour descending.
 */
export function findSingleItemArbitrageOpportunities(
	options?: SingleItemArbitrageScanOptions
): SingleItemArbitrageOpportunity[] {
	const limit = options?.limit ?? 50
	const minProfitPercent = options?.minProfitPercent ?? 0
	const excludeCities = options?.excludeCities ?? ['Black Market']
	const itemIds = options?.itemIds ?? ALL_ITEMS.map((i) => i.id)
	const hasPremium = options?.hasPremium ?? true

	// Only use royal cities for teleport arbitrage (Brecilien excluded - no teleport)
	const activeCities = ROYAL_CITIES.filter((c) => !excludeCities.includes(c))
	const opportunities: SingleItemArbitrageOpportunity[] = []

	// Scan all items across all quality levels
	for (const itemId of itemIds) {
		const itemEntry = ITEMS_BY_ID.get(itemId)
		if (!itemEntry) continue

		// Get item weight (default to 1kg if not specified)
		const itemWeight = itemEntry.weight ?? DEFAULT_ITEM_WEIGHT

		// Scan all quality levels for this item
		for (const quality of ALL_QUALITIES) {
			// Get prices for all cities at this quality level
			const cityPrices = getCityPricesForItem(itemId, quality, activeCities)
			if (cityPrices.length === 0) continue

			// Find best buy (lowest sell order) and best sell (highest buy order)
			let bestBuy: { city: RoyalCity; price: number; observedAt: Date } | null = null
			let bestSell: { city: RoyalCity; price: number; observedAt: Date } | null = null

			for (const cp of cityPrices) {
				if (cp.buyPrice !== null) {
					if (!bestBuy || cp.buyPrice < bestBuy.price) {
						bestBuy = { city: cp.city as RoyalCity, price: cp.buyPrice, observedAt: cp.buyPriceDate }
					}
				}
				if (cp.sellPrice !== null) {
					if (!bestSell || cp.sellPrice > bestSell.price) {
						bestSell = { city: cp.city as RoyalCity, price: cp.sellPrice, observedAt: cp.sellPriceDate }
					}
				}
			}

			// Need both buy and sell, and they must be in different cities
			if (!bestBuy || !bestSell) continue
			if (bestBuy.city === bestSell.city) continue

			// Calculate actual profit using trading economics
			const profitResult = calculateUnitProfitInstantSell(
				bestBuy.price,
				bestSell.price,
				itemWeight,
				bestBuy.city,
				bestSell.city,
				hasPremium
			)

			// Skip if below minimum profit threshold
			if (profitResult.profitPercent < minProfitPercent) continue

			// Calculate profit per hour
			// Assumes TRANSACTION_TIME_MINUTES per trade
			const tradesPerHour = 60 / TRANSACTION_TIME_MINUTES
			const profitPerHour = Math.round(profitResult.netProfit * tradesPerHour)

			// Get baseline price for comparison
			const baselinePrice = getBaselinePrice(itemId, { quality, days: 28 })

			// Calculate buy price percentage vs baseline
			let buyPriceVsBaseline: number | null = null
			if (baselinePrice !== null && baselinePrice > 0) {
				buyPriceVsBaseline = Math.round(((bestBuy.price - baselinePrice) / baselinePrice) * 1000) / 10
			}

			// Calculate sell price percentage vs baseline
			let sellPriceVsBaseline: number | null = null
			if (baselinePrice !== null && baselinePrice > 0) {
				sellPriceVsBaseline = Math.round(((bestSell.price - baselinePrice) / baselinePrice) * 1000) / 10
			}

			// Get daily volume
			const dailyVolume = getDailyVolume(itemId, { city: bestSell.city, quality })

			// Calculate data age (worst case of buy/sell)
			const buyAge = Math.floor((Date.now() - bestBuy.observedAt.getTime()) / 60000)
			const sellAge = Math.floor((Date.now() - bestSell.observedAt.getTime()) / 60000)
			const dataAgeMinutes = Math.max(buyAge, sellAge)

			opportunities.push({
				itemId,
				itemName: itemEntry.name,
				buyCity: bestBuy.city,
				buyPrice: bestBuy.price,
				baselinePrice,
				buyPriceVsBaseline,
				dailyVolume,
				dataAgeMinutes,
				sellCity: bestSell.city,
				instantSellPrice: bestSell.price,
				sellPriceVsBaseline,
				quality,
				// Profit calculations
				grossProfit: profitResult.grossProfit,
				netProfit: profitResult.netProfit,
				profitPercent: profitResult.profitPercent,
				profitPerHour,
				taxPaid: profitResult.taxPaid,
				teleportCost: profitResult.teleportCost,
				itemWeight,
			})
		}
	}

	// Always sort by profit/hour descending
	opportunities.sort((a, b) => b.profitPerHour - a.profitPerHour)

	return opportunities.slice(0, limit)
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

interface CityPriceData {
	city: string
	buyPrice: number | null // lowest sell order (cost to buy)
	buyPriceDate: Date
	sellPrice: number | null // highest buy order (revenue when selling)
	sellPriceDate: Date
}

function getCityPricesForItem(
	itemId: string,
	quality: number,
	cities: readonly string[]
): CityPriceData[] {
	const results: CityPriceData[] = []

	for (const city of cities) {
		const row = db
			.prepare(
				`
			SELECT
				sell_price_min, sell_price_min_date,
				buy_price_max, buy_price_max_date
			FROM latest_prices
			WHERE item_id = ? AND city = ? AND quality = ?
		`
			)
			.get(itemId, city, quality) as
			| {
					sell_price_min: number
					sell_price_min_date: string
					buy_price_max: number
					buy_price_max_date: string
			  }
			| undefined

		if (!row) continue

		results.push({
			city,
			buyPrice: row.sell_price_min > 0 ? row.sell_price_min : null,
			buyPriceDate: new Date(row.sell_price_min_date),
			sellPrice: row.buy_price_max > 0 ? row.buy_price_max : null,
			sellPriceDate: new Date(row.buy_price_max_date),
		})
	}

	return results
}
