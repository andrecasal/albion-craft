// collector.ts
// Background service that syncs daily price averages from AODP API
// NATS subscription is mocked for now but architecture is preserved for future use

import * as readline from 'readline'
import * as https from 'https'
import {
	closeDb,
	getDailyPriceCount,
	getDailyPriceItemCount,
	getDailyPriceDateCount,
	getDailyPriceLocationCount,
	getDatabaseSize,
	clearAllDailyPrices,
	getLatestDailyPriceDate,
	getMissingDailyPriceDates,
	insertDailyPrices,
	cleanupOldDailyPrices,
	saveSyncState,
	getSyncState,
	clearSyncState,
} from './db/db'
import {
	parseRateLimitHeaders,
	calculateWaitTime,
	DEFAULT_RATE_LIMIT_WAIT,
	RateLimitInfo,
} from './utils/rate-limiter'
import { City } from './types'

// ============================================================================
// DAILY PRICE SYNC PROGRESS STATE
// ============================================================================

interface DailyPriceSyncProgress {
	currentBatch: number
	totalBatches: number
	rateLimitWait: number // seconds remaining, 0 if not rate limited
}

let dailyPriceSyncProgress: DailyPriceSyncProgress = {
	currentBatch: 0,
	totalBatches: 0,
	rateLimitWait: 0,
}

function getDailyPriceSyncProgress(): DailyPriceSyncProgress {
	return { ...dailyPriceSyncProgress }
}

function updateDailyPriceSyncProgress(batch: number, total: number): void {
	dailyPriceSyncProgress.currentBatch = batch
	dailyPriceSyncProgress.totalBatches = total
}

function setDailyPriceRateLimitWait(seconds: number): void {
	dailyPriceSyncProgress.rateLimitWait = seconds
}

async function waitWithCountdown(seconds: number): Promise<void> {
	for (let remaining = seconds; remaining > 0; remaining--) {
		setDailyPriceRateLimitWait(remaining)
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
	setDailyPriceRateLimitWait(0)
}

// ============================================================================
// DAILY PRICE CONFIGURATION
// ============================================================================

import { ALL_ITEM_IDS } from './constants/items'
import { table } from 'console'

const ITEMS = ALL_ITEM_IDS

const CITIES: City[] = [
	'Caerleon',
	'Bridgewatch',
	'Fort Sterling',
	'Lymhurst',
	'Martlock',
	'Thetford',
	'Brecilien',
]

// City name to location ID mapping (primary market only)
const CITY_TO_PRIMARY_LOCATION: Record<City, number> = {
	Thetford: 7,
	Martlock: 301,
	'Fort Sterling': 1002,
	Lymhurst: 1006,
	Bridgewatch: 3003,
	Caerleon: 4002,
	Brecilien: 5003,
}

interface DailyPriceFetchConfig {
	maxRetries: number
	initialRetryDelay: number
	maxRetryDelay: number
	backoffMultiplier: number
	jitterRange: number
	requestTimeout: number
	historyDays: number
}

const DAILY_PRICE_CONFIG: DailyPriceFetchConfig = {
	maxRetries: 5,
	initialRetryDelay: 2000,
	maxRetryDelay: 60000,
	backoffMultiplier: 2,
	jitterRange: 0.3,
	requestTimeout: 15000,
	historyDays: 30,
}

const MAX_URL_LENGTH = 8000

// ============================================================================
// DAILY PRICE TYPES
// ============================================================================

interface DailyPriceFetchResult<T = any> {
	success: boolean
	data?: T
	error?: string
	statusCode?: number
	retryable?: boolean
	rateLimitInfo?: RateLimitInfo
}

interface AODPChartRawResponse {
	location: string
	item_id: string
	quality: number
	data: {
		timestamps: string[]
		prices_avg: number[]
		item_count: number[]
	}
}

interface DailyPriceRecord {
	itemId: string
	locationId: number
	date: string
	avgPrice: number
	itemCount: number
}

// ============================================================================
// DAILY PRICE HELPER FUNCTIONS
// ============================================================================

function addJitter(delay: number): number {
	const jitter = delay * DAILY_PRICE_CONFIG.jitterRange
	return delay + (Math.random() * 2 - 1) * jitter
}

function createBatchesByUrlLength(
	items: string[],
	baseUrl: string,
	queryParams: string,
): string[][] {
	const batches: string[][] = []
	const baseLength = baseUrl.length + queryParams.length

	let currentBatch: string[] = []
	let currentLength = baseLength

	for (const itemId of items) {
		const itemLength = itemId.length + (currentBatch.length > 0 ? 1 : 0)
		const newLength = currentLength + itemLength

		if (newLength > MAX_URL_LENGTH && currentBatch.length > 0) {
			batches.push([...currentBatch])
			currentBatch = [itemId]
			currentLength = baseLength + itemId.length
		} else {
			currentBatch.push(itemId)
			currentLength = newLength
		}
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch)
	}

	return batches
}

