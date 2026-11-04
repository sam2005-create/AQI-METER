/**
 * Live AQI backend (Cloudflare Worker)
 *
 * Serves the app from ./public and a small JSON API under /api:
 *   GET /api/aqi?lat=..&lon=..           best reading for a point (station vs model, see RULE)
 *   GET /api/station?uid=..              one WAQI station
 *   GET /api/search?q=..                 WAQI station search
 *   GET /api/place?q=..                  best live WAQI station for a city name
 *   GET /api/history?lat=..&lon=..&days= hourly AQI for the last 7 or 30 days
 *   GET /api/whereami                    rough location of the caller (city level)
 *   GET /api/health                      liveness check
 *
 * An hourly cron job records readings for tracked places (src/history.js).
 * The WAQI token lives in the WAQI_TOKEN secret, never in the page.
 */

import {
  RULE, TTL, json, coord, uidParam, textParam,
  stationFeed, search, bestForPlace, bestForPoint, whereAmI,
} from './sources.js';
import { historyFor, hourlyJob } from './history.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, { status: 405 });

    try {
      const p = url.searchParams;
      switch (url.pathname) {
        case '/api/aqi':
          return json(await bestForPoint(env, coord(p.get('lat'), 90), coord(p.get('lon'), 180)), { maxAge: 300 });
        case '/api/station':
          return json(await stationFeed(env, uidParam(p.get('uid'))), { maxAge: TTL.feed });
        case '/api/search':
          return json(await search(env, textParam(p.get('q'))), { maxAge: 3600 });
        case '/api/place':
          return json(await bestForPlace(env, textParam(p.get('q'))), { maxAge: TTL.feed });
        case '/api/history': {
          const days = p.get('days') === '30' ? 30 : 7;
          return json(await historyFor(env, coord(p.get('lat'), 90), coord(p.get('lon'), 180), days), { maxAge: 300 });
        }
        case '/api/whereami':
          return json(whereAmI(request), { private: true });
        case '/api/health':
          return json({ ok: true, rule: RULE });
        default:
          return json({ error: 'Not found.' }, { status: 404 });
      }
    } catch (e) {
      return json({ error: e.message || 'Server error.' }, { status: e.status || 502 });
    }
  },

  // hourly: record readings for tracked places
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourlyJob(env));
  },
};
