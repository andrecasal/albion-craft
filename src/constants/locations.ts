import { City } from '../types'
import zones from './zones.json'

// ============================================================================
// Types
// ============================================================================

interface ZoneWithCoords {
	id: string
	name: string
	market?: string
	x?: number
	y?: number
}

interface CityCoordinates {
	x: number
	y: number
}

// Royal cities (excludes Black Market and Brecilien which is in the Mists)
export type RoyalCity = 'Caerleon' | 'Bridgewatch' | 'Fort Sterling' | 'Lymhurst' | 'Martlock' | 'Thetford'

// ============================================================================
// Zone lookup helpers
// ============================================================================

function findZoneId(name: string): number | null {
	const zone = zones.find((z) => z.name === name)
	return zone ? parseInt(zone.id, 10) : null
}

function findZoneCoords(name: string): CityCoordinates | null {
	const zone = (zones as ZoneWithCoords[]).find((z) => z.name === name)
	if (zone && zone.x !== undefined && zone.y !== undefined) {
		return { x: zone.x, y: zone.y }
	}
	return null
}

// Market location IDs from zones.json
const THETFORD_MARKET = findZoneId('Thetford Market')!
const MARTLOCK_MARKET = findZoneId('Martlock Market')!
const FORT_STERLING_MARKET = findZoneId('Fort Sterling Market')!
const LYMHURST_MARKET = findZoneId('Lymhurst Market')!
const BRIDGEWATCH_MARKET = findZoneId('Bridgewatch Market')!
const CAERLEON_MARKET = findZoneId('Caerleon Market')!
const BRECILIEN_MARKET = findZoneId('Brecilien Market')!

// Portal location IDs from zones.json
const THETFORD_PORTAL = findZoneId('Thetford Portal')!
const MARTLOCK_PORTAL = findZoneId('Martlock Portal')!
const FORT_STERLING_PORTAL = findZoneId('Fort Sterling Portal')!
const LYMHURST_PORTAL = findZoneId('Lymhurst Portal')!
const BRIDGEWATCH_PORTAL = findZoneId('Bridgewatch Portal')!

export const LOCATION_TO_CITY: Record<number, City> = {
	// Main markets
	[THETFORD_MARKET]: 'Thetford',
	[MARTLOCK_MARKET]: 'Martlock',
	[FORT_STERLING_MARKET]: 'Fort Sterling',
	[LYMHURST_MARKET]: 'Lymhurst',
	[BRIDGEWATCH_MARKET]: 'Bridgewatch',
	[CAERLEON_MARKET]: 'Caerleon',
	[BRECILIEN_MARKET]: 'Brecilien',
	// Portal markets (map to main city)
	[THETFORD_PORTAL]: 'Thetford',
	[MARTLOCK_PORTAL]: 'Martlock',
	[FORT_STERLING_PORTAL]: 'Fort Sterling',
	[LYMHURST_PORTAL]: 'Lymhurst',
	[BRIDGEWATCH_PORTAL]: 'Bridgewatch',
}

export const CITY_TO_LOCATION: Record<City, number[]> = {
	Thetford: [THETFORD_MARKET, THETFORD_PORTAL],
	Martlock: [MARTLOCK_MARKET, MARTLOCK_PORTAL],
	'Fort Sterling': [FORT_STERLING_MARKET, FORT_STERLING_PORTAL],
	Lymhurst: [LYMHURST_MARKET, LYMHURST_PORTAL],
	Bridgewatch: [BRIDGEWATCH_MARKET, BRIDGEWATCH_PORTAL],
	Caerleon: [CAERLEON_MARKET],
	Brecilien: [BRECILIEN_MARKET],
	'Black Market': [CAERLEON_MARKET], // Black Market is in Caerleon
}

// ============================================================================
// City Coordinates (from zones.json @worldmapposition)
// ============================================================================

