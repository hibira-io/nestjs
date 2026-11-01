import { type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, type Observable } from 'rxjs';

import type { BroadcastContext, BroadcastMeta } from './decorators';
import { HibiraService } from './hibira.service';

const BROADCAST_KEY = 'hibira:broadcast';

/** Runs @Broadcast(). Usually added by the decorator, not used directly. */
@Injectable()
export class HibiraBroadcastInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Hibira');

  constructor(
    private readonly reflector: Reflector,
    private readonly hibira: HibiraService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<BroadcastMeta | undefined>(BROADCAST_KEY, context.getHandler());
    if (!meta || context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest();
    return next.handle().pipe(mergeMap((result) => from(this.publish(meta, { result, params: request?.params ?? {}, request }).then(() => result))));
  }

  private async publish(meta: BroadcastMeta, ctx: BroadcastContext): Promise<void> {
    try {
      if (meta.when && !meta.when(ctx)) return;
      const raw = typeof meta.channels === 'function' ? meta.channels(ctx) : meta.channels;
      const channels = (Array.isArray(raw) ? raw : [raw]).map((c) => fill(c, ctx));
      if (channels.length === 0) return;
      const data = meta.data ? meta.data(ctx) : ctx.result;
      const header = ctx.request?.headers?.['x-socket-id'];
      const socketId = meta.toOthers === false ? undefined : (Array.isArray(header) ? header[0] : header) || undefined;
      await this.hibira.trigger(channels, meta.event, data ?? null, { socketId: validSocketId(socketId) });
    } catch (err) {
      this.logger.error(`broadcast of ${meta.event} failed: ${(err as Error)?.message ?? err}`);
    }
  }
}

function fill(template: string, ctx: BroadcastContext): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = ctx.params?.[name] ?? (ctx.result && typeof ctx.result === 'object' ? (ctx.result as any)[name] : undefined);
    if (value === undefined || value === null) throw new Error(`no route parameter or result field "${name}" for channel ${template}`);
    return String(value);
  });
}

// Pusher socket IDs look like "1234.5678"; anything else would make the
// publish fail, so it is ignored.
function validSocketId(id: string | undefined): string | undefined {
  return id && /^\d+\.\d+$/.test(id) ? id : undefined;
}
