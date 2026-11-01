import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Pusher from 'pusher';

import { HIBIRA_OPTIONS, HIBIRA_PUSHER, type ResolvedHibiraOptions } from './options';
import { streamToChannel, type StreamResult, type StreamSource, type StreamToChannelOptions } from './stream';

export interface TriggerOptions {
  /** Leave out this connection, usually the sender's (Laravel Echo sends it as `X-Socket-ID`). */
  socketId?: string;
  /** Ask for channel attributes in the answer, e.g. `['subscription_count']`. */
  info?: string[];
}

export interface BatchEvent {
  channel: string;
  name: string;
  data: unknown;
  socketId?: string;
  info?: string[];
}

export interface ChannelInfo {
  occupied?: boolean;
  subscription_count?: number;
  user_count?: number;
  [key: string]: unknown;
}

export interface ApprovalRequest {
  /** What needs a decision, as a short question (at most 200 characters). */
  title: string;
  /** Context shown to the person (at most 4000 characters). */
  details?: string;
  /** 2 to 4 choices; the first one approves. Default `["Approve", "Reject"]`. */
  options?: string[];
  /** How long the link can be answered, 1 to 10080. Default 60. */
  expiresInMinutes?: number;
  /** Channel that gets an `approval` event, for the @hibira-io/approvals inbox. */
  channel?: string;
  /** Send the link as a push notification to these interests (the app needs Push). */
  pushInterests?: string[];
  /** Or to these user IDs. */
  pushUsers?: string[];
  /** Who is asking, shown in the inbox. Default "Workflow". */
  agent?: string;
}

export interface Approval {
  approval_id: string;
  app_id: string;
  title: string;
  options: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  /** Hibira-hosted answer page; share it with whoever decides. Only on create. */
  url?: string;
  choice?: string;
  comment?: string;
  answered_at?: string;
  created_at: string;
  expires_at: string;
  push_error?: string;
  [key: string]: unknown;
}

export interface WebhookEvent {
  name:
    | 'channel_occupied'
    | 'channel_vacated'
    | 'member_added'
    | 'member_removed'
    | 'client_event'
    | 'cache_miss'
    | 'subscription_count'
    | 'chat_message'
    | (string & {});
  channel: string;
  user_id?: string;
  event?: string;
  data?: string;
  socket_id?: string;
  subscription_count?: number;
  [key: string]: unknown;
}

export interface WebhookPayload {
  time_ms: number;
  events: WebhookEvent[];
}

/** Thrown by verifyWebhook() for a request that did not come from this app. */
export class InvalidWebhookError extends Error {}

/** Server side of a Hibira app: publish events, authorize channels, stream text, ask for approvals. */
@Injectable()
export class HibiraService {
  /** The underlying `pusher` client, for anything not wrapped here. */
  readonly pusher: Pusher;

  constructor(
    @Inject(HIBIRA_OPTIONS) private readonly options: ResolvedHibiraOptions,
    @Inject(HIBIRA_PUSHER) pusher: Pusher,
  ) {
    this.pusher = pusher;
  }

  /** The public app key, for the browser (pusher-js / Laravel Echo). */
  get key(): string {
    return this.options.key;
  }

  /** Client settings for pusher-js or Laravel Echo, safe to send to a browser. */
  clientConfig(): { key: string; wsHost: string; wsPort?: number; wssPort?: number; forceTLS: boolean; enabledTransports: string[]; cluster: string } {
    const port = this.options.port ? Number(this.options.port) : undefined;
    return {
      key: this.options.key,
      wsHost: this.options.host,
      ...(port ? (this.options.useTLS ? { wssPort: port } : { wsPort: port }) : {}),
      forceTLS: this.options.useTLS,
      enabledTransports: ['ws', 'wss'],
      cluster: '',
    };
  }

  /** Publish an event to one channel or up to 100. */
  async trigger(channels: string | string[], event: string, data: unknown, options: TriggerOptions = {}): Promise<{ channels?: Record<string, ChannelInfo> }> {
    const params: Pusher.TriggerParams = {};
    if (options.socketId) params.socket_id = options.socketId;
    if (options.info?.length) params.info = options.info.join(',');
    const res = await this.pusher.trigger(channels as any, event, data, params);
    return json(res);
  }

  /** Publish up to 10 events in one request. */
  async triggerBatch(events: BatchEvent[]): Promise<{ batch?: ChannelInfo[] }> {
    const res = await this.pusher.triggerBatch(
      events.map((e) => ({
        channel: e.channel,
        name: e.name,
        data: e.data,
        ...(e.socketId ? { socket_id: e.socketId } : {}),
        ...(e.info?.length ? { info: e.info.join(',') } : {}),
      })) as Pusher.BatchEvent[],
    );
    return json(res);
  }

  /** Send an event to every connection of a signed-in user (pusher-js `signin()`). */
  async sendToUser(userId: string | number, event: string, data: unknown): Promise<void> {
    await this.pusher.sendToUser(String(userId), event, data);
  }

  /** Disconnect every connection of a signed-in user. */
  async terminateUserConnections(userId: string | number): Promise<void> {
    await this.pusher.terminateUserConnections(String(userId));
  }

