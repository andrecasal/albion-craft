// collector.ts
// Background service that ingests NATS market orders and stores them in SQLite

import { connect, StringCodec, NatsConnection, Subscription } from 'nats'
import { City } from './types'
import {
	CITY_TO_LOCATION,
	closeDb,
	LOCATION_TO_CITY,
	MarketOrder,
	upsertOrders,
	getStats,
	getOrderCountsByCity,
	getCitiesWithData,
	getDatabaseSize,
	cleanupExpired,
} from './db/db'
import {
	checkHistoryStatus,
	fetchMissingHistory,
} from './services/history-fetcher'
import {
	checkHourlyHistoryStatus,
	fetchHourlyHistory,
} from './services/hourly-fetcher'

// ============================================================================
// CONFIGURATION
// ============================================================================

const NATS_SERVERS = {
	europe: { host: 'nats.albion-online-data.com', port: 34222 },
	americas: { host: 'nats.albion-online-data.com', port: 4222 },
	asia: { host: 'nats.albion-online-data.com', port: 24222 },
}

const NATS_USER = 'public'
const NATS_PASS = 'thenewalbiondata'

// Use ingest for real-time, deduped for less frequent updates
const MARKET_ORDERS_TOPIC = 'marketorders.ingest'

// How often to clean up expired orders (in ms)
const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes

// How often to log stats (in ms)
const STATS_INTERVAL = 1000 // 1 second

// How often to check for new historical/hourly data (in ms)
const HISTORY_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

// ============================================================================
// TYPES
// ============================================================================

interface RawMarketOrder {
	Id: number
	ItemTypeId: string
	ItemGroupTypeId: string
	LocationId: number
	QualityLevel: number
	EnchantmentLevel: number
	UnitPriceSilver: number
	Amount: number
	AuctionType: 'offer' | 'request'
	Expires: string
}

interface MarketOrdersMessage {
	Orders: RawMarketOrder[]
}

type Region = 'europe' | 'americas' | 'asia'

interface CollectorState {
	region: Region
	nc: NatsConnection | null
	subscription: Subscription | null
	cleanupTimer: NodeJS.Timeout | null
	statsTimer: NodeJS.Timeout | null
	historyTimer: NodeJS.Timeout | null
	running: boolean
	messagesReceived: number
	ordersProcessed: number
	ordersProcessedTotal: number
	ordersExpiredCleaned: number
	lastStatsTime: number
	startTime: number
	cityLastUpdate: Map<City, number>
	lastHistorySync: Date | null
	lastHourlySync: Date | null
	historySyncInProgress: boolean
}

