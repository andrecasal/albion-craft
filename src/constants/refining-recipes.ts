import returnRates from './return-rates.json' with { type: 'json' }
import allRecipes from './recipes.json' with { type: 'json' }

/**
 * Refining recipes for Albion Online
 * Derived from recipes.json (extracted from game data)
 */

export interface RefiningRecipe {
	output: string
	rawMaterial: string
	rawQty: number
	prevRefined: string | null
	prevQty: number
	focusCost: number
	category: 'Ore' | 'Wood' | 'Hide' | 'Fiber' | 'Stone'
}

// Derive city bonuses for refining from return-rates.json (category -> city)
export const REFINING_CITY_BONUSES: Record<string, string> = Object.entries(returnRates.cityBonuses).reduce(
	(acc, [city, bonuses]) => {
		for (const material of bonuses.refining) {
			acc[material] = city
		}
		return acc
	},
	{} as Record<string, string>,
)

// Map item ID patterns to categories
const CATEGORY_PATTERNS: { pattern: RegExp; category: RefiningRecipe['category'] }[] = [
	{ pattern: /^T\d_METALBAR/, category: 'Ore' },
	{ pattern: /^T\d_PLANKS/, category: 'Wood' },
	{ pattern: /^T\d_LEATHER/, category: 'Hide' },
	{ pattern: /^T\d_CLOTH/, category: 'Fiber' },
	{ pattern: /^T\d_STONEBLOCK/, category: 'Stone' },
]

function getCategory(itemId: string): RefiningRecipe['category'] | null {
	for (const { pattern, category } of CATEGORY_PATTERNS) {
		if (pattern.test(itemId)) return category
	}
	return null
}

function isRefiningRecipe(recipe: (typeof allRecipes)[number]): boolean {
	return getCategory(recipe.itemId) !== null
}

// Extract refining recipes from recipes.json
export const REFINING_RECIPES: RefiningRecipe[] = allRecipes
	.filter(isRefiningRecipe)
	.map(recipe => {
		const category = getCategory(recipe.itemId)!
		return {
			output: recipe.itemId,
			rawMaterial: recipe.material1,
			rawQty: recipe.mat1Qty,
			prevRefined: recipe.material2 || null,
			prevQty: recipe.mat2Qty,
			focusCost: recipe.focusCost,
			category,
		}
	})

// Map for quick lookup by output item ID
export const REFINING_RECIPES_BY_OUTPUT = new Map<string, RefiningRecipe>(
	REFINING_RECIPES.map(recipe => [recipe.output, recipe]),
)

// Get all item IDs needed for price lookups
export const ALL_REFINING_ITEM_IDS: string[] = [
	...new Set(
		REFINING_RECIPES.flatMap(r => [r.output, r.rawMaterial, r.prevRefined].filter(Boolean) as string[]),
	),
]