  /** Occupied channels, optionally only those starting with `prefix`. */
  async channels(options: { prefix?: string; info?: string[] } = {}): Promise<Record<string, ChannelInfo>> {
    const params: Record<string, string> = {};
    if (options.prefix) params.filter_by_prefix = options.prefix;
    if (options.info?.length) params.info = options.info.join(',');
    const body = await json<{ channels?: Record<string, ChannelInfo> }>(await this.pusher.get({ path: '/channels', params }));
    return body.channels ?? {};
  }

  /** One channel's state, e.g. `channel('presence-room', ['user_count'])`. */
  async channel(name: string, info: string[] = []): Promise<ChannelInfo> {
    const params = info.length ? { info: info.join(',') } : undefined;
    return json(await this.pusher.get({ path: `/channels/${encodeURIComponent(name)}`, params }));
  }

  /** Members of a presence channel. */
  async users(name: string): Promise<Array<{ id: string }>> {
    const body = await json<{ users?: Array<{ id: string }> }>(await this.pusher.get({ path: `/channels/${encodeURIComponent(name)}/users` }));
    return body.users ?? [];
  }

  /** Signature for a private or presence channel subscription. Usually HibiraModule's auth route does this for you. */
  authorizeChannel(socketId: string, channel: string, presence?: { user_id: string; user_info?: Record<string, unknown> }): Pusher.ChannelAuthResponse {
    return this.pusher.authorizeChannel(socketId, channel, presence as Pusher.PresenceChannelData | undefined);
  }

  /** Signature for user sign-in (pusher-js `signin()`). */
  authenticateUser(socketId: string, user: { id: string; user_info?: Record<string, unknown>; watchlist?: string[] }): Pusher.UserAuthResponse {
    return this.pusher.authenticateUser(socketId, user as unknown as Pusher.UserChannelData);
  }

  /**
   * Stream text (an LLM SDK stream, async iterable or ReadableStream) to a
   * channel; useStream() in @hibira-io/react, vue and nuxt shows it live.
   */
  stream(channel: string, source: StreamSource, options?: StreamToChannelOptions): Promise<StreamResult> {
    return streamToChannel(this.pusher, channel, source, options);
  }

  /** Ask a person for a decision; returns the request with its answer link (`url`). Hibira account apps only. */
  async requestApproval(request: ApprovalRequest): Promise<Approval> {
    const body: Record<string, unknown> = { title: request.title };
    if (request.details !== undefined) body.details = request.details;
    if (request.options !== undefined) body.options = request.options;
    if (request.expiresInMinutes !== undefined) body.expires_in_minutes = request.expiresInMinutes;
    if (request.channel !== undefined) body.channel = request.channel;
    if (request.pushInterests !== undefined) body.push_interests = request.pushInterests;
    if (request.pushUsers !== undefined) body.push_users = request.pushUsers;
    if (request.agent !== undefined) body.agent = request.agent;
    // pusher's typings say string, but post() JSON-encodes whatever it gets.
    return json(await this.pusher.post({ path: '/approvals', body: body as any }));
  }

  /** Read an approval; `wait` (0 to 25 seconds) holds the request until it is answered. */
  async getApproval(id: string, options: { wait?: number } = {}): Promise<Approval> {
    const params = options.wait ? { wait: Math.max(0, Math.min(25, Math.floor(options.wait))) } : undefined;
    return json(await this.pusher.get({ path: `/approvals/${encodeURIComponent(id)}`, params }));
  }

  /**
   * Wait until an approval is answered or expires, or `timeoutMs` (default 10
   * minutes) runs out; then it resolves with the status at that point
   * (`pending` on timeout).
   */
  async waitForApproval(id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Approval> {
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    let current = await this.getApproval(id);
    while (current.status === 'pending') {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
      const left = Math.floor((deadline - Date.now()) / 1000);
      if (left <= 0) break;
      current = await this.getApproval(id, { wait: Math.min(25, left) });
    }
    return current;
  }

  /**
   * Check a webhook request and return its events. `rawBody` must be the
   * exact bytes received (NestFactory.create(AppModule, { rawBody: true })).
   * Throws InvalidWebhookError when the key or signature does not match.
   */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string | Buffer, previousSecret?: string): WebhookPayload {
    const header = (name: string) => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    if (header('x-pusher-key') !== this.options.key) throw new InvalidWebhookError('webhook X-Pusher-Key does not match this app');
    const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
    const valid =
      matches(header('x-pusher-signature'), this.options.secret, body) ||
      (previousSecret !== undefined && matches(header('x-hibira-previous-signature'), previousSecret, body));
    if (!valid) throw new InvalidWebhookError('webhook signature does not match the app secret');
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new InvalidWebhookError('webhook body is not JSON');
    }
    if (!payload || !Array.isArray(payload.events)) throw new InvalidWebhookError('webhook body has no events');
    return payload;
  }
}

function matches(signature: string | undefined, secret: string, body: Buffer): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function json<T = any>(res: { text(): Promise<string> } | undefined): Promise<T> {
  if (!res) return {} as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
