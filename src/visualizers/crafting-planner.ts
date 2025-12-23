import 'dotenv/config'
import { db } from '../db'

// ============================================================================
// TYPES
// ============================================================================

type CraftingPlannerState = {
	startTime: number
	running: boolean

	// Timers
	dashboardTimer: NodeJS.Timeout | null
	analysisTimer: NodeJS.Timeout | null

	// Planning
	targetItem: string | null
	targetQuantity: number
	craftingCity: string | null

	// Analysis results
	materialCosts: MaterialCost[]
	demandAnalysis: DemandAnalysis | null
	profitability: Profitability | null
	executionPlan: ExecutionStep[]
	lastAnalysis: Date | null
}

type MaterialCost = {
	itemId: string
	quantity: number
	bestCity: string
	bestPrice: number
	totalCost: number
	availability: number // How many available at this price
}

type DemandAnalysis = {
	avgDailyVolume: number
	priceVolatility: number
	demandTrend: 'rising' | 'stable' | 'falling'
	recommendedSellCity: string
	expectedSellPrice: number
}

type Profitability = {
	totalMaterialCost: number
	expectedRevenue: number
	estimatedProfit: number
	profitMargin: number
	returnMultiplier: number
}

type ExecutionStep = {
	step: number
	action: 'buy' | 'craft' | 'sell' | 'transport'
	itemId: string
	quantity: number
	city: string
	estimatedCost: number
	notes: string
}

type PriceRow = {
	city: string
	sellPrice: number
	amount: number
}

