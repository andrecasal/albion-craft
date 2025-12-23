import 'dotenv/config'
import { connect, NatsConnection, Subscription, StringCodec } from 'nats'
import { appendFileSync } from 'fs'
import { closeDb, getDatabaseSize, db } from './db'
import { ALL_ITEM_IDS } from './constants/items'
import { getMarket } from './constants/markets'

// ============================================================================
// TYPES
// ============================================================================

type Region = 'europe' | 'americas' | 'asia'

type SyncType = 'latest' | 'daily' | 'sixHour' | 'hourly'

type CollectorState = {
	region: Region
	startTime: number
	running: boolean

	// Timers
	dashboardTimer: NodeJS.Timeout | null
	latestSyncTimer: NodeJS.Timeout | null
	dailySyncTimer: NodeJS.Timeout | null
	sixHourSyncTimer: NodeJS.Timeout | null
	hourlySyncTimer: NodeJS.Timeout | null
	orderBookCleanupTimer: NodeJS.Timeout | null

	// API Rate Limiting & Mutual Exclusion
	apiLockHolder: SyncType | null
	rateLimitedUntil: number | null
	syncQueue: SyncType[]

	// Latest Prices (5-minute sync)
	latestSyncInProgress: boolean
	latestSyncBatch: number
	latestSyncTotal: number
	lastLatestSync: Date | null

	// Daily Average Prices (hourly sync)
	dailySyncInProgress: boolean
	dailySyncBatch: number
	dailySyncTotal: number
	lastDailySync: Date | null

	// 6-Hour Average Prices (30-minute sync)
	sixHourSyncInProgress: boolean
	sixHourSyncBatch: number
	sixHourSyncTotal: number
	lastSixHourSync: Date | null

	// Hourly Average Prices (15-minute sync)
	hourlySyncInProgress: boolean
	hourlySyncBatch: number
	hourlySyncTotal: number
	lastHourlySync: Date | null

	// NATS Stream (real-time)
	natsConnection: NatsConnection | null
	natsSubscription: Subscription | null
	natsConnected: boolean
	natsMessagesReceived: number
	natsUnknownLocations: number
	lastNatsMessage: Date | null
}

type MarketHistoryDataPoint = {
	item_count: number
	avg_price: number
	timestamp: string
}

type MarketHistoriesResponse = {
	location: string
	item_id: string
	quality: number
	data: MarketHistoryDataPoint[]
}

type LatestPriceResponse = {
	item_id: string
	city: string
	quality: number
	sell_price_min: number
	sell_price_min_date: string
	sell_price_max: number
	sell_price_max_date: string
	buy_price_min: number
	buy_price_min_date: string
	buy_price_max: number
	buy_price_max_date: string
}

