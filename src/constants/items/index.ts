/**
 * Central index for all tradable items in Albion Online
 * Re-run scripts/extract-items.js to update these files from ao-bin-dumps
 */

// Equipment
import weapons from './equipment/weapons.json' with { type: 'json' }
import armor from './equipment/armor.json' with { type: 'json' }
import offhands from './equipment/offhands.json' with { type: 'json' }
import tools from './equipment/tools.json' with { type: 'json' }

// Consumables
import potions from './consumables/potions.json' with { type: 'json' }
import food from './consumables/food.json' with { type: 'json' }

// Accessories
import capes from './accessories/capes.json' with { type: 'json' }
import bags from './accessories/bags.json' with { type: 'json' }

// Materials
import rawMaterials from './materials/raw.json' with { type: 'json' }
import refinedMaterials from './materials/refined.json' with { type: 'json' }
import artifacts from './materials/artifacts.json' with { type: 'json' }
import runesSoulsRelics from './materials/runes-souls-relics.json' with { type: 'json' }

// Farming
import seeds from './farming/seeds.json' with { type: 'json' }
import animals from './farming/animals.json' with { type: 'json' }

// Misc
import tomes from './misc/tomes.json' with { type: 'json' }
import furniture from './misc/furniture.json' with { type: 'json' }
import treasure from './misc/treasure.json' with { type: 'json' }
import alchemyDrops from './misc/alchemy-drops.json' with { type: 'json' }

// Top-level categories
import mounts from './mounts.json' with { type: 'json' }
import journals from './journals.json' with { type: 'json' }
import fish from './fish.json' with { type: 'json' }

export type ItemEntry = { id: string; name: string }

// Re-export individual arrays
export {
	weapons,
	armor,
	offhands,
	tools,
	potions,
	food,
	capes,
	bags,
	rawMaterials,
	refinedMaterials,
	artifacts,
	runesSoulsRelics,
	seeds,
	animals,
	tomes,
	furniture,
	treasure,
	alchemyDrops,
	mounts,
	journals,
	fish,
}

// Grouped by category type
export const equipment = [...weapons, ...armor, ...offhands, ...tools] as ItemEntry[]
export const consumables = [...potions, ...food] as ItemEntry[]
export const accessories = [...capes, ...bags] as ItemEntry[]
export const materials = [...rawMaterials, ...refinedMaterials, ...artifacts, ...runesSoulsRelics] as ItemEntry[]
export const farming = [...seeds, ...animals] as ItemEntry[]
export const misc = [...tomes, ...furniture, ...treasure, ...alchemyDrops] as ItemEntry[]

// All items combined
export const ALL_ITEMS: ItemEntry[] = [
	...equipment,
	...consumables,
	...accessories,
	...materials,
	...farming,
	...misc,
	...(mounts as ItemEntry[]),
	...(journals as ItemEntry[]),
	...(fish as ItemEntry[]),
]

// Array of all item IDs
export const ALL_ITEM_IDS = ALL_ITEMS.map((item) => item.id)

// Map of item ID to item entry for quick lookups
export const ITEMS_BY_ID = new Map<string, ItemEntry>(
	ALL_ITEMS.map((item) => [item.id, item])
)
