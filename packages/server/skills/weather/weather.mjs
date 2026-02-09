#!/usr/bin/env node

// Weather skill — demonstrates env var injection via the skills server.
// Uses the free Open-Meteo API (no API key required for the HTTP call,
// but WEATHER_UNITS is injected as an env var to control output format).

const city = process.argv.slice(2).join(' ');
if (!city) {
  console.error('Usage: weather.mjs <city>');
  process.exit(1);
}

const units = process.env.WEATHER_UNITS || 'celsius';
const tempUnit = units === 'fahrenheit' ? 'fahrenheit' : 'celsius';

async function main() {
  // 1. Geocode the city name
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
  const geoRes = await fetch(geoUrl);
  const geoData = await geoRes.json();

  if (!geoData.results || geoData.results.length === 0) {
    console.error(`City not found: ${city}`);
    process.exit(1);
  }

  const { latitude, longitude, name, country } = geoData.results[0];

  // 2. Fetch current weather
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m,weather_code&temperature_unit=${tempUnit}&wind_speed_unit=mph`;
  const weatherRes = await fetch(weatherUrl);
  const weather = await weatherRes.json();

  const current = weather.current;
  const tempSymbol = tempUnit === 'fahrenheit' ? 'F' : 'C';

  // 3. Map weather code to description
  const weatherCodes = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail',
  };
  const conditions = weatherCodes[current.weather_code] || `Code ${current.weather_code}`;

  console.log(`Weather for ${name}, ${country}:`);
  console.log(`  Temperature: ${current.temperature_2m}°${tempSymbol}`);
  console.log(`  Wind: ${current.wind_speed_10m} mph`);
  console.log(`  Conditions: ${conditions}`);
  console.log(`  Units: ${units}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
