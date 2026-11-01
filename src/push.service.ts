import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { HIBIRA_OPTIONS, type ResolvedHibiraOptions } from './options';

/** A Beams-compatible publish body: `apns`, `fcm` and/or `web` payloads. */
export interface PushPayload {
  apns?: Record<string, unknown>;
  fcm?: Record<string, unknown>;
  web?: Record<string, unknown>;
  [key: string]: unknown;
}

export class HibiraPushError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * Hibira Push (Beams-compatible) from the server: publish to interests or
 * users, sign user tokens for @hibira-io/push-web and the mobile SDKs, and
 * delete users. Needs `push` options or HIBIRA_PUSH_INSTANCE_ID and
 * HIBIRA_PUSH_SECRET_KEY.
 */
@Injectable()
export class HibiraPushService {
  constructor(@Inject(HIBIRA_OPTIONS) private readonly options: ResolvedHibiraOptions) {}

  /** True when an instance ID and secret key are set. */
  get enabled(): boolean {
    return this.options.push !== undefined;
  }

  /** Send a notification to devices subscribed to any of up to 100 interests. */
  publishToInterests(interests: string[], payload: PushPayload): Promise<{ publishId: string }> {
    return this.request('POST', `/publish_api/v1/instances/{instance}/publishes/interests`, { ...payload, interests });
  }

  /** Send a notification to up to 1000 signed-in users. */
  publishToUsers(users: Array<string | number>, payload: PushPayload): Promise<{ publishId: string }> {
    return this.request('POST', `/publish_api/v1/instances/{instance}/publishes/users`, { ...payload, users: users.map(String) });
  }

  /** Remove a user and all their devices. */
  async deleteUser(userId: string | number): Promise<void> {
    await this.request('DELETE', `/customer_api/v1/instances/{instance}/users/${encodeURIComponent(String(userId))}`);
  }

  /**
   * A user token that links a device to `userId` (what the client SDKs'
   * TokenProvider fetches). Serve it only to that user, after your own
   * authentication. `expiresIn` is in seconds, default 24 hours.
   */
  generateToken(userId: string | number, options: { expiresIn?: number } = {}): { token: string } {
    const push = this.config();
    const id = String(userId);
    if (!id || id.length > 164) throw new Error('HibiraPushService.generateToken: userId must be 1 to 164 characters');
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({ sub: id, iat: now, exp: now + (options.expiresIn ?? 86_400), iss: `https://${push.instanceId}.pushnotifications.pusher.com` }),
    );
    const signature = base64url(createHmac('sha256', push.secretKey).update(`${header}.${claims}`).digest());
    return { token: `${header}.${claims}.${signature}` };
  }

  private config() {
    if (!this.options.push) {
      throw new Error('HibiraPushService: set push.instanceId and push.secretKey in HibiraModule options, or HIBIRA_PUSH_INSTANCE_ID and HIBIRA_PUSH_SECRET_KEY');
    }
    return this.options.push;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const push = this.config();
    const url = push.endpoint + path.replace('{instance}', encodeURIComponent(push.instanceId));
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${push.secretKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeout),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `Hibira Push answered ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.description || parsed?.error) message += `: ${parsed.description ?? parsed.error}`;
      } catch {
        /* not JSON */
      }
      throw new HibiraPushError(message, res.status, text);
    }
    return text ? JSON.parse(text) : {};
  }
}
