/**
 * Extract gallop/sprint data from mount buffs in ao-bin-dumps
 */

import fs from 'fs'

const SPELLS_JSON = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/spells.json'
const spells = JSON.parse(fs.readFileSync(SPELLS_JSON, 'utf8'))

function findMountBuff(obj, targetName, results = []) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] === targetName) {
		results.push(obj)
		return results
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findMountBuff(item, targetName, results)
			}
		} else if (typeof value === 'object') {
			findMountBuff(value, targetName, results)
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
function findMountBuffsWithGallop(obj, results = []) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] && obj['@category'] === 'mountbuff' && obj['castspellaftermoving']) {
		const cast = obj['castspellaftermoving']
		results.push({
			buffName: obj['@uniquename'],
			gallopSpell: cast['@spell'],
			timeToGallop: parseFloat(cast['@movetimetocast']),
			standTimeToEnd: parseFloat(cast['@standtimetoendspell']),
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

console.log('=== Gallop Spells ===\n')
const gallopSpells = findGallopSpells(spells)

// Show sample gallop spells for T3 and T5 horses
const horseGallopT3 = gallopSpells.get('MOUNT_SPEEDBUFF_HORSE_T3')
console.log('T3 Horse Gallop Spell:')
console.log(JSON.stringify(horseGallopT3, null, 2))

const horseGallopT5 = gallopSpells.get('MOUNT_SPEEDBUFF_HORSE_T5')
console.log('\nT5 Horse Gallop Spell:')
console.log(JSON.stringify(horseGallopT5, null, 2))

console.log('\n\n=== Mount Gallop Data ===\n')
const mountGallopData = findMountBuffsWithGallop(spells)

// Extract gallop speed bonus from gallop spells
for (const mount of mountGallopData) {
	const gallopSpell = gallopSpells.get(mount.gallopSpell)
	if (gallopSpell && gallopSpell['buffovertime']) {
		// buffovertime can be object or array
		const buffs = Array.isArray(gallopSpell['buffovertime'])
			? gallopSpell['buffovertime']
			: [gallopSpell['buffovertime']]
		const speedBuff = buffs.find((b) => b['@type'] === 'movespeedbonus')
		if (speedBuff) {
			mount.gallopSpeedBonus = parseFloat(speedBuff['@value'])
		}
	}
}

// Show key mounts
const keyMounts = [
	'T3_MOUNT_HORSE_MOUNTED',
	'T4_MOUNT_HORSE_MOUNTED',
	'T5_MOUNT_HORSE_MOUNTED',
	'T6_MOUNT_HORSE_MOUNTED',
	'T7_MOUNT_HORSE_MOUNTED',
	'T8_MOUNT_HORSE_MOUNTED',
	'T3_MOUNT_OX_MOUNTED',
	'T4_MOUNT_OX_MOUNTED',
	'T5_MOUNT_OX_MOUNTED',
	'T6_MOUNT_OX_MOUNTED',
	'T7_MOUNT_OX_MOUNTED',
	'T8_MOUNT_OX_MOUNTED',
	'T8_MOUNT_MAMMOTH_TRANSPORT_MOUNTED',
]

console.log('Mount | Time to Gallop | Gallop Speed Bonus')
console.log('------|----------------|-------------------')
for (const mountName of keyMounts) {
	const data = mountGallopData.find((m) => m.buffName === mountName)
	if (data) {
		const bonus = data.gallopSpeedBonus ? `+${(data.gallopSpeedBonus * 100).toFixed(0)}%` : 'N/A'
		console.log(`${mountName}: ${data.timeToGallop}s | ${bonus}`)
	}
}
