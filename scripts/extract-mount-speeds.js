/**
 * Extract mount speed and carry capacity data from ao-bin-dumps
 */

import fs from 'fs'

const ITEMS_JSON = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/items.json'
const SPELLS_JSON = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/spells.json'

const items = JSON.parse(fs.readFileSync(ITEMS_JSON, 'utf8'))
const spells = JSON.parse(fs.readFileSync(SPELLS_JSON, 'utf8'))

// Find all mount buffs and their speed bonuses
function findSpeedBonus(obj, results = new Map()) {
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
				findSpeedBonus(item, results)
			}
		} else if (typeof value === 'object') {
			findSpeedBonus(value, results)
		}
	}
	return results
}

// Find all maxload passives
function findMaxloadPassives(obj, results = new Map()) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] && obj['@uniquename'].startsWith('PASSIVE_MAXLOAD')) {
		const buff = obj['buff']
		if (buff) {
			// Handle both single buff and array of buffs
			const buffs = Array.isArray(buff) ? buff : [buff]
			for (const b of buffs) {
				if (b['@type'] === 'maxload') {
					results.set(obj['@uniquename'], parseFloat(b['@value']))
				}
			}
		}
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findMaxloadPassives(item, results)
			}
		} else if (typeof value === 'object') {
			findMaxloadPassives(value, results)
		}
	}
	return results
}

// Find all mounts and their buffs
function findMounts(obj, results = []) {
	if (typeof obj !== 'object' || obj === null) return results

	if (obj['@uniquename'] && obj['@slottype'] === 'mount' && obj['@mountedbuff']) {
		results.push({
			id: obj['@uniquename'],
			tier: obj['@tier'],
			category: obj['@mountcategory'],
			weight: parseFloat(obj['@weight'] || '0'),
			mountedbuff: obj['@mountedbuff'],
		})
	}

	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				findMounts(item, results)
			}
		} else if (typeof value === 'object') {
			findMounts(value, results)
		}
	}
	return results
}

console.log('=== Extracting Mount Data ===\n')

// Get speed bonuses from spells
const speedBonuses = findSpeedBonus(spells)
console.log(`Found ${speedBonuses.size} mount buffs with speed bonuses`)

// Get maxload passives
const maxloadPassives = findMaxloadPassives(spells)
console.log(`Found ${maxloadPassives.size} maxload passives\n`)

console.log('=== Maxload Passives ===')
for (const [name, value] of maxloadPassives) {
	console.log(`  ${name}: ${value}`)
}
console.log()

// Get mounts
const mounts = findMounts(items)
console.log(`Found ${mounts.length} mounts\n`)

// Combine data
const mountData = mounts.map((mount) => ({
	...mount,
	speedBonus: speedBonuses.get(mount.mountedbuff) || 0,
}))

// Show key mounts for transport
console.log('=== Key Transport Mounts ===\n')
const transportMounts = [
	'T3_MOUNT_OX',
	'T4_MOUNT_OX',
	'T5_MOUNT_OX',
	'T6_MOUNT_OX',
	'T7_MOUNT_OX',
	'T8_MOUNT_OX',
	'T3_MOUNT_HORSE',
	'T4_MOUNT_HORSE',
	'T5_MOUNT_HORSE',
	'T6_MOUNT_HORSE',
	'T7_MOUNT_HORSE',
	'T8_MOUNT_HORSE',
	'T5_MOUNT_ARMORED_HORSE',
	'T6_MOUNT_ARMORED_HORSE',
	'T7_MOUNT_ARMORED_HORSE',
	'T8_MOUNT_ARMORED_HORSE',
	'T8_MOUNT_MAMMOTH_TRANSPORT',
]

for (const mountId of transportMounts) {
	const mount = mountData.find((m) => m.id === mountId)
	if (mount) {
		const baseSpeed = 5.5 // m/s
		const actualSpeed = baseSpeed * (1 + mount.speedBonus)
		console.log(
			`${mount.id}: +${(mount.speedBonus * 100).toFixed(0)}% speed (${actualSpeed.toFixed(1)} m/s)`
		)
	}
}