// Main
const main = async (): Promise<void> => {
	const state: CollectorState = {
		region: (process.env.ALBION_REGION as Region) || 'europe',
		nc: null,
		subscription: null,
		cleanupTimer: null,
		statsTimer: null,
		historyTimer: null,
		running: false,
		messagesReceived: 0,
		ordersProcessed: 0,
		ordersProcessedTotal: 0,
		ordersExpiredCleaned: 0,
		lastStatsTime: Date.now(),
		startTime: Date.now(),
		cityLastUpdate: new Map(),
		lastHistorySync: null,
		lastHourlySync: null,
		historySyncInProgress: false,
	}

	const shutdown = async () => {
		await stopCollector(state)
		closeDb()
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	try {
		console.log('🚀 Starting real-time order book collector...\n')
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

// ============================================================================
// COLLECTOR LIFECYCLE
// ============================================================================

const startCollector = async (state: CollectorState): Promise<void> => {
	if (state.running) {
		console.log('Collector is already running')
		return
	}

	const server = NATS_SERVERS[state.region]

	try {
		state.nc = await connect({
			servers: `${server.host}:${server.port}`,
			user: NATS_USER,
			pass: NATS_PASS,
			reconnect: true,
			maxReconnectAttempts: -1,
			reconnectTimeWait: 2000,
		})

		handleConnectionStatus(state)

		state.running = true
		state.startTime = Date.now()

		startHistoryCheckTimer(state)
		subscribeToOrders(state)
		startCleanupTimer(state)
		startStatsTimer(state)

		logStats(state, false)
	} catch (err) {
		console.error(`❌ Failed to connect to NATS:`, err)
		throw err
	}
}

const stopCollector = async (state: CollectorState): Promise<void> => {
	if (!state.running) {
		return
	}

	console.log(`\n🛑 Stopping collector...`)

	state.running = false

	stopTimers(state)

	if (state.subscription) {
		state.subscription.unsubscribe()
		state.subscription = null
	}

	if (state.nc) {
		await state.nc.close()
		state.nc = null
	}

	logStats(state, true)

	console.log(`👋 Collector stopped\n`)
}

// ============================================================================
// NATS CONNECTION
// ============================================================================

const handleConnectionStatus = (state: CollectorState): void => {
	;(async () => {
		if (!state.nc) return
		for await (const status of state.nc.status()) {
			switch (status.type) {
				case 'disconnect':
					console.log(`⚠️  Disconnected from NATS`)
					break
				case 'reconnect':
					console.log(`✅ Reconnected to NATS`)
					break
				case 'error':
					console.error(`❌ NATS error:`, status.data)
					break
			}
		}
	})()
}

const subscribeToOrders = (state: CollectorState): void => {
	if (!state.nc) return

	const sc = StringCodec()
	state.subscription = state.nc.subscribe(MARKET_ORDERS_TOPIC)
	;(async () => {
		if (!state.subscription) return

		for await (const msg of state.subscription) {
			if (!state.running) break

			try {
				const data = sc.decode(msg.data)
				const message: MarketOrdersMessage = JSON.parse(data)

				if (message.Orders && message.Orders.length > 0) {
					processOrders(state, message.Orders)
				}
			} catch (err) {
				console.error(`❌ Error processing message:`, err)
			}
		}
	})()
}

// ============================================================================
// ORDER PROCESSING
// ============================================================================

const processOrders = ( state: CollectorState, rawOrders: RawMarketOrder[]): void => {
	state.messagesReceived++

	const orders = rawOrders.map((raw) => ({
		id: raw.Id,
		itemId: raw.ItemTypeId,
		itemGroupId: raw.ItemGroupTypeId,
		locationId: raw.LocationId,
		qualityLevel: raw.QualityLevel,
		enchantmentLevel: raw.EnchantmentLevel,
		priceSilver: raw.UnitPriceSilver,
		amount: raw.Amount,
		auctionType: raw.AuctionType,
		expires: raw.Expires,
	}))

	for (const order of orders) {
		const city = LOCATION_TO_CITY[order.locationId]
		if (city) {
			state.cityLastUpdate.set(city, Date.now())
		}
	}

	upsertOrders(orders)
	state.ordersProcessed += orders.length
	state.ordersProcessedTotal += orders.length
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

const formatTimeAgo = (ms: number): string => {
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
	const elapsed = (now - state.lastStatsTime) / 1000
	const totalElapsed = now - state.startTime

	const dbStats = getStats()
	const cityCounts = getOrderCountsByCity()
	const citiesWithData = getCitiesWithData()
	const totalCities = Object.keys(CITY_TO_LOCATION).length
	const dbSize = getDatabaseSize()

	const ordersPerSecond =
		elapsed > 0 ? (state.ordersProcessed / elapsed).toFixed(1) : '0'

	if (final) {
		console.log(`\n📊 Final Statistics:`)
		console.log(`   Runtime: ${formatUptime(totalElapsed)}`)
		console.log(`   Messages received: ${state.messagesReceived}`)
		console.log(
			`   Orders processed: ${formatNumber(state.ordersProcessedTotal)}`,
		)
		console.log(
			`   Orders expired/cleaned: ${formatNumber(state.ordersExpiredCleaned)}`,
		)
		console.log(`   Active orders in DB: ${formatNumber(dbStats.totalOrders)}`)
		console.log(`   Unique items tracked: ${formatNumber(dbStats.uniqueItems)}`)
	} else {
		process.stdout.write('\x1B[H\x1B[J')

		const uptime = formatUptime(totalElapsed)
		const W = '─'.repeat(70)
		const lines: string[] = []

		lines.push(`┌${W}┐`)
		const titleText = `ALBION MARKET COLLECTOR                   > ${state.region.toUpperCase()}`
		lines.push(`│  📡 ${titleText.padEnd(63)}  │`)
		const statusIcon = state.nc ? '🟢' : '🔴'
		const statusText = `${state.nc ? 'Connected' : 'Disconnected'}                                 Uptime: ${uptime}`
		lines.push(`│  ${statusIcon} ${statusText.padEnd(65)}│`)
		lines.push(`├${W}┤`)

		const r1c1 = `Rate: ${ordersPerSecond}/s`.padEnd(19)
		const r1c2 = `Total: ${formatNumber(dbStats.totalOrders)}`.padEnd(18)
		const r1c3 = `Items: ${formatNumber(dbStats.uniqueItems)}`.padEnd(20)
		lines.push(`│  ⚡ ${r1c1} 📦 ${r1c2} 🏷️  ${r1c3}│`)

		const r2c1 = `Session: ${formatNumber(state.ordersProcessedTotal)}`.padEnd(
			19,
		)
		const r2c2 = `Sell: ${formatNumber(dbStats.sellOrders)}`.padEnd(18)
		const r2c3 = `Cities: ${citiesWithData}/${totalCities}`.padEnd(20)
		lines.push(`│  📊 ${r2c1} 💰 ${r2c2} 🏙️  ${r2c3}│`)

		const r3c1 = `Cleaned: ${formatNumber(state.ordersExpiredCleaned)}`.padEnd(
			19,
		)
		const r3c2 = `Buy: ${formatNumber(dbStats.buyOrders)}`.padEnd(18)
		const r3c3 = `DB: ${formatBytes(dbSize)}`.padEnd(20)
		lines.push(`│  🧹 ${r3c1} 🛒 ${r3c2} 💾 ${r3c3}│`)

		lines.push(`├${W}┤`)
		lines.push(`│  🗺️  ${'CITY BREAKDOWN'.padEnd(65)}│`)

		const allCities = (Object.keys(CITY_TO_LOCATION) as City[]).sort(
			(a, b) => (cityCounts[b] || 0) - (cityCounts[a] || 0),
		)
		const cityEmojis: Record<City, string> = {
			Thetford: '🌿',
			Martlock: '⛰️ ',
			'Fort Sterling': '❄️ ',
			Lymhurst: '🌲',
			Bridgewatch: '🏜️ ',
			Caerleon: '👑',
			Brecilien: '🌳',
		}

		for (const city of allCities) {
			const count = cityCounts[city] || 0
			const lastUpdate = state.cityLastUpdate.get(city)
			const timeAgo = lastUpdate ? formatTimeAgo(now - lastUpdate) : 'never'
			const cityName = `${city}:`.padEnd(15)
			const countStr = formatNumber(count).padEnd(10)
			const text = `${cityName}${countStr}${timeAgo}`.padEnd(65)
			lines.push(`│  ${cityEmojis[city]} ${text}│`)
		}

		lines.push(`└${W}┘`)
		console.log(lines.join('\n'))
	}

	state.lastStatsTime = now
	state.ordersProcessed = 0
}

// ============================================================================
// TIMERS
// ============================================================================

const startHistoryCheckTimer = (state: CollectorState): void => {
	state.historyTimer = setInterval(() => {
		checkAndFetchHistory(state)
	}, HISTORY_CHECK_INTERVAL)
}

const startCleanupTimer = (state: CollectorState): void => {
	state.cleanupTimer = setInterval(() => {
		const deleted = cleanupExpired()
		if (deleted > 0) {
			state.ordersExpiredCleaned += deleted
			console.log(`🧹 Cleaned up ${deleted} expired orders`)
		}
	}, CLEANUP_INTERVAL)
}

const startStatsTimer = (state: CollectorState): void => {
	state.statsTimer = setInterval(() => {
		logStats(state, false)
	}, STATS_INTERVAL)
}

const stopTimers = (state: CollectorState): void => {
	if (state.cleanupTimer) {
		clearInterval(state.cleanupTimer)
		state.cleanupTimer = null
	}
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
	const hourlyStatus = checkHourlyHistoryStatus()

	if (!historyStatus.needsFetch && !hourlyStatus.needsFetch) return

	state.historySyncInProgress = true

	try {
		if (historyStatus.needsFetch) {
			const missingCount = historyStatus.missingDates.length
			console.log(
				`\n📅 New daily data available (${missingCount} day${missingCount > 1 ? 's' : ''} missing). Syncing...`,
			)

			const result = await fetchMissingHistory()
			if (!result.skipped && result.recordsAdded > 0) {
				state.lastHistorySync = new Date()
				console.log(
					`   ✅ Added ${result.recordsAdded.toLocaleString()} daily records`,
				)
			}
		}

		if (hourlyStatus.needsFetch) {
			const hoursOld = hourlyStatus.hoursOld || 0
			console.log(`\n⏰ Hourly data is ${hoursOld}h old. Refreshing...`)

			const result = await fetchHourlyHistory()
			if (!result.skipped && result.recordsAdded > 0) {
				state.lastHourlySync = new Date()
				console.log(
					`   ✅ Added ${result.recordsAdded.toLocaleString()} hourly records`,
				)
			}
		}
	} catch (err) {
		console.error(`\n❌ Error fetching history:`, err)
	} finally {
		state.historySyncInProgress = false
	}
}

// ============================================================================
// STANDALONE RUNNER
// ============================================================================

const fetchPriceHistory = async (): Promise<void> => {
	console.log(
		'\n┌──────────────────────────────────────────────────────────────────────┐',
	)
	console.log(
		'│  📊 PRICE HISTORY SYNC                                               │',
	)
	console.log(
		'└──────────────────────────────────────────────────────────────────────┘\n',
	)

	console.log('📅 Checking daily price history (30 days, time-scale=24)...')
	const historyStatus = checkHistoryStatus()

	if (historyStatus.totalRecords === 0) {
		console.log('   ⚫ No daily data found. Fetching full 30-day history...')
	} else if (historyStatus.missingDates.length === 0) {
		console.log(
			`   🟢 Complete: ${historyStatus.totalRecords.toLocaleString()} records available`,
		)
	} else {
		console.log(
			`   🟡 Missing ${historyStatus.missingDates.length} day(s): ${historyStatus.missingDates.slice(0, 3).join(', ')}${historyStatus.missingDates.length > 3 ? '...' : ''}`,
		)
	}

	if (historyStatus.needsFetch) {
		const historyResult = await fetchMissingHistory()
		if (!historyResult.skipped) {
			console.log(
				`   ✅ Synced ${historyResult.recordsAdded.toLocaleString()} daily records\n`,
			)
		}
	} else {
		console.log('')
	}

	console.log('⏰ Checking hourly price history (24h, time-scale=1)...')
	const hourlyStatus = checkHourlyHistoryStatus()

	if (hourlyStatus.totalRecords === 0) {
		console.log('   ⚫ No hourly data found. Fetching last 24 hours...')
	} else if (!hourlyStatus.needsFetch) {
		console.log(
			`   🟢 Fresh: ${hourlyStatus.totalRecords.toLocaleString()} records (${hourlyStatus.uniqueItems.toLocaleString()} items), ${hourlyStatus.hoursOld || 0}h old`,
		)
	} else {
		console.log(
			`   🟡 Stale: Data is ${hourlyStatus.hoursOld}h old. Refreshing...`,
		)
	}

	if (hourlyStatus.needsFetch) {
		const hourlyResult = await fetchHourlyHistory()
		if (!hourlyResult.skipped) {
			console.log(
				`   ✅ Synced ${hourlyResult.recordsAdded.toLocaleString()} hourly records\n`,
			)
		}
	} else {
		console.log('')
	}

	console.log(
		'────────────────────────────────────────────────────────────────────────\n',
	)
}
