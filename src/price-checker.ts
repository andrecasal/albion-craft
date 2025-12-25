import 'dotenv/config'
import { search, select } from '@inquirer/prompts'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { db } from './db/db'
import { ITEMS_WITH_QUALITY, BLACK_MARKET_ITEMS, equipment } from './constants/items'

// ============================================================================
// TYPES
// ============================================================================

type Item = {
	id: string
	name: string
}

type PriceCheckerState = {
	startTime: number
	running: boolean

	// Search
	searchItemIds: string[] // Multiple item IDs for tier equivalence
	searchItemName: string | null
	tierEquivalent: number | null // null means show all
	searchResults: CityPrice[]
	lastRefresh: Date | null
}

type CityPrice = {
	itemId: string
	city: string
	sellPrice: number
	sellDate: string
	buyPrice: number
	buyDate: string
	quality: number
}


// ============================================================================
// CONFIGURATION
// ============================================================================

// Set of base item IDs (without tier/enchant) that are equipment
const EQUIPMENT_BASE_IDS = new Set(
	equipment.map((item) => {
		const parsed = parseItemId(item.id)
		return parsed ? parsed.baseId : null
	}).filter((id): id is string => id !== null)
)

// ============================================================================
// ITEM ID PARSING
// ============================================================================

type ParsedItemId = {
	baseId: string // e.g., "2H_BOW"
	tier: number // e.g., 4
	enchant: number // e.g., 0, 1, 2, 3, 4
	fullId: string // e.g., "T4_2H_BOW@1"
}

/**
 * Parse an item ID into its components
 * e.g., "T4_2H_BOW@1" -> { baseId: "2H_BOW", tier: 4, enchant: 1 }
 */
function parseItemId(itemId: string): ParsedItemId | null {
	const match = itemId.match(/^T(\d+)_(.+?)(?:@(\d+))?$/)
	if (!match) return null

	return {
		baseId: match[2],
		tier: parseInt(match[1], 10),
		enchant: match[3] ? parseInt(match[3], 10) : 0,
		fullId: itemId,
	}
}

/**
 * Build an item ID from components
 */
function buildItemId(baseId: string, tier: number, enchant: number): string {
	return enchant > 0 ? `T${tier}_${baseId}@${enchant}` : `T${tier}_${baseId}`
}

/**
 * Check if an item has enchantment variants (is equipment)
 */
function hasEnchantmentVariants(itemId: string): boolean {
	const parsed = parseItemId(itemId)
	if (!parsed) return false
	return EQUIPMENT_BASE_IDS.has(parsed.baseId)
}

/**
 * Get all item IDs that match a tier equivalence
 * Tier equivalence = tier + enchant
 * e.g., tier equiv 8 = T4@4, T5@3, T6@2, T7@1, T8@0
 */
function getTierEquivalentIds(itemId: string, tierEquiv: number): string[] {
	const parsed = parseItemId(itemId)
	if (!parsed) return [itemId]

	const ids: string[] = []

	// For each possible tier (4-8), calculate the enchant needed
	for (let tier = 4; tier <= 8; tier++) {
		const enchant = tierEquiv - tier
		if (enchant >= 0 && enchant <= 4) {
			ids.push(buildItemId(parsed.baseId, tier, enchant))
		}
	}

	return ids
}

/**
 * Get all possible item IDs for an equipment item (all tier/enchant combos)
 */
function getAllVariantIds(itemId: string): string[] {
	const parsed = parseItemId(itemId)
	if (!parsed) return [itemId]

	const ids: string[] = []

	for (let tier = 4; tier <= 8; tier++) {
		for (let enchant = 0; enchant <= 4; enchant++) {
			ids.push(buildItemId(parsed.baseId, tier, enchant))
		}
	}

	return ids
}

// ============================================================================
// ITEM LOADING
// ============================================================================

