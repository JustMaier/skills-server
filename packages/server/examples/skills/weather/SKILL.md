---
name: weather
description: Get current weather for any city using the Open-Meteo API.
---

## Usage

Fetch the current weather for a city:

```
weather.mjs <city>
```

Examples:
```
weather.mjs "New York"
weather.mjs London
weather.mjs "Tokyo"
```

The script geocodes the city name and returns current temperature, wind speed, and conditions.

## Environment Variables

This skill requires a `WEATHER_UNITS` environment variable to control temperature units:
- `fahrenheit` — temperatures in Fahrenheit
- `celsius` — temperatures in Celsius (default if not set)
