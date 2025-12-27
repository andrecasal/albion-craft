/**
 * Teleport + Instant Sell Arbitrage UI (Single Item)
 *
 * Fast scanner using latest prices to spot arbitrage opportunities.
 * Shows the best single-item price discrepancy between cities.
 *
 * Reads/writes configuration from src/config.json
 *
 * Run with: bun src/ui/teleport-single-item.ts
 */

import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
	findSingleItemArbitrageOpportunities,
	type SingleItemArbitrageOpportunity,
} from '../strategies/teleport-single-item'
import { formatItemDisplay } from './table'

// ============================================================================
// TYPES
// ============================================================================

interface Config {
	hasPremium: boolean
	excludeBlackMarket: boolean
	excludeCaerleon: boolean
}

interface State {
	startTime: number
	running: boolean
	config: Config
	opportunities: SingleItemArbitrageOpportunity[]
	lastScan: Date | null
	isScanning: boolean
}

// ============================================================================
// CONFIG FILE HANDLING
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, '..', 'config.json')

const DEFAULT_CONFIG: Config = {
	hasPremium: true,
	excludeBlackMarket: true,
	excludeCaerleon: false,
}

// Hardcoded scan parameters (not configurable)
const SCAN_LIMIT = 50
const MIN_PROFIT_PERCENT = 0

function loadConfig(): Config {
	try {
		const data = readFileSync(CONFIG_PATH, 'utf-8')
		const loaded = JSON.parse(data) as Partial<Config>
		return {
			...DEFAULT_CONFIG,
			...loaded,
		}
	} catch {
		// If config doesn't exist, create it with defaults
		saveConfig(DEFAULT_CONFIG)
		return DEFAULT_CONFIG
	}
}

function saveConfig(config: Config): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, '\t') + '\n')
}

// ============================================================================
// SCANNING
// ============================================================================

function scanForArbitrage(state: State): void {
	state.isScanning = true

	const excludeCities: string[] = []
	if (state.config.excludeBlackMarket) excludeCities.push('Black Market')
	if (state.config.excludeCaerleon) excludeCities.push('Caerleon')

	const opportunities = findSingleItemArbitrageOpportunities({
		limit: SCAN_LIMIT,
		minProfitPercent: MIN_PROFIT_PERCENT,
		hasPremium: state.config.hasPremium,
		excludeCities,
	})

	// Results are already sorted by profit/hour from the strategy
	state.opportunities = opportunities
	state.lastScan = new Date()
	state.isScanning = false
}

// ============================================================================
// DASHBOARD RENDERING
// ============================================================================

