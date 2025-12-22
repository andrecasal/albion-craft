# Albion Online Data API v2

Base URL: `https://old.west.albion-online-data.com/api/v2/stats/`

## Endpoints

### History

**GET** `/api/v2/stats/History/{itemList}.{format}`

Retrieves historical market data for items. This is useful to get the average
item price.

#### Path Parameters

| Parameter  | Type   | Required | Description                      |
| ---------- | ------ | -------- | -------------------------------- |
| `itemList` | string | Yes      | Comma-separated list of item IDs |
| `format`   | string | Yes      | Response format (json, xml)      |

#### Query Parameters

| Parameter    | Type      | Default | Nullable | Description                                                                                                                         |
| ------------ | --------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `locations`  | string    | -       | Yes      | Comma-separated cities: `Caerleon`, `Bridgewatch`, `Fort Sterling`, `Lymhurst`, `Martlock`, `Thetford`, `Black Market`, `Brecilien` |
| `date`       | date-time | -       | Yes      | Start date for data range                                                                                                           |
| `end_date`   | date-time | -       | Yes      | End date for data range                                                                                                             |
| `qualities`  | string    | -       | Yes      | Comma-separated quality levels: `1` (Normal), `2` (Good), `3` (Outstanding), `4` (Excellent), `5` (Masterpiece)                     |
| `time-scale` | integer   | 6       | No       | Time aggregation interval (1, 6, or 24 hours)                                                                                       |

#### Example

```bash
# Get historical data for T4 Bag with 24-hour intervals
curl "https://old.west.albion-online-data.com/api/v2/stats/History/T4_BAG.json?date=2024-01-01&time-scale=24"

# Get history for multiple items in specific cities
curl "https://old.west.albion-online-data.com/api/v2/stats/History/T4_BAG,T5_BAG.json?locations=Caerleon,Bridgewatch"
```

#### Response: `MarketHistoriesResponse[]`

```typescript
interface MarketHistoriesResponse {
	location: string // City where data was recorded
	item_id: string // Item unique identifier
	quality: number // Quality level (1=Normal, 2=Good, 3=Outstanding, 4=Excellent, 5=Masterpiece)
	data: MarketHistoryResponse[]
}

interface MarketHistoryResponse {
	item_count: number // Number of items traded (int64)
	avg_price: number // Average price during the period (int64)
	timestamp: string // ISO timestamp of the data point
}
```

#### Example Response:

```json
[
	{
		"location": "Lymhurst",
		"item_id": "T4_BAG",
		"quality": 1,
		"data": [
			{
				"item_count": 911,
				"avg_price": 3731,
				"timestamp": "2025-11-22T00:00:00"
			},
			{
				"item_count": 1914,
				"avg_price": 4604,
				"timestamp": "2025-11-23T00:00:00"
			},
			{
				"item_count": 1198,
				"avg_price": 5192,
				"timestamp": "2025-11-24T00:00:00"
			}
		]
	}
]
```

---

### Charts

**GET** `/api/v2/stats/Charts/{itemList}.{format}`

Retrieves market statistics charts for specified items. Retrieves the same data
as the history endpoint, in a format that's easier for charts to consume.

#### Path Parameters

| Parameter  | Type   | Required | Description                      |
| ---------- | ------ | -------- | -------------------------------- |
| `itemList` | string | Yes      | Comma-separated list of item IDs |
| `format`   | string | Yes      | Response format (json, xml)      |

#### Query Parameters

| Parameter    | Type      | Default | Nullable | Description                                                                                                                         |
| ------------ | --------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `locations`  | string    | -       | Yes      | Comma-separated cities: `Caerleon`, `Bridgewatch`, `Fort Sterling`, `Lymhurst`, `Martlock`, `Thetford`, `Black Market`, `Brecilien` |
| `date`       | date-time | -       | Yes      | Start date for data range                                                                                                           |
| `end_date`   | date-time | -       | Yes      | End date for data range                                                                                                             |
| `qualities`  | string    | -       | Yes      | Comma-separated quality levels: `1` (Normal), `2` (Good), `3` (Outstanding), `4` (Excellent), `5` (Masterpiece)                     |
| `time-scale` | integer   | 6       | No       | Time aggregation interval (1, 6, or 24 hours)                                                                                       |

#### Example

```bash
# Get chart data for T4 Bag
curl "https://old.west.albion-online-data.com/api/v2/stats/Charts/T4_BAG.json"

# Get chart data for specific cities and date range
curl "https://old.west.albion-online-data.com/api/v2/stats/Charts/T4_BAG.json?locations=Caerleon&date=2024-01-01&time-scale=24"
```

#### Response: `MarketStatChartResponsev2[]`

