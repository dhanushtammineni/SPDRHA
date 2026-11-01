
import {
  getPendingAnomalyEvents,
  markAnomalyEventSynced,
  markAnomalyEventRejected,
} from './database';

import type { AnomalyEvent } from './database';
import { API_BASE_URL } from '../config';
import { getDeviceIdHash } from './deviceIdentity';
import { getOrCreateDeviceCredential } from './deviceRegistration';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export class SyncService {
  private syncing = false;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  private consecutiveFailures = 0;
  private retryNotBefore = 0;

  async syncPendingEvents(): Promise<void> {
    if (this.syncing) {
      return;
    }

    if (Date.now() < this.retryNotBefore) {
      return;
    }

    this.syncing = true;

    try {
      const events = await getPendingAnomalyEvents();

      if (events.length === 0) {
        this.consecutiveFailures = 0;
        this.retryNotBefore = 0;
        return;
      }

      console.log(
        `Found ${events.length} pending anomaly event(s).`
      );

      for (const event of events) {
        try {
          await this.syncEvent(event);

          this.consecutiveFailures = 0;
          this.retryNotBefore = 0;

        } catch (error) {
          if (error instanceof PermanentEventError) {
            console.warn(
              `Event ${event.id} permanently rejected: HTTP ${error.status}`
            );

            await markAnomalyEventRejected(event.id);
            continue;
          }

          if (error instanceof RateLimitError) {
            this.retryNotBefore =
              Date.now() + error.retryAfterSeconds * 1000;

          } else {
            this.consecutiveFailures = Math.min(
              this.consecutiveFailures + 1,
              8
            );

            const delay = Math.min(
              MAX_RETRY_DELAY_MS,
              2000 * 2 ** (this.consecutiveFailures - 1)
            );

            this.retryNotBefore = Date.now() + delay;
          }

          console.warn(
            `Upload paused. Event ${event.id} remains PENDING:`,
            error
          );

          break;
        }
      }

    } catch (error) {
      this.consecutiveFailures = Math.min(
        this.consecutiveFailures + 1,
        8
      );

      const delay = Math.min(
        MAX_RETRY_DELAY_MS,
        2000 * 2 ** (this.consecutiveFailures - 1)
      );

      this.retryNotBefore = Date.now() + delay;

      console.warn('Offline queue failure:', error);

    } finally {
      this.syncing = false;
    }
  }

  private async syncEvent(
    event: AnomalyEvent
  ): Promise<void> {
    const token = await this.getToken();

    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/v1/anomalies`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: event.id,
          type: event.type,
          confidence: event.confidence,
          latitude: event.latitude,
          longitude: event.longitude,
          gps_accuracy_m: event.gpsAccuracyM,
          speed_kmh: event.speedKmh,
          raw_z_peak: event.rawZPeak,
          device_id_hash: event.deviceIdHash,
          detected_at_ms: event.detectedAt,
        }),
      }
    );

    if (response.status === 429) {
      const seconds = Number.parseInt(
        response.headers.get('Retry-After') ?? '60',
        10
      );

      throw new RateLimitError(
        Number.isFinite(seconds) && seconds > 0
          ? seconds
          : 60
      );
    }

    if (response.status === 401) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
    }

    if (
      response.status === 400 ||
      response.status === 422
    ) {
      throw new PermanentEventError(response.status);
    }

    if (!response.ok) {
      throw new Error(
        `Anomaly upload rejected: HTTP ${response.status}`
      );
    }

    await markAnomalyEventSynced(event.id);

    console.log(
      `Synced anomaly event successfully: ${event.id}`
    );
  }

  private async getToken(): Promise<string> {
    if (
      this.accessToken &&
      Date.now() < this.tokenExpiresAt
    ) {
      return this.accessToken;
    }

    const [deviceIdHash, credential] =
      await Promise.all([
        getDeviceIdHash(),
        getOrCreateDeviceCredential(),
      ]);

    const registrationResponse = await fetchWithTimeout(
      `${API_BASE_URL}/api/v1/dev/register`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          device_id_hash: deviceIdHash,
          device_credential: credential,
        }),
      }
    );

    if (registrationResponse.status === 429) {
      const seconds = Number.parseInt(
        registrationResponse.headers.get('Retry-After') ?? '60',
        10
      );

      throw new RateLimitError(
        Number.isFinite(seconds) && seconds > 0
          ? seconds
          : 60
      );
    }

    if (!registrationResponse.ok) {
      throw new Error(
        `Device registration failed: HTTP ${registrationResponse.status}`
      );
    }

    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/v1/dev/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Key': credential,
        },
        body: JSON.stringify({
          device_id_hash: deviceIdHash,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `Device authentication failed: HTTP ${response.status}`
      );
    }

    const data: { access_token?: string } =
      await response.json();

    if (!data.access_token) {
      throw new Error(
        'Token response did not contain access_token'
      );
    }

    this.accessToken = data.access_token;

    this.tokenExpiresAt =
      Date.now() + 11 * 60 * 60 * 1000;

    return data.access_token;
  }
}

class RateLimitError extends Error {
  constructor(
    public readonly retryAfterSeconds: number
  ) {
    super('Backend rate limit exceeded');
  }
}

class PermanentEventError extends Error {
  constructor(
    public readonly status: number
  ) {
    super(`Permanent validation failure: HTTP ${status}`);
  }
}

export const syncService = new SyncService();
