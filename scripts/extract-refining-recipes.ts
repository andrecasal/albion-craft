/**
 * Extract refining recipes from ao-bin-dumps/items.json
 * and merge them into src/constants/recipes.json
 */

import * as fs from 'fs'
import * as path from 'path'

const ITEMS_JSON_PATH = '/Users/andrecasal/Developer/Apps/ao-bin-dumps/items.json'
const RECIPES_JSON_PATH = path.join(process.cwd(), 'src/constants/recipes.json')

interface CraftResource {
	'@uniquename': string
	'@count': string
	'@enchantmentlevel'?: string
}

interface CraftingRequirement {
	'@silver': string
	'@time': string
	'@craftingfocus': string
	'@amountcrafted'?: string
	'@craftbuttonlocaoverride'?: string
	craftresource: CraftResource | CraftResource[]
}

interface Item {
	'@uniquename': string
	'@shopcategory'?: string
	'@shopsubcategory1'?: string
	'@craftingcategory'?: string
	'@tier'?: string
	'@enchantmentlevel'?: string
	craftingrequirements?: CraftingRequirement | CraftingRequirement[]
}

interface Recipe {
	itemId: string
	material1: string
	mat1Qty: number
	material2: string
	mat2Qty: number
	material3: string
	mat3Qty: number
	material4: string
	mat4Qty: number
	craftingFee: number
	focusCost: number
}

// Refining categories to extract
const REFINING_CATEGORIES = ['ore', 'wood', 'hide', 'fiber', 'rock']

function isRefiningItem(item: Item): boolean {
	return (
		item['@shopsubcategory1'] === 'refinedresources' &&
		item.craftingrequirements !== undefined &&
		REFINING_CATEGORIES.includes(item['@craftingcategory'] || '')
	)
}

function extractRecipeFromRequirement(
	itemId: string,
	req: CraftingRequirement,
): Recipe | null {
	const resources = Array.isArray(req.craftresource)
		? req.craftresource
		: [req.craftresource]

	// Only extract base refining recipe (first one, without transmutation)
	// Skip recipes that are transmutations (craftbuttonlocaoverride contains TRANSMUTE)
	if (req['@craftbuttonlocaoverride']?.includes('TRANSMUTE')) {
		return null
	}

	const recipe: Recipe = {
		itemId,
		material1: '',
		mat1Qty: 0,
		material2: '',
		mat2Qty: 0,
		material3: '',
		mat3Qty: 0,
		material4: '',
		mat4Qty: 0,
		craftingFee: parseInt(req['@silver']) || 0,
		focusCost: parseInt(req['@craftingfocus']) || 0,
	}

	resources.forEach((res, idx) => {
		const matNum = idx + 1
		if (matNum <= 4) {
			;(recipe as Record<string, string | number>)[`material${matNum}`] = res['@uniquename']
			;(recipe as Record<string, string | number>)[`mat${matNum}Qty`] = parseInt(res['@count']) || 0
		}
	})

	return recipe
}

function main() {
	console.log('Reading items.json...')
	const itemsData = JSON.parse(fs.readFileSync(ITEMS_JSON_PATH, 'utf-8'))

	// Navigate to the items array
	const items: Item[] = []

	// The structure has different item types at different paths
	// Let's find all simpleitem and other item types
	const itemsRoot = itemsData.items

	// Collect items from different categories
	const itemTypes = ['simpleitem', 'equipmentitem', 'weapon', 'mount', 'farmableitem', 'consumableitem', 'consumablefrominventoryitem', 'trackingitem', 'journalitem']

	for (const itemType of itemTypes) {
		if (itemsRoot[itemType]) {
			const typeItems = Array.isArray(itemsRoot[itemType])
				? itemsRoot[itemType]
				: [itemsRoot[itemType]]
			items.push(...typeItems)
		}
	}

	console.log(`Found ${items.length} total items`)

	// Filter for refining items and extract recipes
	const refiningRecipes: Recipe[] = []

	for (const item of items) {
		if (!isRefiningItem(item)) continue

		const requirements = Array.isArray(item.craftingrequirements)
			? item.craftingrequirements
			: [item.craftingrequirements!]

		// Get the first (base) refining recipe
		for (const req of requirements) {
			const recipe = extractRecipeFromRequirement(item['@uniquename'], req)
			if (recipe && recipe.material1) {
				refiningRecipes.push(recipe)
				break // Only take the first valid recipe per item
			}
		}
	}

	console.log(`Extracted ${refiningRecipes.length} refining recipes`)

	// Sort by itemId for consistency
	refiningRecipes.sort((a, b) => a.itemId.localeCompare(b.itemId))

	// Read existing recipes
	console.log('Reading existing recipes.json...')
	const existingRecipes: Recipe[] = JSON.parse(fs.readFileSync(RECIPES_JSON_PATH, 'utf-8'))

	// Check for duplicates
	const existingIds = new Set(existingRecipes.map(r => r.itemId))
	const newRecipes = refiningRecipes.filter(r => !existingIds.has(r.itemId))

	console.log(`Found ${newRecipes.length} new refining recipes to add`)

	if (newRecipes.length > 0) {
		// Merge and sort
		const mergedRecipes = [...existingRecipes, ...newRecipes].sort((a, b) =>
			a.itemId.localeCompare(b.itemId),
		)

		// Write back
		console.log('Writing updated recipes.json...')
		fs.writeFileSync(RECIPES_JSON_PATH, JSON.stringify(mergedRecipes, null, '\t'))
		console.log('Done!')

		// Print sample of new recipes
		console.log('\nSample of new recipes added:')
		newRecipes.slice(0, 5).forEach(r => {
			console.log(`  ${r.itemId}: ${r.mat1Qty}x ${r.material1} + ${r.mat2Qty}x ${r.material2}`)
		})
	} else {
		console.log('No new recipes to add.')
	}
}

main()
