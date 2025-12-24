import 'dotenv/config'
import { search, select } from '@inquirer/prompts'
import {
	ALL_ITEMS,
	ITEMS_BY_ID,
	equipment,
	consumables,
	accessories,
	materials,
	farming,
	misc,
	mounts,
	journals,
	fish,
	type ItemEntry,
} from './constants/items'
import { findArbitrageOpportunities, type ArbitrageOpportunity } from './market-api'

// ============================================================================
// TYPES
// ============================================================================

type ScanMode = 'single' | 'category' | 'all'

type Category = {
	name: string
	items: ItemEntry[]
}

type ExtendedArbitrageOpportunity = ArbitrageOpportunity & {
	itemId: string
	itemName: string
	displayName: string // e.g., "T4.2 Bow" instead of "Adept's Bow"
}

type SortBy = 'instant' | 'undercut'

type ArbitrageScannerState = {
	startTime: number
	running: boolean

	// Timers
	scanTimer: NodeJS.Timeout | null

	// Scan configuration
	scanMode: ScanMode
	selectedItemIds: string[]
	selectedLabel: string
	minProfitPercent: number
	maxAgeMinutes: number
	excludeBlackMarket: boolean
	sortBy: SortBy

	// Results
	opportunities: ExtendedArbitrageOpportunity[]
	lastScan: Date | null
	scanProgress: { current: number; total: number }
	isScanning: boolean
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CATEGORIES: Category[] = [
	{ name: 'Equipment (Weapons, Armor, Offhands, Tools)', items: equipment },
	{ name: 'Consumables (Potions, Food)', items: consumables },
	{ name: 'Accessories (Capes, Bags)', items: accessories },
	{ name: 'Materials (Raw, Refined, Artifacts, Runes)', items: materials },
	{ name: 'Farming (Seeds, Animals)', items: farming },
	{ name: 'Misc (Tomes, Furniture, Treasure)', items: misc },
	{ name: 'Mounts', items: mounts as ItemEntry[] },
	{ name: 'Journals', items: journals as ItemEntry[] },
	{ name: 'Fish', items: fish as ItemEntry[] },
]

const DEFAULT_MAX_AGE_MINUTES = 60 * 24 // Accept prices up to 24 hours old

// ============================================================================
// ENTRY POINT
// ============================================================================

main()

async function main(): Promise<void> {
	const state: ArbitrageScannerState = {
		startTime: Date.now(),
		running: false,

		// Timers
		scanTimer: null,

		// Scan configuration
		scanMode: 'single',
		selectedItemIds: [],
		selectedLabel: '',
		minProfitPercent: 1,
		maxAgeMinutes: DEFAULT_MAX_AGE_MINUTES,
		excludeBlackMarket: true,
		sortBy: 'instant',

		// Results
		opportunities: [],
		lastScan: null,
		scanProgress: { current: 0, total: 0 },
		isScanning: false,
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	// Main loop - allows returning to search
	while (true) {
		await promptForScanConfig(state)
		await startScanner(state)
	}
}

function shutdown(state: ArbitrageScannerState): void {
	if (!state.running) process.exit(0)
	state.running = false

	if (state.scanTimer) clearInterval(state.scanTimer)

	console.log('\nArbitrage scanner stopped.')
	process.exit(0)
}

// ============================================================================
// PROMPTS
// ============================================================================

async function promptForScanConfig(state: ArbitrageScannerState): Promise<void> {
	// Step 1: Select scan mode
	const mode = await select<ScanMode>({
		message: 'Select scan mode:',
		choices: [
			{
				name: 'Single Item',
				value: 'single' as ScanMode,
				description: 'Search for a specific item',
			},
			{
				name: 'Category',
				value: 'category' as ScanMode,
				description: 'Scan all items in a category',
			},
			{
				name: 'All Items',
				value: 'all' as ScanMode,
				description: 'Scan entire market (slow)',
			},
		],
	})

	state.scanMode = mode

	// Step 2: Select items based on mode
	if (mode === 'single') {
		const item = await search<ItemEntry>({
			message: 'Search for an item:',
			source: async (input) => {
				if (!input) {
					return ALL_ITEMS.slice(0, 10).map((item) => ({
						name: item.name,
						value: item,
						description: item.id,
					}))
				}
				const lowerInput = input.toLowerCase()
				return ALL_ITEMS.filter((item) =>
					item.name.toLowerCase().includes(lowerInput),
				)
					.slice(0, 10)
					.map((item) => ({
						name: item.name,
						value: item,
						description: item.id,
					}))
			},
		})
		state.selectedItemIds = [item.id]
		state.selectedLabel = item.name
	} else if (mode === 'category') {
		const category = await select<Category>({
			message: 'Select category:',
			choices: CATEGORIES.map((cat) => ({
				name: cat.name,
				value: cat,
				description: `${cat.items.length} items`,
			})),
		})
		state.selectedItemIds = category.items.map((i) => i.id)
		state.selectedLabel = category.name
	} else {
		state.selectedItemIds = ALL_ITEMS.map((i) => i.id)
		state.selectedLabel = 'All Items'
	}
}

// ============================================================================
// SCANNER LIFECYCLE
// ============================================================================

async function startScanner(state: ArbitrageScannerState): Promise<void> {
	state.running = true
	state.startTime = Date.now()
	state.opportunities = []
	state.lastScan = null

	// Initial scan
	await scanForArbitrage(state)
	showDashboard(state)

	// Wait for keypresses (manual refresh only)
	await waitForKeypress(state)
}

function stopScanner(state: ArbitrageScannerState): void {
	state.running = false
	if (state.scanTimer) {
		clearInterval(state.scanTimer)
		state.scanTimer = null
	}
}

// ============================================================================
// ARBITRAGE SCANNING
// ============================================================================

async function scanForArbitrage(state: ArbitrageScannerState): Promise<void> {
	state.isScanning = true
	state.opportunities = []
	state.scanProgress = { current: 0, total: state.selectedItemIds.length }

	const allOpportunities: ExtendedArbitrageOpportunity[] = []

	for (let i = 0; i < state.selectedItemIds.length; i++) {
		const itemId = state.selectedItemIds[i]
		state.scanProgress.current = i + 1

		// Update display during long scans
		if (state.selectedItemIds.length > 10 && i % 50 === 0) {
			showDashboard(state)
		}

		try {
			// Scan all qualities (1-5) for each item
			for (let quality = 1; quality <= 5; quality++) {
				const opps = findArbitrageOpportunities(itemId, {
					minProfitPercent: state.minProfitPercent,
					maxAgeMinutes: state.maxAgeMinutes,
					quality,
				})

				for (const opp of opps) {
					const itemEntry = ITEMS_BY_ID.get(itemId)
					const itemName = itemEntry?.name ?? itemId
					allOpportunities.push({
						...opp,
						itemId,
						itemName,
						displayName: formatItemDisplayName(itemId, itemName),
					})
				}
			}
		} catch {
			// Skip items with no price data
		}
	}

	// Sort by selected strategy's profit descending
	state.opportunities = sortOpportunities(allOpportunities, state.sortBy)
	state.lastScan = new Date()
	state.isScanning = false
}

function sortOpportunities(
	opps: ExtendedArbitrageOpportunity[],
	sortBy: SortBy,
): ExtendedArbitrageOpportunity[] {
	return [...opps].sort((a, b) => {
		const aProfit = sortBy === 'instant' ? (a.instantProfit ?? -Infinity) : (a.undercutProfit ?? -Infinity)
		const bProfit = sortBy === 'instant' ? (b.instantProfit ?? -Infinity) : (b.undercutProfit ?? -Infinity)
		return bProfit - aProfit
	})
}

// ============================================================================
// DASHBOARD
// ============================================================================

function showDashboard(state: ArbitrageScannerState): void {
	console.clear()

	const uptime = formatDuration(Date.now() - state.startTime)

	const W = 156
	const lines: string[] = []

	// Header
	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${'ALBION ARBITRAGE SCANNER'.padEnd(W - 2)} │`)

	const modeStr = `Mode: ${state.selectedLabel}`
	const foundStr = `Found: ${state.opportunities.length} opportunities`
	const uptimeStr = `Uptime: ${uptime}`

	lines.push(
		`│ ${modeStr.padEnd(W / 2)}${foundStr.padEnd(W / 4)}${uptimeStr.padEnd(W / 4 - 2)} │`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Scanning progress
	if (state.isScanning) {
		const progress = `Scanning... ${state.scanProgress.current}/${state.scanProgress.total} items`
		lines.push(`│ ${progress.padEnd(W - 2)} │`)
		lines.push(`├${'─'.repeat(W)}┤`)
	}

	// Column headers
	const itemW = 22
	const qualW = 3
	const cityW = 14
	const priceW = 9
	const sellW = 9
	const profitW = 9
	const pctW = 7
	const avgW = 9
	const volW = 7
	const ageW = 5

	// Build header with sort indicators
	const instantHdr = state.sortBy === 'instant' ? '▼Instant' : 'Instant'
	const undercutHdr = state.sortBy === 'undercut' ? '▼Undercut' : 'Undercut'

	lines.push(
		`│ ${'Item'.padEnd(itemW)}${'Q'.padEnd(qualW)}${'Buy City'.padEnd(cityW)}${'Buy'.padEnd(priceW)}${'Sell City'.padEnd(cityW - 1)}│ ${instantHdr.padEnd(sellW)}${'Profit'.padEnd(profitW)}${'%'.padEnd(pctW - 1)}│ ${undercutHdr.padEnd(sellW)}${'Profit'.padEnd(profitW)}${'%'.padEnd(pctW - 1)}│ ${'Avg30d'.padEnd(avgW)}${'Vol/d'.padEnd(volW)}${'Age'.padEnd(ageW - 1)}│`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Filter opportunities based on Black Market toggle
	const filteredOpps = state.excludeBlackMarket
		? state.opportunities.filter(
				(opp) => opp.buyCity !== 'Black Market' && opp.sellCity !== 'Black Market',
			)
		: state.opportunities

	// Results
	if (filteredOpps.length === 0 && !state.isScanning) {
		lines.push(
			`│ ${`No arbitrage opportunities found.`.padEnd(W - 2)} │`,
		)
	} else {
		// Show top 40 opportunities
		const displayOpps = filteredOpps.slice(0, 40)
		for (const opp of displayOpps) {
			const itemDisplay = truncate(opp.displayName, itemW - 1)
			const qualStr = `${opp.quality}`
			const ageStr = formatDataAge(opp.dataAgeMinutes)
			const avgStr = opp.avgPrice !== null ? formatSilver(opp.avgPrice) : '-'
			const volStr = formatVolume(opp.dailyVolume)

			// Instant sell columns
			const instantSell = opp.instantSellPrice !== null ? formatSilver(opp.instantSellPrice) : '-'
			const instantProfit = opp.instantProfit !== null ? formatSilver(opp.instantProfit) : '-'
			const instantPct = opp.instantProfitPercent !== null ? `${opp.instantProfitPercent.toFixed(1)}%` : '-'

			// Undercut sell columns
			const undercutSell = opp.undercutSellPrice !== null ? formatSilver(opp.undercutSellPrice) : '-'
			const undercutProfit = opp.undercutProfit !== null ? formatSilver(opp.undercutProfit) : '-'
			const undercutPct = opp.undercutProfitPercent !== null ? `${opp.undercutProfitPercent.toFixed(1)}%` : '-'

			lines.push(
				`│ ${itemDisplay.padEnd(itemW)}${qualStr.padEnd(qualW)}${opp.buyCity.padEnd(cityW)}${formatSilver(opp.buyPrice).padEnd(priceW)}${opp.sellCity.padEnd(cityW - 1)}│ ${instantSell.padEnd(sellW)}${instantProfit.padEnd(profitW)}${instantPct.padEnd(pctW - 1)}│ ${undercutSell.padEnd(sellW)}${undercutProfit.padEnd(profitW)}${undercutPct.padEnd(pctW - 1)}│ ${avgStr.padEnd(avgW)}${volStr.padEnd(volW)}${ageStr.padEnd(ageW - 1)}│`,
			)
		}

		if (filteredOpps.length > 40) {
			lines.push(
				`│ ${`... and ${filteredOpps.length - 40} more opportunities`.padEnd(W - 2)} │`,
			)
		}
	}

	// Footer
	lines.push(`├${'─'.repeat(W)}┤`)
	const lastScanStr = state.lastScan
		? `Last scan: ${formatTimeAgo(state.lastScan)}`
		: 'Last scan: Never'
	const blackMarketStr = state.excludeBlackMarket ? 'Black Market: OFF' : 'Black Market: ON'
	const sortByStr = `Sort: ${state.sortBy}`
	const maxAgeStr = state.maxAgeMinutes >= 60
		? `Max age: ${Math.round(state.maxAgeMinutes / 60)}h`
		: `Max age: ${state.maxAgeMinutes}min`
	lines.push(
		`│ ${lastScanStr.padEnd(W / 4)}${blackMarketStr.padEnd(W / 4)}${sortByStr.padEnd(W / 4)}${maxAgeStr.padEnd(W / 4 - 2)} │`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(
		`│ ${`[r] refresh | [b] Black Market | [t] toggle sort | [s] new search | [q] quit`.padEnd(W - 2)} │`,
	)
	lines.push(`└${'─'.repeat(W)}┘`)

	console.log(lines.join('\n'))
}

// ============================================================================
// INPUT HANDLING
// ============================================================================

function waitForKeypress(state: ArbitrageScannerState): Promise<void> {
	return new Promise((resolve) => {
		process.stdin.setRawMode(true)
		process.stdin.resume()

		const onKeypress = async (key: Buffer) => {
			const char = key.toString()

			// Ctrl+C
			if (char === '\u0003') {
				cleanup()
				shutdown(state)
				return
			}

			// 'r' for refresh
			if (char === 'r' || char === 'R') {
				await scanForArbitrage(state)
				showDashboard(state)
				return
			}

			// 'b' to toggle Black Market
			if (char === 'b' || char === 'B') {
				state.excludeBlackMarket = !state.excludeBlackMarket
				showDashboard(state)
				return
			}

			// 't' to toggle sort
			if (char === 't' || char === 'T') {
				state.sortBy = state.sortBy === 'instant' ? 'undercut' : 'instant'
				state.opportunities = sortOpportunities(state.opportunities, state.sortBy)
				showDashboard(state)
				return
			}

			// 's' for new search
			if (char === 's' || char === 'S') {
				cleanup()
				stopScanner(state)
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

function formatVolume(volume: number): string {
	if (volume === 0) return '-'
	if (volume >= 1_000) return (volume / 1_000).toFixed(1) + 'K'
	return String(volume)
}

function formatTimeAgo(date: Date): string {
	const s = Math.floor((Date.now() - date.getTime()) / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	return `${Math.floor(m / 60)}h ${m % 60}m ago`
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str
	return str.slice(0, maxLen - 1) + '…'
}

function formatDataAge(minutes: number): string {
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const mins = minutes % 60
	if (mins === 0) return `${hours}h`
	return `${hours}h${mins}m`
}

// ============================================================================
// ITEM NAME FORMATTING
// ============================================================================

// Tier prefixes in item names that we want to replace with TN.M notation
const TIER_PREFIXES: Record<string, number> = {
	"Beginner's": 1,
	"Novice's": 2,
	"Journeyman's": 3,
	"Adept's": 4,
	"Expert's": 5,
	"Master's": 6,
	"Grandmaster's": 7,
	"Elder's": 8,
}

/**
 * Parse item ID to extract tier and enchantment
 * e.g., "T4_2H_BOW@2" -> { tier: 4, enchant: 2 }
 */
function parseItemId(itemId: string): { tier: number; enchant: number } | null {
	const match = itemId.match(/^T(\d+)_.+?(?:@(\d+))?$/)
	if (!match) return null
	return {
		tier: parseInt(match[1], 10),
		enchant: match[2] ? parseInt(match[2], 10) : 0,
	}
}

// Quality suffixes in item names that we want to remove (displayed in separate column)
const QUALITY_SUFFIXES = [
	' (Uncommon)',
	' (Rare)',
	' (Exceptional)',
	' (Excellent)',
	' (Masterpiece)',
]

/**
 * Format item name with TN.M notation instead of tier prefix
 * Also removes quality suffixes like "(Uncommon)", "(Rare)", etc.
 * e.g., "Adept's Bow (Uncommon)" with id "T4_2H_BOW@2" -> "T4.2 Bow"
 */
function formatItemDisplayName(itemId: string, itemName: string): string {
	const parsed = parseItemId(itemId)
	if (!parsed) return itemName

	let name = itemName

	// Remove quality suffix if present
	for (const suffix of QUALITY_SUFFIXES) {
		if (name.endsWith(suffix)) {
			name = name.slice(0, -suffix.length)
			break
		}
	}

	// Try to remove tier prefix from name
	for (const [prefix, _tier] of Object.entries(TIER_PREFIXES)) {
		if (name.startsWith(prefix + ' ')) {
			const baseName = name.slice(prefix.length + 1)
			return `T${parsed.tier}.${parsed.enchant} ${baseName}`
		}
	}

	// No tier prefix found, just prepend tier notation
	return `T${parsed.tier}.${parsed.enchant} ${name}`
}
