import * as readline from 'readline'
import * as https from 'https'
import { closeDb, getDatabaseSize } from './db'
import { db } from './db'
import { City } from './types'
import { ALL_ITEM_IDS } from './constants/items'

// ============================================================================
// TYPES
// ============================================================================

type Region = 'europe' | 'americas' | 'asia'

interface RateLimitInfo {
	limit: number
	remaining: number
	resetTimestamp: number // Unix timestamp in seconds
}

interface CollectorState {
	region: Region
	natsConnected: boolean // Would be connected if not mocked
	running: boolean
	startTime: number
	lastHistorySync: Date | null
	historySyncInProgress: boolean
	lastLatestSync: Date | null
	latestSyncInProgress: boolean
	statsTimer: NodeJS.Timeout | null
	historyTimer: NodeJS.Timeout | null
	latestTimer: NodeJS.Timeout | null
	statusMessage: string | null
	statusMessageExpiry: number | null
}

interface DailyPriceSyncProgress {
	currentBatch: number
	totalBatches: number
	rateLimitWait: number // seconds remaining, 0 if not rate limited
}

interface LatestPriceSyncProgress {
	currentBatch: number
	totalBatches: number
	rateLimitWait: number // seconds remaining, 0 if not rate limited
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
// CONFIGURATION
// ============================================================================

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

// How often to sync latest prices (in ms)
const LATEST_PRICE_SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

// Default fallback wait time when headers are missing (in seconds)
const DEFAULT_RATE_LIMIT_WAIT = 10

// ============================================================================
// RATE LIMITER
// ============================================================================

/**
 * Parse rate limit headers from a 429 response
 */
function parseRateLimitHeaders(
	headers: Record<string, string | string[] | undefined>,
): RateLimitInfo | null {
	const limit = headers['ratelimit-limit']
	const remaining = headers['ratelimit-remaining']
	const reset = headers['ratelimit-reset']

	if (limit === undefined || remaining === undefined || reset === undefined) {
		return null
	}

	return {
		limit: parseInt(String(limit), 10),
		remaining: parseInt(String(remaining), 10),
		resetTimestamp: parseInt(String(reset), 10),
	}
}

/**
 * Calculate how many seconds to wait based on rate limit info
 */
function calculateWaitTime(rateLimitInfo: RateLimitInfo): number {
	const nowSeconds = Math.floor(Date.now() / 1000)
	const waitSeconds = rateLimitInfo.resetTimestamp - nowSeconds
	// Add 1 second buffer to be safe, minimum 1 second wait
	return Math.max(1, waitSeconds + 1)
}

// ============================================================================
// STATE
// ============================================================================

let dailyPriceSyncProgress: DailyPriceSyncProgress = {
	currentBatch: 0,
	totalBatches: 0,
	rateLimitWait: 0,
}

let latestPriceSyncProgress: LatestPriceSyncProgress = {
	currentBatch: 0,
	totalBatches: 0,
	rateLimitWait: 0,
}

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
	const state: CollectorState = {
		region: (process.env.ALBION_REGION as Region) || 'europe',
		natsConnected: false,
		running: false,
		startTime: Date.now(),
		lastHistorySync: null,
		historySyncInProgress: false,
		lastLatestSync: null,
		latestSyncInProgress: false,
		statsTimer: null,
		historyTimer: null,
		latestTimer: null,
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
// KEYBOARD INPUT (called first in main)
// ============================================================================

function setupKeyboardInput(state: CollectorState): void {
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
// COLLECTOR LIFECYCLE (called second in main)
// ============================================================================

async function startCollector(state: CollectorState): Promise<void> {
	if (state.running) {
		console.log('Collector is already running')
		return
	}

	state.running = true
	state.startTime = Date.now()

	mockNatsConnection(state)
	startDailyPriceSyncTimer(state)
	startLatestPriceSyncTimer(state)
	startDashboardTimer(state)
}

async function stopCollector(state: CollectorState): Promise<void> {
	if (!state.running) {
		return
	}

	console.log(`\n🛑 Stopping collector...`)
	state.running = false
	stopTimers(state)
	console.log(`👋 Collector stopped\n`)
}

// ============================================================================
// NATS CONNECTION (called by startCollector)
// ============================================================================

/**
 * Mock NATS connection - preserves architecture for future real-time integration
 * When ready to enable real orders, replace this with actual NATS connection
 */
function mockNatsConnection(state: CollectorState): void {
	// Mark as "connected" for display purposes
	state.natsConnected = true
}

// ============================================================================
// TIMERS (called by startCollector)
// ============================================================================

function startDailyPriceSyncTimer(state: CollectorState): void {
	// Initial sync after latest has a chance to start first
	setTimeout(() => {
		syncDailyPrices(state)
	}, 2000)

	// Then sync periodically
	state.historyTimer = setInterval(() => {
		syncDailyPrices(state)
	}, DAILY_PRICE_SYNC_INTERVAL)
}

function startLatestPriceSyncTimer(state: CollectorState): void {
	// Initial sync first - latest data has priority for fresh prices
	setTimeout(() => {
		syncLatestPrices(state)
	}, 1000)

	// Then sync periodically
	state.latestTimer = setInterval(() => {
		syncLatestPrices(state)
	}, LATEST_PRICE_SYNC_INTERVAL)
}

function startDashboardTimer(state: CollectorState): void {
	state.statsTimer = setInterval(() => {
		showDashboard(state)
	}, STATS_INTERVAL)
}

function stopTimers(state: CollectorState): void {
	if (state.statsTimer) {
		clearInterval(state.statsTimer)
		state.statsTimer = null
	}
	if (state.historyTimer) {
		clearInterval(state.historyTimer)
		state.historyTimer = null
	}
	if (state.latestTimer) {
		clearInterval(state.latestTimer)
		state.latestTimer = null
	}
}

// ============================================================================
// DAILY PRICE SYNC (called by timer and keyboard input)
// ============================================================================

async function syncDailyPrices(
	state: CollectorState,
	force: boolean = false,
): Promise<void> {
	// Don't run if already syncing or if latest sync is in progress
	if (state.historySyncInProgress || state.latestSyncInProgress) return

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
// LATEST PRICE SYNC (called by timer)
// ============================================================================

async function syncLatestPrices(state: CollectorState): Promise<void> {
	// Don't run if already syncing or if daily sync is in progress
	if (state.latestSyncInProgress || state.historySyncInProgress) return

	const latestStatus = getLatestPriceStatus()

	// Always sync latest - we want fresh data
	if (!latestStatus.needsFetch) return

	state.latestSyncInProgress = true

	try {
		const result = await fetchLatestPrices()
		if (!result.skipped && result.recordsAdded > 0) {
			state.lastLatestSync = new Date()
		}
	} catch {
		// Error handled silently - dashboard shows sync status
	} finally {
		state.latestSyncInProgress = false
	}
}

// ============================================================================
// LATEST PRICE STATUS (called by syncLatestPrices and showDashboard)
// ============================================================================

/**
 * Check if we need to fetch latest price data
 * We need to fetch if data is older than 1 hour
 */
function getLatestPriceStatus(): {
	totalRecords: number
	latestTimestamp: string | null
	needsFetch: boolean
} {
	const totalRecords = getLatestPriceCount()
	const latestTimestamp = getLatestPriceTimestamp()

	// Need to fetch if no data or data is older than 1 hour
	let needsFetch = true
	if (latestTimestamp) {
		const latestDate = new Date(latestTimestamp)
		const now = new Date()
		const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
		needsFetch = latestDate < hourAgo
	}

	return {
		totalRecords,
		latestTimestamp,
		needsFetch,
	}
}

// ============================================================================
// FETCH LATEST PRICES (called by syncLatestPrices)
// ============================================================================

interface LatestPriceRecord {
	itemId: string
	locationId: number
	timestamp: string
	avgPrice: number
	itemCount: number
}

/**
 * Fetch and store latest price data (most recent data point only)
 */
async function fetchLatestPrices(): Promise<{
	recordsAdded: number
	skipped: boolean
}> {
	// Check for interrupted sync to resume
	const savedState = getLatestSyncState()

	// Create item batches (ordered list - same order every time)
	const locationsParam = CITIES.join(',')
	const latestBaseUrl =
		'https://europe.albion-online-data.com/api/v2/stats/charts/'
	const latestQueryParams = `?time-scale=1&locations=${locationsParam}`
	const itemBatches = createBatchesByUrlLength(
		ITEMS,
		latestBaseUrl,
		latestQueryParams,
	)

	const totalBatches = itemBatches.length

	// Resume from saved batch or start from 0
	const startBatch = savedState?.currentBatch ?? 0

	// Get the date range for the last hour
	const now = new Date()
	const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
	const dateFrom = oneHourAgo.toISOString().split('T')[0]
	const dateTo = now.toISOString().split('T')[0]

	let totalRecordsAdded = 0

	for (let i = startBatch; i < totalBatches; i++) {
		updateLatestPriceSyncProgress(i + 1, totalBatches)

		// Save state before fetching so we can resume from this batch
		saveLatestSyncState({
			currentBatch: i,
			totalBatches,
			startedAt: Date.now(),
		})

		const batch = itemBatches[i]
		const itemsParam = batch.join(',')
		const url = `https://europe.albion-online-data.com/api/v2/stats/charts/${itemsParam}?time-scale=1&locations=${locationsParam}&date=${dateFrom}&end_date=${dateTo}`

		const result =
			await fetchLatestPriceWithRetry<AODPChartRawResponse[]>(url)

		if (result.success && result.data) {
			const records = transformLatestPriceResponse(result.data)
			if (records.length > 0) {
				insertLatestPrices(records)
				totalRecordsAdded += records.length
			}
		}
	}

	// Reset progress and clear state on successful completion
	updateLatestPriceSyncProgress(0, 0)
	clearLatestSyncState()

	return {
		recordsAdded: totalRecordsAdded,
		skipped: false,
	}
}

/**
 * Transform raw API response to latest price records
 * Only keeps the most recent data point for each item/location
 */
function transformLatestPriceResponse(
	rawData: AODPChartRawResponse[],
): LatestPriceRecord[] {
	const records: LatestPriceRecord[] = []

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

		// Get the most recent data point (last in the array)
		const lastIndex = data.timestamps.length - 1
		const timestamp = data.timestamps[lastIndex]
		const avgPrice = Math.round(data.prices_avg[lastIndex] || 0)
		const itemCount = data.item_count[lastIndex] || 0

		if (avgPrice > 0) {
			records.push({
				itemId: item_id,
				locationId,
				timestamp,
				avgPrice,
				itemCount,
			})
		}
	}

	return records
}

// ============================================================================
// LATEST PRICE DATABASE OPERATIONS
// ============================================================================

function getLatestPriceCount(): number {
	const row = db
		.prepare('SELECT COUNT(*) as count FROM latest_prices')
		.get() as { count: number }
	return row.count
}

function getLatestPriceTimestamp(): string | null {
	const row = db
		.prepare('SELECT MAX(timestamp) as latest FROM latest_prices')
		.get() as { latest: string | null } | undefined
	return row?.latest ?? null
}

function insertLatestPrices(records: LatestPriceRecord[]): void {
	const insertStmt = db.prepare(`
		INSERT OR REPLACE INTO latest_prices
		(item_id, location_id, timestamp, avg_price, item_count, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`)

	const now = Date.now()
	const transaction = db.transaction((records: LatestPriceRecord[]) => {
		for (const record of records) {
			insertStmt.run(
				record.itemId,
				record.locationId,
				record.timestamp,
				record.avgPrice,
				record.itemCount,
				now,
			)
		}
	})

	transaction(records)
}

function getLatestPriceItemCount(): number {
	const row = db
		.prepare(
			'SELECT COUNT(DISTINCT item_id) as count FROM latest_prices',
		)
		.get() as { count: number }
	return row.count
}

function getLatestPriceLocationCount(): number {
	const row = db
		.prepare(
			'SELECT COUNT(DISTINCT location_id) as count FROM latest_prices',
		)
		.get() as { count: number }
	return row.count
}

// ============================================================================
// LATEST SYNC PROGRESS STATE
// ============================================================================

interface LatestSyncState {
	currentBatch: number
	totalBatches: number
	startedAt: number
}

function saveLatestSyncState(state: LatestSyncState): void {
	db.prepare(
		`
		INSERT OR REPLACE INTO latest_prices_sync_progress (id, current_batch, total_batches, started_at)
		VALUES (1, ?, ?, ?)
	`,
	).run(state.currentBatch, state.totalBatches, state.startedAt)
}

function getLatestSyncState(): LatestSyncState | null {
	const row = db
		.prepare(
			'SELECT current_batch, total_batches, started_at FROM latest_prices_sync_progress WHERE id = 1',
		)
		.get() as
		| { current_batch: number; total_batches: number; started_at: number }
		| undefined

	if (!row) return null

	return {
		currentBatch: row.current_batch,
		totalBatches: row.total_batches,
		startedAt: row.started_at,
	}
}

function clearLatestSyncState(): void {
	db.prepare('DELETE FROM latest_prices_sync_progress WHERE id = 1').run()
}

function getLatestPriceSyncProgress(): LatestPriceSyncProgress {
	return { ...latestPriceSyncProgress }
}

function updateLatestPriceSyncProgress(batch: number, total: number): void {
	latestPriceSyncProgress.currentBatch = batch
	latestPriceSyncProgress.totalBatches = total
}

function setLatestPriceRateLimitWait(seconds: number): void {
	latestPriceSyncProgress.rateLimitWait = seconds
}

// ============================================================================
// FETCH LATEST WITH RETRY
// ============================================================================

async function fetchLatestPriceWithRetry<T = any>(
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

		await waitWithCountdownLatest(waitSeconds)
	} else {
		const baseDelay =
			DAILY_PRICE_CONFIG.initialRetryDelay *
			Math.pow(DAILY_PRICE_CONFIG.backoffMultiplier, attempt - 1)
		const delayWithJitter = addJitter(
			Math.min(baseDelay, DAILY_PRICE_CONFIG.maxRetryDelay),
		)
		const waitSeconds = Math.round(delayWithJitter / 1000)

		await waitWithCountdownLatest(waitSeconds)
	}

	const nextAttempt = isRateLimited ? attempt : attempt + 1
	return fetchLatestPriceWithRetry<T>(url, nextAttempt)
}

async function waitWithCountdownLatest(seconds: number): Promise<void> {
	for (let remaining = seconds; remaining > 0; remaining--) {
		setLatestPriceRateLimitWait(remaining)
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
	setLatestPriceRateLimitWait(0)
}

// ============================================================================
// DAILY PRICE STATUS (called by syncDailyPrices and showDashboard)
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

// ============================================================================
// FETCH MISSING DAILY PRICES (called by syncDailyPrices)
// ============================================================================

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
// BATCH CREATION (called by fetchMissingDailyPrices)
// ============================================================================

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

// ============================================================================
// DATE RANGE (called by fetchMissingDailyPrices)
// ============================================================================

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

// ============================================================================
// FETCH WITH RETRY (called by fetchMissingDailyPrices)
// ============================================================================

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

// ============================================================================
// HTTP REQUEST (called by fetchDailyPriceWithRetry)
// ============================================================================

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

// ============================================================================
// RESPONSE TRANSFORMATION (called by fetchMissingDailyPrices)
// ============================================================================

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
// SYNC PROGRESS STATE (called by fetchMissingDailyPrices and showDashboard)
// ============================================================================

function getDailyPriceSyncProgress(): DailyPriceSyncProgress {
	return { ...dailyPriceSyncProgress }
}

interface SyncState {
	currentBatch: number
	totalBatches: number
	startedAt: number
}

function saveSyncState(state: SyncState): void {
	db.prepare(
		`
		INSERT OR REPLACE INTO daily_prices_averages_sync_progress (id, current_batch, total_batches, started_at)
		VALUES (1, ?, ?, ?)
	`,
	).run(state.currentBatch, state.totalBatches, state.startedAt)
}

function getSyncState(): SyncState | null {
	const row = db
		.prepare(
			'SELECT current_batch, total_batches, started_at FROM daily_prices_averages_sync_progress WHERE id = 1',
		)
		.get() as
		| { current_batch: number; total_batches: number; started_at: number }
		| undefined

	if (!row) return null

	return {
		currentBatch: row.current_batch,
		totalBatches: row.total_batches,
		startedAt: row.started_at,
	}
}

function clearSyncState(): void {
	db.prepare('DELETE FROM daily_prices_averages_sync_progress WHERE id = 1').run()
}

function updateDailyPriceSyncProgress(batch: number, total: number): void {
	dailyPriceSyncProgress.currentBatch = batch
	dailyPriceSyncProgress.totalBatches = total
}

function setDailyPriceRateLimitWait(seconds: number): void {
	dailyPriceSyncProgress.rateLimitWait = seconds
}

// ============================================================================
// WAIT WITH COUNTDOWN (called by fetchDailyPriceWithRetry)
// ============================================================================

async function waitWithCountdown(seconds: number): Promise<void> {
	for (let remaining = seconds; remaining > 0; remaining--) {
		setDailyPriceRateLimitWait(remaining)
		await new Promise((resolve) => setTimeout(resolve, 1000))
	}
	setDailyPriceRateLimitWait(0)
}

// ============================================================================
// RETRY HELPERS (called by fetchDailyPriceWithRetry)
// ============================================================================

function addJitter(delay: number): number {
	const jitter = delay * DAILY_PRICE_CONFIG.jitterRange
	return delay + (Math.random() * 2 - 1) * jitter
}

// ============================================================================
// DASHBOARD DISPLAY (called by timer and keyboard input)
// ============================================================================

function setStatusMessage(
	state: CollectorState,
	message: string,
	durationMs: number = 3000,
): void {
	state.statusMessage = message
	state.statusMessageExpiry = Date.now() + durationMs
}

function showDashboard(state: CollectorState): void {
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

	// Section 2: Latest Prices
	const latestStatus = getLatestPriceStatus()
	const latestUniqueItems = getLatestPriceItemCount()
	const latestUniqueLocations = getLatestPriceLocationCount()
	lines.push(`│${padding}${`💰 Latest Prices`.padEnd(tableWidth)}${padding}│`)
	const latestItemsPercent =
		ITEMS.length > 0
			? ((latestUniqueItems / ITEMS.length) * 100).toFixed(1)
			: '0.0'
	const latestItems =
		`Items: ${formatNumber(latestUniqueItems)}/${formatNumber(ITEMS.length)} (${latestItemsPercent}%)`.padEnd(
			tableWidth / 3,
		)
	const latestCities = `Cities: ${latestUniqueLocations}`.padEnd(tableWidth / 3)
	const latestLabel = ``.padEnd(tableWidth / 3 + 1)
	lines.push(`│${padding}${latestItems}${latestCities}${latestLabel}${padding}│`)
	const latestExpectedRecords = ITEMS.length * CITIES.length
	const latestRecordsPercent =
		latestExpectedRecords > 0
			? ((latestStatus.totalRecords / latestExpectedRecords) * 100).toFixed(1)
			: '0.0'
	const latestRecords =
		`Records: ${formatNumber(latestStatus.totalRecords, true)}/${formatNumber(latestExpectedRecords, true)} (${latestRecordsPercent}%)`.padEnd(
			tableWidth / 3,
		)
	const latestTimestampDisplay = `Latest: ${latestStatus.latestTimestamp ? formatHourAgo(latestStatus.latestTimestamp) : 'None'}`.padEnd(
		tableWidth / 3,
	)
	const latestProgress = getLatestPriceSyncProgress()
	let latestSyncStatus: string
	if (state.latestSyncInProgress) {
		if (latestProgress.rateLimitWait > 0) {
			latestSyncStatus = `${latestProgress.currentBatch}/${latestProgress.totalBatches} (${latestProgress.rateLimitWait}s)`
		} else if (latestProgress.totalBatches > 0) {
			latestSyncStatus = `${latestProgress.currentBatch}/${latestProgress.totalBatches}`
		} else {
			latestSyncStatus = 'Starting...'
		}
	} else {
		latestSyncStatus = formatTimeAgo(state.lastLatestSync)
	}
	const latestSync = `Sync: ${latestSyncStatus}`.padEnd(tableWidth / 3 + 1)
	lines.push(`│${padding}${latestRecords}${latestTimestampDisplay}${latestSync}${padding}│`)
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
// FORMATTING HELPERS (called by showDashboard)
// ============================================================================

function formatNumber(num: number, abbreviate: boolean = false): string {
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

function formatUptime(ms: number): string {
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

function formatBytes(bytes: number): string {
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

function formatTimeAgo(date: Date | null): string {
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

function formatHourAgo(isoTimestamp: string): string {
	const date = new Date(isoTimestamp)
	const ms = Date.now() - date.getTime()
	const minutes = Math.floor(ms / 1000 / 60)
	if (minutes < 60) {
		return `${minutes}m ago`
	}
	const hours = Math.floor(minutes / 60)
	if (hours < 24) {
		return `${hours}h ago`
	}
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

function getLatestDailyPriceDate(): string | null {
	const row = db
		.prepare('SELECT MAX(date) as latest FROM daily_price_averages')
		.get() as { latest: string | null } | undefined
	return row?.latest ?? null
}

function getMissingDailyPriceDates(daysToKeep: number = 30): string[] {
	const missingDates: string[] = []
	const yesterday = new Date()
	yesterday.setDate(yesterday.getDate() - 1)

	for (let i = 0; i < daysToKeep; i++) {
		const date = new Date(yesterday)
		date.setDate(date.getDate() - i)
		const dateStr = date.toISOString().split('T')[0]

		const row = db
			.prepare('SELECT 1 FROM daily_price_averages WHERE date = ? LIMIT 1')
			.get(dateStr)

		if (!row) {
			missingDates.push(dateStr)
		}
	}

	return missingDates
}

function getDailyPriceCount(): number {
	const row = db
		.prepare('SELECT COUNT(*) as count FROM daily_price_averages')
		.get() as { count: number }
	return row.count
}

function getDailyPriceItemCount(): number {
	const row = db
		.prepare(
			'SELECT COUNT(DISTINCT item_id) as count FROM daily_price_averages',
		)
		.get() as { count: number }
	return row.count
}

function getDailyPriceDateCount(): number {
	const row = db
		.prepare('SELECT COUNT(DISTINCT date) as count FROM daily_price_averages')
		.get() as { count: number }
	return row.count
}

function getDailyPriceLocationCount(): number {
	const row = db
		.prepare(
			'SELECT COUNT(DISTINCT location_id) as count FROM daily_price_averages',
		)
		.get() as { count: number }
	return row.count
}

function insertDailyPrices(
	records: Array<{
		itemId: string
		locationId: number
		date: string
		avgPrice: number
		itemCount: number
	}>,
): void {
	const insertStmt = db.prepare(`
		INSERT OR REPLACE INTO daily_price_averages
		(item_id, location_id, date, avg_price, item_count, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`)

	const now = Date.now()
	const transaction = db.transaction((records: (typeof arguments)[0]) => {
		for (const record of records) {
			insertStmt.run(
				record.itemId,
				record.locationId,
				record.date,
				record.avgPrice,
				record.itemCount,
				now,
			)
		}
	})

	transaction(records)
}

function getDailyPrices(
	itemId: string,
	days: number = 30,
): Array<{
	locationId: number
	date: string
	avgPrice: number
	itemCount: number
}> {
	const cutoffDate = new Date()
	cutoffDate.setDate(cutoffDate.getDate() - days)
	const cutoffStr = cutoffDate.toISOString().split('T')[0]

	return db
		.prepare(
			`
			SELECT location_id as locationId, date, avg_price as avgPrice, item_count as itemCount
			FROM daily_price_averages
			WHERE item_id = ? AND date >= ?
			ORDER BY date DESC
		`,
		)
		.all(itemId, cutoffStr) as Array<{
		locationId: number
		date: string
		avgPrice: number
		itemCount: number
	}>
}

function get30DayAverage(
	itemId: string,
	locationIds: number[],
): { avgPrice: number; totalVolume: number; dataPoints: number } | null {
	const placeholders = locationIds.map(() => '?').join(',')
	const cutoffDate = new Date()
	cutoffDate.setDate(cutoffDate.getDate() - 30)
	const cutoffStr = cutoffDate.toISOString().split('T')[0]

	const rows = db
		.prepare(
			`
			SELECT avg_price, item_count
			FROM daily_price_averages
			WHERE item_id = ? AND location_id IN (${placeholders}) AND date >= ?
		`,
		)
		.all(itemId, ...locationIds, cutoffStr) as Array<{
		avg_price: number
		item_count: number
	}>

	if (rows.length === 0) {
		return null
	}

	let totalPrice = 0
	let totalVolume = 0

	for (const row of rows) {
		totalPrice += row.avg_price
		totalVolume += row.item_count
	}

	return {
		avgPrice: Math.round(totalPrice / rows.length),
		totalVolume,
		dataPoints: rows.length,
	}
}

function cleanupOldDailyPrices(daysToKeep: number = 30): number {
	const cutoffDate = new Date()
	cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)
	const cutoffStr = cutoffDate.toISOString().split('T')[0]

	const result = db
		.prepare('DELETE FROM daily_price_averages WHERE date < ?')
		.run(cutoffStr)

	return result.changes
}

function clearAllDailyPrices(): number {
	const result = db.prepare('DELETE FROM daily_price_averages').run()
	return result.changes
}
