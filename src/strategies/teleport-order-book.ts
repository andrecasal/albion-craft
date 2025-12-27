/**
 * Teleport + Instant Sell Arbitrage Strategy (Order Book)
 *
 * Capacity-aware scan using order book depth for realistic profit calculations.
 *
 * Features:
 * - Walks the order book to find profitable trade quantities
 * - Respects player's carry capacity (mount, bag, boots, pork pie)
 * - Calculates weighted average prices across order levels
 * - Shows total profit for a full trip
 *
 * Use case: Realistic planning when you want to maximize profit per trip.
 * Trade-off: Slower than single-item scan, requires fresh order book data.
 */

import { getBaselinePrice, getDailyVolume, getOrderBookDepth } from '../market-api'
import { ITEMS_BY_ID, ALL_ITEMS } from '../constants/items'
import {
	calculateCarryCapacity,
	calculateTeleportCost,
	calculateInstantSellTax,
	type CarryLoadout,
} from '../trading-economics'
import { type RoyalCity } from '../constants/locations'

// ============================================================================
// TYPES
// ============================================================================

export interface TeleportArbitrageOpportunity {
	itemId: string
	itemName: string
	buyCity: string
	sellCity: string
	quality: number
	itemWeight: number
	dataAgeMinutes: number
	baselinePrice: number | null
	dailyVolume: number
	// Order book fill info
	fillQuantity: number // How many items can be profitably traded
	avgBuyPrice: number // Weighted average buy price across order book
	avgSellPrice: number // Weighted average sell price across order book
	buyPriceVsBaseline: number | null
	sellPriceVsBaseline: number | null
	// Profit calculations (for the full fill quantity)
	totalCost: number // Total silver to buy all items
	totalRevenue: number // Total silver received after selling
	totalTaxPaid: number
	totalTeleportCost: number
	totalProfit: number // Net profit for the full quantity
	profitPerUnit: number // Average profit per item
	profitPerHour: number // Total profit / transaction time
}

