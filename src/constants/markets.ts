import zonesData from './zones.json'

type Zone = {
	id: string
	name: string
	market?: string
}

// Build a flat lookup from numeric zone ID to market name for O(1) access
// Only includes zones that have a market and whose ID can be parsed as an integer
const marketLookup: Record<number, string> = {}
const marketNames = new Set<string>()

for (const zone of zonesData as Zone[]) {
	if (zone.market) {
		const numId = parseInt(zone.id, 10)
		if (!isNaN(numId)) {
			marketLookup[numId] = zone.market
			marketNames.add(zone.market)
		}
	}
}

// List of all valid market names
export const MARKETS = [...marketNames] as readonly string[]

/**
 * Get the market name for a given location ID.
 * Returns the market name (e.g., "Thetford", "Caerleon") or null if not a market zone.
 */
export function getMarket(locationId: number): string | null {
	return marketLookup[locationId] ?? null
}

/**
 * Check if a location ID belongs to a market zone.
 */
export function isMarketZone(locationId: number): boolean {
	return locationId in marketLookup
}
