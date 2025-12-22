import { remember } from '@epic-web/remember'
import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'

const DB_PATH = path.join(process.cwd(), 'src', 'data', 'database.sqlite')

export const db = remember('sqlite-db', () => {
	// Ensure directory exists
	const dir = path.dirname(DB_PATH)
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}

	const instance = new Database(DB_PATH)
	instance.pragma('journal_mode = WAL')
	instance.pragma('synchronous = NORMAL')

	// Initialize tables
	instance.exec(`
		CREATE TABLE IF NOT EXISTS daily_average_prices (
			item_id TEXT NOT NULL,
			location TEXT NOT NULL,
			quality INTEGER NOT NULL,
			timestamp TEXT NOT NULL,
			item_count INTEGER NOT NULL,
			avg_price INTEGER NOT NULL,
			PRIMARY KEY (item_id, location, quality, timestamp)
		);

		CREATE INDEX IF NOT EXISTS idx_daily_average_prices_item_id ON daily_average_prices(item_id);
		CREATE INDEX IF NOT EXISTS idx_daily_average_prices_location ON daily_average_prices(location);
		CREATE INDEX IF NOT EXISTS idx_daily_average_prices_timestamp ON daily_average_prices(timestamp);

		CREATE TABLE IF NOT EXISTS latest_prices (
			item_id TEXT NOT NULL,
			city TEXT NOT NULL,
			quality INTEGER NOT NULL,
			sell_price_min INTEGER NOT NULL,
			sell_price_min_date TEXT NOT NULL,
			sell_price_max INTEGER NOT NULL,
			sell_price_max_date TEXT NOT NULL,
			buy_price_min INTEGER NOT NULL,
			buy_price_min_date TEXT NOT NULL,
			buy_price_max INTEGER NOT NULL,
			buy_price_max_date TEXT NOT NULL,
			fetched_at INTEGER NOT NULL,
			PRIMARY KEY (item_id, city, quality)
		);

		CREATE INDEX IF NOT EXISTS idx_latest_prices_item_id ON latest_prices(item_id);
		CREATE INDEX IF NOT EXISTS idx_latest_prices_city ON latest_prices(city);
	`)

	return instance
})

export function getDatabaseSize(): number {
	let totalSize = 0

	if (fs.existsSync(DB_PATH)) {
		totalSize += fs.statSync(DB_PATH).size
	}

	const walPath = DB_PATH + '-wal'
	if (fs.existsSync(walPath)) {
		totalSize += fs.statSync(walPath).size
	}

	const shmPath = DB_PATH + '-shm'
	if (fs.existsSync(shmPath)) {
		totalSize += fs.statSync(shmPath).size
	}

	return totalSize
}

export function closeDb(): void {
	db.close()
}
