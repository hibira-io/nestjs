import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';

import { HibiraBroadcastInterceptor } from './broadcast.interceptor';

export const HIBIRA_CHANNEL = 'hibira:channel';
export const HIBIRA_WEBHOOK = 'hibira:webhook';
export const HIBIRA_BROADCAST = 'hibira:broadcast';

export interface HibiraChannelOptions {
  /** Call the method for visitors with no signed-in user too (it gets `undefined`). Default false: they are refused. */
  guests?: boolean;
}

export interface HibiraChannelMeta extends HibiraChannelOptions {
  pattern: string | RegExp;
}

/**
 * Marks a provider method as the authorizer for channels matching `pattern`,
 * like Laravel's routes/channels.php. `{name}` matches one dot-separated
 * part and is passed in `params`:
 *
 * ```ts
 * @HibiraChannel('private-orders.{orderId}')
 * canSeeOrder(user: User, { orderId }: { orderId: string }) {
 *   return this.orders.ownedBy(orderId, user.id);
 * }
 * ```
 *
 * Return true (or for presence channels, the member's `user_info` object, or
 * a full `{ user_id, user_info }`) to allow; anything falsy refuses with 403.
 * The method may be async.
 */
export function HibiraChannel(pattern: string | RegExp, options: HibiraChannelOptions = {}): MethodDecorator {
  return (target, key, descriptor) => {
    const list: HibiraChannelMeta[] = Reflect.getMetadata(HIBIRA_CHANNEL, descriptor.value as object) ?? [];
    Reflect.defineMetadata(HIBIRA_CHANNEL, [...list, { pattern, ...options }], descriptor.value as object);
    return descriptor;
  };
}

/**
 * Marks a provider method as a webhook handler. It gets each event of the
 * given type (`'*'` for all) and the batch time:
 *
 * ```ts
 * @OnHibiraWebhook('member_removed')
 * async left(event: WebhookEvent) { await this.rooms.leave(event.channel, event.user_id) }
 * ```
 *
 * A handler that throws makes the route answer 500, and Hibira sends the
 * whole batch again later, so keep handlers idempotent.
 */
export function OnHibiraWebhook(...names: string[]): MethodDecorator {
  return (target, key, descriptor) => {
    const list: string[] = Reflect.getMetadata(HIBIRA_WEBHOOK, descriptor.value as object) ?? [];
    Reflect.defineMetadata(HIBIRA_WEBHOOK, [...list, ...(names.length ? names : ['*'])], descriptor.value as object);
    return descriptor;
  };
}

export interface BroadcastContext<T = any> {
  /** What the route handler returned. */
  result: T;
  /** Route parameters. */
  params: Record<string, string>;
  /** The request (Express or Fastify). */
  request: any;
}

export interface BroadcastOptions<T = any> {
  /** Event data. Default: the handler's return value. */
  data?: (ctx: BroadcastContext<T>) => unknown;
  /** Leave out the connection named in the `X-Socket-ID` header (Laravel Echo's toOthers). Default true. */
  toOthers?: boolean;
  /** Skip broadcasting when this returns false. */
  when?: (ctx: BroadcastContext<T>) => boolean;
}

export interface BroadcastMeta extends BroadcastOptions {
  channels: string | string[] | ((ctx: BroadcastContext) => string | string[]);
  event: string;
}

/**
 * Publishes a route's result after the handler succeeds. In channel names,
 * `{name}` is replaced by the route parameter of that name, then by the
 * result's field of that name:
 *
 * ```ts
 * @Patch('orders/:id')
 * @Broadcast('private-orders.{id}', 'order.updated')
 * update(@Param('id') id: string, @Body() dto: UpdateOrder) { return this.orders.update(id, dto) }
 * ```
 *
 * A failed publish is logged and does not fail the request.
 */
export function Broadcast<T = any>(
  channels: string | string[] | ((ctx: BroadcastContext<T>) => string | string[]),
  event: string,
  options: BroadcastOptions<T> = {},
) {
  return applyDecorators(SetMetadata(HIBIRA_BROADCAST, { channels, event, ...options }), UseInterceptors(HibiraBroadcastInterceptor));
}
