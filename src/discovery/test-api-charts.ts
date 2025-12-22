import * as https from 'https'
import * as zlib from 'zlib'

const itemId = 'T4_BAG'
const locations = 'Lymhurst'

// Test the charts endpoint with time-scale=1 (hourly)
const url = `https://europe.albion-online-data.com/api/v2/stats/charts/${itemId}?time-scale=1&locations=${locations}`

console.log('Fetching:', url)
console.log()

const options = {
	headers: {
		'Accept-Encoding': 'gzip, deflate',
	},
}

https.get(url, options, (res) => {
	const chunks: Buffer[] = []
	res.on('data', (chunk) => chunks.push(chunk))
	res.on('end', () => {
		console.log('Status:', res.statusCode)
		console.log('Headers:', JSON.stringify(res.headers, null, 2))
		console.log()

		const buffer = Buffer.concat(chunks)
		const encoding = res.headers['content-encoding']

		let data: string
		if (encoding === 'gzip') {
			data = zlib.gunzipSync(buffer).toString()
		} else if (encoding === 'deflate') {
			data = zlib.inflateSync(buffer).toString()
		} else {
			data = buffer.toString()
		}

		console.log('Response:')
		if (res.statusCode === 200) {
			console.log(JSON.stringify(JSON.parse(data), null, 2))
		} else {
			console.log(data)
		}
	})
})
