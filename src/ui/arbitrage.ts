import 'dotenv/config'

// ============================================================================
// TYPES
// ============================================================================

type ArbitrageUIState = {
	startTime: number
	running: boolean

	// Timers
	renderTimer: NodeJS.Timeout | null

	// Results (populated by strategy layer)
	opportunities: ArbitrageOpportunity[]
	lastCalculation: Date | null
	isCalculating: boolean
}

// TODO: Import this from strategies layer
type ArbitrageOpportunity = {
	itemId: string
	itemName: string
	buyCity: string
	sellCity: string
	buyPrice: number
	sellPrice: number
	profit: number
	profitPercent: number
}

// ============================================================================
// STATE
// ============================================================================

const state: ArbitrageUIState = {
	startTime: Date.now(),
	running: false,

	renderTimer: null,

	opportunities: [],
	lastCalculation: null,
	isCalculating: false,
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main()

async function main(): Promise<void> {
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	state.running = true
	state.startTime = Date.now()

	// Initial calculation
	await recalculate()

	// Start render loop (1 second interval)
	state.renderTimer = setInterval(render, 1000)
	render()

	// Handle keypresses
	await handleInput()
}

function shutdown(): void {
	if (!state.running) process.exit(0)
	state.running = false

	if (state.renderTimer) clearInterval(state.renderTimer)

	console.clear()
	console.log('Arbitrage scanner stopped.')
	process.exit(0)
}

// ============================================================================
// CALCULATION (calls strategy layer)
// ============================================================================

async function recalculate(): Promise<void> {
	state.isCalculating = true
	render()

	// TODO: Call strategy layer here
	// const opportunities = await findArbitrageOpportunities(...)
	// state.opportunities = opportunities

	// Simulate work for now
	await new Promise((resolve) => setTimeout(resolve, 500))
	state.opportunities = []

	state.lastCalculation = new Date()
	state.isCalculating = false
}

// ============================================================================
// RENDER (pure display, no side effects)
// ============================================================================

function render(): void {
	console.clear()

	const uptime = formatDuration(Date.now() - state.startTime)
	const W = 120
	const lines: string[] = []

	// Header
	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${'ALBION ARBITRAGE SCANNER'.padEnd(W - 2)} │`)
	lines.push(`│ ${`Uptime: ${uptime}`.padEnd(W / 2)}${`Found: ${state.opportunities.length} opportunities`.padEnd(W / 2 - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Status
	if (state.isCalculating) {
		lines.push(`│ ${'Calculating...'.padEnd(W - 2)} │`)
		lines.push(`├${'─'.repeat(W)}┤`)
	}

	// Results
	if (state.opportunities.length === 0 && !state.isCalculating) {
		lines.push(`│ ${'No opportunities found. Press [r] to refresh.'.padEnd(W - 2)} │`)
	} else {
		for (const opp of state.opportunities.slice(0, 30)) {
			const line = `${opp.itemName} | Buy: ${opp.buyCity} @ ${opp.buyPrice} | Sell: ${opp.sellCity} @ ${opp.sellPrice} | Profit: ${opp.profit} (${opp.profitPercent.toFixed(1)}%)`
			lines.push(`│ ${line.padEnd(W - 2)} │`)
		}
	}

	// Footer
	lines.push(`├${'─'.repeat(W)}┤`)
	const lastCalc = state.lastCalculation
		? `Last calculation: ${formatTimeAgo(state.lastCalculation)}`
		: 'Last calculation: Never'
	lines.push(`│ ${lastCalc.padEnd(W - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(`│ ${`[r] refresh | [q] quit`.padEnd(W - 2)} │`)
	lines.push(`└${'─'.repeat(W)}┘`)

	console.log(lines.join('\n'))
}

// ============================================================================
// INPUT HANDLING
// ============================================================================

function handleInput(): Promise<void> {
	return new Promise((resolve) => {
		process.stdin.setRawMode(true)
		process.stdin.resume()

		const onKeypress = async (key: Buffer) => {
			const char = key.toString()

			// Ctrl+C
			if (char === '\u0003') {
				cleanup()
				shutdown()
				return
			}

			// 'r' for refresh
			if (char === 'r' || char === 'R') {
				await recalculate()
				render()
				return
			}

			// 'q' for quit
			if (char === 'q' || char === 'Q') {
				cleanup()
				shutdown()
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
// FORMATTING HELPERS
// ============================================================================

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	const m = Math.floor(s / 60)
	const h = Math.floor(m / 60)
	if (h > 0) return `${h}h ${m % 60}m`
	if (m > 0) return `${m}m ${s % 60}s`
	return `${s}s`
}

function formatTimeAgo(date: Date): string {
	const s = Math.floor((Date.now() - date.getTime()) / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	return `${Math.floor(m / 60)}h ${m % 60}m ago`
}