function makeDailyPriceRequest<T = any>(
	url: string,
): Promise<DailyPriceFetchResult<T>> {
	return new Promise((resolve) => {
		const request = https.get(url, (res) => {
			let data = ''

			res.on('data', (chunk) => {
				data += chunk
			})

			res.on('end', () => {
				if (res.statusCode === 200) {
					try {
						const json = JSON.parse(data) as T
						resolve({
							success: true,
							data: json,
							statusCode: 200,
						})
					} catch (e) {
						const error = e as Error
						resolve({
							success: false,
							error: `Parse error: ${error.message}`,
							statusCode: 200,
							retryable: false,
						})
					}
				} else if (res.statusCode === 429) {
					const rateLimitInfo = parseRateLimitHeaders(
						res.headers as Record<string, string | string[] | undefined>,
					)
					resolve({
						success: false,
						error: 'Rate limited',
						statusCode: 429,
						retryable: true,
						rateLimitInfo: rateLimitInfo || undefined,
					})
				} else if (res.statusCode && res.statusCode >= 500) {
					resolve({
						success: false,
						error: `Server error ${res.statusCode}`,
						statusCode: res.statusCode,
						retryable: true,
					})
				} else {
					resolve({
						success: false,
						error: `HTTP ${res.statusCode}`,
						statusCode: res.statusCode,
						retryable: false,
					})
				}
			})
		})

		request.on('error', (err) => {
			resolve({
				success: false,
				error: err.message,
				retryable: true,
			})
		})

		request.setTimeout(DAILY_PRICE_CONFIG.requestTimeout, () => {
			request.destroy()
			resolve({
				success: false,
				error: 'Timeout',
				retryable: true,
			})
		})
	})
}

async function fetchDailyPriceWithRetry<T = any>(
	url: string,
	attempt: number = 1,
): Promise<DailyPriceFetchResult<T>> {
	const result = await makeDailyPriceRequest<T>(url)

	if (result.success) {
		return result
	}

	const isRateLimited = result.statusCode === 429

	if (
		!result.retryable ||
		(!isRateLimited && attempt >= DAILY_PRICE_CONFIG.maxRetries)
	) {
		return result
	}

	if (isRateLimited) {
		const waitSeconds = result.rateLimitInfo
			? calculateWaitTime(result.rateLimitInfo)
			: DEFAULT_RATE_LIMIT_WAIT

		await waitWithCountdown(waitSeconds)
	} else {
		const baseDelay =
			DAILY_PRICE_CONFIG.initialRetryDelay *
			Math.pow(DAILY_PRICE_CONFIG.backoffMultiplier, attempt - 1)
		const delayWithJitter = addJitter(
			Math.min(baseDelay, DAILY_PRICE_CONFIG.maxRetryDelay),
		)
		const waitSeconds = Math.round(delayWithJitter / 1000)

		await waitWithCountdown(waitSeconds)
	}

	const nextAttempt = isRateLimited ? attempt : attempt + 1
	return fetchDailyPriceWithRetry<T>(url, nextAttempt)
}

function transformDailyPriceResponse(
	rawData: AODPChartRawResponse[],
): DailyPriceRecord[] {
	const records: DailyPriceRecord[] = []

	for (const response of rawData) {
		const { item_id, location, quality, data } = response

		// Only process Normal quality (1)
		if (quality !== 1) continue

		if (!data || !data.timestamps || data.timestamps.length === 0) {
			continue
		}

		// Find the location ID for this city name
		const locationId = CITY_TO_PRIMARY_LOCATION[location as City]
		if (!locationId) continue

		// Convert each timestamp to a record
		for (let i = 0; i < data.timestamps.length; i++) {
			const timestamp = data.timestamps[i]
			const date = timestamp.split('T')[0] // Extract YYYY-MM-DD
			const avgPrice = Math.round(data.prices_avg[i] || 0)
			const itemCount = data.item_count[i] || 0

			if (avgPrice > 0) {
				records.push({
					itemId: item_id,
					locationId,
					date,
					avgPrice,
					itemCount,
				})
			}
		}
	}

	return records
}

