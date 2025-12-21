import { City } from '../types'
import zones from './zones.json'

function findZoneId(name: string): number | null {
	const zone = zones.find((z) => z.name === name)
	return zone ? parseInt(zone.id, 10) : null
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
}
