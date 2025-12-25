/**
 * Mount data and mount-related functions
 *
 * Mount data is loaded from mounts.json which contains accurate data
 * extracted from ao-bin-dumps and verified with in-game measurements.
 */

import mountsData from './items/mounts.json'

// ============================================================================
// Constants
// ============================================================================

/** Base player movement speed in m/s */
export const BASE_SPEED = 5.5

/** Base player carry capacity in kg */
export const BASE_CARRY_CAPACITY = 50

/**
 * Conversion factor from map units to meters
 * Calibrated based on: ~5 minutes between adjacent cities on a T5 Ox (8.0 m/s)
 * Average adjacent city distance: ~90 map units
 * 5 min * 60s * 8 m/s = 2400m -> 2400m / 90 units ≈ 27 m/unit
 */
export const MAP_UNITS_TO_METERS = 27

// ============================================================================
// Types
// ============================================================================

/** Quality level for equipment */
export type Quality = 1 | 2 | 3 | 4 | 5

export interface MountJsonData {
	id: string
	name: string
	weight: number
	speedBonus: number
	capacity?: number // Single capacity (for mounts without quality tiers)
	capacities?: number[] // [Q1, Q2, Q3, Q4, Q5] capacity by quality
	capacityType?: 'buff' | 'storage'
	timeToGallop?: number
	gallopSpeedBonus?: number
}

// ============================================================================
// Mount Data
// ============================================================================

/** All mounts indexed by ID */
export const MOUNTS: Record<string, MountJsonData> = Object.fromEntries(
	(mountsData as MountJsonData[]).map((mount) => [mount.id, mount])
)

/**
 * Get mount by ID.
 *
 * @param mountId - Mount ID (e.g., 'T5_MOUNT_OX')
 * @returns Mount data or undefined if not found
 */
export function getMount(mountId: string): MountJsonData | undefined {
	return MOUNTS[mountId]
}

/**
 * Get mount capacity for a specific mount and quality.
 *
 * @param mountId - Mount ID (e.g., 'T5_MOUNT_OX')
 * @param quality - Quality level 1-5 (default: 1)
 * @returns Capacity in kg, or 0 if mount not found
 */
export function getMountCapacity(mountId: string, quality: Quality = 1): number {
	const mount = MOUNTS[mountId]
	if (!mount) return 0
	if (mount.capacities) {
		return mount.capacities[quality - 1]
	}
	return mount.capacity ?? 0
}

/**
 * Get effective speed for a mount (always assumes gallop).
 *
 * @param mountId - Mount ID
 * @returns Speed in m/s
 */
export function getMountSpeed(mountId: string): number {
	const mount = MOUNTS[mountId]
	if (!mount) {
		throw new Error(`Unknown mount: ${mountId}`)
	}
	const totalBonus = mount.speedBonus + (mount.gallopSpeedBonus ?? 0)
	return BASE_SPEED * (1 + totalBonus)
}

/**
 * Check if a mount ID is valid.
 */
export function isValidMount(mountId: string): boolean {
	return mountId in MOUNTS
}

/**
 * Get all available mount IDs.
 */
export function getAllMountIds(): string[] {
	return Object.keys(MOUNTS)
}