// ============================================================================
// DAILY PRICE STATUS AND SYNC
// ============================================================================

/**
 * Check if we need to fetch daily price data
 * Returns the dates that are missing
 */
function getDailyPriceStatus(): {
	totalRecords: number
	latestDate: string | null
	missingDates: string[]
	needsFetch: boolean
} {
	const totalRecords = getDailyPriceCount()
	const latestDate = getLatestDailyPriceDate()
	const missingDates = getMissingDailyPriceDates(DAILY_PRICE_CONFIG.historyDays)

	return {
		totalRecords,
		latestDate,
		missingDates,
		needsFetch: missingDates.length > 0,
	}
}

/**
 * Compute the date range for syncing (last N days, ending yesterday)
 */
function getDailyPriceDateRange(): { dateFrom: string; dateTo: string } {
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(yesterday.getDate() - 1)

	const startDate = new Date(yesterday)
	startDate.setDate(startDate.getDate() - DAILY_PRICE_CONFIG.historyDays + 1)

	return {
		dateFrom: startDate.toISOString().split('T')[0],
		dateTo: yesterday.toISOString().split('T')[0],
	}
}

/**
 * Fetch and store missing daily price data
 * Tracks progress by batch index so we can resume on crash/restart
 */
async function fetchMissingDailyPrices(): Promise<{
	recordsAdded: number
	skipped: boolean
}> {
	// Check for interrupted sync to resume
	const savedState = getSyncState()

	const status = getDailyPriceStatus()

	// Skip if no missing dates AND no saved state to resume
	if (!status.needsFetch && !savedState) {
		return {
			recordsAdded: 0,
			skipped: true,
		}
	}

	// Create item batches (ordered list - same order every time)
	const locationsParam = CITIES.join(',')
	const historyBaseUrl =
		'https://europe.albion-online-data.com/api/v2/stats/charts/'
	const historyQueryParams = `?time-scale=24&locations=${locationsParam}&date=2024-01-01&end_date=2024-01-31`
	const itemBatches = createBatchesByUrlLength(
		ITEMS,
		historyBaseUrl,
		historyQueryParams,
	)

	const totalBatches = itemBatches.length

	// Resume from saved batch or start from 0
	const startBatch = savedState?.currentBatch ?? 0

	// Use fixed date range (last 30 days ending yesterday)
	const { dateFrom, dateTo } = getDailyPriceDateRange()

	let totalRecordsAdded = 0

	for (let i = startBatch; i < totalBatches; i++) {
		updateDailyPriceSyncProgress(i + 1, totalBatches)

		// Save state before fetching so we can resume from this batch
		saveSyncState({
			currentBatch: i,
			totalBatches,
			startedAt: Date.now(),
		})

		const batch = itemBatches[i]
		const itemsParam = batch.join(',')
		const url = `https://europe.albion-online-data.com/api/v2/stats/charts/${itemsParam}?time-scale=24&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`

		const result = await fetchDailyPriceWithRetry<AODPChartRawResponse[]>(url)

		if (result.success && result.data) {
			const records = transformDailyPriceResponse(result.data)
			if (records.length > 0) {
				insertDailyPrices(records)
				totalRecordsAdded += records.length
			}
		}
	}

	// Reset progress and clear state on successful completion
	updateDailyPriceSyncProgress(0, 0)
	clearSyncState()

	// Clean up old data
	cleanupOldDailyPrices(DAILY_PRICE_CONFIG.historyDays)

	return {
		recordsAdded: totalRecordsAdded,
		skipped: false,
	}
}

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
const STATS_INTERVAL = 1000 // 1 second

// How often to sync daily price averages (in ms)
const DAILY_PRICE_SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

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
	statusMessage: string | null
	statusMessageExpiry: number | null
}

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
		statusMessage: null,
		statusMessageExpiry: null,
	}

	const shutdown = async () => {
		await stopCollector(state)
		closeDb()
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	try {
		setupKeyboardInput(state)
		await startCollector(state)
		await new Promise(() => {})
	} catch (err) {
		console.error('Failed to start collector:', err)
		process.exit(1)
	}
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

	mockNatsConnection(state)
	startDailyPriceSyncTimer(state)
	startDashboardTimer(state)
}

