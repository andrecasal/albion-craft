/**
 * Add speed bonuses to mounts in mounts.json from ao-bin-dumps
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const MOUNTS_JSON_PATH = path.join(__dirname, '..', 'src', 'constants', 'items', 'mounts.json')
const ITEMS_JSON = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/items.json'
const SPELLS_JSON = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/spells.json'

const items = JSON.parse(fs.readFileSync(ITEMS_JSON, 'utf8'))
const spells = JSON.parse(fs.readFileSync(SPELLS_JSON, 'utf8'))

// Find all mount buffs and their speed bonuses
function findSpeedBonuses(obj, results = new Map()) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] && obj['@category'] === 'mountbuff') {
		const buffName = obj['@uniquename']
		const buffovertime = obj['buffovertime']
		if (Array.isArray(buffovertime)) {
			for (const buff of buffovertime) {
				if (buff['@type'] === 'movespeedbonus') {
					results.set(buffName, parseFloat(buff['@value']))
				}
			}
		}
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findSpeedBonuses(item, results)
			}
		} else if (typeof value === 'object') {
			findSpeedBonuses(value, results)
		}
	}
	return results
}

// Find mount -> buff mappings from items.json
function findMountBuffMappings(obj, results = new Map()) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] && obj['@slottype'] === 'mount' && obj['@mountedbuff']) {
		results.set(obj['@uniquename'], obj['@mountedbuff'])
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findMountBuffMappings(item, results)
			}
		} else if (typeof value === 'object') {
			findMountBuffMappings(value, results)
		}
	}
	return results
}

console.log('=== Adding Mount Speed Bonuses ===\n')

// Get speed bonuses from spells
const speedBonuses = findSpeedBonuses(spells)
console.log(`Found ${speedBonuses.size} mount buffs with speed bonuses`)

// Get mount -> buff mappings
const mountBuffMappings = findMountBuffMappings(items)
console.log(`Found ${mountBuffMappings.size} mount -> buff mappings\n`)

// Load mounts.json
const mounts = JSON.parse(fs.readFileSync(MOUNTS_JSON_PATH, 'utf8'))

let updated = 0
let notFound = []

for (const mount of mounts) {
	const buffName = mountBuffMappings.get(mount.id)
	if (buffName) {
		const speedBonus = speedBonuses.get(buffName)
		if (speedBonus !== undefined) {
			mount.speedBonus = speedBonus
			updated++
			const actualSpeed = 5.5 * (1 + speedBonus)
			console.log(`  ${mount.id}: +${(speedBonus * 100).toFixed(0)}% (${actualSpeed.toFixed(1)} m/s)`)
		} else {
			notFound.push(`${mount.id} (buff: ${buffName})`)
		}
	} else {
		notFound.push(`${mount.id} (no buff mapping)`)
	}
}

// Write back
fs.writeFileSync(MOUNTS_JSON_PATH, JSON.stringify(mounts, null, '\t') + '\n')

console.log(`\n=== Summary ===`)
console.log(`Total mounts: ${mounts.length}`)
console.log(`Updated with speed bonus: ${updated}`)
console.log(`Not found: ${notFound.length}`)

if (notFound.length > 0) {
	console.log('\nMounts without speed data:')
	notFound.forEach((m) => console.log(`  - ${m}`))
}

console.log('\nDone!')
