export {}

const itemId = 'T4_BAG'
const locations = 'Black Market'

// Test the prices endpoint
const url = `https://europe.albion-online-data.com/api/v2/stats/prices/${itemId}?locations=${locations}`

console.log('Fetching:', url)
console.log()

const response = await fetch(url)

console.log('Status:', response.status)
console.log('Headers:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2))
console.log()

console.log('Response:')
if (response.ok) {
	const data = await response.json()
	console.log(JSON.stringify(data, null, 2))
} else {
	const text = await response.text()
	console.log(text)
}
