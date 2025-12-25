/**
 * Trading Economics API
 *
 * Functions for calculating taxes, teleport costs, transport time,
 * carry capacity, and profitable arbitrage opportunities.
 */

import taxes from './constants/taxes.json'
import { CITY_DISTANCES, type RoyalCity } from './constants/locations'
import {
	getMount,
	getMountCapacity,
	BASE_CARRY_CAPACITY,
	BASE_SPEED,
	MAP_UNITS_TO_METERS,
	type Quality,
} from './constants/mounts'
import { getBagCapacity } from './constants/bags'
import { getBootCapacity } from './constants/boots'
import type { OrderLevel } from './market-api'

// Re-export Quality type for convenience
export type { Quality } from './constants/mounts'

// ============================================================================
// TYPES
// ============================================================================

/** Equipment loadout for capacity calculation */
export interface CarryLoadout {
	mountId?: string
	mountQuality?: Quality
	bagId?: string
	bagQuality?: Quality
	bootsId?: string
	bootsQuality?: Quality
	/** Whether player has Pork Pie buff (+30% carry capacity) */
	hasPorkPie?: boolean
}

/** Result of a profit calculation */
export interface ProfitResult {
	grossProfit: number
	netProfit: number
	taxPaid: number
	teleportCost: number
	profitPercent: number
	breakEvenPrice: number
}

/** Result of transport time calculation */
export interface TransportResult {
	distanceUnits: number
	speedMs: number
	travelTimeSeconds: number
	trips: number
	totalTimeSeconds: number // one-way travel time * trips
}

/** Result of arbitrage analysis for instant sell strategy */
export interface ArbitrageInstantSellResult {
	profitableQuantity: number
	totalProfit: number
	avgProfitPerUnit: number
	totalTeleportCost: number
	ordersUsed: number
}