export interface TeleportArbitrageScanOptions {
	/** Maximum number of results to return (default: 50) */
	limit?: number
	/** Cities to exclude from buy/sell (default: ['Black Market']) */
	excludeCities?: string[]
	/** Specific item IDs to scan (default: all items) */
	itemIds?: string[]
	/** Whether player has premium (affects tax rate, default: true) */
	hasPremium?: boolean
	/** Player's equipment loadout for carry capacity calculation */
	loadout?: CarryLoadout
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
 * Find teleport + instant sell arbitrage opportunities.
 * Scans ALL items across ALL quality levels (1-5) to find the best opportunities.
 *
 * Uses order book depth to calculate:
 * - How many items can be profitably traded (up to carry capacity)
 * - Weighted average buy/sell prices across order levels
 * - Total profit for a full trip
 *
 * Profit calculation includes:
 * - Sales tax (4% with premium, 8% without)
 * - Teleport cost (based on total weight and distance)
 *
 * Results are always sorted by profit/hour descending.
 */
export function findTeleportArbitrageOpportunities(
	options?: TeleportArbitrageScanOptions
): TeleportArbitrageOpportunity[] {
	const limit = options?.limit ?? 50
	const excludeCities = options?.excludeCities ?? ['Black Market']
	const itemIds = options?.itemIds ?? ALL_ITEMS.map((i) => i.id)
	const hasPremium = options?.hasPremium ?? true
	const loadout = options?.loadout ?? {}

	// Calculate player's carry capacity from loadout
	const carryCapacity = calculateCarryCapacity(loadout)

	// Only use royal cities for teleport arbitrage (Brecilien excluded - no teleport)
	const activeCities = ROYAL_CITIES.filter((c) => !excludeCities.includes(c))
	const opportunities: TeleportArbitrageOpportunity[] = []

	// Scan all items across all quality levels
	for (const itemId of itemIds) {
		const itemEntry = ITEMS_BY_ID.get(itemId)
		if (!itemEntry) continue

		// Get item weight (default to 1kg if not specified)
		const itemWeight = itemEntry.weight ?? DEFAULT_ITEM_WEIGHT

		// Calculate max items we can carry
		const maxCarryQuantity = Math.floor(carryCapacity / itemWeight)
		if (maxCarryQuantity <= 0) continue

		// Scan all quality levels for this item
		for (const quality of ALL_QUALITIES) {
			// Find best city pair by checking order books
			const result = findBestCityPairWithOrderBook(
				itemId,
				quality,
				itemWeight,
				maxCarryQuantity,
				activeCities,
				hasPremium
			)

			if (!result) continue

			// Get baseline price for comparison
			const baselinePrice = getBaselinePrice(itemId, { quality, days: 28 })

			// Calculate buy price percentage vs baseline
			let buyPriceVsBaseline: number | null = null
			if (baselinePrice !== null && baselinePrice > 0) {
				buyPriceVsBaseline = Math.round(((result.avgBuyPrice - baselinePrice) / baselinePrice) * 1000) / 10
			}

			// Calculate sell price percentage vs baseline
			let sellPriceVsBaseline: number | null = null
			if (baselinePrice !== null && baselinePrice > 0) {
				sellPriceVsBaseline = Math.round(((result.avgSellPrice - baselinePrice) / baselinePrice) * 1000) / 10
			}

			// Get daily volume
			const dailyVolume = getDailyVolume(itemId, { city: result.sellCity, quality })

			// Calculate profit per hour (based on total profit for the trip)
			const tradesPerHour = 60 / TRANSACTION_TIME_MINUTES
			const profitPerHour = Math.round(result.totalProfit * tradesPerHour)

			opportunities.push({
				itemId,
				itemName: itemEntry.name,
				buyCity: result.buyCity,
				sellCity: result.sellCity,
				quality,
				itemWeight,
				dataAgeMinutes: result.dataAgeMinutes,
				baselinePrice,
				dailyVolume,
				// Order book fill info
				fillQuantity: result.fillQuantity,
				avgBuyPrice: result.avgBuyPrice,
				avgSellPrice: result.avgSellPrice,
				buyPriceVsBaseline,
				sellPriceVsBaseline,
				// Profit calculations (for the full fill quantity)
				totalCost: result.totalCost,
				totalRevenue: result.totalRevenue,
				totalTaxPaid: result.totalTaxPaid,
				totalTeleportCost: result.totalTeleportCost,
				totalProfit: result.totalProfit,
				profitPerUnit: result.fillQuantity > 0 ? Math.round(result.totalProfit / result.fillQuantity) : 0,
				profitPerHour,
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

interface CityPairResult {
	buyCity: RoyalCity
	sellCity: RoyalCity
	fillQuantity: number
	avgBuyPrice: number
	avgSellPrice: number
	totalCost: number
	totalRevenue: number
	totalTaxPaid: number
	totalTeleportCost: number
	totalProfit: number
	dataAgeMinutes: number
}

/**
 * Find the best city pair for an item by walking order books.
 * Returns the pair with highest total profit up to carry capacity.
 */
function findBestCityPairWithOrderBook(
	itemId: string,
	quality: number,
	itemWeight: number,
	maxCarryQuantity: number,
	cities: readonly RoyalCity[],
	hasPremium: boolean
): CityPairResult | null {
	let bestResult: CityPairResult | null = null

	// Use 24 hours as max age - we still show opportunities but display their age
	// so users can decide if data is too stale
	const maxAgeMinutes = 24 * 60

	// Try all city pairs
	for (const buyCity of cities) {
		// Get sell orders in buy city (what we can buy from)
		const sellOrders = getOrderBookDepth(itemId, buyCity, {
			quality,
			orderType: 'sell',
			maxAgeMinutes,
		})
		if (sellOrders.length === 0) continue

		for (const sellCity of cities) {
			if (buyCity === sellCity) continue

			// Get buy orders in sell city (what we can sell to)
			const buyOrders = getOrderBookDepth(itemId, sellCity, {
				quality,
				orderType: 'buy',
				maxAgeMinutes,
			})
			if (buyOrders.length === 0) continue

			// Walk the order books to find profitable fill
			const result = calculateOrderBookFill(
				sellOrders, // sorted by price ASC (cheapest first)
				buyOrders, // sorted by price ASC (we'll reverse to get highest first)
				itemWeight,
				maxCarryQuantity,
				buyCity,
				sellCity,
				hasPremium
			)

			if (!result) continue

			// Track best result by total profit
			if (!bestResult || result.totalProfit > bestResult.totalProfit) {
				bestResult = result
			}
		}
	}

	return bestResult
}

/**
 * Walk order books to calculate profitable fill quantity and total profit.
 * Matches sell orders (what we buy) against buy orders (what we sell to).
 */
function calculateOrderBookFill(
	sellOrders: { price: number; quantity: number; updatedAt: Date }[],
	buyOrders: { price: number; quantity: number; updatedAt: Date }[],
	itemWeight: number,
	maxCarryQuantity: number,
	buyCity: RoyalCity,
	sellCity: RoyalCity,
	hasPremium: boolean
): CityPairResult | null {
	if (sellOrders.length === 0 || buyOrders.length === 0) return null

	// Sort: sell orders ASC (cheapest first), buy orders DESC (highest first)
	const sortedSellOrders = [...sellOrders].sort((a, b) => a.price - b.price)
	const sortedBuyOrders = [...buyOrders].sort((a, b) => b.price - a.price)

	let fillQuantity = 0
	let totalCost = 0
	let totalRevenue = 0
	let totalTaxPaid = 0

	let sellIdx = 0
	let buyIdx = 0
	let sellRemaining = sortedSellOrders[0]?.quantity ?? 0
	let buyRemaining = sortedBuyOrders[0]?.quantity ?? 0

	// Track oldest data for age calculation
	let oldestDate = new Date()

	while (
		sellIdx < sortedSellOrders.length &&
		buyIdx < sortedBuyOrders.length &&
		fillQuantity < maxCarryQuantity
	) {
		const buyPrice = sortedSellOrders[sellIdx].price // price to buy from sell order
		const sellPrice = sortedBuyOrders[buyIdx].price // price we get from buy order

		// Calculate profit for this price combination
		const tax = calculateInstantSellTax(sellPrice, hasPremium)
		const netRevenue = sellPrice - tax
		const unitProfit = netRevenue - buyPrice

		// Stop if this combination is not profitable (before teleport cost)
		// We'll deduct teleport cost at the end
		if (unitProfit <= 0) break

		// How many units can we trade at this price level?
		const availableQuantity = Math.min(sellRemaining, buyRemaining)
		const remainingCapacity = maxCarryQuantity - fillQuantity
		const tradeQuantity = Math.min(availableQuantity, remainingCapacity)

		fillQuantity += tradeQuantity
		totalCost += buyPrice * tradeQuantity
		totalRevenue += sellPrice * tradeQuantity
		totalTaxPaid += tax * tradeQuantity

		// Track oldest data
		if (sortedSellOrders[sellIdx].updatedAt < oldestDate) {
			oldestDate = sortedSellOrders[sellIdx].updatedAt
		}
		if (sortedBuyOrders[buyIdx].updatedAt < oldestDate) {
			oldestDate = sortedBuyOrders[buyIdx].updatedAt
		}

		// Update remaining quantities
		sellRemaining -= tradeQuantity
		buyRemaining -= tradeQuantity

		// Move to next order if current is exhausted
		if (sellRemaining === 0) {
			sellIdx++
			sellRemaining = sortedSellOrders[sellIdx]?.quantity ?? 0
		}
		if (buyRemaining === 0) {
			buyIdx++
			buyRemaining = sortedBuyOrders[buyIdx]?.quantity ?? 0
		}
	}

	if (fillQuantity === 0) return null

	// Calculate teleport cost for the total weight
	const totalWeight = fillQuantity * itemWeight
	const totalTeleportCost = calculateTeleportCost(totalWeight, buyCity, sellCity)

	// Calculate total profit after all costs
	const totalProfit = totalRevenue - totalTaxPaid - totalCost - totalTeleportCost

	// Skip if not profitable after teleport
	if (totalProfit <= 0) return null

	const dataAgeMinutes = Math.floor((Date.now() - oldestDate.getTime()) / 60000)

	return {
		buyCity,
		sellCity,
		fillQuantity,
		avgBuyPrice: Math.round(totalCost / fillQuantity),
		avgSellPrice: Math.round(totalRevenue / fillQuantity),
		totalCost,
		totalRevenue,
		totalTaxPaid,
		totalTeleportCost,
		totalProfit,
		dataAgeMinutes,
	}
}
