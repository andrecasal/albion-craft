/**
 * Boot data and capacity functions
 *
 * Some boots have a passive ability that increases carry capacity.
 * This is typically a selectable passive, not always active.
 */

/** Quality level for equipment */
export type Quality = 1 | 2 | 3 | 4 | 5

/**
 * Boot capacity passives in kg.
 *
 * Most boots have a selectable passive for weight capacity.
 * The values here represent the capacity bonus when that passive is selected.
 *
 * TODO: Extract from ao-bin-dumps spells.json (look for PASSIVE_MAXLOAD_*)
 * Currently a placeholder - needs data extraction.
 */
const BOOT_CAPACITY_PASSIVES: Record<string, number[]> = {
	// Placeholder - needs extraction from game data
	// Format: { bootId: [Q1, Q2, Q3, Q4, Q5] }
	//
	// Example structure once extracted:
	// T4_SHOES_LEATHER_SET1: [50, 52, 55, 58, 64],
	// T5_SHOES_LEATHER_SET1: [75, 79, 83, 87, 96],
	// ...
}

/**
 * Extract the base boot ID from a boot ID that may include enchantment suffix.
 * e.g., "T5_SHOES_LEATHER_SET1@2" -> "T5_SHOES_LEATHER_SET1"
 */
function getBaseBootId(bootId: string): string {
	return bootId.split('@')[0]
}

/**
 * Get boot capacity passive for a specific boot and quality.
 *
 * @param bootsId - Boot ID (e.g., 'T5_SHOES_LEATHER_SET1')
 * @param quality - Quality level 1-5 (default: 1)
 * @returns Capacity bonus in kg, or 0 if boot has no capacity passive
 */
export function getBootCapacity(bootsId: string, quality: Quality = 1): number {
	const baseBootId = getBaseBootId(bootsId)
	const capacities = BOOT_CAPACITY_PASSIVES[baseBootId]
	if (!capacities) return 0
	return capacities[quality - 1] ?? capacities[0]
}

/**
 * Check if a boot has a capacity passive.
 */
export function hasCapacityPassive(bootsId: string): boolean {
	const baseBootId = getBaseBootId(bootsId)
	return baseBootId in BOOT_CAPACITY_PASSIVES
}

/**
 * Get all boot IDs that have capacity passives.
 */
export function getBootsWithCapacityPassive(): string[] {
	return Object.keys(BOOT_CAPACITY_PASSIVES)
}
