const itemId = 'T4_BAG'
const locations = 'Lymhurst'

// Test the view endpoint (table view of current prices)
const url = `https://europe.albion-online-data.com/api/v2/stats/view/${itemId}?locations=${locations}`

console.log('Fetching:', url)
console.log()
;(async () => {
	const response = await fetch(url)

	console.log('Status:', response.status)
	console.log(
		'Headers:',
		JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2),
	)
	console.log()

	console.log('Response:')
	if (response.ok) {
		const data = await response.json()
		console.log(JSON.stringify(data, null, 2))
	} else {
		const text = await response.text()
		console.log(text)
	}
})()
