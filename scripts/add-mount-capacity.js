/**
 * Add carry capacity to mounts in mounts.json
 *
 * Capacity data from in-game measurements and transport.ts
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const MOUNTS_JSON_PATH = path.join(__dirname, '..', 'src', 'constants', 'items', 'mounts.json')

// Known mount capacities (in kg)
// Base player capacity is 50kg
const MOUNT_CAPACITIES = {
	// Transport Oxen
	T3_MOUNT_OX: 1503,
	T4_MOUNT_OX: 1655,
	T5_MOUNT_OX: 1901,
	T6_MOUNT_OX: 2237,
	T7_MOUNT_OX: 2667,
	T8_MOUNT_OX: 3200,

	// Transport Mammoth
	T8_MOUNT_MAMMOTH_TRANSPORT: 22521,

	// Horses (50kg base * 1.25 multiplier from PASSIVE_MAXLOAD_HORSE)
	T3_MOUNT_HORSE: 62.5,
	T4_MOUNT_HORSE: 62.5,
	T5_MOUNT_HORSE: 62.5,
	T6_MOUNT_HORSE: 62.5,
	T7_MOUNT_HORSE: 62.5,
	T8_MOUNT_HORSE: 62.5,

	// Armored Horses (same as regular horses)
	T5_MOUNT_ARMORED_HORSE: 62.5,
	T6_MOUNT_ARMORED_HORSE: 62.5,
	T7_MOUNT_ARMORED_HORSE: 62.5,
	T8_MOUNT_ARMORED_HORSE: 62.5,

	// Mule (buff type - increases player capacity)
	T2_MOUNT_MULE: 53,

	// Giant Stag (50kg base * 3.0 multiplier from PASSIVE_MAXLOAD_GIANTSTAG)
	T4_MOUNT_GIANTSTAG: 150,
	T6_MOUNT_GIANTSTAG_MOOSE: 150,

	// Direboar (50kg base * 8.0 multiplier from PASSIVE_MAXLOAD_DIREBOAR)
	T7_MOUNT_DIREBOAR: 400,

	// Swamp Dragon (50kg base * 4.0 multiplier from PASSIVE_MAXLOAD_SWAMPDRAGON)
	T7_MOUNT_SWAMPDRAGON: 200,

	// Direbear (50kg base * unknown multiplier - estimate based on tank role)
	T8_MOUNT_DIREBEAR: 100,

	// Direwolf (fast mount, lower capacity)
	T6_MOUNT_DIREWOLF: 75,
}

console.log('=== Adding Mount Capacities ===\n')

const mounts = JSON.parse(fs.readFileSync(MOUNTS_JSON_PATH, 'utf8'))

let updated = 0
for (const mount of mounts) {
	const capacity = MOUNT_CAPACITIES[mount.id]
	if (capacity !== undefined) {
		mount.capacity = capacity
		updated++
		console.log(`  ${mount.id}: ${capacity} kg`)
	}
}

// Write back
fs.writeFileSync(MOUNTS_JSON_PATH, JSON.stringify(mounts, null, '\t') + '\n')

console.log(`\n=== Summary ===`)
console.log(`Total mounts: ${mounts.length}`)
console.log(`Updated with capacity: ${updated}`)
console.log('\nDone!')
