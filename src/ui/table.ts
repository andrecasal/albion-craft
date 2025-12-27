/**
 * Simple table formatting utilities for CLI output
 */

// ============================================================================
// TYPES
// ============================================================================

export interface Column {
	header: string
	width: number
	align?: 'left' | 'right' | 'center'
}

export interface TableOptions {
	columns: Column[]
	borderStyle?: 'single' | 'double' | 'none'
}

// ============================================================================
// TABLE RENDERING
// ============================================================================

/**
 * Render a table with the given columns and rows
 */
export function renderTable(
	options: TableOptions,
	rows: string[][]
): string {
	const { columns, borderStyle = 'single' } = options
	const lines: string[] = []

	const chars = getBorderChars(borderStyle)
	const totalWidth = columns.reduce((sum, col) => sum + col.width, 0) + columns.length + 1

	// Top border
	if (chars.top) {
		lines.push(
			chars.topLeft +
				columns.map((col) => chars.horizontal.repeat(col.width)).join(chars.topMid) +
				chars.topRight
		)
	}

	// Header row
	const headerCells = columns.map((col) => padCell(col.header, col.width, col.align ?? 'left'))
	lines.push(chars.vertical + headerCells.join(chars.vertical) + chars.vertical)

	// Header separator
	lines.push(
		chars.midLeft +
			columns.map((col) => chars.horizontal.repeat(col.width)).join(chars.midMid) +
			chars.midRight
	)

	// Data rows
	for (const row of rows) {
		const cells = columns.map((col, i) => {
			const value = row[i] ?? ''
			return padCell(value, col.width, col.align ?? 'left')
		})
		lines.push(chars.vertical + cells.join(chars.vertical) + chars.vertical)
	}

	// Bottom border
	if (chars.bottom) {
		lines.push(
			chars.bottomLeft +
				columns.map((col) => chars.horizontal.repeat(col.width)).join(chars.bottomMid) +
				chars.bottomRight
		)
	}

	return lines.join('\n')
}

// ============================================================================
// HELPERS
// ============================================================================

function padCell(text: string, width: number, align: 'left' | 'right' | 'center'): string {
	// Truncate if too long
	const truncated = text.length > width ? text.slice(0, width - 1) + '…' : text

	switch (align) {
		case 'right':
			return truncated.padStart(width)
		case 'center':
			const leftPad = Math.floor((width - truncated.length) / 2)
			return truncated.padStart(leftPad + truncated.length).padEnd(width)
		case 'left':
		default:
			return truncated.padEnd(width)
	}
}

interface BorderChars {
	horizontal: string
	vertical: string
	topLeft: string
	topRight: string
	topMid: string
	bottomLeft: string
	bottomRight: string
	bottomMid: string
	midLeft: string
	midRight: string
	midMid: string
	top: boolean
	bottom: boolean
}

