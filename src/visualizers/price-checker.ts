import 'dotenv/config'
import { db } from '../db'

// ============================================================================
// TYPES
// ============================================================================

type PriceCheckerState = {
	startTime: number
	running: boolean

	// Timers
	dashboardTimer: NodeJS.Timeout | null
	priceRefreshTimer: NodeJS.Timeout | null

	// Search
	searchQuery: string | null
	searchResults: CityPrice[]
	lastRefresh: Date | null
}

type CityPrice = {
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

const DASHBOARD_REFRESH_MS = 1000 // 1 second
const PRICE_REFRESH_MS = 10_000 // 10 seconds

// ============================================================================
// ENTRY POINT
// ============================================================================

main()

async function main(): Promise<void> {
	const itemId = process.argv[2]
	if (!itemId) {
		console.log('Usage: npm run price-checker <ITEM_ID>')
		console.log('Example: npm run price-checker T4_BAG')
		process.exit(1)
	}

	const state: PriceCheckerState = {
		startTime: Date.now(),
		running: false,

		// Timers
		dashboardTimer: null,
		priceRefreshTimer: null,

		// Search
		searchQuery: itemId,
		searchResults: [],
		lastRefresh: null,
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	await startPriceChecker(state)
}

function shutdown(state: PriceCheckerState): void {
	if (!state.running) return
	state.running = false

	if (state.dashboardTimer) clearInterval(state.dashboardTimer)
	if (state.priceRefreshTimer) clearInterval(state.priceRefreshTimer)

	console.log('\nPrice checker stopped.')
	process.exit(0)
}

// ============================================================================
// PRICE CHECKER LIFECYCLE
// ============================================================================

async function startPriceChecker(state: PriceCheckerState): Promise<void> {
	state.running = true
	state.startTime = Date.now()

	// Initial data fetch
	refreshPrices(state)

	// Start dashboard
	showDashboard(state)
	state.dashboardTimer = setInterval(
		() => showDashboard(state),
		DASHBOARD_REFRESH_MS,
	)

	// Periodic price refresh
	state.priceRefreshTimer = setInterval(
		() => refreshPrices(state),
		PRICE_REFRESH_MS,
	)
}

// ============================================================================
// DATA FUNCTIONS
// ============================================================================

function refreshPrices(state: PriceCheckerState): void {
	if (!state.searchQuery) return

	const results = db
		.prepare(
			`
			SELECT
				city,
				quality,
				sell_price_min as sellPrice,
				sell_price_min_date as sellDate,
				buy_price_max as buyPrice,
				buy_price_max_date as buyDate
			FROM latest_prices
			WHERE item_id = ?
			ORDER BY sell_price_min ASC
		`,
		)
		.all(state.searchQuery) as CityPrice[]

	state.searchResults = results
	state.lastRefresh = new Date()
}

// ============================================================================
// DASHBOARD
// ============================================================================

function showDashboard(state: PriceCheckerState): void {
	console.clear()

	const uptime = formatDuration(Date.now() - state.startTime)

	const W = 90
	const lines: string[] = []

	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${`ALBION PRICE CHECKER`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`🔍 Item: ${state.searchQuery || 'None'}`.padEnd(W / 2)}${`⚡ Uptime: ${uptime}`.padEnd(W / 2 - 2)} │`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	if (state.searchResults.length === 0) {
		lines.push(`│ ${`No prices found for this item`.padEnd(W - 2)} │`)
	} else {
		// Header
		lines.push(
			`│ ${`City`.padEnd(20)}${`Quality`.padEnd(10)}${`Sell Price`.padEnd(15)}${`Buy Price`.padEnd(15)}${`Last Updated`.padEnd(W - 62)} │`,
		)
		lines.push(`├${'─'.repeat(W)}┤`)

		// Results sorted by sell price
		for (const row of state.searchResults.slice(0, 15)) {
			const sellStr = row.sellPrice > 0 ? formatSilver(row.sellPrice) : '-'
			const buyStr = row.buyPrice > 0 ? formatSilver(row.buyPrice) : '-'
			const dateStr = row.sellDate
				? formatTimeAgo(new Date(row.sellDate))
				: 'N/A'

			lines.push(
				`│ ${row.city.padEnd(20)}${`Q${row.quality}`.padEnd(10)}${sellStr.padEnd(15)}${buyStr.padEnd(15)}${dateStr.padEnd(W - 62)} │`,
			)
		}
	}

	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(
		`│ ${`Last refresh: ${state.lastRefresh ? formatTimeAgo(state.lastRefresh) : 'Never'}`.padEnd(W / 2)}${`Next refresh: ${formatDuration(PRICE_REFRESH_MS)}`.padEnd(W / 2 - 2)} │`,
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
