/**
 * Check which zones have position data in ao-bin-dumps
 */

import fs from 'fs'

const data = JSON.parse(fs.readFileSync('/Users/andrecasal/Developer/Apps/ao-bin-dumps/cluster/world.json', 'utf8'))

function findZonesWithWorldMapPos(obj, results = []) {
	if (typeof obj !== 'object' || obj === null) return results

	// Look for clusters with @worldmapposition
	if (obj['@worldmapposition'] && obj['@displayname']) {
		const [x, y] = obj['@worldmapposition'].split(' ').map(Number)
		results.push({
			id: obj['@id'],
			name: obj['@displayname'],
			x,
			y,
		})
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findZonesWithWorldMapPos(item, results)
			}
		} else if (typeof value === 'object') {
			findZonesWithWorldMapPos(value, results)
		}
	}
	return results
}

const zones = findZonesWithWorldMapPos(data)
console.log('Total zones with worldmapposition:', zones.length)

// Cities we care about for arbitrage
const CITIES = ['Caerleon', 'Thetford', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Fort Sterling', 'Brecilien']

console.log('\nCity zones with worldmapposition:')
zones
	.filter((z) => CITIES.includes(z.name))
	.forEach((z) => console.log(`  ${z.id} "${z.name}" -> x: ${z.x}, y: ${z.y}`))

console.log('\nPortal zones with worldmapposition:')
zones
	.filter((z) => z.name.includes('Portal'))
	.forEach((z) => console.log(`  ${z.id} "${z.name}" -> x: ${z.x}, y: ${z.y}`))
