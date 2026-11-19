// Weather from Open-Meteo (free, no API key). W-A fetches every 30 min and forwards to W-B.
// Only the place the user typed (or its coordinates) is sent; nothing else leaves the laptop.

export interface Place { name: string; lat: number; lon: number }
export interface Weather {
  place: string; temp: number; code: number; isDay: boolean;
  hi: number | null; lo: number | null; precip: number; sunrise: string | null; sunset: string | null; at: number;
}

/** WMO weather interpretation codes → icon + words. */
export function describeCode(code: number, isDay = true): { icon: string; text: string } {
  if (code === 0) return { icon: isDay ? '☀' : '☾', text: 'Clear' };
  if (code <= 2) return { icon: isDay ? '⛅' : '☁', text: 'Partly cloudy' };
  if (code === 3) return { icon: '☁', text: 'Overcast' };
  if (code === 45 || code === 48) return { icon: '🌫', text: 'Fog' };
  if (code >= 51 && code <= 57) return { icon: '🌦', text: 'Drizzle' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: '🌧', text: code >= 80 ? 'Showers' : 'Rain' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: '❄', text: 'Snow' };
  if (code >= 95) return { icon: '⛈', text: 'Thunderstorm' };
  return { icon: '·', text: 'Unknown' };
}

export const isRain = (code: number) => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

export function forecastUrl(p: Place): string {
  const q = new URLSearchParams({
    latitude: p.lat.toFixed(3), longitude: p.lon.toFixed(3),
    current: 'temperature_2m,weather_code,is_day,precipitation',
    daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
    forecast_days: '1', timezone: 'auto',
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

export function parseForecast(j: any, place: string, now = Date.now()): Weather {
  const c = j?.current;
  if (!c || typeof c.temperature_2m !== 'number') throw new Error('Unexpected weather response');
  const d = j.daily || {};
  const first = (a: unknown) => (Array.isArray(a) && a.length ? a[0] : null);
  return {
    place, temp: c.temperature_2m, code: c.weather_code ?? -1, isDay: c.is_day !== 0, precip: c.precipitation ?? 0,
    hi: first(d.temperature_2m_max), lo: first(d.temperature_2m_min),
    sunrise: first(d.sunrise), sunset: first(d.sunset), at: now,
  };
}

export async function geocode(name: string): Promise<Place> {
  const q = new URLSearchParams({ name: name.trim(), count: '1', format: 'json' });
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${q}`);
  if (!r.ok) throw new Error(`Place lookup failed (${r.status})`);
  const hit = (await r.json())?.results?.[0];
  if (!hit) throw new Error(`No place called "${name}"`);
  return { name: [hit.name, hit.admin1].filter(Boolean).join(', '), lat: hit.latitude, lon: hit.longitude };
}

export async function fetchWeather(p: Place): Promise<Weather> {
  const r = await fetch(forecastUrl(p));
  if (!r.ok) throw new Error(`Weather failed (${r.status})`);
  return parseForecast(await r.json(), p.name);
}