type DailyRow = {
	item_count: number
	avg_price: number
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const DASHBOARD_REFRESH_MS = 1000 // 1 second
const ANALYSIS_REFRESH_MS = 60_000 // 1 minute

// ============================================================================
// ENTRY POINT
// ============================================================================

main()

async function main(): Promise<void> {
	const targetItem = process.argv[2]
	const targetQuantity = parseInt(process.argv[3] || '1', 10)
	const craftingCity = process.argv[4] || null

	if (!targetItem) {
		console.log('Usage: npm run crafting-planner <ITEM_ID> [QUANTITY] [CRAFTING_CITY]')
		console.log('Example: npm run crafting-planner T4_BAG 10 Bridgewatch')
		process.exit(1)
	}

	const state: CraftingPlannerState = {
		startTime: Date.now(),
		running: false,

		// Timers
		dashboardTimer: null,
		analysisTimer: null,

		// Planning
		targetItem,
		targetQuantity,
		craftingCity,

		// Analysis
		materialCosts: [],
		demandAnalysis: null,
		profitability: null,
		executionPlan: [],
		lastAnalysis: null,
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	await startCraftingPlanner(state)
}

function shutdown(state: CraftingPlannerState): void {
	if (!state.running) return
	state.running = false

	if (state.dashboardTimer) clearInterval(state.dashboardTimer)
	if (state.analysisTimer) clearInterval(state.analysisTimer)

	console.log('\nCrafting planner stopped.')
	process.exit(0)
}

// ============================================================================
// CRAFTING PLANNER LIFECYCLE
// ============================================================================

async function startCraftingPlanner(state: CraftingPlannerState): Promise<void> {
	state.running = true
	state.startTime = Date.now()

	// Initial analysis
	runAnalysis(state)

	// Start dashboard
	showDashboard(state)
	state.dashboardTimer = setInterval(
		() => showDashboard(state),
		DASHBOARD_REFRESH_MS,
	)

	// Periodic analysis refresh
	state.analysisTimer = setInterval(
		() => runAnalysis(state),
		ANALYSIS_REFRESH_MS,
	)
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

function runAnalysis(state: CraftingPlannerState): void {
	if (!state.targetItem) return

	// TODO: Integrate with recipes.json to get material requirements
	analyzeMaterialCosts(state)
	analyzeDemand(state)
	calculateProfitability(state)
	generateExecutionPlan(state)

	state.lastAnalysis = new Date()
}

function analyzeMaterialCosts(state: CraftingPlannerState): void {
	// TODO: Look up recipe for targetItem and calculate material costs
	// For now, just show the target item's prices as a placeholder
	const prices = db
		.prepare(
			`
			SELECT
				city,
				sell_price_min as sellPrice,
				1 as amount
			FROM latest_prices
			WHERE item_id = ? AND sell_price_min > 0
			ORDER BY sell_price_min ASC
			LIMIT 1
		`,
		)
		.all(state.targetItem) as PriceRow[]

	state.materialCosts = prices.map((p) => ({
		itemId: state.targetItem!,
		quantity: state.targetQuantity,
		bestCity: p.city,
		bestPrice: p.sellPrice,
		totalCost: p.sellPrice * state.targetQuantity,
		availability: p.amount,
	}))
}

function analyzeDemand(state: CraftingPlannerState): void {
	// Calculate average daily volume from historical data
	const history = db
		.prepare(
			`
			SELECT item_count, avg_price
			FROM daily_average_prices
			WHERE item_id = ?
			ORDER BY timestamp DESC
			LIMIT 30
		`,
		)
		.all(state.targetItem) as DailyRow[]

	if (history.length === 0) {
		state.demandAnalysis = null
		return
	}

	const volumes = history.map((h) => h.item_count)
	const prices = history.map((h) => h.avg_price)

	const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length
	const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length

	// Calculate price volatility (standard deviation / mean)
	const priceVariance =
		prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length
	const volatility = Math.sqrt(priceVariance) / avgPrice

	// Determine trend from recent vs older prices
	const recentAvg =
		prices.slice(0, 7).reduce((a, b) => a + b, 0) / Math.min(7, prices.length)
	const olderAvg =
		prices.slice(7).reduce((a, b) => a + b, 0) /
		Math.max(1, prices.length - 7)

	let trend: 'rising' | 'stable' | 'falling' = 'stable'
	if (recentAvg > olderAvg * 1.05) trend = 'rising'
	else if (recentAvg < olderAvg * 0.95) trend = 'falling'

	// Find best sell city
	const sellPrices = db
		.prepare(
			`
			SELECT city, sell_price_min as price
			FROM latest_prices
			WHERE item_id = ? AND sell_price_min > 0
			ORDER BY sell_price_min DESC
			LIMIT 1
		`,
		)
		.get(state.targetItem) as { city: string; price: number } | undefined

	state.demandAnalysis = {
		avgDailyVolume: avgVolume,
		priceVolatility: volatility,
		demandTrend: trend,
		recommendedSellCity: sellPrices?.city || 'Unknown',
		expectedSellPrice: sellPrices?.price || avgPrice,
	}
}

function calculateProfitability(state: CraftingPlannerState): void {
	if (!state.demandAnalysis || state.materialCosts.length === 0) {
		state.profitability = null
		return
	}

	const totalCost = state.materialCosts.reduce((sum, m) => sum + m.totalCost, 0)
	const revenue = state.demandAnalysis.expectedSellPrice * state.targetQuantity
	const profit = revenue - totalCost

	state.profitability = {
		totalMaterialCost: totalCost,
		expectedRevenue: revenue,
		estimatedProfit: profit,
		profitMargin: totalCost > 0 ? (profit / totalCost) * 100 : 0,
		returnMultiplier: totalCost > 0 ? revenue / totalCost : 0,
	}
}

function generateExecutionPlan(state: CraftingPlannerState): void {
	const steps: ExecutionStep[] = []
	let stepNum = 1

	// Buy materials
	for (const material of state.materialCosts) {
		steps.push({
			step: stepNum++,
			action: 'buy',
			itemId: material.itemId,
			quantity: material.quantity,
			city: material.bestCity,
			estimatedCost: material.totalCost,
			notes: `Best price: ${formatSilver(material.bestPrice)} each`,
		})
	}

	// Transport if needed
	if (
		state.craftingCity &&
		state.materialCosts.some((m) => m.bestCity !== state.craftingCity)
	) {
		steps.push({
			step: stepNum++,
			action: 'transport',
			itemId: 'materials',
			quantity: state.targetQuantity,
			city: state.craftingCity,
			estimatedCost: 0, // TODO: Calculate transport cost
			notes: 'Transport materials to crafting station',
		})
	}

	// Craft
	steps.push({
		step: stepNum++,
		action: 'craft',
		itemId: state.targetItem!,
		quantity: state.targetQuantity,
		city: state.craftingCity || state.materialCosts[0]?.bestCity || 'Unknown',
		estimatedCost: 0, // TODO: Calculate crafting fees
		notes: 'Craft at station',
	})

	// Sell
	if (state.demandAnalysis) {
		steps.push({
			step: stepNum++,
			action: 'sell',
			itemId: state.targetItem!,
			quantity: state.targetQuantity,
			city: state.demandAnalysis.recommendedSellCity,
			estimatedCost: -state.demandAnalysis.expectedSellPrice * state.targetQuantity,
			notes: `Expected: ${formatSilver(state.demandAnalysis.expectedSellPrice)} each`,
		})
	}

	state.executionPlan = steps
}

// ============================================================================
// DASHBOARD
// ============================================================================

function showDashboard(state: CraftingPlannerState): void {
	console.clear()

	const uptime = formatDuration(Date.now() - state.startTime)

	const W = 110
	const lines: string[] = []

	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${`ALBION CRAFTING PLANNER`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`🎯 Item: ${state.targetItem}`.padEnd(W / 4)}${`📦 Qty: ${state.targetQuantity}`.padEnd(W / 4)}${`🏭 City: ${state.craftingCity || 'Auto'}`.padEnd(W / 4)}${`⚡ Uptime: ${uptime}`.padEnd(W / 4 - 2)} │`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Material Costs
	lines.push(`│ ${`💰 MATERIAL COSTS`.padEnd(W - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	if (state.materialCosts.length === 0) {
		lines.push(`│ ${`No material data available. Recipe lookup not implemented yet.`.padEnd(W - 2)} │`)
	} else {
		lines.push(
			`│ ${`Material`.padEnd(30)}${`Qty`.padEnd(10)}${`Best City`.padEnd(20)}${`Unit Price`.padEnd(15)}${`Total`.padEnd(15)}${`Stock`.padEnd(W - 92)} │`,
		)
		for (const m of state.materialCosts) {
			lines.push(
				`│ ${m.itemId.padEnd(30)}${String(m.quantity).padEnd(10)}${m.bestCity.padEnd(20)}${formatSilver(m.bestPrice).padEnd(15)}${formatSilver(m.totalCost).padEnd(15)}${String(m.availability).padEnd(W - 92)} │`,
			)
		}
	}

	lines.push(`├${'─'.repeat(W)}┤`)

	// Demand Analysis
	lines.push(`│ ${`📊 DEMAND ANALYSIS`.padEnd(W - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	if (!state.demandAnalysis) {
		lines.push(`│ ${`No historical data available for demand analysis.`.padEnd(W - 2)} │`)
	} else {
		const d = state.demandAnalysis
		const trendIcon = d.demandTrend === 'rising' ? '📈' : d.demandTrend === 'falling' ? '📉' : '➡️'
		lines.push(
			`│ ${`${trendIcon} Trend: ${d.demandTrend}`.padEnd(W / 4)}${`📦 Daily Vol: ${formatNumber(d.avgDailyVolume)}`.padEnd(W / 4)}${`📊 Volatility: ${(d.priceVolatility * 100).toFixed(1)}%`.padEnd(W / 4)}${`🏆 Best Sell: ${d.recommendedSellCity}`.padEnd(W / 4 - 2)} │`,
		)
	}

	lines.push(`├${'─'.repeat(W)}┤`)

	// Profitability
	lines.push(`│ ${`💵 PROFITABILITY`.padEnd(W - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	if (!state.profitability) {
		lines.push(`│ ${`Cannot calculate profitability without cost/demand data.`.padEnd(W - 2)} │`)
	} else {
		const p = state.profitability
		const profitIcon = p.estimatedProfit > 0 ? '✅' : '❌'
		lines.push(
			`│ ${`💸 Cost: ${formatSilver(p.totalMaterialCost)}`.padEnd(W / 4)}${`💰 Revenue: ${formatSilver(p.expectedRevenue)}`.padEnd(W / 4)}${`${profitIcon} Profit: ${formatSilver(p.estimatedProfit)}`.padEnd(W / 4)}${`📈 Margin: ${p.profitMargin.toFixed(1)}%`.padEnd(W / 4 - 2)} │`,
		)
	}

	lines.push(`├${'─'.repeat(W)}┤`)

	// Execution Plan
	lines.push(`│ ${`📋 EXECUTION PLAN`.padEnd(W - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	if (state.executionPlan.length === 0) {
		lines.push(`│ ${`No execution plan generated.`.padEnd(W - 2)} │`)
	} else {
		for (const step of state.executionPlan) {
			const actionIcon =
				step.action === 'buy'
					? '🛒'
					: step.action === 'sell'
						? '💰'
						: step.action === 'craft'
							? '🔨'
							: '🚚'
			const costStr =
				step.estimatedCost < 0
					? `+${formatSilver(-step.estimatedCost)}`
					: `-${formatSilver(step.estimatedCost)}`
			lines.push(
				`│ ${`${step.step}. ${actionIcon} ${step.action.toUpperCase()}`.padEnd(20)}${step.itemId.padEnd(25)}${`x${step.quantity}`.padEnd(10)}${step.city.padEnd(20)}${costStr.padEnd(15)}${step.notes.padEnd(W - 92)} │`,
			)
		}
	}

	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(
		`│ ${`Last analysis: ${state.lastAnalysis ? formatTimeAgo(state.lastAnalysis) : 'Never'}`.padEnd(W / 2)}${`Next refresh: in ${formatDuration(ANALYSIS_REFRESH_MS)}`.padEnd(W / 2 - 2)} │`,
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

function formatNumber(num: number): string {
	if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
	if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K'
	return num.toFixed(0)
}

function formatTimeAgo(date: Date): string {
	const s = Math.floor((Date.now() - date.getTime()) / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	return `${Math.floor(m / 60)}h ${m % 60}m ago`
}
