/**
 * Add world map coordinates to zones.json from ao-bin-dumps/cluster/world.json
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const WORLD_JSON_PATH = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/cluster/world.json'
const ZONES_JSON_PATH = path.join(__dirname, '..', 'src', 'constants', 'zones.json')

// Extract zones with @worldmapposition from ao-bin-dumps
function findZonesWithWorldMapPos(obj, results = new Map()) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@worldmapposition'] && obj['@id']) {
		const [x, y] = obj['@worldmapposition'].split(' ').map(Number)
		results.set(obj['@id'], { x, y, name: obj['@displayname'] })
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

console.log('=== Add Zone Coordinates ===\n')

console.log('Loading world.json...')
const worldData = JSON.parse(fs.readFileSync(WORLD_JSON_PATH, 'utf8'))
const coordsMap = findZonesWithWorldMapPos(worldData)
console.log(`Found ${coordsMap.size} zones with worldmapposition\n`)

console.log('Loading zones.json...')
const zones = JSON.parse(fs.readFileSync(ZONES_JSON_PATH, 'utf8'))

let updated = 0
let alreadyHasCoords = 0

for (const zone of zones) {
	const coords = coordsMap.get(zone.id)
	if (coords) {
		if (zone.x !== undefined && zone.y !== undefined) {
			alreadyHasCoords++
		} else {
			zone.x = coords.x
			zone.y = coords.y
			updated++
			console.log(`  Added coords to ${zone.id} "${zone.name}" -> x: ${coords.x}, y: ${coords.y}`)
		}
	}
}

console.log(`\n=== Summary ===`)
console.log(`Already had coordinates: ${alreadyHasCoords}`)
console.log(`Updated with coordinates: ${updated}`)

// Write back
fs.writeFileSync(ZONES_JSON_PATH, JSON.stringify(zones, null, '\t') + '\n')
console.log('\nDone!')