const stopCollector = async (state: CollectorState): Promise<void> => {
	if (!state.running) {
		return
	}

	console.log(`\n🛑 Stopping collector...`)
	state.running = false
	stopTimers(state)
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
	// Mark as "connected" for display purposes
	state.natsConnected = true
}

// ============================================================================
// DASHBOARD DISPLAY
// ============================================================================

const setStatusMessage = (
	state: CollectorState,
	message: string,
	durationMs: number = 3000,
): void => {
	state.statusMessage = message
	state.statusMessageExpiry = Date.now() + durationMs
}

const showDashboard = (state: CollectorState): void => {
	const now = Date.now()
	const totalElapsed = now - state.startTime

	const totalRecords = getDailyPriceCount()
	const uniqueItems = getDailyPriceItemCount()
	const uniqueDates = getDailyPriceDateCount()
	const uniqueLocations = getDailyPriceLocationCount()
	const dbSize = getDatabaseSize()
	const historyStatus = getDailyPriceStatus()

	process.stdout.write('\x1B[H\x1B[J')

	const uptime = formatUptime(totalElapsed)
	const tableWidth = 100
	const paddingWidth = 1
	const W = '─'.repeat(tableWidth + paddingWidth * 2)
	const lines: string[] = []

	// Header
	lines.push(`┌${W}┐`)
	const padding = ' '.repeat(paddingWidth)
	const titleText = `${`📊 ALBION MARKET DATA COLLECTOR`.padEnd(tableWidth / 2)}${`> ${state.region}`.padEnd(tableWidth / 2)}`
	lines.push(`│${padding}${titleText.padEnd(tableWidth)}${padding}│`)
	const statusText = `${`Uptime: ${uptime}`.padEnd(tableWidth / 2)}${`Database: ${formatBytes(dbSize)}`.padEnd(tableWidth / 2)}`
	lines.push(`│${padding}${statusText.padEnd(tableWidth)}${padding}│`)
	lines.push(`├${W}┤`)

	// Section 1: Daily Price Averages (24h)
	lines.push(`│${padding}${`📅 Daily Averages`.padEnd(tableWidth)}${padding}│`)
	const itemsPercent =
		ITEMS.length > 0 ? ((uniqueItems / ITEMS.length) * 100).toFixed(1) : '0.0'
	const items =
		`Items: ${formatNumber(uniqueItems)}/${formatNumber(ITEMS.length)} (${itemsPercent}%)`.padEnd(
			tableWidth / 3,
		)
	const cities = `Cities: ${uniqueLocations}`.padEnd(tableWidth / 3)
	const days = `Days: ${uniqueDates}`.padEnd(tableWidth / 3 + 1)
	lines.push(`│${padding}${items}${cities}${days}${padding}│`)
	const expectedRecords =
		ITEMS.length * CITIES.length * DAILY_PRICE_CONFIG.historyDays
	const recordsPercent =
		expectedRecords > 0
			? ((totalRecords / expectedRecords) * 100).toFixed(1)
			: '0.0'
	const records =
		`Records: ${formatNumber(totalRecords, true)}/${formatNumber(expectedRecords, true)} (${recordsPercent}%)`.padEnd(
			tableWidth / 3,
		)
	const latest = `Latest: ${historyStatus.latestDate || 'None'}`.padEnd(
		tableWidth / 3,
	)
	const progress = getDailyPriceSyncProgress()
	let syncStatus: string
	if (state.historySyncInProgress) {
		if (progress.rateLimitWait > 0) {
			syncStatus = `${progress.currentBatch}/${progress.totalBatches} (${progress.rateLimitWait}s)`
		} else if (progress.totalBatches > 0) {
			syncStatus = `${progress.currentBatch}/${progress.totalBatches}`
		} else {
			syncStatus = 'Starting...'
		}
	} else {
		syncStatus = formatTimeAgo(state.lastHistorySync)
	}
	const sync = `Sync: ${syncStatus}`.padEnd(tableWidth / 3 + 1)
	lines.push(`│${padding}${records}${latest}${sync}${padding}│`)
	lines.push(`├${W}┤`)

	// Section 2: Hourly Price Averages (1h) - placeholder
	lines.push(`│  ${'⏰ HOURLY AVERAGES (1h scale)'.padEnd(68)}│`)
	lines.push(`│     ${'Not implemented yet'.padEnd(64)}│`)
	lines.push(`├${W}┤`)

	// Section 3: Real-time Stream - placeholder
	const natsIcon = state.natsConnected ? '🟡' : '⚫'
	const natsStatus = state.natsConnected ? 'Mocked' : 'Disconnected'
	lines.push(`│  ${natsIcon} ${'REAL-TIME STREAM (NATS)'.padEnd(66)}│`)
	lines.push(`│     ${`Status: ${natsStatus}`.padEnd(64)}│`)
	lines.push(`├${W}┤`)

	// Status message (if any and not expired)
	if (
		state.statusMessage &&
		state.statusMessageExpiry &&
		now < state.statusMessageExpiry
	) {
		lines.push(`│  ⚠️  ${state.statusMessage.padEnd(65)}│`)
		lines.push(`├${W}┤`)
	} else if (state.statusMessage) {
		state.statusMessage = null
		state.statusMessageExpiry = null
	}

	// Keyboard shortcuts
	lines.push(`│  ${'[s] Sync daily   [d] Clear daily   [q] Quit'.padEnd(68)}│`)
	lines.push(`└${W}┘`)

	console.log(lines.join('\n'))
}

