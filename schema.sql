-- AQI history (Cloudflare D1 / SQLite)
-- Apply with: npx wrangler d1 execute aqi-history --remote --file schema.sql

-- Places being tracked. id is "lat,lon" rounded to 2 decimals (about 1 km).
CREATE TABLE IF NOT EXISTS places (
  id          TEXT PRIMARY KEY,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  first_seen  INTEGER NOT NULL,          -- unix seconds
  last_seen   INTEGER NOT NULL,          -- last time the app asked for it
  backfilled  INTEGER NOT NULL DEFAULT 0, -- 1 once the past 30 days were filled in
  station_uid INTEGER,                   -- nearest WAQI station (-1 = none found, NULL = not looked up yet)
  station_km  REAL
);
-- Databases created before station_uid existed:
--   ALTER TABLE places ADD COLUMN station_uid INTEGER;
--   ALTER TABLE places ADD COLUMN station_km REAL;

-- One row per place per hour.
-- source: 'waqi' = measured by a ground station, 'model' = Open-Meteo estimate
CREATE TABLE IF NOT EXISTS readings (
  place_id  TEXT NOT NULL,
  ts        INTEGER NOT NULL,              -- start of the hour, unix seconds
  aqi       INTEGER,
  pm25      INTEGER,                       -- PM2.5 sub-index (US AQI)
  source    TEXT NOT NULL,
  PRIMARY KEY (place_id, ts)
);

CREATE INDEX IF NOT EXISTS readings_ts ON readings (ts);