function loadAllItems(): Item[] {
	const items: Item[] = []
	const itemsDir = join(import.meta.dirname, 'constants/items')

	function scanDirectory(dir: string): void {
		const entries = readdirSync(dir, { withFileTypes: true })
		for (const entry of entries) {
			const fullPath = join(dir, entry.name)
			if (entry.isDirectory()) {
				scanDirectory(fullPath)
			} else if (entry.name.endsWith('.json')) {
				const content = readFileSync(fullPath, 'utf-8')
				const parsed = JSON.parse(content) as Item[]
				items.push(...parsed)
			}
		}
	}

	scanDirectory(itemsDir)
	return items
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main()

async function main(): Promise<void> {
	// Load all items for autocomplete
	const allItems = loadAllItems()

	const state: PriceCheckerState = {
		startTime: Date.now(),
		running: false,

		// Search
		searchItemIds: [],
		searchItemName: null,
		tierEquivalent: null,
		searchResults: [],
		lastRefresh: null,
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	// Main loop - allows returning to search
	while (true) {
		const selectedItem = await promptForItem(allItems)

		// Check if this item has enchantment variants (equipment)
		if (hasEnchantmentVariants(selectedItem.id)) {
			const tierEquiv = await promptForTierEquivalence(selectedItem.id)
			state.tierEquivalent = tierEquiv

			if (tierEquiv === null) {
				// Show all variants
				state.searchItemIds = getAllVariantIds(selectedItem.id)
			} else {
				// Show only tier-equivalent items
				state.searchItemIds = getTierEquivalentIds(selectedItem.id, tierEquiv)
			}
		} else {
			// Non-equipment item, just search for it directly
			state.searchItemIds = [selectedItem.id]
			state.tierEquivalent = null
		}

		state.searchItemName = selectedItem.name
		state.searchResults = []
		state.lastRefresh = null

		await startPriceChecker(state)
	}
}

async function promptForItem(allItems: Item[]): Promise<Item> {
	return search<Item>({
		message: 'Search for an item:',
		source: async (input) => {
			if (!input) {
				return allItems.slice(0, 10).map((item) => ({
					name: item.name,
					value: item,
					description: item.id,
				}))
			}
			const lowerInput = input.toLowerCase()
			return allItems
				.filter((item) => item.name.toLowerCase().includes(lowerInput))
				.slice(0, 10)
				.map((item) => ({
					name: item.name,
					value: item,
					description: item.id,
				}))
		},
	})
}

async function promptForTierEquivalence(itemId: string): Promise<number | null> {
	const parsed = parseItemId(itemId)
	if (!parsed) return null

	// Build choices for tier equivalence (4-12)
	// 4 = T4.0, 5 = T4.1 or T5.0, ..., 12 = T8.4
	const choices: { name: string; value: number | null; description: string }[] = [
		{
			name: 'All tiers & enchantments',
			value: null,
			description: 'Show all combinations',
		},
	]

	for (let tierEquiv = 4; tierEquiv <= 12; tierEquiv++) {
		const variants: string[] = []
		for (let tier = 4; tier <= 8; tier++) {
			const enchant = tierEquiv - tier
			if (enchant >= 0 && enchant <= 4) {
				variants.push(`T${tier}.${enchant}`)
			}
		}
		choices.push({
			name: `Tier ${tierEquiv} equivalent`,
			value: tierEquiv,
			description: variants.join(', '),
		})
	}

	return select<number | null>({
		message: 'Select tier equivalence:',
		choices,
	})
}

function shutdown(state: PriceCheckerState): void {
	if (!state.running) return
	state.running = false

	console.log('\nPrice checker stopped.')
	process.exit(0)
}

// ============================================================================
// PRICE CHECKER LIFECYCLE
// ============================================================================

async function startPriceChecker(state: PriceCheckerState): Promise<void> {
	state.running = true
	state.startTime = Date.now()

	// Initial data fetch and display
	refreshPrices(state)
	showDashboard(state)

	// Wait for user keypresses (r to refresh, s to search, q to quit)
	await waitForKeypress(state)
}

function waitForKeypress(state: PriceCheckerState): Promise<void> {
	return new Promise((resolve) => {
		process.stdin.setRawMode(true)
		process.stdin.resume()

		const onKeypress = (key: Buffer) => {
			const char = key.toString()

			// Ctrl+C
			if (char === '\u0003') {
				cleanup()
				shutdown(state)
				return
			}

			// 'r' for refresh
			if (char === 'r' || char === 'R') {
				refreshPrices(state)
				showDashboard(state)
				return
			}

			// 's' for new search
			if (char === 's' || char === 'S') {
				cleanup()
				stopPriceChecker(state)
				resolve()
				return
			}

			// 'q' for quit
			if (char === 'q' || char === 'Q') {
				cleanup()
				shutdown(state)
				return
			}
		}

		const cleanup = () => {
			process.stdin.removeListener('data', onKeypress)
			process.stdin.setRawMode(false)
			process.stdin.pause()
		}

		process.stdin.on('data', onKeypress)
	})
}

function stopPriceChecker(state: PriceCheckerState): void {
	state.running = false
}

// ============================================================================
// DATA FUNCTIONS
// ============================================================================

function refreshPrices(state: PriceCheckerState): void {
	if (state.searchItemIds.length === 0) return

	// Build placeholders for IN clause
	const placeholders = state.searchItemIds.map(() => '?').join(',')

	// Fetch from latest_prices (API data)
	const results = db
		.prepare(
			`
			SELECT
				item_id as itemId,
				city,
				quality,
				sell_price_min as sellPrice,
				sell_price_min_date as sellDate,
				buy_price_max as buyPrice,
				buy_price_max_date as buyDate
			FROM latest_prices
			WHERE item_id IN (${placeholders})
			ORDER BY sell_price_min ASC
		`,
		)
		.all(...state.searchItemIds) as CityPrice[]

	state.searchResults = results
	state.lastRefresh = new Date()
}

// ============================================================================
// DASHBOARD
// ============================================================================

function showDashboard(state: PriceCheckerState): void {
	console.clear()

	const uptime = formatDuration(Date.now() - state.startTime)

	const W = 140
	const lines: string[] = []

	// Build item display with tier equivalence info
	let itemDisplay = state.searchItemName || 'None'
	if (state.tierEquivalent !== null) {
		itemDisplay += ` (Tier ${state.tierEquivalent} equiv)`
	} else if (state.searchItemIds.length > 1) {
		itemDisplay += ` (All tiers)`
	}

	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${`ALBION PRICE CHECKER`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`🔍 Item: ${itemDisplay}`.padEnd(W / 2)}${`⚡ Uptime: ${uptime}`.padEnd(W / 2 - 2)} │`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Check if items have quality levels (equipment always does)
	const hasQuality = state.searchItemIds.some((id) => ITEMS_WITH_QUALITY.has(id))
	const isBlackMarketItem = state.searchItemIds.some((id) => BLACK_MARKET_ITEMS.has(id))
	// Show tier column if we have multiple item variants
	const showTier = state.searchItemIds.length > 1

	type PriceRow = {
		itemId: string
		tier: number
		enchant: number
		city: string
		quality: number
		sellPrice: number
		sellDate: string
		buyPrice: number
		buyDate: string
	}

	const rows: PriceRow[] = state.searchResults
		.filter((r) => {
			if (!hasQuality && r.quality !== 1) return false
			if (!isBlackMarketItem && r.city === 'Black Market') return false
			return true
		})
		.map((r) => {
			const parsed = parseItemId(r.itemId)
			return {
				itemId: r.itemId,
				tier: parsed?.tier ?? 0,
				enchant: parsed?.enchant ?? 0,
				city: r.city,
				quality: r.quality,
				sellPrice: r.sellPrice,
				sellDate: r.sellDate,
				buyPrice: r.buyPrice,
				buyDate: r.buyDate,
			}
		})
		.sort((a, b) => a.sellPrice - b.sellPrice)

	if (rows.length === 0) {
		lines.push(`│ ${`No prices found for this item`.padEnd(W - 2)} │`)
	} else {
		const tierW = showTier ? 7 : 0
		const cityW = 15
		const qualW = hasQuality ? 5 : 0
		const priceW = 12
		const dateW = 14

		const tierHeader = showTier ? `Tier`.padEnd(tierW) : ''
		const qualHeader = hasQuality ? `Qual`.padEnd(qualW) : ''

		lines.push(
			`│ ${tierHeader}${`City`.padEnd(cityW)}${qualHeader}│ ${`Sell Price`.padEnd(priceW)}${`Updated`.padEnd(dateW)}│ ${`Buy Price`.padEnd(priceW)}${`Updated`.padEnd(dateW)}│`,
		)
		lines.push(`├${'─'.repeat(W)}┤`)

		for (const row of rows) {
			const tierStr = showTier ? `T${row.tier}.${row.enchant}`.padEnd(tierW) : ''
			const qualStr = hasQuality ? `Q${row.quality}`.padEnd(qualW) : ''

			const sellStr = row.sellPrice > 0 ? formatSilver(row.sellPrice) : '-'
			const sellDateStr = row.sellDate && row.sellDate !== '0001-01-01T00:00:00' ? formatTimeAgo(new Date(row.sellDate)) : '-'
			const buyStr = row.buyPrice > 0 ? formatSilver(row.buyPrice) : '-'
			const buyDateStr = row.buyDate && row.buyDate !== '0001-01-01T00:00:00' ? formatTimeAgo(new Date(row.buyDate)) : '-'

			lines.push(
				`│ ${tierStr}${row.city.padEnd(cityW)}${qualStr}│ ${sellStr.padEnd(priceW)}${sellDateStr.padEnd(dateW)}│ ${buyStr.padEnd(priceW)}${buyDateStr.padEnd(dateW)}│`,
			)
		}
	}

	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(
		`│ ${`Last refresh: ${state.lastRefresh ? formatTimeAgo(state.lastRefresh) : 'Never'}`.padEnd(W - 2)} │`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(
		`│ ${`Press [r] to refresh | [s] to search another item | [q] to quit`.padEnd(W - 2)} │`,
	)
	lines.push(`└${'─'.repeat(W)}┘`)

	console.log(lines.join('\n'))
}

// ============================================================================
// FORMATTING
// ============================================================================

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000),
		m = Math.floor(s / 60),
		h = Math.floor(m / 60)
	if (h > 0) return `${h}h ${m % 60}m`
	if (m > 0) return `${m}m ${s % 60}s`
	return `${s}s`
}

function formatSilver(amount: number): string {
	if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M'
	if (amount >= 1_000) return (amount / 1_000).toFixed(1) + 'K'
	return String(amount)
}

function formatTimeAgo(date: Date): string {
	const s = Math.floor((Date.now() - date.getTime()) / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	return `${Math.floor(m / 60)}h ${m % 60}m ago`
}
