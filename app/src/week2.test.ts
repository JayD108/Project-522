import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENES, nextScene, sceneAt, toMin, type Scene } from './scenes';
import { describeCode, forecastUrl, isRain, parseForecast } from './weather';

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 18, h, m, s);

describe('scene scheduler', () => {
  it('parses HH:MM', () => {
    expect(toMin('05:30')).toBe(330);
    expect(toMin('0:00')).toBe(0);
    expect(toMin('24:00')).toBeNaN();
    expect(toMin('nope')).toBeNaN();
  });
  it('picks the latest scene that has started', () => {
    expect(sceneAt(at(5, 30), DEFAULT_SCENES)?.key).toBe('dawn');
    expect(sceneAt(at(8, 59), DEFAULT_SCENES)?.key).toBe('dawn');
    expect(sceneAt(at(9, 0), DEFAULT_SCENES)?.key).toBe('work');
    expect(sceneAt(at(17, 30), DEFAULT_SCENES)?.key).toBe('ambient');
    expect(sceneAt(at(23, 0), DEFAULT_SCENES)?.key).toBe('night');
  });
  it('wraps past midnight to the last scene of the day', () => {
    expect(sceneAt(at(2, 0), DEFAULT_SCENES)?.key).toBe('night');
  });
  it('handles unsorted and invalid entries', () => {
    const odd: Scene[] = [
      { key: 'night', label: 'N', start: '21:00', wallpaperId: null },
      { key: 'dawn', label: 'D', start: 'bad', wallpaperId: null },
      { key: 'work', label: 'W', start: '08:00', wallpaperId: null },
    ];
    expect(sceneAt(at(12, 0), odd)?.key).toBe('work');
    expect(sceneAt(at(7, 0), odd)?.key).toBe('night');
    expect(sceneAt(at(7, 0), [])).toBeNull();
  });
  it('finds the next change and the time until it', () => {
    const n = nextScene(at(8, 57, 30), DEFAULT_SCENES)!;
    expect(n.scene.key).toBe('work');
    expect(n.inMs).toBe(150_000);
    const w = nextScene(at(23, 0), DEFAULT_SCENES)!;
    expect(w.scene.key).toBe('dawn');
    expect(w.inMs).toBe((60 + 5 * 60 + 30) * 60_000);
  });
});

describe('weather', () => {
  it('maps WMO codes', () => {
    expect(describeCode(0).text).toBe('Clear');
    expect(describeCode(0, false).icon).toBe('☾');
    expect(describeCode(63).text).toBe('Rain');
    expect(describeCode(81).text).toBe('Showers');
    expect(describeCode(95).text).toBe('Thunderstorm');
    expect(isRain(61) && isRain(95) && !isRain(3)).toBe(true);
  });
  it('builds a key-free Open-Meteo URL with only coordinates', () => {
    const u = new URL(forecastUrl({ name: 'Pune', lat: 18.5204, lon: 73.8567 }));
    expect(u.host).toBe('api.open-meteo.com');
    expect(u.searchParams.get('latitude')).toBe('18.520');
    expect(u.searchParams.has('name')).toBe(false);
  });
  it('parses a forecast response', () => {
    const w = parseForecast({
      current: { temperature_2m: 24.3, weather_code: 2, is_day: 1, precipitation: 0 },
      daily: { temperature_2m_max: [29.1], temperature_2m_min: [17.4], sunrise: ['2026-11-18T06:44'], sunset: ['2026-11-18T17:58'] },
    }, 'Pune', 123);
    expect(w).toMatchObject({ place: 'Pune', temp: 24.3, code: 2, isDay: true, hi: 29.1, lo: 17.4, sunrise: '2026-11-18T06:44', at: 123 });
    expect(() => parseForecast({}, 'x')).toThrow();
  });
});
