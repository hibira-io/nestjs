import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { HIBIRA_CHANNEL, HIBIRA_WEBHOOK, type HibiraChannelMeta } from './decorators';
import type { WebhookEvent, WebhookPayload } from './hibira.service';

export interface ChannelContext {
  /** Full channel name, e.g. "presence-room.42". */
  channel: string;
  socketId: string;
  request: any;
}

type ChannelHandler = (user: any, params: Record<string, string>, ctx: ChannelContext) => unknown;
type WebhookHandler = (event: WebhookEvent, ctx: { timeMs: number; request?: any }) => unknown;

interface ChannelRoute {
  regex: RegExp;
  names: string[];
  guests: boolean;
  handler: ChannelHandler;
  label: string;
}

/** Finds @HibiraChannel and @OnHibiraWebhook methods on the app's providers and calls them. */
@Injectable()
export class HibiraExplorer implements OnModuleInit {
  private readonly logger = new Logger('Hibira');
  private channelRoutes: ChannelRoute[] = [];
  private webhookHandlers: Array<{ names: string[]; handler: WebhookHandler }> = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    this.channelRoutes = [];
    this.webhookHandlers = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object' || !wrapper.isDependencyTreeStatic()) continue;
      const proto = Object.getPrototypeOf(instance);
      if (!proto) continue;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const fn = proto[name];
        if (typeof fn !== 'function') continue;
        const channels: HibiraChannelMeta[] | undefined = Reflect.getMetadata(HIBIRA_CHANNEL, fn);
        for (const meta of channels ?? []) {
          this.channelRoutes.push({
            ...compile(meta.pattern),
            guests: meta.guests === true,
            handler: fn.bind(instance),
            label: `${instance.constructor?.name ?? 'provider'}.${name}`,
          });
        }
        const webhooks: string[] | undefined = Reflect.getMetadata(HIBIRA_WEBHOOK, fn);
        if (webhooks?.length) this.webhookHandlers.push({ names: webhooks, handler: fn.bind(instance) });
      }
    }
  }

  /** The first @HibiraChannel pattern that matches, with its parameters. */
  matchChannel(channel: string): { route: ChannelRoute; params: Record<string, string> } | undefined {
    for (const route of this.channelRoutes) {
      const m = route.regex.exec(channel);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.names.forEach((n, i) => (params[n] = m[i + 1]));
      if (m.groups) Object.assign(params, m.groups);
      return { route, params };
    }
    return undefined;
  }

  /** Call every @OnHibiraWebhook handler for each event of a verified payload, in order. */
  async dispatch(payload: WebhookPayload, request?: any): Promise<number> {
    let calls = 0;
    for (const event of payload.events) {
      for (const { names, handler } of this.webhookHandlers) {
        if (!names.includes('*') && !names.includes(event.name)) continue;
        calls++;
        await handler(event, { timeMs: payload.time_ms, request });
      }
    }
    return calls;
  }

  get hasWebhookHandlers(): boolean {
    return this.webhookHandlers.length > 0;
  }

  warnIfEmpty(kind: 'channels' | 'webhooks'): void {
    if (kind === 'channels' && this.channelRoutes.length === 0) {
      this.logger.warn('the auth route is on but no provider method has @HibiraChannel(); every private and presence channel will be refused');
    }
    if (kind === 'webhooks' && this.webhookHandlers.length === 0) {
      this.logger.warn('the webhook route is on but no provider method has @OnHibiraWebhook()');
    }
  }
}

function compile(pattern: string | RegExp): { regex: RegExp; names: string[] } {
  if (pattern instanceof RegExp) return { regex: pattern, names: [] };
  const names: string[] = [];
  const source = pattern
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m) {
        names.push(m[1]);
        return '([^.]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return { regex: new RegExp(`^${source}$`), names };
}