type NatsMarketOrder = {
	Id: number
	ItemTypeId: string
	ItemGroupTypeId: string
	LocationId: number
	QualityLevel: number
	EnchantmentLevel: number
	UnitPriceSilver: number
	Amount: number
	AuctionType: string
	Expires: string
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_URL_LENGTH = 4096
const DASHBOARD_REFRESH_MS = 1000 // 1 second
const LATEST_SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const LATEST_STALENESS_MS = 5 * 60 * 1000 // 5 minutes
const DAILY_SYNC_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const SIX_HOUR_SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const HOURLY_SYNC_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
const ORDER_BOOK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

const NATS_SERVERS: Record<Region, { host: string; port: number }> = {
	europe: { host: 'nats.albion-online-data.com', port: 34222 },
	americas: { host: 'nats.albion-online-data.com', port: 4222 },
	asia: { host: 'nats.albion-online-data.com', port: 24222 },
}
const NATS_TOPIC = 'marketorders.deduped'

const API_BASE_URL = 'https://europe.albion-online-data.com/api/v2/stats'

// ============================================================================
// ENTRY POINT
// ============================================================================

// Run if this is the main module
main()

async function main(): Promise<void> {
	checkEnv()

	const state: CollectorState = {
		// System
		region: process.env.ALBION_REGION as Region,
		startTime: Date.now(),
		running: false,

		// Timers
		dashboardTimer: null,
		latestSyncTimer: null,
		dailySyncTimer: null,
		sixHourSyncTimer: null,
		hourlySyncTimer: null,
		orderBookCleanupTimer: null,

		// API Rate Limiting & Mutual Exclusion
		apiLockHolder: null,
		rateLimitedUntil: null,
		syncQueue: [],

		// Latest Prices (5-minute sync)
		latestSyncInProgress: false,
		latestSyncBatch: 0,
		latestSyncTotal: 0,
		lastLatestSync: null,

		// Daily Average Prices (hourly sync)
		dailySyncInProgress: false,
		dailySyncBatch: 0,
		dailySyncTotal: 0,
		lastDailySync: null,

		// 6-Hour Average Prices (30-minute sync)
		sixHourSyncInProgress: false,
		sixHourSyncBatch: 0,
		sixHourSyncTotal: 0,
		lastSixHourSync: null,

		// Hourly Average Prices (15-minute sync)
		hourlySyncInProgress: false,
		hourlySyncBatch: 0,
		hourlySyncTotal: 0,
		lastHourlySync: null,

		// NATS Stream (real-time)
		natsConnection: null,
		natsSubscription: null,
		natsConnected: false,
		natsMessagesReceived: 0,
		natsUnknownLocations: 0,
		lastNatsMessage: null,
	}

	process.on('SIGINT', () => shutdown(state))
	process.on('SIGTERM', () => shutdown(state))

	await startCollector(state)
}

function checkEnv(): void {
	const validRegions = ['europe', 'americas', 'asia']
	const region = process.env.ALBION_REGION
	if (!region || !validRegions.includes(region)) {
		throw new Error(
			`Invalid or missing ALBION_REGION. Set one of: ${validRegions.join(', ')}`,
		)
	}
	if (!process.env.NATS_USER || !process.env.NATS_PASS) {
		throw new Error('Missing NATS_USER or NATS_PASS environment variables')
	}
}

async function shutdown(state: CollectorState): Promise<void> {
	if (!state.running) return
	state.running = false

	if (state.dashboardTimer) clearInterval(state.dashboardTimer)
	if (state.latestSyncTimer) clearInterval(state.latestSyncTimer)
	if (state.dailySyncTimer) clearInterval(state.dailySyncTimer)
	if (state.sixHourSyncTimer) clearInterval(state.sixHourSyncTimer)
	if (state.hourlySyncTimer) clearInterval(state.hourlySyncTimer)
	if (state.orderBookCleanupTimer) clearInterval(state.orderBookCleanupTimer)
	if (state.natsSubscription) state.natsSubscription.unsubscribe()
	if (state.natsConnection) await state.natsConnection.close()

	closeDb()
	console.log('\nCollector stopped.')
	process.exit(0)
}

// ============================================================================
// COLLECTOR LIFECYCLE
// ============================================================================

async function startCollector(state: CollectorState): Promise<void> {
	state.running = true
	state.startTime = Date.now()

	showDashboard(state)
	state.dashboardTimer = setInterval(
		() => showDashboard(state),
		DASHBOARD_REFRESH_MS,
	)

	// Latest prices (5-minute sync)
	setTimeout(() => syncLatestPrices(state), 1000)
	state.latestSyncTimer = setInterval(
		() => syncLatestPrices(state),
		LATEST_SYNC_INTERVAL_MS,
	)

	// Daily averages (hourly sync)
	setTimeout(() => syncDailyPrices(state), 2000)
	state.dailySyncTimer = setInterval(
		() => syncDailyPrices(state),
		DAILY_SYNC_INTERVAL_MS,
	)

	// 6-hour averages (30-minute sync)
	setTimeout(() => syncSixHourPrices(state), 3000)
	state.sixHourSyncTimer = setInterval(
		() => syncSixHourPrices(state),
		SIX_HOUR_SYNC_INTERVAL_MS,
	)

	// Hourly averages (15-minute sync)
	setTimeout(() => syncHourlyPrices(state), 4000)
	state.hourlySyncTimer = setInterval(
		() => syncHourlyPrices(state),
		HOURLY_SYNC_INTERVAL_MS,
	)

	// NATS real-time stream
	connectNats(state)

	// Clean up expired orders periodically
	setTimeout(() => cleanupExpiredOrders(), 5000)
	state.orderBookCleanupTimer = setInterval(
		() => cleanupExpiredOrders(),
		ORDER_BOOK_CLEANUP_INTERVAL_MS,
	)
}

function cleanupExpiredOrders(): void {
	const now = new Date().toISOString()
	db.prepare('DELETE FROM order_book WHERE expires < ?').run(now)
}

// ============================================================================
// NATS CONNECTION
// ============================================================================

async function connectNats(state: CollectorState): Promise<void> {
	const server = NATS_SERVERS[state.region]

	try {
		state.natsConnection = await connect({
			servers: `nats://${server.host}:${server.port}`,
			user: process.env.NATS_USER,
			pass: process.env.NATS_PASS,
			reconnect: true,
			maxReconnectAttempts: -1,
		})

		state.natsConnected = true

		const sc = StringCodec()
		state.natsSubscription = state.natsConnection.subscribe(NATS_TOPIC)
		;(async () => {
			for await (const msg of state.natsSubscription!) {
				try {
					handleMarketOrder(state, JSON.parse(sc.decode(msg.data)))
				} catch {}
			}
		})()
		;(async () => {
			for await (const status of state.natsConnection!.status()) {
				state.natsConnected = status.type !== 'disconnect'
			}
		})()
	} catch {
		state.natsConnected = false
	}
}

function handleMarketOrder(
	state: CollectorState,
	order: NatsMarketOrder,
): void {
	state.natsMessagesReceived++
	state.lastNatsMessage = new Date()

	const market = getMarket(order.LocationId)
	if (!market) {
		state.natsUnknownLocations++
		appendFileSync('unknown-locations.log', `${order.LocationId}\n`)
		return
	}

	// Store raw UnitPriceSilver (10000 units = 1 silver) to preserve precision for cheap items
	const price = order.UnitPriceSilver
	const orderType = order.AuctionType === 'offer' ? 'sell' : 'buy'

	// Store/update the order in the order book
	db.prepare(
		`
		INSERT INTO order_book (order_id, item_id, city, quality, price, amount, order_type, expires, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(order_id) DO UPDATE SET
			price = excluded.price,
			amount = excluded.amount,
			expires = excluded.expires,
			updated_at = excluded.updated_at
	`,
	).run(
		order.Id,
		order.ItemTypeId,
		market,
		order.QualityLevel,
		price,
		order.Amount,
		orderType,
		order.Expires,
		Date.now(),
	)
}

// ============================================================================
// DAILY PRICE SYNC
// ============================================================================

async function syncDailyPrices(state: CollectorState): Promise<void> {
	if (state.dailySyncInProgress) return
	if (!needsDailySync()) {
		// Data is already up-to-date, just update the last sync time
		if (!state.lastDailySync) state.lastDailySync = new Date()
		return
	}
	if (!acquireApiLock(state, 'daily')) return

	state.dailySyncInProgress = true
	state.dailySyncBatch = 0
	state.dailySyncTotal = 0

	try {
		const urls = buildBatchedUrls(
			ALL_ITEM_IDS,
			`${API_BASE_URL}/history/`,
			'time-scale=24',
		)
		state.dailySyncTotal = urls.length

		const insertStmt = db.prepare(`
			INSERT OR REPLACE INTO daily_average_prices
			(item_id, city, quality, timestamp, item_count, avg_price)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
		const todayStr = new Date().toISOString().split('T')[0]

		for (let i = 0; i < urls.length; i++) {
			state.dailySyncBatch = i + 1
			const response = await fetchWithRateLimit(state, urls[i])
			if (!response || !response.ok) continue

			const data = (await response.json()) as MarketHistoriesResponse[]
			db.transaction(() => {
				for (const record of data) {
					for (const point of record.data) {
						if (point.timestamp.startsWith(todayStr)) continue
						insertStmt.run(
							record.item_id,
							record.location,
							record.quality,
							point.timestamp,
							point.item_count,
							point.avg_price,
						)
					}
				}
			})()
		}

		state.lastDailySync = new Date()
	} finally {
		state.dailySyncInProgress = false
		releaseApiLock(state, 'daily')
	}
}

function needsDailySync(): boolean {
	const yesterday = new Date()
	yesterday.setDate(yesterday.getDate() - 1)
	return !db
		.prepare(
			`SELECT 1 FROM daily_average_prices WHERE timestamp LIKE ? LIMIT 1`,
		)
		.get(`${yesterday.toISOString().split('T')[0]}%`)
}

// ============================================================================
// LATEST PRICE SYNC
// ============================================================================

async function syncLatestPrices(state: CollectorState): Promise<void> {
	if (state.latestSyncInProgress || !needsLatestSync()) return
	if (!acquireApiLock(state, 'latest')) return

	state.latestSyncInProgress = true
	state.latestSyncBatch = 0
	state.latestSyncTotal = 0

	try {
		const staleThreshold = Date.now() - LATEST_STALENESS_MS
		const freshItems = db
			.prepare(
				`SELECT DISTINCT item_id FROM latest_prices WHERE fetched_at > ?`,
			)
			.all(staleThreshold) as { item_id: string }[]
		const freshSet = new Set(freshItems.map((r) => r.item_id))
		const itemsToFetch = ALL_ITEM_IDS.filter((id) => !freshSet.has(id))

		if (itemsToFetch.length === 0) {
			return
		}

		const urls = buildBatchedUrls(itemsToFetch, `${API_BASE_URL}/prices/`, '')
		state.latestSyncTotal = urls.length

		const insertStmt = db.prepare(`
			INSERT OR REPLACE INTO latest_prices
			(item_id, city, quality, sell_price_min, sell_price_min_date, sell_price_max, sell_price_max_date,
			 buy_price_min, buy_price_min_date, buy_price_max, buy_price_max_date, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		const fetchedAt = Date.now()

		for (let i = 0; i < urls.length; i++) {
			state.latestSyncBatch = i + 1
			const response = await fetchWithRateLimit(state, urls[i])
			if (!response || !response.ok) continue

			const data = (await response.json()) as LatestPriceResponse[]
			db.transaction(() => {
				for (const r of data) {
					insertStmt.run(
						r.item_id,
						r.city,
						r.quality,
						r.sell_price_min,
						r.sell_price_min_date,
						r.sell_price_max,
						r.sell_price_max_date,
						r.buy_price_min,
						r.buy_price_min_date,
						r.buy_price_max,
						r.buy_price_max_date,
						fetchedAt,
					)
				}
			})()
		}

		state.lastLatestSync = new Date()
	} finally {
		state.latestSyncInProgress = false
		releaseApiLock(state, 'latest')
	}
}

function needsLatestSync(): boolean {
	return !db
		.prepare(`SELECT 1 FROM latest_prices WHERE fetched_at > ? LIMIT 1`)
		.get(Date.now() - LATEST_STALENESS_MS)
}

// ============================================================================
// 6-HOUR AVERAGE PRICE SYNC
// ============================================================================

async function syncSixHourPrices(state: CollectorState): Promise<void> {
	if (state.sixHourSyncInProgress) return
	if (!needsSixHourSync()) {
		if (!state.lastSixHourSync) state.lastSixHourSync = new Date()
		return
	}
	if (!acquireApiLock(state, 'sixHour')) return

	state.sixHourSyncInProgress = true
	state.sixHourSyncBatch = 0
	state.sixHourSyncTotal = 0

	try {
		const urls = buildBatchedUrls(
			ALL_ITEM_IDS,
			`${API_BASE_URL}/history/`,
			'time-scale=6',
		)
		state.sixHourSyncTotal = urls.length

		const insertStmt = db.prepare(`
			INSERT OR REPLACE INTO six_hour_average_prices
			(item_id, city, quality, timestamp, item_count, avg_price)
			VALUES (?, ?, ?, ?, ?, ?)
		`)

		for (let i = 0; i < urls.length; i++) {
			state.sixHourSyncBatch = i + 1
			const response = await fetchWithRateLimit(state, urls[i])
			if (!response || !response.ok) continue

			const data = (await response.json()) as MarketHistoriesResponse[]
			db.transaction(() => {
				for (const record of data) {
					for (const point of record.data) {
						insertStmt.run(
							record.item_id,
							record.location,
							record.quality,
							point.timestamp,
							point.item_count,
							point.avg_price,
						)
					}
				}
			})()
		}

		state.lastSixHourSync = new Date()
	} finally {
		state.sixHourSyncInProgress = false
		releaseApiLock(state, 'sixHour')
	}
}

function needsSixHourSync(): boolean {
	const sixHoursAgo = new Date()
	sixHoursAgo.setHours(sixHoursAgo.getHours() - 6)
	return !db
		.prepare(
			`SELECT 1 FROM six_hour_average_prices WHERE timestamp > ? LIMIT 1`,
		)
		.get(sixHoursAgo.toISOString())
}

// ============================================================================
// HOURLY AVERAGE PRICE SYNC
// ============================================================================

async function syncHourlyPrices(state: CollectorState): Promise<void> {
	if (state.hourlySyncInProgress) return
	if (!needsHourlySync()) {
		if (!state.lastHourlySync) state.lastHourlySync = new Date()
		return
	}
	if (!acquireApiLock(state, 'hourly')) return

	state.hourlySyncInProgress = true
	state.hourlySyncBatch = 0
	state.hourlySyncTotal = 0

	try {
		const urls = buildBatchedUrls(
			ALL_ITEM_IDS,
			`${API_BASE_URL}/history/`,
			'time-scale=1',
		)
		state.hourlySyncTotal = urls.length

		const insertStmt = db.prepare(`
			INSERT OR REPLACE INTO hourly_average_prices
			(item_id, city, quality, timestamp, item_count, avg_price)
			VALUES (?, ?, ?, ?, ?, ?)
		`)

		for (let i = 0; i < urls.length; i++) {
			state.hourlySyncBatch = i + 1
			const response = await fetchWithRateLimit(state, urls[i])
			if (!response || !response.ok) continue

			const data = (await response.json()) as MarketHistoriesResponse[]
			db.transaction(() => {
				for (const record of data) {
					for (const point of record.data) {
						insertStmt.run(
							record.item_id,
							record.location,
							record.quality,
							point.timestamp,
							point.item_count,
							point.avg_price,
						)
					}
				}
			})()
		}

		state.lastHourlySync = new Date()
	} finally {
		state.hourlySyncInProgress = false
		releaseApiLock(state, 'hourly')
	}
}

function needsHourlySync(): boolean {
	const oneHourAgo = new Date()
	oneHourAgo.setHours(oneHourAgo.getHours() - 1)
	return !db
		.prepare(`SELECT 1 FROM hourly_average_prices WHERE timestamp > ? LIMIT 1`)
		.get(oneHourAgo.toISOString())
}

// ============================================================================
// HTTP UTILITIES
// ============================================================================

const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000 // 60 seconds default if no Retry-After header

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function enqueueSync(state: CollectorState, syncType: SyncType): void {
	if (!state.syncQueue.includes(syncType)) {
		state.syncQueue.push(syncType)
	}
}

function acquireApiLock(state: CollectorState, syncType: SyncType): boolean {
	if (state.apiLockHolder !== null) {
		enqueueSync(state, syncType)
		return false
	}
	state.apiLockHolder = syncType
	return true
}

function releaseApiLock(state: CollectorState, syncType: SyncType): void {
	if (state.apiLockHolder === syncType) {
		state.apiLockHolder = null
		processQueue(state)
	}
}

function processQueue(state: CollectorState): void {
	if (state.syncQueue.length === 0 || state.apiLockHolder !== null) return

	const nextSync = state.syncQueue.shift()
	if (!nextSync) return

	// Trigger the appropriate sync function
	switch (nextSync) {
		case 'latest':
			syncLatestPrices(state)
			break
		case 'daily':
			syncDailyPrices(state)
			break
		case 'sixHour':
			syncSixHourPrices(state)
			break
		case 'hourly':
			syncHourlyPrices(state)
			break
	}
}

async function fetchWithRateLimit(
	state: CollectorState,
	url: string,
): Promise<Response | null> {
	// Wait if we're currently rate limited
	if (state.rateLimitedUntil !== null && state.rateLimitedUntil > Date.now()) {
		const waitTime = state.rateLimitedUntil - Date.now()
		await sleep(waitTime)
		state.rateLimitedUntil = null
	}

	const response = await fetch(url)

	// Handle rate limiting (429 Too Many Requests)
	if (response.status === 429) {
		const retryAfter = response.headers.get('Retry-After')
		const waitMs = retryAfter
			? parseInt(retryAfter, 10) * 1000
			: DEFAULT_RATE_LIMIT_WAIT_MS

		state.rateLimitedUntil = Date.now() + waitMs
		await sleep(waitMs)
		state.rateLimitedUntil = null

		// Retry the request after waiting
		return fetch(url)
	}

	return response
}

function buildBatchedUrls(
	items: string[],
	baseUrl: string,
	queryParams: string,
): string[] {
	const urls: string[] = []
	let batch: string[] = []
	let len = baseUrl.length + (queryParams ? 1 + queryParams.length : 0)

	for (const id of items) {
		const addLen = (batch.length > 0 ? 1 : 0) + id.length
		if (len + addLen <= MAX_URL_LENGTH) {
			batch.push(id)
			len += addLen
		} else {
			if (batch.length)
				urls.push(
					queryParams
						? `${baseUrl}${batch.join(',')}?${queryParams}`
						: `${baseUrl}${batch.join(',')}`,
				)
			batch = [id]
			len =
				baseUrl.length + id.length + (queryParams ? 1 + queryParams.length : 0)
		}
	}
	if (batch.length)
		urls.push(
			queryParams
				? `${baseUrl}${batch.join(',')}?${queryParams}`
				: `${baseUrl}${batch.join(',')}`,
		)
	return urls
}

// ============================================================================
// DASHBOARD
// ============================================================================

function showDashboard(state: CollectorState): void {
	process.stdout.write('\x1B[H')

	const uptime = formatDuration(Date.now() - state.startTime)
	const dbSize = formatBytes(getDatabaseSize())
	const latest = getLatestStats()
	const daily = getDailyStats()
	const sixHour = getSixHourStats()
	const hourly = getHourlyStats()
	const orderBook = getOrderBookStats()

	const W = 100
	const lines: string[] = []

	// Rate limit status
	const queueStatus = state.syncQueue.length > 0 ? ` [${state.syncQueue.length} queued]` : ''
	const rateLimitStatus =
		state.rateLimitedUntil && state.rateLimitedUntil > Date.now()
			? `⏳ Rate limited (${Math.ceil((state.rateLimitedUntil - Date.now()) / 1000)}s)${queueStatus}`
			: state.apiLockHolder
				? `🔒 ${state.apiLockHolder}${queueStatus}`
				: '✅ Ready'

	lines.push(`┌${'─'.repeat(W)}┐`)
	lines.push(`│ ${`ALBION MARKET COLLECTOR`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${` 🌍 Region: ${state.region}`.padEnd(W / 4)}${`⚡ Uptime: ${uptime}`.padEnd(W / 4 - 1)}${`🗃️  DB: ${dbSize}`.padEnd(W / 4)}${`${rateLimitStatus}`.padEnd(W / 4)}│`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Latest Prices
	const latestStatus = state.latestSyncInProgress
		? `Syncing ${state.latestSyncBatch}/${state.latestSyncTotal}`
		: state.lastLatestSync
			? `Last: ${formatTimeAgo(state.lastLatestSync)}`
			: 'Never synced'

	lines.push(`│ ${`💰 LATEST PRICES (5-min sync)`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`📁 Records: ${formatNumber(latest.records)}`.padEnd(W / 4)}${`📦 Items: ${formatNumber(latest.items)}`.padEnd(W / 4)}${`🏙️  Cities: ${String(latest.cities)}`.padEnd(W / 4)}${`${state.latestSyncInProgress ? '🔄' : '✅'} ${latestStatus}`.padEnd(W / 4)}│`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Daily Averages
	const dailyStatus = state.dailySyncInProgress
		? `Syncing ${state.dailySyncBatch}/${state.dailySyncTotal}`
		: state.lastDailySync
			? `Last: ${formatTimeAgo(state.lastDailySync)}`
			: 'Never synced'

	lines.push(`│ ${`📊 DAILY AVERAGES (hourly sync)`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`📁 Records: ${formatNumber(daily.records)}`.padEnd(W / 4)}${`📦 Items: ${formatNumber(daily.items)}`.padEnd(W / 4)}${`📅 Days: ${String(daily.days)}`.padEnd(W / 4 - 2)}${`${state.dailySyncInProgress ? '🔄' : '✅'} ${dailyStatus}`.padEnd(W / 4)}│`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// 6-Hour Averages
	const sixHourStatus = state.sixHourSyncInProgress
		? `Syncing ${state.sixHourSyncBatch}/${state.sixHourSyncTotal}`
		: state.lastSixHourSync
			? `Last: ${formatTimeAgo(state.lastSixHourSync)}`
			: 'Never synced'

	lines.push(`│ ${`📈 6-HOUR AVERAGES (30-min sync)`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`📁 Records: ${formatNumber(sixHour.records)}`.padEnd(W / 4)}${`📦 Items: ${formatNumber(sixHour.items)}`.padEnd(W / 4)}${`🕐 Periods: ${String(sixHour.periods)}`.padEnd(W / 4 - 2)}${`${state.sixHourSyncInProgress ? '🔄' : '✅'} ${sixHourStatus}`.padEnd(W / 4)}│`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// Hourly Averages
	const hourlyStatus = state.hourlySyncInProgress
		? `Syncing ${state.hourlySyncBatch}/${state.hourlySyncTotal}`
		: state.lastHourlySync
			? `Last: ${formatTimeAgo(state.lastHourlySync)}`
			: 'Never synced'

	lines.push(`│ ${`⏱️  HOURLY AVERAGES (15-min sync)`.padEnd(W - 2)}  │`)
	lines.push(
		`│ ${`📁 Records: ${formatNumber(hourly.records)}`.padEnd(W / 4)}${`📦 Items: ${formatNumber(hourly.items)}`.padEnd(W / 4)}${`🕐 Hours: ${String(hourly.hours)}`.padEnd(W / 4 - 2)}${`${state.hourlySyncInProgress ? '🔄' : '✅'} ${hourlyStatus}`.padEnd(W / 4)}│`,
	)
	lines.push(`├${'─'.repeat(W)}┤`)

	// NATS Real-Time Stream
	const natsIcon = state.natsConnected ? '🟢' : '🔴'
	const natsStatus = state.natsConnected ? 'Connected' : 'Disconnected'

	lines.push(`│ ${`📡 REAL-TIME STREAM (NATS)`.padEnd(W - 2)} │`)
	lines.push(
		`│ ${`${natsIcon} ${natsStatus}`.padEnd(W / 4)}${`📦 Orders: ${formatNumber(orderBook.orders)}`.padEnd(W / 4)}${`❓ Unknown: ${formatNumber(state.natsUnknownLocations)}`.padEnd(W / 4 - 3)}${`✅ Last: ${state.lastNatsMessage ? formatTimeAgo(state.lastNatsMessage) : 'Never'}`.padEnd(W / 4)}│`,
	)
	lines.push(`└${'─'.repeat(W)}┘`)

	console.log(lines.join('\n'))
}

function getDailyStats(): { records: number; items: number; days: number } {
	return {
		records: (
			db.prepare('SELECT COUNT(*) as c FROM daily_average_prices').get() as {
				c: number
			}
		).c,
		items: (
			db
				.prepare(
					'SELECT COUNT(DISTINCT item_id) as c FROM daily_average_prices',
				)
				.get() as { c: number }
		).c,
		days: (
			db
				.prepare(
					'SELECT COUNT(DISTINCT substr(timestamp, 1, 10)) as c FROM daily_average_prices',
				)
				.get() as { c: number }
		).c,
	}
}

function getLatestStats(): { records: number; items: number; cities: number } {
	return {
		records: (
			db.prepare('SELECT COUNT(*) as c FROM latest_prices').get() as {
				c: number
			}
		).c,
		items: (
			db
				.prepare('SELECT COUNT(DISTINCT item_id) as c FROM latest_prices')
				.get() as { c: number }
		).c,
		cities: (
			db
				.prepare('SELECT COUNT(DISTINCT city) as c FROM latest_prices')
				.get() as { c: number }
		).c,
	}
}

function getSixHourStats(): {
	records: number
	items: number
	periods: number
} {
	return {
		records: (
			db.prepare('SELECT COUNT(*) as c FROM six_hour_average_prices').get() as {
				c: number
			}
		).c,
		items: (
			db
				.prepare(
					'SELECT COUNT(DISTINCT item_id) as c FROM six_hour_average_prices',
				)
				.get() as { c: number }
		).c,
		periods: (
			db
				.prepare(
					'SELECT COUNT(DISTINCT timestamp) as c FROM six_hour_average_prices',
				)
				.get() as { c: number }
		).c,
	}
}

function getHourlyStats(): { records: number; items: number; hours: number } {
	return {
		records: (
			db.prepare('SELECT COUNT(*) as c FROM hourly_average_prices').get() as {
				c: number
			}
		).c,
		items: (
			db
				.prepare(
					'SELECT COUNT(DISTINCT item_id) as c FROM hourly_average_prices',
				)
				.get() as { c: number }
		).c,
		hours: (
			db
				.prepare(
					'SELECT COUNT(DISTINCT timestamp) as c FROM hourly_average_prices',
				)
				.get() as { c: number }
		).c,
	}
}

function getOrderBookStats(): { orders: number } {
	return {
		orders: (
			db.prepare('SELECT COUNT(*) as c FROM order_book').get() as {
				c: number
			}
		).c,
	}
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

function formatBytes(bytes: number): string {
	if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB'
	if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
	if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
	return bytes + ' B'
}

function formatNumber(num: number): string {
	if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
	if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
	return String(num)
}

function formatTimeAgo(date: Date): string {
	const s = Math.floor((Date.now() - date.getTime()) / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	return `${Math.floor(m / 60)}h ${m % 60}m ago`
}