```typescript
interface MarketStatChartResponsev2 {
	location: string // City where data was recorded
	item_id: string // Item unique identifier
	quality: number // Quality level (1-5)
	data: MarketStatResponsev2
}

interface MarketStatResponsev2 {
	timestamps: string[] // Array of ISO timestamps
	prices_avg: number[] // Array of average prices (double)
	item_count: number[] // Array of item counts traded (int64)
}
```

---

### Prices

**GET** `/api/v2/stats/Prices/{itemList}.{format}`

Retrieves market's latest sell and buy prices for items, and the last time we saw them.
This is useful to check for items being sold at below market value and bought
above market value for arbitrage opportunities.

#### Path Parameters

| Parameter  | Type   | Required | Description                      |
| ---------- | ------ | -------- | -------------------------------- |
| `itemList` | string | Yes      | Comma-separated list of item IDs |
| `format`   | string | Yes      | Response format (json, xml)      |

#### Query Parameters

| Parameter   | Type   | Nullable | Description                                                                                                                         |
| ----------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `locations` | string | Yes      | Comma-separated cities: `Caerleon`, `Bridgewatch`, `Fort Sterling`, `Lymhurst`, `Martlock`, `Thetford`, `Black Market`, `Brecilien` |
| `qualities` | string | Yes      | Comma-separated quality levels: `1` (Normal), `2` (Good), `3` (Outstanding), `4` (Excellent), `5` (Masterpiece)                     |

#### Example

```bash
# Get current prices for T4 Bag in all cities
curl "https://old.west.albion-online-data.com/api/v2/stats/Prices/T4_BAG.json"

# Get prices for multiple items in specific cities
curl "https://old.west.albion-online-data.com/api/v2/stats/Prices/T4_BAG,T5_BAG.json?locations=Caerleon,Bridgewatch"

# Get prices for specific quality levels
curl "https://old.west.albion-online-data.com/api/v2/stats/Prices/T4_BAG.json?qualities=1,2,3"
```

#### Response: `MarketResponse[]`

```typescript
interface MarketResponse {
	item_id: string // Item unique identifier (e.g., "T4_BAG")
	city: string // City where price was recorded (e.g., "Caerleon")
	quality: number // Quality level (1=Normal, 2=Good, 3=Outstanding, 4=Excellent, 5=Masterpiece)
	sell_price_min: number // Lowest sell order price (int64)
	sell_price_min_date: string // ISO timestamp of lowest sell price observation
	sell_price_max: number // Highest sell order price (int64)
	sell_price_max_date: string // ISO timestamp of highest sell price observation
	buy_price_min: number // Lowest buy order price (int64)
	buy_price_min_date: string // ISO timestamp of lowest buy price observation
	buy_price_max: number // Highest buy order price (int64)
	buy_price_max_date: string // ISO timestamp of highest buy price observation
}
```

---

### View

**GET** `/api/v2/stats/View/{itemList}`

View prices endpoint. Same as the Prices endpoint but returns HTML. Ignore this
one.

#### Path Parameters

| Parameter  | Type   | Required | Description                      |
| ---------- | ------ | -------- | -------------------------------- |
| `itemList` | string | Yes      | Comma-separated list of item IDs |

#### Query Parameters

| Parameter   | Type   | Nullable | Description                                                                                                                         |
| ----------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `locations` | string | Yes      | Comma-separated cities: `Caerleon`, `Bridgewatch`, `Fort Sterling`, `Lymhurst`, `Martlock`, `Thetford`, `Black Market`, `Brecilien` |
| `qualities` | string | Yes      | Comma-separated quality levels: `1` (Normal), `2` (Good), `3` (Outstanding), `4` (Excellent), `5` (Masterpiece)                     |

---

### Gold Prices

**GET** `/api/v2/stats/Gold` or `/api/v2/stats/Gold.{format}`

Retrieves gold-to-silver exchange rate history.

#### Query Parameters

| Parameter  | Type      | Default | Description                 |
| ---------- | --------- | ------- | --------------------------- |
| `date`     | date-time | -       | Start date for data         |
| `end_date` | date-time | -       | End date for data           |
| `count`    | integer   | 0       | Number of records to return |

#### Example

```bash
# Get recent gold prices (last 100 records)
curl "https://old.west.albion-online-data.com/api/v2/stats/Gold.json?count=100"

# Get gold prices for a specific date range
curl "https://old.west.albion-online-data.com/api/v2/stats/Gold.json?date=2024-01-01&end_date=2024-01-31"
```

#### Response: `GoldPrice[]`

```typescript
interface GoldPrice {
	price: number // Silver price per gold (int32)
	timestamp: string // ISO timestamp of the price record
}
```
