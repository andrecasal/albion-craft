import { db } from './db'

// ============================================================================
// TYPES
// ============================================================================

type VisualizerState = {
	startTime: number
	tick: number
	dashboardTimer: NodeJS.Timeout | null
	topProducts: TopProduct[]
}

type TopProduct = {
	item_id: string
	avg_price: number
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const DASHBOARD_REFRESH_MS = 1000
const DATA_REFRESH_MS = 10000

// ============================================================================
// ENTRY POINT
// ============================================================================

main()

function main(): void {
	const state: VisualizerState = {
		startTime: Date.now(),
		tick: 0,
		dashboardTimer: null,
		topProducts: [],
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	startVisualizer(state)
}

function shutdown(state: VisualizerState): void {
	if (state.dashboardTimer) clearInterval(state.dashboardTimer)
	console.log('\nVisualizer stopped.')
	process.exit(0)
}

// ============================================================================
// VISUALIZER LIFECYCLE
// ============================================================================

function startVisualizer(state: VisualizerState): void {
	refreshData(state)
	setInterval(() => refreshData(state), DATA_REFRESH_MS)
	
	showDashboard(state)
	state.dashboardTimer = setInterval(() => showDashboard(state), DASHBOARD_REFRESH_MS)
}

// ============================================================================
// DATA REFRESH
// ============================================================================

function refreshData(state: VisualizerState): void {
	state.topProducts = getTopProductsByAvgPrice()
}

function getTopProductsByAvgPrice(): TopProduct[] {
	const thirtyDaysAgo = new Date()
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
	const cutoff = thirtyDaysAgo.toISOString().split('T')[0]

	return db
		.prepare(
			`
			SELECT item_id, CAST(AVG(avg_price) AS INTEGER) as avg_price
			FROM daily_average_prices
			WHERE timestamp >= ?
			GROUP BY item_id
			ORDER BY avg_price DESC
			LIMIT 10
		`,
		)
		.all(cutoff) as TopProduct[]
}

// ============================================================================
// DASHBOARD
// ============================================================================

function showDashboard(state: VisualizerState): void {
	state.tick++
	console.clear()

	const W = 60
	const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][state.tick % 10]
	const lines: string[] = []

	const uptime = formatDuration(Date.now() - state.startTime)

	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${spinner} TOP 10 PRODUCTS BY AVG PRICE (30 days)${`⏱ ${uptime}`.padStart(W - 43)}│`)
	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(`│${'#'.padStart(4)}  ${'ITEM'.padEnd(35)}  ${'AVG PRICE'.padStart(15)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	for (let i = 0; i < state.topProducts.length; i++) {
		const p = state.topProducts[i]
		const rank = String(i + 1).padStart(4)
		const name = p.item_id.slice(0, 35).padEnd(35)
		const price = formatPrice(p.avg_price).padStart(15)
		lines.push(`│${rank}  ${name}  ${price} │`)
	}

	if (state.topProducts.length === 0) {
		lines.push(`│${'No data available'.padStart((W + 17) / 2).padEnd(W)}│`)
	}

	lines.push(`└${'─'.repeat(W)}┘`)

	console.log(lines.join('\n'))
}

// ============================================================================
// FORMATTING
// ============================================================================

function formatPrice(price: number): string {
	return price.toLocaleString() + ' silver'
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	const m = Math.floor(s / 60)
	const h = Math.floor(m / 60)
	if (h > 0) return `${h}h ${m % 60}m`
	if (m > 0) return `${m}m ${s % 60}s`
	return `${s}s`
}
