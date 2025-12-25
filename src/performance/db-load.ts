import { Database } from 'bun:sqlite'
import * as path from 'path'

const DB_PATH = path.join(import.meta.dir, '..', 'data', 'database.sqlite')

function formatRows(count: number): string {
	if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M'
	if (count >= 1_000) return (count / 1_000).toFixed(0) + 'K'
	return count.toString()
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return bytes + 'B'
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB'
	if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + 'MB'
	return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB'
}

function formatDuration(ms: number): string {
	if (ms < 1000) return ms.toFixed(0) + 'ms'
	return (ms / 1000).toFixed(1) + 's'
}

interface TableResult {
	name: string
	rows: number
	size: number
	time: number
}

function getTableSize(db: Database, tableName: string): number {
	const result = db
		.query<{ size: number }, [string]>(
			`SELECT SUM(pgsize) as size FROM dbstat WHERE name = ?`,
		)
		.get(tableName)
	return result?.size ?? 0
}

function loadTable(db: Database, tableName: string): TableResult {
	const size = getTableSize(db, tableName)
	const start = performance.now()
	const rows = db.query(`SELECT * FROM ${tableName}`).all()
	const time = performance.now() - start
	return { name: tableName, rows: rows.length, size, time }
}

function testDbLoad() {
	const db = new Database(DB_PATH, { readonly: true })
	const memBefore = process.memoryUsage()

	const tables = [
		'latest_prices',
		'order_book',
		'daily_average_prices',
		'six_hour_average_prices',
		'hourly_average_prices',
	]

	const results: TableResult[] = []
	for (const table of tables) {
		results.push(loadTable(db, table))
	}

	const memAfter = process.memoryUsage()
	db.close()

	// Calculate totals
	const totalRows = results.reduce((sum, r) => sum + r.rows, 0)
	const totalSize = results.reduce((sum, r) => sum + r.size, 0)
	const totalTime = results.reduce((sum, r) => sum + r.time, 0)
	const memoryUsed = memAfter.heapUsed - memBefore.heapUsed

	// Print table
	const colWidths = { table: 24, rows: 8, size: 10, time: 10 }
	const divider = '-'.repeat(colWidths.table + colWidths.rows + colWidths.size + colWidths.time + 6)

	console.log()
	console.log(
		'Table'.padEnd(colWidths.table) +
			'Rows'.padStart(colWidths.rows) +
			'Size'.padStart(colWidths.size) +
			'Load Time'.padStart(colWidths.time),
	)
	console.log(divider)

	for (const result of results) {
		console.log(
			result.name.padEnd(colWidths.table) +
				formatRows(result.rows).padStart(colWidths.rows) +
				formatBytes(result.size).padStart(colWidths.size) +
				formatDuration(result.time).padStart(colWidths.time),
		)
	}

	console.log(divider)
	console.log(
		`Total: ${formatRows(totalRows)} rows, ${formatBytes(totalSize)} on disk, loaded in ~${formatDuration(totalTime)}, using ~${formatBytes(memoryUsed)} of heap memory.`,
	)
	console.log()
}

testDbLoad()
