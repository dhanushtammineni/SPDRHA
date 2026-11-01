
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
const TOKEN_CACHE_MS = 11 * 60 * 60 * 1000;

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
    super(`Permanent anomaly validation failure: HTTP ${status}`);
  }
}

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

function getRetryAfterSeconds(response: Response): number {
  const value = Number.parseInt(
    response.headers.get('Retry-After') ?? '60',
    10
  );

  return Number.isFinite(value) && value > 0
    ? value
    : 60;
}

export class SyncService {
  private syncing = false;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  private consecutiveFailures = 0;
  private retryNotBefore = 0;

  async syncPendingEvents(): Promise<void> {
    if (this.syncing || Date.now() < this.retryNotBefore) {
      return;
    }

    this.syncing = true;

    try {
      const events = await getPendingAnomalyEvents();

      if (events.length === 0) {
        this.resetRetryState();
        return;
      }

      console.log(
        `IRADS: ${events.length} pending anomaly event(s)`
      );

      for (const event of events) {
        try {
          await this.uploadEvent(event);
          this.resetRetryState();

        } catch (error) {
          if (error instanceof PermanentEventError) {
            console.warn(
              `IRADS: event ${event.id} rejected with HTTP ${error.status}`
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
            `IRADS: sync paused; event ${event.id} remains PENDING`,
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

      this.retryNotBefore = Date.now() + Math.min(
        MAX_RETRY_DELAY_MS,
        2000 * 2 ** (this.consecutiveFailures - 1)
      );

      console.warn('IRADS: offline sync error', error);

    } finally {
      this.syncing = false;
    }
  }

  private resetRetryState(): void {
    this.consecutiveFailures = 0;
    this.retryNotBefore = 0;
  }

  private clearCachedToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  private async uploadEvent(
    event: AnomalyEvent
  ): Promise<void> {
    let token = await this.getToken();

    let response = await this.sendAnomaly(event, token);

    if (response.status === 401) {
      console.log(
        'IRADS: JWT rejected; refreshing authentication'
      );

      this.clearCachedToken();

      token = await this.getToken();

      response = await this.sendAnomaly(event, token);
    }

    if (response.status === 429) {
      throw new RateLimitError(
        getRetryAfterSeconds(response)
      );
    }

    if (
      response.status === 400 ||
      response.status === 422
    ) {
      throw new PermanentEventError(response.status);
    }

    if (!response.ok) {
      throw new Error(
        `Anomaly upload failed: HTTP ${response.status}`
      );
    }

    await markAnomalyEventSynced(event.id);

    console.log(
      `IRADS: event ${event.id} synchronized`
    );
  }

  private async sendAnomaly(
    event: AnomalyEvent,
    token: string
  ): Promise<Response> {
    return fetchWithTimeout(
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

    // First try to authenticate an already registered device.
    let response = await this.requestToken(
      deviceIdHash,
      credential
    );

    // A new installation has not been registered yet.
    if (response.status === 401) {
      console.log(
        'IRADS: device not authenticated; attempting registration'
      );

      await this.registerDevice(
        deviceIdHash,
        credential
      );

      response = await this.requestToken(
        deviceIdHash,
        credential
      );
    }

    if (response.status === 429) {
      throw new RateLimitError(
        getRetryAfterSeconds(response)
      );
    }

    if (!response.ok) {
      throw new Error(
        `Device authentication failed: HTTP ${response.status}`
      );
    }

    const data: { access_token?: string } =
      await response.json();

    if (!data.access_token) {
      throw new Error(
        'Authentication response missing access_token'
      );
    }

    this.accessToken = data.access_token;

    this.tokenExpiresAt =
      Date.now() + TOKEN_CACHE_MS;

    console.log('IRADS: device authenticated');

    return data.access_token;
  }

  private async requestToken(
    deviceIdHash: string,
    credential: string
  ): Promise<Response> {
    return fetchWithTimeout(
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
  }

  private async registerDevice(
    deviceIdHash: string,
    credential: string
  ): Promise<void> {
    const response = await fetchWithTimeout(
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

    if (response.status === 429) {
      throw new RateLimitError(
        getRetryAfterSeconds(response)
      );
    }

    if (!response.ok) {
      throw new Error(
        `Device registration failed: HTTP ${response.status}`
      );
    }

    console.log('IRADS: device registration successful');
  }
}

export const syncService = new SyncService();
