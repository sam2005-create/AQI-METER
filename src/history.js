/**
 * AQI history: hourly readings per place, stored in D1.
 *
 * - A place starts being tracked when the app asks for its history.
 * - The first request fills in the past 30 days from Open-Meteo's model
 *   archive, so the chart is useful straight away.
 * - An hourly cron job then records the live reading (station or model,
 *   picked by the same rule as the app) for each tracked place.
 */

import { RULE, bestForPoint, stationFeed, hoursOld } from './sources.js';

// The hourly job remembers each place's nearest station, so recording a place
// costs at most 2 upstream requests. 12 places stays well inside the free
// plan's 50 subrequests per run.
const MAX_PLACES = 12;
const FULL_LOOKUPS_PER_RUN = 2;  // places whose nearest station isn't known yet
const KEEP_DAYS = 35;       // readings older than this are deleted
const IDLE_DAYS = 30;       // places the app hasn't asked about in this long stop being tracked
const BACKFILL_DAYS = 30;
const HOUR = 3600;

const nowS = () => Math.floor(Date.now() / 1000);
const hourOf = (t) => Math.floor(t / HOUR) * HOUR;
export const placeId = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

/* ---------- places ---------- */

async function touchPlace(env, lat, lon) {
  const id = placeId(lat, lon);
  await env.DB.prepare(
    `INSERT INTO places (id, lat, lon, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
  ).bind(id, lat, lon, nowS()).run();

  // keep only the most recently used places
  const extra = await env.DB.prepare(
    'SELECT id FROM places ORDER BY last_seen DESC LIMIT -1 OFFSET ?1',
  ).bind(MAX_PLACES).all();
  for (const r of extra.results) await dropPlace(env, r.id);

  return env.DB.prepare('SELECT * FROM places WHERE id = ?1').bind(id).first();
}

function dropPlace(env, id) {
  return env.DB.batch([
    env.DB.prepare('DELETE FROM readings WHERE place_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM places WHERE id = ?1').bind(id),
  ]);
}

/* ---------- writing readings ---------- */

// Fill in the past 30 days from Open-Meteo's hourly model data (marked 'model').
// Live readings recorded later replace these for the same hour.
async function backfill(env, place) {
  if (place.backfilled) return;
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.lat}&longitude=${place.lon}`
    + `&hourly=us_aqi,us_aqi_pm2_5&past_days=${BACKFILL_DAYS}&forecast_days=1&timeformat=unixtime`;
  const res = await fetch(url);
  if (!res.ok) return;                        // try again on the next request
  const h = (await res.json()).hourly;
  if (!h?.time) return;

  const now = nowS();
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO readings (place_id, ts, aqi, pm25, source) VALUES (?1, ?2, ?3, ?4, 'model')`,
  );
  const rows = [];
  h.time.forEach((t, i) => {
    if (t <= now && Number.isFinite(h.us_aqi[i])) rows.push(insert.bind(place.id, t, h.us_aqi[i], h.us_aqi_pm2_5[i] ?? null));
  });
  for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
  await env.DB.prepare('UPDATE places SET backfilled = 1 WHERE id = ?1').bind(place.id).run();
}

// Store this hour's reading for a place (replaces the backfilled model value)
async function saveReading(env, id, source, feed) {
  const aqi = Number(feed?.aqi);
  if (!Number.isFinite(aqi)) return;
  const pm25 = Number(feed.iaqi?.pm25?.v);
  await env.DB.prepare(
    `INSERT INTO readings (place_id, ts, aqi, pm25, source) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(place_id, ts) DO UPDATE SET aqi = excluded.aqi, pm25 = excluded.pm25, source = excluded.source`,
  ).bind(id, hourOf(nowS()), Math.round(aqi), Number.isFinite(pm25) ? Math.round(pm25) : null, source).run();
}

// Full source rule (same as the app). Also remembers the nearest station
// for the cheap hourly path. station_uid -1 means "looked, none found".
async function recordFull(env, place) {
  const r = await bestForPoint(env, place.lat, place.lon);
  await env.DB.prepare('UPDATE places SET station_uid = ?2, station_km = ?3 WHERE id = ?1')
    .bind(place.id, r.nearest?.uid ?? -1, r.nearest?.km ?? null).run();
  await saveReading(env, place.id, r.chosen, r.chosen === 'waqi' ? r.station : r.model);
}

// Cheap version for the cron: the remembered station if it's close and fresh,
// else the Open-Meteo current value. Same rule, fewer requests.
async function recordFast(env, place) {
  if (place.station_uid > 0 && place.station_km <= RULE.maxKm) {
    try {
      const st = await stationFeed(env, place.station_uid);
      if (hoursOld(st) <= RULE.maxAgeH) return saveReading(env, place.id, 'waqi', st);
    } catch { /* fall through to the model */ }
  }
  const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.lat}&longitude=${place.lon}&current=us_aqi,us_aqi_pm2_5`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const cur = (await res.json()).current;
  return saveReading(env, place.id, 'model', { aqi: cur?.us_aqi, iaqi: { pm25: { v: cur?.us_aqi_pm2_5 } } });
}

/* ---------- API + cron ---------- */

// GET /api/history?lat=..&lon=..&days=7|30
export async function historyFor(env, lat, lon, days) {
  if (!env.DB) throw Object.assign(new Error('History database is not set up.'), { status: 500 });
  const place = await touchPlace(env, lat, lon);
  await backfill(env, place);

  // a brand-new place has no live reading yet: take one now so the chart reaches the present
  const thisHour = await env.DB.prepare(
    `SELECT 1 FROM readings WHERE place_id = ?1 AND ts = ?2 AND source != 'model' LIMIT 1`,
  ).bind(place.id, hourOf(nowS())).first();
  if (!thisHour) { try { await recordFull(env, place); } catch { /* the chart still has the backfill */ } }

  const rows = await env.DB.prepare(
    'SELECT ts, aqi, pm25, source FROM readings WHERE place_id = ?1 AND ts >= ?2 ORDER BY ts',
  ).bind(place.id, nowS() - days * 86400).all();
  return { place: place.id, days, trackedSince: place.first_seen, points: rows.results };
}

// Runs every hour (see "triggers" in wrangler.jsonc)
export async function hourlyJob(env) {
  const now = nowS();
  await env.DB.prepare('DELETE FROM readings WHERE ts < ?1').bind(now - KEEP_DAYS * 86400).run();
  const idle = await env.DB.prepare('SELECT id FROM places WHERE last_seen < ?1').bind(now - IDLE_DAYS * 86400).all();
  for (const r of idle.results) await dropPlace(env, r.id);

  const places = await env.DB.prepare('SELECT * FROM places ORDER BY last_seen DESC LIMIT ?1').bind(MAX_PLACES).all();
  let full = 0;
  for (const p of places.results) {
    try {
      if (p.station_uid == null && full < FULL_LOOKUPS_PER_RUN) { full++; await recordFull(env, p); }
      else await recordFast(env, p);
    } catch (e) { console.log(`history: ${p.id} failed: ${e.message}`); }
  }
}