// ============================================================================
// TIMERS
// ============================================================================

const startDailyPriceSyncTimer = (state: CollectorState): void => {
	// Initial sync after a short delay
	setTimeout(() => {
		syncDailyPrices(state)
	}, 1000)

	// Then sync periodically
	state.historyTimer = setInterval(() => {
		syncDailyPrices(state)
	}, DAILY_PRICE_SYNC_INTERVAL)
}

const startDashboardTimer = (state: CollectorState): void => {
	state.statsTimer = setInterval(() => {
		showDashboard(state)
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
// KEYBOARD INPUT
// ============================================================================

const setupKeyboardInput = (state: CollectorState): void => {
	readline.emitKeypressEvents(process.stdin)
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
	}

	process.stdin.on('keypress', (_str, key) => {
		if (!key) return

		// Ctrl+C to quit
		if (key.ctrl && key.name === 'c') {
			process.emit('SIGINT')
			return
		}

		switch (key.name) {
			case 's':
				// Force sync daily prices
				if (!state.historySyncInProgress) {
					syncDailyPrices(state, true)
					showDashboard(state)
				}
				break
			case 'd':
				// Reset daily prices
				if (state.historySyncInProgress) {
					setStatusMessage(state, 'Cannot delete while sync is in progress')
					showDashboard(state)
				} else {
					clearAllDailyPrices()
					state.lastHistorySync = null
					showDashboard(state)
				}
				break
			case 'q':
				// Quit
				process.emit('SIGINT')
				break
		}
	})

	process.stdin.resume()
}

// ============================================================================
// DAILY PRICE SYNC
// ============================================================================

const syncDailyPrices = async (
	state: CollectorState,
	force: boolean = false,
): Promise<void> => {
	if (state.historySyncInProgress) return

	const historyStatus = getDailyPriceStatus()

	if (!force && !historyStatus.needsFetch) return

	state.historySyncInProgress = true

	try {
		const result = await fetchMissingDailyPrices()
		if (!result.skipped && result.recordsAdded > 0) {
			state.lastHistorySync = new Date()
		}
	} catch {
		// Error handled silently - dashboard shows sync status
	} finally {
		state.historySyncInProgress = false
	}
}

// ============================================================================
// EXPORTS (for programmatic use)
// ============================================================================

export { startCollector, stopCollector, CollectorState, getDailyPriceStatus }

// ============================================================================
// PURE HELPER FUNCTIONS
// ============================================================================

const formatNumber = (num: number, abbreviate: boolean = false): string => {
	if (abbreviate) {
		if (num >= 1000000) {
			return (num / 1000000).toFixed(1) + 'm'
		}
		if (num >= 1000) {
			return (num / 1000).toFixed(1) + 'k'
		}
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
// ENTRY POINT
// ============================================================================

if (require.main === module) {
	main()
}
