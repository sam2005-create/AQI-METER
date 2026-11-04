/**
 * Data sources and the source rule.
 * WAQI ground stations + Open-Meteo model estimates, and the logic that
 * picks the most accurate one for a point.
 */

export const WAQI = 'https://api.waqi.info';

// A WAQI ground station is used only when it is this close and this fresh.
// Otherwise the Open-Meteo model estimate for the exact point is used.
export const RULE = { maxKm: 25, maxAgeH: 3 };

// How long each kind of upstream answer is cached (seconds)
export const TTL = { feed: 600, bounds: 900, search: 86400, model: 900 };

/* ---------------- responses and input checks ---------------- */

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(data, { status = 200, maxAge = 0, private: priv = false } = {}) {
  const cache = priv ? 'private, no-store' : maxAge ? `public, max-age=${maxAge}` : 'no-store';
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });
}

// Coordinates are rounded to 2 decimals (about 1 km): enough for air quality,
// better for privacy, and nearby users share cache entries.
export function coord(v, limit) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || Math.abs(n) > limit) throw new HttpError(400, 'Bad coordinates.');
  return Math.round(n * 100) / 100;
}

export function uidParam(v) {
  if (!/^-?\d{1,9}$/.test(v || '')) throw new HttpError(400, 'Bad station id.');
  return v;
}

export function textParam(v) {
  const s = (v || '').trim();
  if (s.length < 2 || s.length > 80) throw new HttpError(400, 'Search text must be 2 to 80 characters.');
  return s;
}

/* ---------------- upstream: WAQI ---------------- */

export async function waqi(env, path, ttl) {
  if (!env.WAQI_TOKEN) throw new HttpError(500, 'Server is missing the WAQI token.');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${WAQI}/${path}${sep}token=${env.WAQI_TOKEN}`, { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!res.ok) throw new HttpError(502, `WAQI answered ${res.status}.`);
  const body = await res.json();
  if (body.status !== 'ok') throw new HttpError(502, `WAQI: ${typeof body.data === 'string' ? body.data : 'error'}`);
  return body.data;
}

export const stationFeed = (env, uid) => waqi(env, `feed/@${uid}/`, TTL.feed);
export const search = (env, q) => waqi(env, `search/?keyword=${encodeURIComponent(q)}`, TTL.search);

// Best station for a city name: one with a live number, reported in the last day
export async function bestForPlace(env, q) {
  const list = await search(env, q);
  const live = list.filter((s) => Number.isFinite(Number(s.aqi)));
  const dayAgo = Date.now() / 1000 - 86400;
  const pick = live.find((s) => (s.time?.vtime || 0) > dayAgo) || live[0] || list[0];
  if (!pick) throw new HttpError(404, `No stations found for "${q}".`);
  return stationFeed(env, pick.uid);
}

// Closest live WAQI station. Two lookups, because each has a blind spot:
// - the map scan misses some networks entirely (it returns nothing for Mumbai)
// - WAQI's geo lookup can jump very far away (Bhubaneswar gave Lhasa)
// So scan the map first, and if nothing close turns up, also ask the geo
// lookup and keep whichever station is nearer.
export async function nearestStation(env, lat, lon) {
  let best = null;
  for (const span of [0.5, 1.5, 4]) {
    const box = [lat - span, lon - span, lat + span, lon + span].map((v) => v.toFixed(2)).join(',');
    const list = await waqi(env, `v2/map/bounds?latlng=${box}&networks=all`, TTL.bounds);
    const live = list
      .filter((s) => Number.isFinite(Number(s.aqi)))
      .map((s) => ({ uid: s.uid, aqi: Number(s.aqi), km: kmBetween(lat, lon, s.lat, s.lon) }))
      .sort((a, b) => a.km - b.km);
    if (live.length) { best = live[0]; break; }
  }
  if (!best || best.km > RULE.maxKm) {
    try {
      const g = await waqi(env, `feed/geo:${lat};${lon}/`, TTL.feed);
      const geo = g.city?.geo;
      if (Number.isFinite(Number(g.aqi)) && Array.isArray(geo)) {
        const cand = { uid: g.idx, aqi: Number(g.aqi), km: kmBetween(lat, lon, Number(geo[0]), Number(geo[1])) };
        if (!best || cand.km < best.km) best = cand;
      }
    } catch { /* keep the map result */ }
  }
  // Last try: both lookups above skip some cities (Mumbai again), but name
  // search finds them. Turn the point into a city name and search that.
  if (!best || best.km > RULE.maxKm) {
    try {
      const city = await cityName(lat, lon);
      if (city) {
        const list = await search(env, city);
        const live = list
          .filter((s) => Number.isFinite(Number(s.aqi)) && Array.isArray(s.station?.geo))
          .map((s) => ({ uid: s.uid, aqi: Number(s.aqi), km: kmBetween(lat, lon, Number(s.station.geo[0]), Number(s.station.geo[1])) }))
          .sort((a, b) => a.km - b.km);
        if (live.length && (!best || live[0].km < best.km)) best = live[0];
      }
    } catch { /* keep what we have */ }
  }
  return best;
}

// City name for a point, from OpenStreetMap's free reverse geocoder.
// Cached for 30 days at the edge so the same area is asked about rarely,
// as Nominatim's usage policy asks.
export async function cityName(lat, lon) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10&accept-language=en`,
    {
      headers: { 'user-agent': 'samarth-aqi/1.0 (+https://samarth-aqi.samarth0205.workers.dev)' },
      cf: { cacheTtl: 30 * 86400, cacheEverything: true },
    },
  );
  if (!res.ok) return null;
  const a = (await res.json()).address || {};
  const raw = a.city || a.town || a.village || a.state_district || '';
  // "Bhubaneswar Municipal Corporation" -> "Bhubaneswar"
  return raw.replace(/\b(municipal corporation|municipality|metropolitan region|district|city)\b/gi, '').trim() || null;
}

