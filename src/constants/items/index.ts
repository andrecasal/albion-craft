/**
 * Central index for all tradable items in Albion Online
 * Re-run scripts/extract-items.js to update these files from ao-bin-dumps
 */

export type ItemEntry = { id: string; name: string }

// Equipment
export const weapons = require('./equipment/weapons.json') as ItemEntry[]
export const armor = require('./equipment/armor.json') as ItemEntry[]
export const offhands = require('./equipment/offhands.json') as ItemEntry[]
export const tools = require('./equipment/tools.json') as ItemEntry[]

// Consumables
export const potions = require('./consumables/potions.json') as ItemEntry[]
export const food = require('./consumables/food.json') as ItemEntry[]

// Accessories
export const capes = require('./accessories/capes.json') as ItemEntry[]
export const bags = require('./accessories/bags.json') as ItemEntry[]

// Materials
export const rawMaterials = require('./materials/raw.json') as ItemEntry[]
export const refinedMaterials = require('./materials/refined.json') as ItemEntry[]
export const artifacts = require('./materials/artifacts.json') as ItemEntry[]
export const runesSoulsRelics = require('./materials/runes-souls-relics.json') as ItemEntry[]

// Farming
export const seeds = require('./farming/seeds.json') as ItemEntry[]
export const animals = require('./farming/animals.json') as ItemEntry[]

// Misc
export const tomes = require('./misc/tomes.json') as ItemEntry[]
export const furniture = require('./misc/furniture.json') as ItemEntry[]
export const treasure = require('./misc/treasure.json') as ItemEntry[]
export const alchemyDrops = require('./misc/alchemy-drops.json') as ItemEntry[]

// Top-level categories
export const mounts = require('./mounts.json') as ItemEntry[]
export const journals = require('./journals.json') as ItemEntry[]
export const fish = require('./fish.json') as ItemEntry[]

// Grouped by category type
export const equipment = [...weapons, ...armor, ...offhands, ...tools]
export const consumables = [...potions, ...food]
export const accessories = [...capes, ...bags]
export const materials = [...rawMaterials, ...refinedMaterials, ...artifacts, ...runesSoulsRelics]
export const farming = [...seeds, ...animals]
export const misc = [...tomes, ...furniture, ...treasure, ...alchemyDrops]

// All items combined
export const ALL_ITEMS = [
	...equipment,
	...consumables,
	...accessories,
	...materials,
	...farming,
	...misc,
	...mounts,
	...journals,
	...fish,
]

// Array of all item IDs
export const ALL_ITEM_IDS = ALL_ITEMS.map((item) => item.id)

// Map of item ID to item entry for quick lookups
export const ITEMS_BY_ID = new Map<string, ItemEntry>(
	ALL_ITEMS.map((item) => [item.id, item])
)
