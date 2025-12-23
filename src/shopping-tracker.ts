import 'dotenv/config'
import { db } from './db'

// ============================================================================
// TYPES
// ============================================================================

type ShoppingTrackerState = {
	startTime: number
	running: boolean

	// Timers
	dashboardTimer: NodeJS.Timeout | null
	priceCheckTimer: NodeJS.Timeout | null

	// Watchlist
	watchlist: WatchlistItem[]
	alerts: Alert[]
	lastCheck: Date | null
}

type WatchlistItem = {
	itemId: string
	targetPrice: number
	preferredCity: string | null
}

type Alert = {
	itemId: string
	city: string
	currentPrice: number
	targetPrice: number
	triggeredAt: Date
}

type PriceRow = {
	city: string
	sellPrice: number
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const DASHBOARD_REFRESH_MS = 1000 // 1 second
const PRICE_CHECK_MS = 30_000 // 30 seconds

// ============================================================================
// ENTRY POINT
// ============================================================================

main()

async function main(): Promise<void> {
	const state: ShoppingTrackerState = {
		startTime: Date.now(),
		running: false,

		// Timers
		dashboardTimer: null,
		priceCheckTimer: null,

		// Watchlist
		watchlist: loadWatchlist(),
		alerts: [],
		lastCheck: null,
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	await startShoppingTracker(state)
}

function shutdown(state: ShoppingTrackerState): void {
	if (!state.running) return
	state.running = false

	if (state.dashboardTimer) clearInterval(state.dashboardTimer)
	if (state.priceCheckTimer) clearInterval(state.priceCheckTimer)

	console.log('\nShopping tracker stopped.')
	process.exit(0)
}

// ============================================================================
// SHOPPING TRACKER LIFECYCLE
// ============================================================================

async function startShoppingTracker(state: ShoppingTrackerState): Promise<void> {
	state.running = true
	state.startTime = Date.now()

	// Initial price check
	checkPrices(state)

	// Start dashboard
	showDashboard(state)
	state.dashboardTimer = setInterval(
		() => showDashboard(state),
		DASHBOARD_REFRESH_MS,
	)

	// Periodic price checks
	state.priceCheckTimer = setInterval(
		() => checkPrices(state),
		PRICE_CHECK_MS,
	)
}

// ============================================================================
// WATCHLIST MANAGEMENT
// ============================================================================

function loadWatchlist(): WatchlistItem[] {
	// TODO: Load from persistent storage (file or database)
	// For now, return empty array - users will add items via commands
	return []
}

function saveWatchlist(_watchlist: WatchlistItem[]): void {
	// TODO: Persist watchlist to storage
}

function addToWatchlist(
	state: ShoppingTrackerState,
	itemId: string,
	targetPrice: number,
	preferredCity: string | null = null,
): void {
	state.watchlist.push({ itemId, targetPrice, preferredCity })
	saveWatchlist(state.watchlist)
}

function removeFromWatchlist(
	state: ShoppingTrackerState,
	itemId: string,
): void {
	state.watchlist = state.watchlist.filter((item) => item.itemId !== itemId)
	saveWatchlist(state.watchlist)
}

// ============================================================================
// PRICE CHECKING
// ============================================================================

function checkPrices(state: ShoppingTrackerState): void {
	const newAlerts: Alert[] = []

	for (const item of state.watchlist) {
		const prices = db
			.prepare(
				`
				SELECT city, sell_price_min as sellPrice
				FROM latest_prices
				WHERE item_id = ? AND sell_price_min > 0
				ORDER BY sell_price_min ASC
			`,
			)
			.all(item.itemId) as PriceRow[]

		for (const price of prices) {
			// Skip if preferred city specified and this isn't it
			if (item.preferredCity && price.city !== item.preferredCity) continue

			if (price.sellPrice <= item.targetPrice) {
				// Check if we already have this alert
				const existing = state.alerts.find(
					(a) => a.itemId === item.itemId && a.city === price.city,
				)

				if (!existing) {
					newAlerts.push({
						itemId: item.itemId,
						city: price.city,
						currentPrice: price.sellPrice,
						targetPrice: item.targetPrice,
						triggeredAt: new Date(),
					})
				}
			}
		}
	}

	// Add new alerts
	state.alerts.push(...newAlerts)

	// Ring the bell for new alerts
	if (newAlerts.length > 0) {
		process.stdout.write('\x07') // Terminal bell
	}

	state.lastCheck = new Date()
}

// ============================================================================
// DASHBOARD
// ============================================================================

function showDashboard(state: ShoppingTrackerState): void {
	console.clear()

	const uptime = formatDuration(Date.now() - state.startTime)

	const W = 100
	const lines: string[] = []

	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${`ALBION SHOPPING TRACKER`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`📋 Watching: ${state.watchlist.length} items`.padEnd(W / 3)}${`🔔 Alerts: ${state.alerts.length}`.padEnd(W / 3)}${`⚡ Uptime: ${uptime}`.padEnd(W / 3 - 2)} │`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Watchlist section
	lines.push(`│ ${`📋 WATCHLIST`.padEnd(W - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	if (state.watchlist.length === 0) {
		lines.push(`│ ${`No items in watchlist. Add items to start tracking.`.padEnd(W - 2)} │`)
	} else {
		lines.push(
			`│ ${`Item`.padEnd(30)}${`Target Price`.padEnd(20)}${`Preferred City`.padEnd(20)}${`Best Current`.padEnd(W - 72)} │`,
		)
		lines.push(`├${'─'.repeat(W)}┤`)

		for (const item of state.watchlist.slice(0, 10)) {
			const bestPrice = getBestPrice(item.itemId, item.preferredCity)
			const bestStr = bestPrice
				? `${formatSilver(bestPrice.price)} @ ${bestPrice.city}`
				: 'No data'
			const priceStatus = bestPrice && bestPrice.price <= item.targetPrice ? '✅' : '⏳'

			lines.push(
				`│ ${item.itemId.padEnd(30)}${formatSilver(item.targetPrice).padEnd(20)}${(item.preferredCity || 'Any').padEnd(20)}${`${priceStatus} ${bestStr}`.padEnd(W - 72)} │`,
			)
		}
	}

	lines.push(`├${'─'.repeat(W)}┤`)

	// Alerts section
	lines.push(`│ ${`🔔 ACTIVE ALERTS`.padEnd(W - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	if (state.alerts.length === 0) {
		lines.push(`│ ${`No price alerts triggered.`.padEnd(W - 2)} │`)
	} else {
		for (const alert of state.alerts.slice(0, 5)) {
			const savings = alert.targetPrice - alert.currentPrice
			lines.push(
				`│ ${`🎯 ${alert.itemId} in ${alert.city}: ${formatSilver(alert.currentPrice)} (save ${formatSilver(savings)}) - ${formatTimeAgo(alert.triggeredAt)}`.padEnd(W - 2)} │`,
			)
		}
	}

	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(
		`│ ${`Last check: ${state.lastCheck ? formatTimeAgo(state.lastCheck) : 'Never'}`.padEnd(W / 2)}${`Next check: in ${formatDuration(PRICE_CHECK_MS)}`.padEnd(W / 2 - 2)} │`,
	)
	lines.push(`└${'─'.repeat(W)}┘`)

	console.log(lines.join('\n'))
}

function getBestPrice(
	itemId: string,
	preferredCity: string | null,
): { price: number; city: string } | null {
	const query = preferredCity
		? `SELECT city, sell_price_min as price FROM latest_prices WHERE item_id = ? AND city = ? AND sell_price_min > 0 ORDER BY sell_price_min ASC LIMIT 1`
		: `SELECT city, sell_price_min as price FROM latest_prices WHERE item_id = ? AND sell_price_min > 0 ORDER BY sell_price_min ASC LIMIT 1`

	const params = preferredCity ? [itemId, preferredCity] : [itemId]
	const result = db.prepare(query).get(...params) as
		| { price: number; city: string }
		| undefined

	return result || null
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

// Export for external use (adding items programmatically)
export { addToWatchlist, removeFromWatchlist }
