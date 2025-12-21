import { db } from './db'
import { ITEMS_BY_ID } from './constants/items'

// ============================================================================
// TYPES
// ============================================================================

interface ItemStats {
	itemId: string
	avgPrice: number
	minPrice: number
	maxPrice: number
	dataPoints: number
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const REFRESH_INTERVAL = 1000 // 1 second
const ITEMS_TO_DISPLAY = 20

// ============================================================================
// ENTRY POINT
// ============================================================================

if (require.main === module) {
	main()
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
	const shutdown = () => {
		console.clear()
		console.log('Visualizer stopped.')
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	// Initial render
	showDashboard()

	// Update every second
	setInterval(showDashboard, REFRESH_INTERVAL)

	// Keep process alive
	await new Promise(() => {})
}

// ============================================================================
// DATA QUERIES
// ============================================================================

/**
 * Get all items with their 30-day average, min, and max price
 */
function getItemStats(): ItemStats[] {
	const rows = db
		.prepare(
			`
			SELECT
				item_id,
				AVG(avg_price) as mean_price,
				MIN(avg_price) as min_price,
				MAX(avg_price) as max_price,
				COUNT(*) as data_points
			FROM daily_price_averages
			WHERE date >= date('now', '-30 days')
			GROUP BY item_id
			HAVING data_points >= 5
			ORDER BY mean_price DESC
		`,
		)
		.all() as Array<{
		item_id: string
		mean_price: number
		min_price: number
		max_price: number
		data_points: number
	}>

	return rows.slice(0, ITEMS_TO_DISPLAY).map((row) => ({
		itemId: row.item_id,
		avgPrice: Math.round(row.mean_price),
		minPrice: Math.round(row.min_price),
		maxPrice: Math.round(row.max_price),
		dataPoints: row.data_points,
	}))
}

// ============================================================================
// RENDERING
// ============================================================================

function showDashboard(): void {
	const stats = getItemStats()

	// Clear screen and move cursor to top
	process.stdout.write('\x1B[H\x1B[J')

	const lines: string[] = []
	const tableWidth = 100

	// Header
	lines.push('┌' + '─'.repeat(tableWidth) + '┐')
	lines.push(
		'│' + centerText('📈 PROFIT OPPORTUNITY VISUALIZER', tableWidth) + '│',
	)
	lines.push(
		'│' +
			centerText(
				`Updated: ${new Date().toLocaleTimeString()} | Items: ${stats.length}`,
				tableWidth,
			) +
			'│',
	)
	lines.push('├' + '─'.repeat(tableWidth) + '┤')

	if (stats.length === 0) {
		lines.push(
			'│' +
				centerText('No data available. Run the collector first.', tableWidth) +
				'│',
		)
		lines.push('└' + '─'.repeat(tableWidth) + '┘')
		console.log(lines.join('\n'))
		return
	}

	// Table header
	const colItem = 40
	const colAvg = 10
	const colMin = 10
	const colMax = 10

	const headerContent =
		'Item'.padEnd(colItem) +
		'Avg Price'.padStart(colAvg) +
		'Min %'.padStart(colMin) +
		'Max %'.padStart(colMax)
	const headerRow = '│ ' + headerContent.padEnd(tableWidth - 2) + ' │'
	lines.push(headerRow)
	lines.push('├' + '─'.repeat(tableWidth) + '┤')

	// Data rows
	for (const stat of stats) {
		const itemEntry = ITEMS_BY_ID.get(stat.itemId)
		const itemName = truncateText(itemEntry?.name ?? stat.itemId, colItem - 1)
		const avgPrice = formatNumber(stat.avgPrice)
		const minPct =
			stat.avgPrice > 0
				? ((stat.minPrice - stat.avgPrice) / stat.avgPrice) * 100
				: 0
		const maxPct =
			stat.avgPrice > 0
				? ((stat.maxPrice - stat.avgPrice) / stat.avgPrice) * 100
				: 0
		const minPrice = formatPercent(minPct)
		const maxPrice = formatPercent(maxPct)

		const rowContent =
			itemName.padEnd(colItem) +
			avgPrice.padStart(colAvg) +
			minPrice.padStart(colMin) +
			maxPrice.padStart(colMax)
		const row = '│ ' + rowContent.padEnd(tableWidth - 2) + ' │'
		lines.push(row)
	}

	// Footer
	lines.push('├' + '─'.repeat(tableWidth) + '┤')
	lines.push(
		'│' +
			centerText('Sorted by average price (highest first)', tableWidth) +
			'│',
	)
	lines.push('│' + centerText('[Ctrl+C] Quit', tableWidth) + '│')
	lines.push('└' + '─'.repeat(tableWidth) + '┘')

	console.log(lines.join('\n'))
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

function centerText(text: string, width: number): string {
	const padding = Math.max(0, width - text.length)
	const leftPad = Math.floor(padding / 2)
	const rightPad = padding - leftPad
	return ' '.repeat(leftPad) + text + ' '.repeat(rightPad)
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text
	return text.slice(0, maxLength - 3) + '...'
}

function formatNumber(num: number): string {
	if (num >= 1000000) {
		return (num / 1000000).toFixed(1) + 'M'
	}
	if (num >= 1000) {
		return (num / 1000).toFixed(1) + 'K'
	}
	return num.toLocaleString()
}

function formatPercent(pct: number): string {
	const sign = pct >= 0 ? '+' : ''
	return sign + pct.toFixed(1) + '%'
}
