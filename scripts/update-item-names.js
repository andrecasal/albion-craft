#!/usr/bin/env node

/**
 * Updates item JSON files with proper localized names from ao-bin-dumps
 * Usage: node scripts/update-item-names.js <target-file>
 * Example: node scripts/update-item-names.js src/constants/items/equipment/weapons.json
 */

const fs = require('fs')
const path = require('path')

const ITEMS_DUMP_PATH = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/formatted/items.json'

function main() {
	const targetFile = process.argv[2]
	if (!targetFile) {
		console.error('Usage: node scripts/update-item-names.js <target-file>')
		console.error('Example: node scripts/update-item-names.js src/constants/items/equipment/weapons.json')
		process.exit(1)
	}

	const targetPath = path.resolve(process.cwd(), targetFile)
	if (!fs.existsSync(targetPath)) {
		console.error(`Target file not found: ${targetPath}`)
		process.exit(1)
	}

	if (!fs.existsSync(ITEMS_DUMP_PATH)) {
		console.error(`Items dump not found: ${ITEMS_DUMP_PATH}`)
		process.exit(1)
	}

	console.log(`Loading items dump from ${ITEMS_DUMP_PATH}...`)
	const itemsDump = JSON.parse(fs.readFileSync(ITEMS_DUMP_PATH, 'utf-8'))

	// Build lookup map: UniqueName -> EN-US name
	// For items with @quality suffix, use the base item name
	const nameMap = new Map()
	for (const item of itemsDump) {
		if (item.UniqueName && item.LocalizedNames?.['EN-US']) {
			nameMap.set(item.UniqueName, item.LocalizedNames['EN-US'])
		}
	}
	console.log(`Loaded ${nameMap.size} item names`)

	console.log(`Loading target file: ${targetPath}`)
	const targetItems = JSON.parse(fs.readFileSync(targetPath, 'utf-8'))

	let updated = 0
	let notFound = 0
	const missingIds = []

	for (const item of targetItems) {
		// Item ID might have @quality suffix (e.g., T4_2H_BOW@1)
		// Try exact match first, then base ID without quality
		const baseId = item.id.split('@')[0]

		let name = nameMap.get(item.id) || nameMap.get(baseId)

		if (name) {
			// For items with quality suffix, append the quality indicator
			if (item.id.includes('@')) {
				const quality = item.id.split('@')[1]
				const qualityNames = {
					'1': 'Uncommon',
					'2': 'Rare',
					'3': 'Exceptional',
					'4': 'Pristine'
				}
				if (qualityNames[quality]) {
					name = `${name} (${qualityNames[quality]})`
				}
			}

			if (item.name !== name) {
				item.name = name
				updated++
			}
		} else {
			notFound++
			missingIds.push(item.id)
		}
	}

	// Write back
	fs.writeFileSync(targetPath, JSON.stringify(targetItems, null, '\t') + '\n')

	console.log(`\nResults:`)
	console.log(`  Updated: ${updated}`)
	console.log(`  Not found: ${notFound}`)

	if (missingIds.length > 0 && missingIds.length <= 20) {
		console.log(`\nMissing IDs:`)
		for (const id of missingIds) {
			console.log(`  - ${id}`)
		}
	} else if (missingIds.length > 20) {
		console.log(`\nFirst 20 missing IDs:`)
		for (const id of missingIds.slice(0, 20)) {
			console.log(`  - ${id}`)
		}
		console.log(`  ... and ${missingIds.length - 20} more`)
	}
}

main()
