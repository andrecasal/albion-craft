/**
 * Extract item weights from ao-bin-dumps/items.json and add them to the item JSON files.
 *
 * Usage: node scripts/extract-weights.js
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ITEMS_JSON_PATH = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/items.json'
const CONSTANTS_DIR = path.join(__dirname, '..', 'src', 'constants', 'items')

// Recursively find all items with @uniquename and @weight
function extractWeights(obj, weights = new Map()) {
	if (typeof obj !== 'object' || obj === null) return weights

	// Check if this object has both @uniquename and @weight
	if (obj['@uniquename'] && obj['@weight'] !== undefined) {
		const id = obj['@uniquename']
		const weight = parseFloat(obj['@weight'])
		weights.set(id, weight)
	}

	// Recurse into children
	for (const value of Object.values(obj)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				extractWeights(item, weights)
			}
		} else if (typeof value === 'object') {
			extractWeights(value, weights)
		}
	}

	return weights
}

// Get the base item ID (strip @enchant suffix for weight lookup)
function getBaseItemId(itemId) {
	// T4_2H_BOW@1 -> T4_2H_BOW
	return itemId.split('@')[0]
}

// Process a single JSON file
function processItemFile(filePath, weights) {
	const content = fs.readFileSync(filePath, 'utf8')
	const items = JSON.parse(content)

	let updated = 0
	let missing = 0

	for (const item of items) {
		const baseId = getBaseItemId(item.id)
		const weight = weights.get(baseId)

		if (weight !== undefined) {
			item.weight = weight
			updated++
		} else {
			missing++
		}
	}

	// Write back with pretty formatting
	fs.writeFileSync(filePath, JSON.stringify(items, null, '\t') + '\n')

	return { updated, missing, total: items.length }
}

// Find all JSON files in the constants/items directory
function findJsonFiles(dir) {
	const files = []

	function walk(currentDir) {
		const entries = fs.readdirSync(currentDir, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name)

			if (entry.isDirectory()) {
				walk(fullPath)
			} else if (entry.name.endsWith('.json')) {
				files.push(fullPath)
			}
		}
	}

	walk(dir)
	return files
}

// Main
console.log('=== Extract Item Weights ===\n')

console.log('Loading items.json...')
const itemsData = JSON.parse(fs.readFileSync(ITEMS_JSON_PATH, 'utf8'))

console.log('Extracting weights...')
const weights = extractWeights(itemsData)
console.log(`Found ${weights.size} items with weights\n`)

console.log('Processing item files...')
const jsonFiles = findJsonFiles(CONSTANTS_DIR)

let totalUpdated = 0
let totalMissing = 0
let totalItems = 0

for (const filePath of jsonFiles) {
	const relativePath = path.relative(CONSTANTS_DIR, filePath)
	const result = processItemFile(filePath, weights)

	console.log(`  ${relativePath}: ${result.updated}/${result.total} updated, ${result.missing} missing`)

	totalUpdated += result.updated
	totalMissing += result.missing
	totalItems += result.total
}

console.log('\n=== Summary ===')
console.log(`Total items: ${totalItems}`)
console.log(`Updated with weight: ${totalUpdated}`)
console.log(`Missing weight data: ${totalMissing}`)
console.log('\nDone!')