/* ---------------- upstream: Open-Meteo (free, no key) ----------------
   Model estimate (Copernicus CAMS) for an exact point. The us_aqi_* fields
   are US AQI sub-indices, the same scale WAQI uses. The result is reshaped
   to look like a WAQI feed so the page renders both the same way. */

const OM_FIELDS = {
  pm25: 'us_aqi_pm2_5', pm10: 'us_aqi_pm10', o3: 'us_aqi_ozone',
  no2: 'us_aqi_nitrogen_dioxide', so2: 'us_aqi_sulphur_dioxide', co: 'us_aqi_carbon_monoxide',
};

export async function openMeteo(lat, lon) {
  const ll = `latitude=${lat}&longitude=${lon}`;
  const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?${ll}&current=us_aqi,${Object.values(OM_FIELDS).join(',')}&hourly=us_aqi_pm2_5&forecast_days=4&timezone=auto&timeformat=unixtime`;
  const wxUrl = `https://api.open-meteo.com/v1/forecast?${ll}&current=temperature_2m,relative_humidity_2m,wind_speed_10m&wind_speed_unit=ms`;
  const opts = { cf: { cacheTtl: TTL.model, cacheEverything: true } };
  const [aqRes, wxRes] = await Promise.allSettled([
    fetch(aqUrl, opts).then((r) => r.json()),
    fetch(wxUrl, opts).then((r) => r.json()),
  ]);
  if (aqRes.status !== 'fulfilled' || aqRes.value.error || !aqRes.value.current) throw new HttpError(502, 'Open-Meteo did not answer.');
  const aq = aqRes.value;
  const cur = aq.current;

  const iaqi = {};
  let dominant = null;
  let top = -1;
  for (const [k, f] of Object.entries(OM_FIELDS)) {
    if (Number.isFinite(cur[f])) {
      iaqi[k] = { v: cur[f] };
      if (cur[f] > top) { top = cur[f]; dominant = k; }
    }
  }
  const wx = wxRes.status === 'fulfilled' ? wxRes.value.current : null;
  if (wx) {
    if (Number.isFinite(wx.temperature_2m)) iaqi.t = { v: wx.temperature_2m };
    if (Number.isFinite(wx.relative_humidity_2m)) iaqi.h = { v: wx.relative_humidity_2m };
    if (Number.isFinite(wx.wind_speed_10m)) iaqi.w = { v: wx.wind_speed_10m };
  }

  // daily PM2.5 avg/min/max from the hourly forecast, grouped by local date
  const byDay = {};
  const off = aq.utc_offset_seconds || 0;
  (aq.hourly?.time || []).forEach((t, i) => {
    const v = aq.hourly.us_aqi_pm2_5[i];
    if (!Number.isFinite(v)) return;
    const day = new Date((t + off) * 1000).toISOString().slice(0, 10);
    (byDay[day] ||= []).push(v);
  });
  const pm25 = Object.entries(byDay).map(([day, vs]) => ({
    day,
    avg: Math.round(vs.reduce((a, b) => a + b, 0) / vs.length),
    min: Math.min(...vs),
    max: Math.max(...vs),
  }));

  return {
    aqi: cur.us_aqi,
    city: { name: null, geo: [lat, lon] },
    dominentpol: dominant,
    iaqi,
    time: { iso: new Date(cur.time * 1000).toISOString() },
    forecast: { daily: { pm25 } },
    attributions: [],
    isModel: true,
  };
}