// City coordinates on the world map (main city zones, not market sub-zones)
export const CITY_COORDINATES: Record<RoyalCity, CityCoordinates> = {
	Thetford: findZoneCoords('Thetford')!,
	Martlock: findZoneCoords('Martlock')!,
	'Fort Sterling': findZoneCoords('Fort Sterling')!,
	Lymhurst: findZoneCoords('Lymhurst')!,
	Bridgewatch: findZoneCoords('Bridgewatch')!,
	Caerleon: findZoneCoords('Caerleon')!,
}

// ============================================================================
// Distance Calculations
// ============================================================================

/**
 * Calculate Euclidean distance between two cities
 * Note: This is map distance, not actual travel distance
 */
export function calculateDistance(city1: RoyalCity, city2: RoyalCity): number {
	const coords1 = CITY_COORDINATES[city1]
	const coords2 = CITY_COORDINATES[city2]
	const dx = coords2.x - coords1.x
	const dy = coords2.y - coords1.y
	return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Pre-computed distances between all royal cities
 * Distances are Euclidean (straight-line) on the world map
 */
export const CITY_DISTANCES: Record<RoyalCity, Record<RoyalCity, number>> = {
	Thetford: {
		Thetford: 0,
		Martlock: calculateDistance('Thetford', 'Martlock'),
		'Fort Sterling': calculateDistance('Thetford', 'Fort Sterling'),
		Lymhurst: calculateDistance('Thetford', 'Lymhurst'),
		Bridgewatch: calculateDistance('Thetford', 'Bridgewatch'),
		Caerleon: calculateDistance('Thetford', 'Caerleon'),
	},
	Martlock: {
		Thetford: calculateDistance('Martlock', 'Thetford'),
		Martlock: 0,
		'Fort Sterling': calculateDistance('Martlock', 'Fort Sterling'),
		Lymhurst: calculateDistance('Martlock', 'Lymhurst'),
		Bridgewatch: calculateDistance('Martlock', 'Bridgewatch'),
		Caerleon: calculateDistance('Martlock', 'Caerleon'),
	},
	'Fort Sterling': {
		Thetford: calculateDistance('Fort Sterling', 'Thetford'),
		Martlock: calculateDistance('Fort Sterling', 'Martlock'),
		'Fort Sterling': 0,
		Lymhurst: calculateDistance('Fort Sterling', 'Lymhurst'),
		Bridgewatch: calculateDistance('Fort Sterling', 'Bridgewatch'),
		Caerleon: calculateDistance('Fort Sterling', 'Caerleon'),
	},
	Lymhurst: {
		Thetford: calculateDistance('Lymhurst', 'Thetford'),
		Martlock: calculateDistance('Lymhurst', 'Martlock'),
		'Fort Sterling': calculateDistance('Lymhurst', 'Fort Sterling'),
		Lymhurst: 0,
		Bridgewatch: calculateDistance('Lymhurst', 'Bridgewatch'),
		Caerleon: calculateDistance('Lymhurst', 'Caerleon'),
	},
	Bridgewatch: {
		Thetford: calculateDistance('Bridgewatch', 'Thetford'),
		Martlock: calculateDistance('Bridgewatch', 'Martlock'),
		'Fort Sterling': calculateDistance('Bridgewatch', 'Fort Sterling'),
		Lymhurst: calculateDistance('Bridgewatch', 'Lymhurst'),
		Bridgewatch: 0,
		Caerleon: calculateDistance('Bridgewatch', 'Caerleon'),
	},
	Caerleon: {
		Thetford: calculateDistance('Caerleon', 'Thetford'),
		Martlock: calculateDistance('Caerleon', 'Martlock'),
		'Fort Sterling': calculateDistance('Caerleon', 'Fort Sterling'),
		Lymhurst: calculateDistance('Caerleon', 'Lymhurst'),
		Bridgewatch: calculateDistance('Caerleon', 'Bridgewatch'),
		Caerleon: 0,
	},
}