function showDashboard(state: State): void {
	console.clear()

	const uptime = formatDuration(Date.now() - state.startTime)
	const W = 150
	const lines: string[] = []

	// Header
	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${'TELEPORT ARBITRAGE (Single Item - Latest Prices)'.padEnd(W - 2)} │`)

	const premiumStr = state.config.hasPremium ? 'Premium: ON (4% tax)' : 'Premium: OFF (8% tax)'
	const foundStr = `Found: ${state.opportunities.length} opportunities`
	const uptimeStr = `Uptime: ${uptime}`

	lines.push(`│ ${premiumStr.padEnd(W / 3)}${foundStr.padEnd(W / 3)}${uptimeStr.padEnd(W / 3 - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Scanning indicator
	if (state.isScanning) {
		lines.push(`│ ${'Scanning...'.padEnd(W - 2)} │`)
		lines.push(`├${'─'.repeat(W)}┤`)
	}

	// Column headers
	lines.push(
		`│ ${'Item Name'.padEnd(22)} ${'T.E.Q'.padStart(5)} ${'Buy City'.padEnd(13)}${'Buy'.padStart(9)} ${'%Base'.padStart(6)} ${'Sell City'.padEnd(13)}${'Sell'.padStart(9)} ${'%Base'.padStart(6)} ${'Vol'.padStart(5)} ${'Age'.padStart(5)} ${'Tax'.padStart(7)} ${'TP'.padStart(6)} ${'Profit'.padStart(8)} ${'▼Silver/h'.padStart(10)} │`
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Results
	if (state.opportunities.length === 0 && !state.isScanning) {
		lines.push(`│ ${'No arbitrage opportunities found.'.padEnd(W - 2)} │`)
		lines.push(`│ ${''.padEnd(W - 2)} │`)
		lines.push(`│ ${'This could mean:'.padEnd(W - 2)} │`)
		lines.push(`│ ${'  - The price data is stale (run the collector)'.padEnd(W - 2)} │`)
		lines.push(`│ ${'  - No profitable cross-city trades exist right now'.padEnd(W - 2)} │`)
	} else {
		for (const opp of state.opportunities) {
			const { baseName, teq } = formatItemDisplay(opp.itemId, opp.itemName, opp.quality)
			const itemNameStr = truncate(baseName, 21)
			const buyPctBaseStr = opp.buyPriceVsBaseline !== null ? `${opp.buyPriceVsBaseline.toFixed(0)}%` : '-'
			const sellPctBaseStr = opp.sellPriceVsBaseline !== null ? `${opp.sellPriceVsBaseline.toFixed(0)}%` : '-'
			const volStr = formatVolume(opp.dailyVolume)
			const ageStr = formatAge(opp.dataAgeMinutes)
			const profitStr = formatProfit(opp.netProfit)
			const profitHourStr = formatSilver(opp.profitPerHour)

			lines.push(
				`│ ${itemNameStr.padEnd(22)} ${teq.padStart(5)} ${opp.buyCity.padEnd(13)}${formatSilver(opp.buyPrice).padStart(9)} ${buyPctBaseStr.padStart(6)} ${opp.sellCity.padEnd(13)}${formatSilver(opp.instantSellPrice).padStart(9)} ${sellPctBaseStr.padStart(6)} ${volStr.padStart(5)} ${ageStr.padStart(5)} ${formatSilver(opp.taxPaid).padStart(7)} ${formatSilver(opp.teleportCost).padStart(6)} ${profitStr.padStart(8)} ${profitHourStr.padStart(10)} │`
			)
		}
	}

	// Footer with config info
	lines.push(`├${'─'.repeat(W)}┤`)
	const lastScanStr = state.lastScan ? `Last scan: ${formatTimeAgo(state.lastScan)}` : 'Last scan: Never'
	const blackMarketStr = state.config.excludeBlackMarket ? 'Black Market: Excluded' : 'Black Market: Included'
	const caerleonStr = state.config.excludeCaerleon ? 'Caerleon: Excluded' : 'Caerleon: Included'
	const configStr = 'Config: src/config.json'

	lines.push(`│ ${lastScanStr.padEnd(W / 4)}${blackMarketStr.padEnd(W / 4)}${caerleonStr.padEnd(W / 4)}${configStr.padEnd(W / 4 - 2)} │`)
	lines.push(`├${'─'.repeat(W)}┤`)
	lines.push(`│ ${'[r] refresh | [p] premium | [b] black market | [c] caerleon | [q] quit'.padEnd(W - 2)} │`)
	lines.push(`└${'─'.repeat(W)}┘`)

	console.log(lines.join('\n'))
	console.log('\n  Sorted by: Profit/Hour (assumes 2 min per transaction)')
	console.log('  Note: Shows per-unit profit. For quantity-aware analysis, use teleport-order-book.')
}

// ============================================================================
// INPUT HANDLING
// ============================================================================

function waitForKeypress(state: State): Promise<void> {
	return new Promise(() => {
		// Check if we're in an interactive TTY
		if (!process.stdin.isTTY) {
			// Non-interactive mode - just exit after showing dashboard
			return
		}

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
				scanForArbitrage(state)
				showDashboard(state)
				return
			}

			// 'p' to toggle premium
			if (char === 'p' || char === 'P') {
				state.config.hasPremium = !state.config.hasPremium
				saveConfig(state.config)
				scanForArbitrage(state)
				showDashboard(state)
				return
			}

			// 'b' to toggle Black Market exclusion
			if (char === 'b' || char === 'B') {
				state.config.excludeBlackMarket = !state.config.excludeBlackMarket
				saveConfig(state.config)
				scanForArbitrage(state)
				showDashboard(state)
				return
			}

			// 'c' to toggle Caerleon exclusion
			if (char === 'c' || char === 'C') {
				state.config.excludeCaerleon = !state.config.excludeCaerleon
				saveConfig(state.config)
				scanForArbitrage(state)
				showDashboard(state)
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

function shutdown(state: State): void {
	state.running = false
	console.log('\nTeleport arbitrage scanner stopped.')
	process.exit(0)
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

function formatSilver(amount: number): string {
	if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M'
	if (amount >= 1_000) return (amount / 1_000).toFixed(1) + 'K'
	return String(amount)
}

function formatVolume(volume: number): string {
	if (volume === 0) return '-'
	if (volume >= 1_000) return (volume / 1_000).toFixed(1) + 'K'
	return String(Math.round(volume))
}

function formatAge(minutes: number): string {
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	return `${hours}h`
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

function formatProfit(value: number): string {
	const formatted = formatSilver(Math.abs(value))
	return value >= 0 ? formatted : `-${formatted}`
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
	const config = loadConfig()

	const state: State = {
		startTime: Date.now(),
		running: true,
		config,
		opportunities: [],
		lastScan: null,
		isScanning: false,
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	// Initial scan
	scanForArbitrage(state)
	showDashboard(state)

	// Wait for keypresses
	await waitForKeypress(state)
}

main()