/* ---------------- the source rule ---------------- */

export function hoursOld(feed) {
  const t = feed?.time?.iso ? Date.parse(feed.time.iso) : NaN;
  return Number.isFinite(t) ? (Date.now() - t) / 3600000 : Infinity;
}

/**
 * Best reading for a point.
 * chosen: 'waqi' | 'model'
 * reason: station_close | station_stale | no_station_near | model_failed
 */
export async function bestForPoint(env, lat, lon) {
  const [nearR, modelR] = await Promise.allSettled([nearestStation(env, lat, lon), openMeteo(lat, lon)]);
  const nearest = nearR.status === 'fulfilled' ? nearR.value : null;
  const model = modelR.status === 'fulfilled' ? modelR.value : null;
  const out = { lat, lon, rule: RULE, nearest, model, station: null, chosen: null, reason: null, stationAgeH: null };

  // 1. a close, fresh ground station wins
  if (nearest && nearest.km <= RULE.maxKm) {
    try {
      out.station = await stationFeed(env, nearest.uid);
      out.stationAgeH = Math.round(hoursOld(out.station) * 10) / 10;
      if (out.stationAgeH <= RULE.maxAgeH || !model) return { ...out, chosen: 'waqi', reason: 'station_close' };
      return { ...out, chosen: 'model', reason: 'station_stale' };
    } catch (e) {
      if (!model) throw e;
    }
  }
  // 2. otherwise the model estimate for the exact point
  if (model) return { ...out, chosen: 'model', reason: 'no_station_near' };
  // 3. model failed: the far station is better than nothing
  if (nearest) {
    out.station = await stationFeed(env, nearest.uid);
    out.stationAgeH = Math.round(hoursOld(out.station) * 10) / 10;
    return { ...out, chosen: 'waqi', reason: 'model_failed' };
  }
  throw new HttpError(503, 'No air-quality data for this location right now. Try again in a minute.');
}

/* ---------------- helpers ---------------- */

// Rough location of the caller, from Cloudflare's own IP lookup (city level)
export function whereAmI(request) {
  const cf = request.cf || {};
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat: null, lon: null, city: null };
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, city: cf.city || null, region: cf.region || null, country: cf.country || null };
}

// Great-circle distance in km (Haversine)
export function kmBetween(lat1, lon1, lat2, lon2) {
  const r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}