/** Result of arbitrage analysis for sell order strategy */
export interface ArbitrageSellOrderResult {
	profitableQuantity: number
	totalProfit: number
	avgProfitPerUnit: number
	totalTeleportCost: number
	suggestedPrice: number
	ordersUsed: number
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Teleport cost rate.
 * TODO: These values are placeholders and need in-game research to calibrate.
 */
const TELEPORT_RATE = 0.5 // silver per kg per map unit (PLACEHOLDER)

/** Pork Pie buff multiplier (+30% carry capacity) */
const PORK_PIE_MULTIPLIER = 1.3

// ============================================================================
// TAX CALCULATIONS
// ============================================================================

/**
 * Get the sales tax rate as a decimal.
 * @param hasPremium - Whether the player has premium subscription
 * @returns Tax rate (e.g., 0.04 for 4%)
 */
export function getSalesTaxRate(hasPremium: boolean): number {
	return hasPremium ? taxes.salesTax.withPremium / 100 : taxes.salesTax.withoutPremium / 100
}

/**
 * Get the listing fee rate as a decimal.
 * @returns Listing fee rate (e.g., 0.025 for 2.5%)
 */
export function getListingFeeRate(): number {
	return taxes.listingFee / 100
}

/**
 * Calculate tax for instant selling to buy orders.
 * Only sales tax applies (no listing fee for instant sales).
 *
 * @param sellPrice - The price at which the item is sold
 * @param hasPremium - Whether the player has premium subscription
 * @returns Tax amount in silver
 */
export function calculateInstantSellTax(sellPrice: number, hasPremium: boolean): number {
	const taxRate = getSalesTaxRate(hasPremium)
	return Math.floor(sellPrice * taxRate)
}

/**
 * Calculate total tax for placing a sell order.
 * Both listing fee (2.5%) and sales tax apply when order fills.
 *
 * @param sellPrice - The price at which the sell order is placed
 * @param hasPremium - Whether the player has premium subscription
 * @returns Total tax amount (listing fee + sales tax) in silver
 */
export function calculateSellOrderTax(sellPrice: number, hasPremium: boolean): number {
	const listingFeeRate = getListingFeeRate()
	const taxRate = getSalesTaxRate(hasPremium)

	const listingFee = Math.floor(sellPrice * listingFeeRate)
	const salesTax = Math.floor(sellPrice * taxRate)

	return listingFee + salesTax
}

/**
 * Calculate listing fee for a sell order.
 * This is charged upfront when placing the order.
 *
 * @param sellPrice - The price at which the sell order is placed
 * @returns Listing fee amount in silver
 */
export function calculateListingFee(sellPrice: number): number {
	return Math.floor(sellPrice * getListingFeeRate())
}

// ============================================================================
// TELEPORT CALCULATIONS
// ============================================================================

/**
 * Calculate teleport cost based on weight and distance.
 *
 * NOTE: The formula is a placeholder and needs in-game research to calibrate.
 *
 * @param weight - Total weight to teleport in kg
 * @param fromCity - Origin city
 * @param toCity - Destination city
 * @returns Teleport cost in silver
 */
export function calculateTeleportCost(weight: number, fromCity: RoyalCity, toCity: RoyalCity): number {
	if (fromCity === toCity) {
		return 0
	}

	const distance = CITY_DISTANCES[fromCity][toCity]
	return Math.floor(weight * distance * TELEPORT_RATE)
}

// ============================================================================
// TRANSPORT TIME CALCULATIONS
// ============================================================================

/**
 * Calculate travel time between cities using mount transport.
 * Always assumes gallop speed for realistic travel times.
 *
 * @param totalWeight - Total weight to transport in kg
 * @param mountId - Mount ID (e.g., 'T5_MOUNT_OX')
 * @param fromCity - Starting city
 * @param toCity - Destination city
 * @param quality - Mount quality level 1-5 (affects capacity for some mounts)
 * @param additionalCapacity - Extra capacity from bags/equipment (kg)
 * @returns Transport calculation result
 */
export function calculateTransportTime(
	totalWeight: number,
	mountId: string,
	fromCity: RoyalCity,
	toCity: RoyalCity,
	quality: Quality = 1,
	additionalCapacity: number = 0
): TransportResult {
	const mount = getMount(mountId)
	if (!mount) {
		throw new Error(`Unknown mount: ${mountId}`)
	}

	const distance = CITY_DISTANCES[fromCity][toCity]

	// Calculate speed (always includes gallop bonus)
	const totalSpeedBonus = mount.speedBonus + (mount.gallopSpeedBonus ?? 0)
	const speed = BASE_SPEED * (1 + totalSpeedBonus)

	// Calculate capacity
	const baseCapacity = getMountCapacity(mountId, quality)
	const effectiveCapacity = baseCapacity + additionalCapacity

	// Calculate trips needed
	const trips = totalWeight > 0 && effectiveCapacity > 0 ? Math.ceil(totalWeight / effectiveCapacity) : 1

	// Convert map units to meters and calculate travel time
	const distanceMeters = distance * MAP_UNITS_TO_METERS
	const travelTimeSeconds = distanceMeters / speed

	return {
		distanceUnits: distance,
		speedMs: speed,
		travelTimeSeconds,
		trips,
		totalTimeSeconds: travelTimeSeconds * trips,
	}
}

// ============================================================================
// CARRY CAPACITY CALCULATIONS
// ============================================================================

/**
 * Calculate total carry capacity with equipment bonuses.
 * Includes base player capacity (50kg) plus mount, bag, and boot bonuses.
 * Optionally applies Pork Pie buff (+30%).
 *
 * @param loadout - Equipment loadout configuration
 * @returns Total carry capacity in kg
 */
export function calculateCarryCapacity(loadout: CarryLoadout): number {
	let capacity = BASE_CARRY_CAPACITY // 50 kg base

	// Add mount capacity (both 'buff' and 'storage' types add to capacity)
	if (loadout.mountId) {
		capacity += getMountCapacity(loadout.mountId, loadout.mountQuality ?? 1)
	}

	// Add bag capacity
	if (loadout.bagId) {
		capacity += getBagCapacity(loadout.bagId, loadout.bagQuality ?? 1)
	}

	// Add boot capacity passive
	if (loadout.bootsId) {
		capacity += getBootCapacity(loadout.bootsId, loadout.bootsQuality ?? 1)
	}

	// Apply Pork Pie buff (+30%)
	if (loadout.hasPorkPie) {
		capacity = Math.floor(capacity * PORK_PIE_MULTIPLIER)
	}

	return capacity
}

// ============================================================================
// UNIT PROFIT CALCULATIONS
// ============================================================================

/**
 * Calculate profit per unit for instant selling strategy.
 * Accounts for: buy price, sell price, sales tax, and teleport cost per unit.
 *
 * @param buyPrice - Price to buy one unit in the source city
 * @param sellPrice - Price received when selling to buy order in destination city
 * @param itemWeight - Weight of one item in kg
 * @param fromCity - City where item is bought
 * @param toCity - City where item is sold
 * @param hasPremium - Whether the player has premium subscription
 * @returns Profit analysis result
 */
export function calculateUnitProfitInstantSell(
	buyPrice: number,
	sellPrice: number,
	itemWeight: number,
	fromCity: RoyalCity,
	toCity: RoyalCity,
	hasPremium: boolean
): ProfitResult {
	const tax = calculateInstantSellTax(sellPrice, hasPremium)
	const netRevenue = sellPrice - tax
	const teleportCost = calculateTeleportCost(itemWeight, fromCity, toCity)

	const grossProfit = sellPrice - buyPrice
	const netProfit = netRevenue - buyPrice - teleportCost

	// Break-even: sellPrice such that netRevenue - buyPrice - teleportCost = 0
	// netRevenue = sellPrice - floor(sellPrice * taxRate) ≈ sellPrice * (1 - taxRate)
	// sellPrice * (1 - taxRate) = buyPrice + teleportCost
	// sellPrice = (buyPrice + teleportCost) / (1 - taxRate)
	const taxRate = getSalesTaxRate(hasPremium)
	const breakEvenPrice = Math.ceil((buyPrice + teleportCost) / (1 - taxRate))

	return {
		grossProfit,
		netProfit,
		taxPaid: tax,
		teleportCost,
		profitPercent: buyPrice > 0 ? Math.round((netProfit / buyPrice) * 1000) / 10 : 0,
		breakEvenPrice,
	}
}

/**
 * Calculate profit per unit for sell order strategy.
 * Accounts for: buy price, sell price, listing fee, sales tax, and teleport cost.
 *
 * @param buyPrice - Price to buy one unit in the source city
 * @param sellPrice - Price at which sell order is placed in destination city
 * @param itemWeight - Weight of one item in kg
 * @param fromCity - City where item is bought
 * @param toCity - City where item is sold
 * @param hasPremium - Whether the player has premium subscription
 * @returns Profit analysis result
 */
export function calculateUnitProfitSellOrder(
	buyPrice: number,
	sellPrice: number,
	itemWeight: number,
	fromCity: RoyalCity,
	toCity: RoyalCity,
	hasPremium: boolean
): ProfitResult {
	const totalTax = calculateSellOrderTax(sellPrice, hasPremium)
	const netRevenue = sellPrice - totalTax
	const teleportCost = calculateTeleportCost(itemWeight, fromCity, toCity)

	const grossProfit = sellPrice - buyPrice
	const netProfit = netRevenue - buyPrice - teleportCost

	// Break-even calculation for sell order
	const taxRate = getSalesTaxRate(hasPremium)
	const listingFeeRate = getListingFeeRate()
	const totalFeeRate = taxRate + listingFeeRate
	const breakEvenPrice = Math.ceil((buyPrice + teleportCost) / (1 - totalFeeRate))

	return {
		grossProfit,
		netProfit,
		taxPaid: totalTax,
		teleportCost,
		profitPercent: buyPrice > 0 ? Math.round((netProfit / buyPrice) * 1000) / 10 : 0,
		breakEvenPrice,
	}
}

// ============================================================================
// ARBITRAGE CALCULATIONS (ORDER BOOK WALKING)
// ============================================================================

/**
 * Calculate profitable arbitrage using instant sell strategy.
 * Walks through buy orders in destination city from highest to lowest,
 * matching against sell orders in source city from lowest to highest.
 *
 * @param sellOrders - Source city sell orders (what we buy from), sorted by price ascending
 * @param buyOrders - Destination city buy orders (what we sell to), sorted by price descending
 * @param itemWeight - Weight of one item in kg
 * @param fromCity - City where items are bought
 * @param toCity - City where items are sold
 * @param hasPremium - Whether the player has premium subscription
 * @returns Arbitrage analysis or null if no profitable trades
 */
export function calculateProfitableArbitrageInstantSell(
	sellOrders: OrderLevel[],
	buyOrders: OrderLevel[],
	itemWeight: number,
	fromCity: RoyalCity,
	toCity: RoyalCity,
	hasPremium: boolean
): ArbitrageInstantSellResult | null {
	if (sellOrders.length === 0 || buyOrders.length === 0) {
		return null
	}

	// Sort orders: sell orders ascending (cheapest first), buy orders descending (highest first)
	const sortedSellOrders = [...sellOrders].sort((a, b) => a.price - b.price)
	const sortedBuyOrders = [...buyOrders].sort((a, b) => b.price - a.price)

	let profitableQuantity = 0
	let totalProfit = 0
	let totalTeleportCost = 0
	let ordersUsed = 0

	let sellIdx = 0
	let buyIdx = 0
	let sellRemaining = sortedSellOrders[0]?.quantity ?? 0
	let buyRemaining = sortedBuyOrders[0]?.quantity ?? 0

	while (sellIdx < sortedSellOrders.length && buyIdx < sortedBuyOrders.length) {
		const buyPrice = sortedSellOrders[sellIdx].price
		const sellPrice = sortedBuyOrders[buyIdx].price

		// Calculate profit for this price combination
		const profitResult = calculateUnitProfitInstantSell(buyPrice, sellPrice, itemWeight, fromCity, toCity, hasPremium)

		// Stop if this combination is not profitable
		if (profitResult.netProfit <= 0) {
			break
		}

		// How many units can we trade at this price level?
		const tradeQuantity = Math.min(sellRemaining, buyRemaining)

		profitableQuantity += tradeQuantity
		totalProfit += profitResult.netProfit * tradeQuantity
		totalTeleportCost += profitResult.teleportCost * tradeQuantity

		// Update remaining quantities
		sellRemaining -= tradeQuantity
		buyRemaining -= tradeQuantity

		// Move to next order if current is exhausted
		if (sellRemaining === 0) {
			sellIdx++
			ordersUsed++
			sellRemaining = sortedSellOrders[sellIdx]?.quantity ?? 0
		}
		if (buyRemaining === 0) {
			buyIdx++
			buyRemaining = sortedBuyOrders[buyIdx]?.quantity ?? 0
		}
	}

	if (profitableQuantity === 0) {
		return null
	}

	return {
		profitableQuantity,
		totalProfit,
		avgProfitPerUnit: Math.round(totalProfit / profitableQuantity),
		totalTeleportCost,
		ordersUsed,
	}
}

/**
 * Calculate profitable arbitrage using sell order strategy.
 * Determines optimal undercut price based on destination sell orders
 * and calculates expected profit if orders are filled.
 *
 * @param sellOrders - Source city sell orders (what we buy from), sorted by price ascending
 * @param destinationSellOrders - Destination city sell orders (to determine undercut price)
 * @param itemWeight - Weight of one item in kg
 * @param fromCity - City where items are bought
 * @param toCity - City where items are sold
 * @param hasPremium - Whether the player has premium subscription
 * @returns Arbitrage analysis or null if no profitable trades
 */
export function calculateProfitableArbitrageSellOrder(
	sellOrders: OrderLevel[],
	destinationSellOrders: OrderLevel[],
	itemWeight: number,
	fromCity: RoyalCity,
	toCity: RoyalCity,
	hasPremium: boolean
): ArbitrageSellOrderResult | null {
	if (sellOrders.length === 0 || destinationSellOrders.length === 0) {
		return null
	}

	// Sort source sell orders ascending (cheapest first)
	const sortedSellOrders = [...sellOrders].sort((a, b) => a.price - b.price)

	// Find lowest sell order in destination to undercut
	const lowestDestinationSell = Math.min(...destinationSellOrders.map((o) => o.price))
	const suggestedPrice = lowestDestinationSell - 1

	let profitableQuantity = 0
	let totalProfit = 0
	let totalTeleportCost = 0
	let ordersUsed = 0

	for (const order of sortedSellOrders) {
		const profitResult = calculateUnitProfitSellOrder(
			order.price,
			suggestedPrice,
			itemWeight,
			fromCity,
			toCity,
			hasPremium
		)

		// Stop if this buy price is no longer profitable
		if (profitResult.netProfit <= 0) {
			break
		}

		profitableQuantity += order.quantity
		totalProfit += profitResult.netProfit * order.quantity
		totalTeleportCost += profitResult.teleportCost * order.quantity
		ordersUsed++
	}

	if (profitableQuantity === 0) {
		return null
	}

	return {
		profitableQuantity,
		totalProfit,
		avgProfitPerUnit: Math.round(totalProfit / profitableQuantity),
		totalTeleportCost,
		suggestedPrice,
		ordersUsed,
	}
}