function getBorderChars(style: 'single' | 'double' | 'none'): BorderChars {
	switch (style) {
		case 'double':
			return {
				horizontal: '═',
				vertical: '║',
				topLeft: '╔',
				topRight: '╗',
				topMid: '╦',
				bottomLeft: '╚',
				bottomRight: '╝',
				bottomMid: '╩',
				midLeft: '╠',
				midRight: '╣',
				midMid: '╬',
				top: true,
				bottom: true,
			}
		case 'none':
			return {
				horizontal: ' ',
				vertical: ' ',
				topLeft: '',
				topRight: '',
				topMid: '',
				bottomLeft: '',
				bottomRight: '',
				bottomMid: '',
				midLeft: '',
				midRight: '',
				midMid: '',
				top: false,
				bottom: false,
			}
		case 'single':
		default:
			return {
				horizontal: '─',
				vertical: '│',
				topLeft: '┌',
				topRight: '┐',
				topMid: '┬',
				bottomLeft: '└',
				bottomRight: '┘',
				bottomMid: '┴',
				midLeft: '├',
				midRight: '┤',
				midMid: '┼',
				top: true,
				bottom: true,
			}
	}
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

/**
 * Format a number as silver (with K/M suffixes)
 */
export function formatSilver(amount: number): string {
	if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M'
	if (amount >= 1_000) return (amount / 1_000).toFixed(1) + 'K'
	return String(amount)
}

/**
 * Format volume with K suffix for large numbers
 */
export function formatVolume(volume: number): string {
	if (volume === 0) return '-'
	if (volume >= 1_000) return (volume / 1_000).toFixed(1) + 'K'
	return String(Math.round(volume))
}

/**
 * Format data age in minutes/hours
 */
export function formatAge(minutes: number): string {
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	const mins = minutes % 60
	if (mins === 0) return `${hours}h`
	return `${hours}h${mins}m`
}

/**
 * Format a percentage with sign
 */
export function formatPercent(value: number | null): string {
	if (value === null) return '-'
	const sign = value >= 0 ? '+' : ''
	return `${sign}${value.toFixed(1)}%`
}

// ============================================================================
// ITEM NAME FORMATTING
// ============================================================================

/**
 * Tier prefixes used in Albion item names
 */
const TIER_PREFIXES: Record<number, string> = {
	1: "Beginner's",
	2: "Novice's",
	3: "Journeyman's",
	4: "Adept's",
	5: "Expert's",
	6: "Master's",
	7: "Grandmaster's",
	8: "Elder's",
}

/**
 * Parse an Albion item ID into its components
 * e.g., "T4_2H_SWORD@2" -> { tier: 4, baseId: "2H_SWORD", enchant: 2 }
 */
export function parseItemId(itemId: string): { tier: number; baseId: string; enchant: number } | null {
	const match = itemId.match(/^T(\d+)_(.+?)(?:@(\d+))?$/)
	if (!match) return null

	return {
		tier: parseInt(match[1], 10),
		baseId: match[2],
		enchant: match[3] ? parseInt(match[3], 10) : 0,
	}
}

/**
 * Get the base name of an item by removing the tier prefix
 * e.g., "Adept's Claymore" -> "Claymore"
 * e.g., "Master's Avalonian Pickaxe" -> "Avalonian Pickaxe"
 */
export function getBaseName(itemName: string, tier: number): string {
	const prefix = TIER_PREFIXES[tier]
	if (prefix && itemName.startsWith(prefix + ' ')) {
		return itemName.slice(prefix.length + 1)
	}
	// For items without tier prefix (unique items, etc.), return as-is
	return itemName
}

/**
 * Format an item for display with base name and T.E.Q code
 * @param itemId - The full item ID (e.g., "T4_2H_SWORD@2")
 * @param itemName - The full item name (e.g., "Adept's Claymore (Uncommon)")
 * @param quality - The quality level (1-5)
 * @returns Object with baseName and teq code
 *
 * Examples:
 *   formatItemDisplay("T4_2H_SWORD@2", "Adept's Claymore (Uncommon)", 3)
 *   -> { baseName: "Claymore (Uncommon)", teq: "4.2.3" }
 *
 *   formatItemDisplay("T8_2H_TOOL_PICK", "Elder's Pickaxe", 1)
 *   -> { baseName: "Pickaxe", teq: "8.0.1" }
 */
export function formatItemDisplay(
	itemId: string,
	itemName: string,
	quality: number
): { baseName: string; teq: string } {
	const parsed = parseItemId(itemId)

	if (!parsed) {
		// Non-standard item ID, return name as-is
		return {
			baseName: itemName,
			teq: `?.?.${quality}`,
		}
	}

	const baseName = getBaseName(itemName, parsed.tier)
	const teq = `${parsed.tier}.${parsed.enchant}.${quality}`

	return { baseName, teq }
}

/**
 * Format an item as a single string: "Base Name [T.E.Q]"
 */
export function formatItemWithTeq(itemId: string, itemName: string, quality: number): string {
	const { baseName, teq } = formatItemDisplay(itemId, itemName, quality)
	return `${baseName} [${teq}]`
}
