// collector.ts
// Background service that syncs daily price averages from AODP API
// NATS subscription is mocked for now but architecture is preserved for future use

import {
	closeDb,
	getDailyPriceCount,
	getDailyPriceItemCount,
	getDailyPriceDateCount,
	getDatabaseSize,
} from './db/db'
import { checkHistoryStatus, fetchMissingHistory } from './services/history-fetcher'

// ============================================================================
// CONFIGURATION
// ============================================================================

// NATS configuration (preserved for future real-time order book integration)
const NATS_SERVERS = {
	europe: { host: 'nats.albion-online-data.com', port: 34222 },
	americas: { host: 'nats.albion-online-data.com', port: 4222 },
	asia: { host: 'nats.albion-online-data.com', port: 24222 },
}

const NATS_USER = 'public'
const NATS_PASS = 'thenewalbiondata'

// Topic for real-time market orders (for future use)
const MARKET_ORDERS_TOPIC = 'marketorders.ingest'

// How often to log stats (in ms)
const STATS_INTERVAL = 5000 // 5 seconds

// How often to check for new historical data (in ms)
const HISTORY_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

// ============================================================================
// TYPES
// ============================================================================

type Region = 'europe' | 'americas' | 'asia'

interface CollectorState {
	region: Region
	natsConnected: boolean // Would be connected if not mocked
	running: boolean
	startTime: number
	lastHistorySync: Date | null
	historySyncInProgress: boolean
	statsTimer: NodeJS.Timeout | null
	historyTimer: NodeJS.Timeout | null
}

// ============================================================================
// COLLECTOR LIFECYCLE
// ============================================================================

const startCollector = async (state: CollectorState): Promise<void> => {
	if (state.running) {
		console.log('Collector is already running')
		return
	}

	state.running = true
	state.startTime = Date.now()

	// Mock NATS connection (architecture preserved for future use)
	mockNatsConnection(state)

	// Start timers
	startHistoryCheckTimer(state)
	startStatsTimer(state)

	// Initial sync
	await checkAndFetchHistory(state)

	// Initial stats display
	logStats(state, false)
}

const stopCollector = async (state: CollectorState): Promise<void> => {
	if (!state.running) {
		return
	}

	console.log(`\n🛑 Stopping collector...`)

	state.running = false

	stopTimers(state)

	logStats(state, true)

	console.log(`👋 Collector stopped\n`)
}

// ============================================================================
// NATS CONNECTION (MOCKED)
// ============================================================================

/**
 * Mock NATS connection - preserves architecture for future real-time integration
 * When ready to enable real orders, replace this with actual NATS connection
 */
const mockNatsConnection = (state: CollectorState): void => {
	const server = NATS_SERVERS[state.region]

	console.log(`📡 NATS connection mocked (${state.region.toUpperCase()})`)
	console.log(`   Would connect to: ${server.host}:${server.port}`)
	console.log(`   Topic: ${MARKET_ORDERS_TOPIC}`)
	console.log(`   User: ${NATS_USER}`)
	console.log('')

	// Mark as "connected" for display purposes
	state.natsConnected = true
}

// ============================================================================
// PURE HELPER FUNCTIONS
// ============================================================================

const formatNumber = (num: number): string => {
	if (num >= 1000000) {
		return (num / 1000000).toFixed(1) + 'M'
	}
	if (num >= 1000) {
		return (num / 1000).toFixed(1) + 'K'
	}
	return num.toString()
}

