
import * as SQLite from 'expo-sqlite';

const DATABASE_NAME = 'irads.db';

export type AnomalyEvent = {
  id: string;
  type: 'POTHOLE' | 'SPEED_BREAKER';
  confidence: number;
  latitude: number;
  longitude: number;
  gpsAccuracyM: number;
  speedKmh: number;
  rawZPeak: number;
  detectedAt: number;
  deviceIdHash: string;
  syncStatus: 'PENDING' | 'SYNCED' | 'REJECTED';
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function initializeDatabase(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(
    DATABASE_NAME
  );

  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS anomaly_events (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      confidence REAL NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      gps_accuracy_m REAL NOT NULL DEFAULT 0,
      speed_kmh REAL NOT NULL,
      raw_z_peak REAL NOT NULL DEFAULT 0,
      detected_at INTEGER NOT NULL,
      device_id_hash TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'PENDING'
    );
  `);

  const columns = await database.getAllAsync<{
    name: string;
  }>(
    'PRAGMA table_info(anomaly_events);'
  );

  const names = new Set(
    columns.map((column) => column.name)
  );

  if (!names.has('gps_accuracy_m')) {
    await database.execAsync(`
      ALTER TABLE anomaly_events
      ADD COLUMN gps_accuracy_m REAL NOT NULL DEFAULT 0;
    `);
  }

  if (!names.has('raw_z_peak')) {
    await database.execAsync(`
      ALTER TABLE anomaly_events
      ADD COLUMN raw_z_peak REAL NOT NULL DEFAULT 0;
    `);
  }

  return database;
}

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = initializeDatabase().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }

  return dbPromise;
}

export async function saveAnomalyEvent(
  event: AnomalyEvent
): Promise<void> {
  const database = await getDatabase();

  await database.runAsync(
    `
      INSERT INTO anomaly_events (
        id,
        type,
        confidence,
        latitude,
        longitude,
        gps_accuracy_m,
        speed_kmh,
        raw_z_peak,
        detected_at,
        device_id_hash,
        sync_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    event.id,
    event.type,
    event.confidence,
    event.latitude,
    event.longitude,
    event.gpsAccuracyM,
    event.speedKmh,
    event.rawZPeak,
    event.detectedAt,
    event.deviceIdHash,
    event.syncStatus
  );
}

export async function getPendingAnomalyEvents(): Promise<AnomalyEvent[]> {
  const database = await getDatabase();

  return database.getAllAsync<AnomalyEvent>(`
    SELECT
      id,
      type,
      confidence,
      latitude,
      longitude,
      gps_accuracy_m AS gpsAccuracyM,
      speed_kmh AS speedKmh,
      raw_z_peak AS rawZPeak,
      detected_at AS detectedAt,
      device_id_hash AS deviceIdHash,
      sync_status AS syncStatus
    FROM anomaly_events
    WHERE sync_status = 'PENDING'
    ORDER BY detected_at ASC;
  `);
}

export async function markAnomalyEventSynced(
  id: string
): Promise<void> {
  const database = await getDatabase();

  await database.runAsync(
    `
      UPDATE anomaly_events
      SET sync_status = 'SYNCED'
      WHERE id = ?
    `,
    id
  );
}

export async function markAnomalyEventRejected(
  id: string
): Promise<void> {
  const database = await getDatabase();

  await database.runAsync(
    `
      UPDATE anomaly_events
      SET sync_status = 'REJECTED'
      WHERE id = ?
    `,
    id
  );
}

export async function clearPendingAnomalyEvents(): Promise<void> {
  const database = await getDatabase();

  await database.runAsync(`
    DELETE FROM anomaly_events
    WHERE sync_status = 'PENDING';
  `);
}
