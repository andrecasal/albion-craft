import 'dotenv/config'
import { closeDb, db } from './db'
import { ALL_ITEM_IDS } from './constants/items'

const MAX_URL_LENGTH = 4096
const LATEST_PRICES_STALENESS_MS = 5 * 60 * 1000 // 5 minutes

type Region = 'europe' | 'americas' | 'asia'
type CollectorState = {
	region: Region
	startTime: number
}

function checkEnv(): void {
	const validRegions = ['europe', 'americas', 'asia']
	const region = process.env.ALBION_REGION
	if (!region || !validRegions.includes(region)) {
		throw new Error(
			`Invalid or missing ALBION_REGION environment variable. Add one of these values to your .env file: ${validRegions.join(
				', ',
			)}`,
		)
	}
}

async function main(): Promise<void> {
	checkEnv()

	const shutdown = async () => {
		closeDb()
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	//mockNatsConnection(state)
	await fetchDailyAveragePrices()
	await fetchLatestPrices()
	//startLatestPriceSyncTimer(state)
	//startDashboard(dashboard)
}

if (require.main === module) {
	main()
}

interface MarketHistoryDataPoint {
	item_count: number
	avg_price: number
	timestamp: string
}

interface MarketHistoriesResponse {
	location: string
	item_id: string
	quality: number
	data: MarketHistoryDataPoint[]
}

interface LatestPriceResponse {
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

async function fetchDailyAveragePrices(): Promise<void> {
	// Check if we already have yesterday's data (if so, data is complete)
	const yesterday = new Date()
	yesterday.setDate(yesterday.getDate() - 1)
	const yesterdayDateStr = yesterday.toISOString().split('T')[0]

	const existingData = db
		.prepare(`SELECT 1 FROM daily_average_prices WHERE timestamp LIKE ? LIMIT 1`)
		.get(`${yesterdayDateStr}%`)

	if (existingData) {
		console.log(`Daily average prices already up to date (have data for ${yesterdayDateStr})`)
		return
	}

	const queryParams = `time-scale=24`
	const baseUrl = `https://europe.albion-online-data.com/api/v2/stats/history/`

	// Build batched URLs, maximizing item IDs per URL while staying under MAX_URL_LENGTH
	const urls: string[] = []
	let currentBatch: string[] = []
	let currentUrlLength = baseUrl.length + 1 + queryParams.length // +1 for '?'

	for (const id of ALL_ITEM_IDS) {
		// Calculate length if we add this ID (comma separator if not first item in batch)
		const separatorLength = currentBatch.length > 0 ? 1 : 0 // comma
		const potentialLength = currentUrlLength + separatorLength + id.length

		if (potentialLength <= MAX_URL_LENGTH) {
			// ID fits in current batch
			currentBatch.push(id)
			currentUrlLength = potentialLength
		} else {
			// ID doesn't fit, finalize current batch and start new one
			if (currentBatch.length > 0) {
				urls.push(`${baseUrl}${currentBatch.join(',')}?${queryParams}`)
			}
			// Start new batch with current ID
			currentBatch = [id]
			currentUrlLength = baseUrl.length + id.length + 1 + queryParams.length
		}
	}

	// Don't forget the last batch
	if (currentBatch.length > 0) {
		urls.push(`${baseUrl}${currentBatch.join(',')}?${queryParams}`)
	}

	console.log(`Fetching daily average prices: ${ALL_ITEM_IDS.length} items with ${urls.length} requests`)

	// Prepare insert statement
	const insertStmt = db.prepare(`
		INSERT OR REPLACE INTO daily_average_prices
		(item_id, location, quality, timestamp, item_count, avg_price)
		VALUES (?, ?, ?, ?, ?, ?)
	`)

	let totalRecordsInserted = 0

	// Fetch all URLs
	for (let i = 0; i < urls.length; i++) {
		const url = urls[i]
		console.log(`Fetching batch ${i + 1}/${urls.length} (URL length: ${url.length})`)

		try {
			const response = await fetch(url)
			if (!response.ok) {
				console.error(`Failed to fetch batch ${i + 1}: ${response.status} ${response.statusText}`)
				continue
			}

			const data = (await response.json()) as MarketHistoriesResponse[]

			// Filter out today's data as it's incomplete and would skew calculations
			const todayDateStr = new Date().toISOString().split('T')[0]

			// Insert records in a transaction for better performance
			const insertBatch = db.transaction((records: MarketHistoriesResponse[]) => {
				for (const record of records) {
					const { item_id, location, quality, data: dataPoints } = record
					for (const point of dataPoints) {
						// Skip today's incomplete data
						if (point.timestamp.startsWith(todayDateStr)) {
							continue
						}
						insertStmt.run(
							item_id,
							location,
							quality,
							point.timestamp,
							point.item_count,
							point.avg_price,
						)
						totalRecordsInserted++
					}
				}
			})

			insertBatch(data)
			console.log(`Batch ${i + 1}: inserted ${data.reduce((sum, r) => sum + r.data.length, 0)} records`)
		} catch (error) {
			console.error(`Error fetching batch ${i + 1}:`, error)
		}
	}

	console.log(`Done! Total records inserted: ${totalRecordsInserted}`)
}

async function fetchLatestPrices(): Promise<void> {
	// Check which items need updating (stale or missing data)
	const now = Date.now()
	const staleThreshold = now - LATEST_PRICES_STALENESS_MS

	// Get all items that have fresh data
	const freshItems = db
		.prepare(`SELECT DISTINCT item_id FROM latest_prices WHERE fetched_at > ?`)
		.all(staleThreshold) as { item_id: string }[]

	const freshItemSet = new Set(freshItems.map((r) => r.item_id))

	// Filter to only items that need fetching
	const itemsToFetch = ALL_ITEM_IDS.filter((id) => !freshItemSet.has(id))

	if (itemsToFetch.length === 0) {
		console.log(`Latest prices already up to date (all ${ALL_ITEM_IDS.length} items fetched within last 5 minutes)`)
		return
	}

	console.log(`Fetching latest prices: ${itemsToFetch.length} items need updating (${freshItemSet.size} already fresh)`)

	const baseUrl = `https://europe.albion-online-data.com/api/v2/stats/prices/`

	// Build batched URLs, maximizing item IDs per URL while staying under MAX_URL_LENGTH
	const urls: string[] = []
	let currentBatch: string[] = []
	let currentUrlLength = baseUrl.length

	for (const id of itemsToFetch) {
		// Calculate length if we add this ID (comma separator if not first item in batch)
		const separatorLength = currentBatch.length > 0 ? 1 : 0 // comma
		const potentialLength = currentUrlLength + separatorLength + id.length

		if (potentialLength <= MAX_URL_LENGTH) {
			// ID fits in current batch
			currentBatch.push(id)
			currentUrlLength = potentialLength
		} else {
			// ID doesn't fit, finalize current batch and start new one
			if (currentBatch.length > 0) {
				urls.push(`${baseUrl}${currentBatch.join(',')}`)
			}
			// Start new batch with current ID
			currentBatch = [id]
			currentUrlLength = baseUrl.length + id.length
		}
	}

	// Don't forget the last batch
	if (currentBatch.length > 0) {
		urls.push(`${baseUrl}${currentBatch.join(',')}`)
	}

	console.log(`Fetching ${itemsToFetch.length} items in ${urls.length} batched requests`)

	// Prepare insert statement
	const insertStmt = db.prepare(`
		INSERT OR REPLACE INTO latest_prices
		(item_id, city, quality, sell_price_min, sell_price_min_date, sell_price_max, sell_price_max_date,
		 buy_price_min, buy_price_min_date, buy_price_max, buy_price_max_date, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)

	let totalRecordsInserted = 0
	const fetchedAt = Date.now()

	// Fetch all URLs
	for (let i = 0; i < urls.length; i++) {
		const url = urls[i]
		console.log(`Fetching batch ${i + 1}/${urls.length} (URL length: ${url.length})`)

		try {
			const response = await fetch(url)
			if (!response.ok) {
				console.error(`Failed to fetch batch ${i + 1}: ${response.status} ${response.statusText}`)
				continue
			}

			const data = (await response.json()) as LatestPriceResponse[]

			// Insert records in a transaction for better performance
			const insertBatch = db.transaction((records: LatestPriceResponse[]) => {
				for (const record of records) {
					insertStmt.run(
						record.item_id,
						record.city,
						record.quality,
						record.sell_price_min,
						record.sell_price_min_date,
						record.sell_price_max,
						record.sell_price_max_date,
						record.buy_price_min,
						record.buy_price_min_date,
						record.buy_price_max,
						record.buy_price_max_date,
						fetchedAt,
					)
					totalRecordsInserted++
				}
			})

			insertBatch(data)
			console.log(`Batch ${i + 1}: inserted ${data.length} records`)
		} catch (error) {
			console.error(`Error fetching batch ${i + 1}:`, error)
		}
	}

	console.log(`Done! Total records inserted: ${totalRecordsInserted}`)
}
