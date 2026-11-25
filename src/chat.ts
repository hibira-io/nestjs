import { createHash, createHmac } from 'node:crypto';
import type { ResolvedHibiraOptions } from './options';

/** Thrown when the Chat API answers with an error status. */
export class HibiraChatError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Hibira Chat API ${status}: ${typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : JSON.stringify(body)}`);
    this.name = 'HibiraChatError';
  }
}

export interface ConversationFields {
  name?: string;
  /** User IDs; leave out to keep the current members. */
  members?: string[];
  metadata?: Record<string, unknown>;
  /** `{ user_id: role }` */
  roles?: Record<string, string>;
  /** Up to 10 private or presence channels that also receive the events; leave out to keep them. */
  watchers?: string[];
}

export interface SendMessageOptions {
  name?: string;
  metadata?: Record<string, unknown>;
  /** `offline` (default): push to members who are not connected; `always`; `never`. */
  push?: 'offline' | 'always' | 'never';
  pushTitle?: string;
  pushUrl?: string;
  /** Up to 5 roles that may see the message. */
  visibleTo?: string[];
  idempotencyKey?: string;
}

type Params = Record<string, string | number | undefined>;

const seg = (value: string | number) => {
  const s = String(value);
  if (!s) throw new Error('an ID is required');
  return encodeURIComponent(s);
};

/**
 * The Chat API (https://hibira.io/chat-api): conversations with stored
 * history, read receipts and offline push. Clients receive `chat.*` events on
 * `#server-to-user-<user_id>` after pusher-js `signin()`.
 */
export class HibiraChat {
  constructor(private readonly options: ResolvedHibiraOptions) {}

  /** Any Chat API call, signed. `path` is relative to /apps/APP_ID/chat, e.g. `/conversations/c1/typing`. */
  async request<T = any>(method: string, path: string, params: Params = {}, body?: unknown): Promise<T> {
    const { appId, key, secret, host, port, useTLS, timeout } = this.options;
    if (!appId || !key || !secret) throw new Error('Hibira Chat API: appId, key and secret are required');
    if (!path.startsWith('/')) throw new Error('path must start with "/"');
    const verb = method.toUpperCase();
    const fullPath = `/apps/${encodeURIComponent(appId)}/chat${path}`;
    const content = body === undefined ? undefined : JSON.stringify(body);
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query[k.toLowerCase()] = String(v);
    query.auth_key = key;
    query.auth_timestamp = String(Math.floor(Date.now() / 1000));
    query.auth_version = '1.0';
    if (content !== undefined) query.body_md5 = createHash('md5').update(content).digest('hex');
    const sorted = Object.keys(query)
      .sort()
      .map((k) => `${k}=${query[k]}`)
      .join('&');
    const signature = createHmac('sha256', secret).update(`${verb}\n${decodeURIComponent(fullPath)}\n${sorted}`).digest('hex');
    const qs = new URLSearchParams({ ...query, auth_signature: signature }).toString();
    const origin = `${useTLS ? 'https' : 'http'}://${host}${port ? `:${port}` : ''}`;
    const res = await fetch(`${origin}${fullPath}?${qs}`, {
      method: verb,
      headers: content === undefined ? {} : { 'content-type': 'application/json' },
      body: content,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let out: unknown = {};
    try {
      out = text ? JSON.parse(text) : {};
    } catch {
      out = text;
    }
    if (!res.ok) throw new HibiraChatError(res.status, out);
    return out as T;
  }

  /** Create or replace a conversation. */
  putConversation(id: string, fields: ConversationFields = {}) {
    return this.request('PUT', `/conversations/${seg(id)}`, {}, clean(fields));
  }

  getConversation(id: string) {
    return this.request('GET', `/conversations/${seg(id)}`);
  }

  /** Delete a conversation with its members, messages and files. */
  deleteConversation(id: string) {
    return this.request('DELETE', `/conversations/${seg(id)}`);
  }

  addMembers(id: string, userIds: Array<string | number>) {
    return this.request('POST', `/conversations/${seg(id)}/members`, {}, { user_ids: userIds.map(String) });
  }

  removeMember(id: string, userId: string | number) {
    return this.request('DELETE', `/conversations/${seg(id)}/members/${seg(userId)}`);
  }

  /** Post a message as a member. */
  sendMessage(id: string, userId: string | number, text: string, options: SendMessageOptions = {}) {
    return this.request(
      'POST',
      `/conversations/${seg(id)}/messages`,
      {},
      clean({
        user_id: String(userId),
        text,
        name: options.name,
        metadata: options.metadata,
        push: options.push,
        push_title: options.pushTitle,
        push_url: options.pushUrl,
        visible_to: options.visibleTo,
        idempotency_key: options.idempotencyKey,
      }),
    );
  }

  /** Messages oldest first: after a seq (with limit), or the last n. */
  listMessages(id: string, options: { after?: number; limit?: number; last?: number } = {}) {
    return this.request('GET', `/conversations/${seg(id)}/messages`, options);
  }

  markRead(id: string, userId: string | number, seq: number) {
    return this.request('POST', `/conversations/${seg(id)}/read`, {}, { user_id: String(userId), seq });
  }

  /** A message with no sender, such as "Alice joined". */
  systemMessage(id: string, text: string, metadata?: Record<string, unknown>) {
    return this.request('POST', `/conversations/${seg(id)}/system`, {}, clean({ text, metadata }));
  }

  /** A user's conversations, latest activity first, each with its unread count. */
  userConversations(userId: string | number, options: { limit?: number; before?: string } = {}) {
    return this.request('GET', `/users/${seg(userId)}/conversations`, options);
  }
}

function clean(fields: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** hex(HMAC-SHA256(identity secret, user ID)): the Live Chat widget's `data-user-hash` for verified visitors. */
export function liveChatUserHash(identitySecret: string, userId: string | number): string {
  if (!identitySecret) throw new Error('liveChatUserHash: identitySecret is required');
  return createHmac('sha256', identitySecret).update(String(userId)).digest('hex');
}
