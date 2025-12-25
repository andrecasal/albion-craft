/**
 * Bag data and capacity functions
 *
 * Bags provide carry capacity bonuses to the player.
 * Capacity scales with tier and quality.
 */

/** Quality level for equipment */
export type Quality = 1 | 2 | 3 | 4 | 5

/**
 * Bag capacity bonuses in kg by base tier (T2-T8).
 * Each tier has 5 quality levels [Q1, Q2, Q3, Q4, Q5].
 *
 * TODO: Extract quality-based values from ao-bin-dumps spells.json
 * Currently using estimated values based on ~5% increase per quality level.
 */
const BAG_CAPACITIES: Record<string, number[]> = {
	T2_BAG: [40, 42, 44, 46, 51],
	T3_BAG: [70, 73, 77, 81, 89],
	T4_BAG: [106, 111, 117, 123, 135],
	T5_BAG: [160, 168, 176, 185, 204],
	T6_BAG: [241, 253, 266, 279, 307],
	T7_BAG: [362, 380, 399, 419, 461],
	T8_BAG: [543, 570, 599, 628, 691],
}

/**
 * Satchel of Insight capacity bonuses (same as regular bags).
 * These bags also provide fame bonus but have same capacity.
 */
const INSIGHT_BAG_CAPACITIES: Record<string, number[]> = {
	T4_BAG_INSIGHT: BAG_CAPACITIES.T4_BAG,
	T5_BAG_INSIGHT: BAG_CAPACITIES.T5_BAG,
	T6_BAG_INSIGHT: BAG_CAPACITIES.T6_BAG,
	T7_BAG_INSIGHT: BAG_CAPACITIES.T7_BAG,
	T8_BAG_INSIGHT: BAG_CAPACITIES.T8_BAG,
}

/**
 * Gatherer backpack capacity bonuses.
 * These have different capacity values than regular bags.
 *
 * TODO: Extract actual values from ao-bin-dumps
 */
const GATHERER_BACKPACK_CAPACITIES: Record<string, number[]> = {
	// Harvester (Fiber)
	T4_BACKPACK_GATHERER_FIBER: [80, 84, 88, 92, 101],
	T5_BACKPACK_GATHERER_FIBER: [120, 126, 132, 139, 153],
	T6_BACKPACK_GATHERER_FIBER: [180, 189, 198, 208, 229],
	T7_BACKPACK_GATHERER_FIBER: [270, 284, 298, 313, 344],
	T8_BACKPACK_GATHERER_FIBER: [405, 425, 446, 469, 516],
	// Skinner (Hide)
	T4_BACKPACK_GATHERER_HIDE: [80, 84, 88, 92, 101],
	T5_BACKPACK_GATHERER_HIDE: [120, 126, 132, 139, 153],
	T6_BACKPACK_GATHERER_HIDE: [180, 189, 198, 208, 229],
	T7_BACKPACK_GATHERER_HIDE: [270, 284, 298, 313, 344],
	T8_BACKPACK_GATHERER_HIDE: [405, 425, 446, 469, 516],
	// Miner (Ore)
	T4_BACKPACK_GATHERER_ORE: [80, 84, 88, 92, 101],
	T5_BACKPACK_GATHERER_ORE: [120, 126, 132, 139, 153],
	T6_BACKPACK_GATHERER_ORE: [180, 189, 198, 208, 229],
	T7_BACKPACK_GATHERER_ORE: [270, 284, 298, 313, 344],
	T8_BACKPACK_GATHERER_ORE: [405, 425, 446, 469, 516],
	// Quarrier (Rock)
	T4_BACKPACK_GATHERER_ROCK: [80, 84, 88, 92, 101],
	T5_BACKPACK_GATHERER_ROCK: [120, 126, 132, 139, 153],
	T6_BACKPACK_GATHERER_ROCK: [180, 189, 198, 208, 229],
	T7_BACKPACK_GATHERER_ROCK: [270, 284, 298, 313, 344],
	T8_BACKPACK_GATHERER_ROCK: [405, 425, 446, 469, 516],
	// Lumberjack (Wood)
	T4_BACKPACK_GATHERER_WOOD: [80, 84, 88, 92, 101],
	T5_BACKPACK_GATHERER_WOOD: [120, 126, 132, 139, 153],
	T6_BACKPACK_GATHERER_WOOD: [180, 189, 198, 208, 229],
	T7_BACKPACK_GATHERER_WOOD: [270, 284, 298, 313, 344],
	T8_BACKPACK_GATHERER_WOOD: [405, 425, 446, 469, 516],
	// Fisherman (Fish)
	T4_BACKPACK_GATHERER_FISH: [80, 84, 88, 92, 101],
	T5_BACKPACK_GATHERER_FISH: [120, 126, 132, 139, 153],
	T6_BACKPACK_GATHERER_FISH: [180, 189, 198, 208, 229],
	T7_BACKPACK_GATHERER_FISH: [270, 284, 298, 313, 344],
	T8_BACKPACK_GATHERER_FISH: [405, 425, 446, 469, 516],
}

/** All bag capacities combined */
const ALL_BAG_CAPACITIES: Record<string, number[]> = {
	...BAG_CAPACITIES,
	...INSIGHT_BAG_CAPACITIES,
	...GATHERER_BACKPACK_CAPACITIES,
}

/**
 * Extract the base bag ID from a bag ID that may include enchantment suffix.
 * e.g., "T5_BAG@2" -> "T5_BAG"
 */
function getBaseBagId(bagId: string): string {
	return bagId.split('@')[0]
}

/**
 * Get bag capacity for a specific bag and quality.
 *
 * @param bagId - Bag ID (e.g., 'T5_BAG', 'T5_BAG@2', 'T6_BACKPACK_GATHERER_ORE')
 * @param quality - Quality level 1-5 (default: 1)
 * @returns Capacity bonus in kg, or 0 if bag not found
 */
export function getBagCapacity(bagId: string, quality: Quality = 1): number {
	const baseBagId = getBaseBagId(bagId)
	const capacities = ALL_BAG_CAPACITIES[baseBagId]
	if (!capacities) return 0
	return capacities[quality - 1] ?? capacities[0]
}

/**
 * Check if a bag ID is valid (has capacity data).
 */
export function isValidBag(bagId: string): boolean {
	const baseBagId = getBaseBagId(bagId)
	return baseBagId in ALL_BAG_CAPACITIES
}

/**
 * Get all available bag base IDs.
 */
export function getAllBagIds(): string[] {
	return Object.keys(ALL_BAG_CAPACITIES)
}
