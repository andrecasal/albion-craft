// Test the history endpoint with time-scale=6 (6-hour averages)
// to see what date range the API actually returns

const itemId = 'T4_BAG'
const locations = 'Caerleon,Martlock,Bridgewatch,Lymhurst,Fort Sterling,Thetford'

const url = `https://europe.albion-online-data.com/api/v2/stats/history/${itemId}?time-scale=6&locations=${locations}`

console.log('Fetching:', url)
console.log()

const response = await fetch(url)

if (!response.ok) {
	console.log('Error:', response.status, await response.text())
	process.exit(1)
}

const data = await response.json()

// Show timestamp range for each location
for (const entry of data) {
	const timestamps = entry.data.map((d: any) => d.timestamp)
	if (timestamps.length > 0) {
		console.log(`${entry.location} (quality ${entry.quality}):`)
		console.log(`  Count: ${timestamps.length}`)
		console.log(`  Oldest: ${timestamps[0]}`)
		console.log(`  Newest: ${timestamps[timestamps.length - 1]}`)
		console.log()
	}
}
