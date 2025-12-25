/**
 * Add gallop data to mounts in mounts.json from ao-bin-dumps
 *
 * Gallop (sprint) is activated after moving continuously for a period of time.
 * - timeToGallop: seconds of continuous movement before gallop activates
 * - gallopSpeedBonus: additional speed bonus while galloping (on top of base speedBonus)
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

// Find all gallop spells
function findGallopSpells(obj, results = new Map()) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] && obj['@uniquename'].startsWith('MOUNT_SPEEDBUFF_')) {
		results.set(obj['@uniquename'], obj)
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findGallopSpells(item, results)
			}
		} else if (typeof value === 'object') {
			findGallopSpells(value, results)
		}
	}
	return results
}

// Find all mount buffs with gallop data
function findMountBuffsWithGallop(obj, results = new Map()) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] && obj['@category'] === 'mountbuff' && obj['castspellaftermoving']) {
		const cast = obj['castspellaftermoving']
		results.set(obj['@uniquename'], {
			gallopSpell: cast['@spell'],
			timeToGallop: parseFloat(cast['@movetimetocast']),
		})
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findMountBuffsWithGallop(item, results)
			}
		} else if (typeof value === 'object') {
			findMountBuffsWithGallop(value, results)
		}
	}
	return results
}

console.log('=== Adding Mount Gallop Data ===\n')

// Get mappings
const mountBuffMappings = findMountBuffMappings(items)
const gallopSpells = findGallopSpells(spells)
const mountBuffsWithGallop = findMountBuffsWithGallop(spells)

console.log(`Found ${mountBuffMappings.size} mount -> buff mappings`)
console.log(`Found ${gallopSpells.size} gallop spells`)
console.log(`Found ${mountBuffsWithGallop.size} mount buffs with gallop\n`)

// Load mounts.json
const mounts = JSON.parse(fs.readFileSync(MOUNTS_JSON_PATH, 'utf8'))

let updated = 0
let noGallop = []

for (const mount of mounts) {
	const buffName = mountBuffMappings.get(mount.id)
	if (buffName) {
		const gallopData = mountBuffsWithGallop.get(buffName)
		if (gallopData) {
			const gallopSpell = gallopSpells.get(gallopData.gallopSpell)
			if (gallopSpell && gallopSpell['buffovertime']) {
				// buffovertime can be object or array
				const buffs = Array.isArray(gallopSpell['buffovertime'])
					? gallopSpell['buffovertime']
					: [gallopSpell['buffovertime']]
				const speedBuff = buffs.find((b) => b['@type'] === 'movespeedbonus')
				if (speedBuff) {
					mount.timeToGallop = gallopData.timeToGallop
					mount.gallopSpeedBonus = parseFloat(speedBuff['@value'])
					updated++
					const totalSpeed = 5.5 * (1 + mount.speedBonus + mount.gallopSpeedBonus)
					console.log(
						`  ${mount.id}: ${gallopData.timeToGallop}s to gallop, +${(mount.gallopSpeedBonus * 100).toFixed(0)}% (total: ${totalSpeed.toFixed(1)} m/s)`
					)
				}
			}
		} else {
			noGallop.push(mount.id)
		}
	} else {
		noGallop.push(`${mount.id} (no buff mapping)`)
	}
}

// Write back
fs.writeFileSync(MOUNTS_JSON_PATH, JSON.stringify(mounts, null, '\t') + '\n')

console.log(`\n=== Summary ===`)
console.log(`Total mounts: ${mounts.length}`)
console.log(`Updated with gallop data: ${updated}`)
console.log(`Mounts without gallop: ${noGallop.length}`)

console.log('\nDone!')