const formatUptime = (ms: number): string => {
	const seconds = Math.floor(ms / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`
	}
	return `${seconds}s`
}

const formatBytes = (bytes: number): string => {
	if (bytes >= 1073741824) {
		return (bytes / 1073741824).toFixed(1) + ' GB'
	}
	if (bytes >= 1048576) {
		return (bytes / 1048576).toFixed(1) + ' MB'
	}
	if (bytes >= 1024) {
		return (bytes / 1024).toFixed(1) + ' KB'
	}
	return bytes + ' B'
}

const formatTimeAgo = (date: Date | null): string => {
	if (!date) return 'never'
	const ms = Date.now() - date.getTime()
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) {
		return `${seconds}s ago`
	}
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) {
		return `${minutes}m ago`
	}
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${minutes % 60}m ago`
}

// ============================================================================
// STATS DISPLAY
// ============================================================================

const logStats = (state: CollectorState, final: boolean): void => {
	const now = Date.now()
	const totalElapsed = now - state.startTime

	const totalRecords = getDailyPriceCount()
	const uniqueItems = getDailyPriceItemCount()
	const uniqueDates = getDailyPriceDateCount()
	const dbSize = getDatabaseSize()

	const historyStatus = checkHistoryStatus()

	if (final) {
		console.log(`\n📊 Final Statistics:`)
		console.log(`   Runtime: ${formatUptime(totalElapsed)}`)
		console.log(`   Total price records: ${formatNumber(totalRecords)}`)
		console.log(`   Unique items tracked: ${formatNumber(uniqueItems)}`)
		console.log(`   Days of data: ${uniqueDates}`)
		console.log(`   Database size: ${formatBytes(dbSize)}`)
	} else {
		process.stdout.write('\x1B[H\x1B[J')

		const uptime = formatUptime(totalElapsed)
		const W = '─'.repeat(70)
		const lines: string[] = []

		lines.push(`┌${W}┐`)
		const titleText = `ALBION DAILY PRICE COLLECTOR                 > ${state.region.toUpperCase()}`
		lines.push(`│  📊 ${titleText.padEnd(63)}  │`)

		const natsIcon = state.natsConnected ? '🟡' : '🔴'
		const natsStatus = state.natsConnected ? 'Mocked' : 'Disconnected'
		const statusText = `NATS: ${natsStatus}                                 Uptime: ${uptime}`
		lines.push(`│  ${natsIcon} ${statusText.padEnd(65)}│`)
		lines.push(`├${W}┤`)

		const r1c1 = `Records: ${formatNumber(totalRecords)}`.padEnd(22)
		const r1c2 = `Items: ${formatNumber(uniqueItems)}`.padEnd(20)
		const r1c3 = `Days: ${uniqueDates}`.padEnd(20)
		lines.push(`│  📈 ${r1c1}🏷️  ${r1c2}📅 ${r1c3}│`)

		const r2c1 = `DB Size: ${formatBytes(dbSize)}`.padEnd(22)
		const r2c2 = `Missing: ${historyStatus.missingDates.length} days`.padEnd(20)
		const r2c3 = `Latest: ${historyStatus.latestDate || 'None'}`.padEnd(20)
		lines.push(`│  💾 ${r2c1}⚠️  ${r2c2}📆 ${r2c3}│`)

		const r3c1 = `Last sync: ${formatTimeAgo(state.lastHistorySync)}`.padEnd(22)
		const r3c2 = `Syncing: ${state.historySyncInProgress ? 'Yes' : 'No'}`.padEnd(
			20,
		)
		const r3c3 = `Next: ${state.historySyncInProgress ? 'In progress' : formatNextSync()}`.padEnd(
			20,
		)
		lines.push(`│  🔄 ${r3c1}⏳ ${r3c2}⏰ ${r3c3}│`)

		lines.push(`├${W}┤`)
		lines.push(`│  ℹ️  ${'NATS real-time orders are mocked (daily averages only)'.padEnd(65)}│`)
		lines.push(`└${W}┘`)

		console.log(lines.join('\n'))
	}
}

const formatNextSync = (): string => {
	return `~${Math.round(HISTORY_CHECK_INTERVAL / 60000)}m`
}

// ============================================================================
// TIMERS
// ============================================================================

const startHistoryCheckTimer = (state: CollectorState): void => {
	// Initial check after a short delay
	setTimeout(() => {
		checkAndFetchHistory(state)
	}, 1000)

	// Then check periodically
	state.historyTimer = setInterval(() => {
		checkAndFetchHistory(state)
	}, HISTORY_CHECK_INTERVAL)
}

const startStatsTimer = (state: CollectorState): void => {
	state.statsTimer = setInterval(() => {
		logStats(state, false)
	}, STATS_INTERVAL)
}

const stopTimers = (state: CollectorState): void => {
	if (state.statsTimer) {
		clearInterval(state.statsTimer)
		state.statsTimer = null
	}
	if (state.historyTimer) {
		clearInterval(state.historyTimer)
		state.historyTimer = null
	}
}

// ============================================================================
// HISTORY SYNC
// ============================================================================

const checkAndFetchHistory = async (state: CollectorState): Promise<void> => {
	if (state.historySyncInProgress) return

	const historyStatus = checkHistoryStatus()

	if (!historyStatus.needsFetch) return

	state.historySyncInProgress = true

	try {
		const missingCount = historyStatus.missingDates.length
		console.log(
			`\n📅 Daily data sync needed (${missingCount} day${missingCount > 1 ? 's' : ''} missing)...`,
		)

		const result = await fetchMissingHistory()
		if (!result.skipped && result.recordsAdded > 0) {
			state.lastHistorySync = new Date()
			console.log(
				`   ✅ Added ${result.recordsAdded.toLocaleString()} daily price records\n`,
			)
		}
	} catch (err) {
		console.error(`\n❌ Error fetching history:`, err)
	} finally {
		state.historySyncInProgress = false
	}
}

// ============================================================================
// EXPORTS (for programmatic use)
// ============================================================================

export { startCollector, stopCollector, CollectorState }

// ============================================================================
// MAIN
// ============================================================================

const main = async (): Promise<void> => {
	const state: CollectorState = {
		region: (process.env.ALBION_REGION as Region) || 'europe',
		natsConnected: false,
		running: false,
		startTime: Date.now(),
		lastHistorySync: null,
		historySyncInProgress: false,
		statsTimer: null,
		historyTimer: null,
	}

	const shutdown = async () => {
		await stopCollector(state)
		closeDb()
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	try {
		console.log('🚀 Starting daily price collector...\n')
		await startCollector(state)
		await new Promise(() => {})
	} catch (err) {
		console.error('Failed to start collector:', err)
		process.exit(1)
	}
}

if (require.main === module) {
	main()
}
