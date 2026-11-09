import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createParamDecorator, type ExecutionContext, Inject, Injectable, mixin, type NestMiddleware, type Type } from '@nestjs/common';

import { HIBIRA_OPTIONS, type ResolvedHibiraOptions } from './options';

const PURPOSE = 'hibira-waitroom-pass.';
const PARAM = 'hibira_pass';

/** The claims of a valid waiting room pass. Times are Unix seconds. */
export interface WaitingRoomPass {
  appId: string;
  room: string;
  number: number;
  ticketId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface VerifyPassOptions {
  /** The app secret; an array during a rotation. */
  secret: string | string[];
  /** The room the pass must be for. */
  room?: string;
  /** The app the pass must be for. */
  appId?: string;
  /** Milliseconds since the epoch. Default: now. */
  now?: number;
}

export interface WaitingRoomOptions {
  /** Hosted waiting page origin. Default: the Hibira host (https://ws.hibira.io). */
  host?: string;
  /** Waiting page language (en, ja, ko, zh-TW, ...). Default: the browser's. */
  lang?: string;
  /** Also accepted during a secret rotation. */
  previousSecret?: string;
  /** Default: `hibira_wr_<room>`. */
  cookieName?: string;
}

function b64url(s: string): Buffer | null {
  return /^[A-Za-z0-9_-]+$/.test(s) ? Buffer.from(s, 'base64url') : null;
}

/** Returns the pass's claims, or null when it is missing, forged, expired, or for another room or app. */
export function verifyPass(token: unknown, { secret, room, appId, now = Date.now() }: VerifyPassOptions): WaitingRoomPass | null {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0]) return null;
  const [payload, sigPart] = parts;
  const sig = b64url(sigPart);
  if (!sig || sig.length !== 32) return null;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
  const ok = secrets.some((s) => timingSafeEqual(createHmac('sha256', s).update(PURPOSE + payload).digest(), sig));
  if (!ok) return null;
  let claims: any;
  try {
    claims = JSON.parse((b64url(payload) ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || claims.v !== 1 || typeof claims.exp !== 'number') return null;
  if (now / 1000 >= claims.exp) return null;
  if (room !== undefined && claims.room !== room) return null;
  if (appId !== undefined && claims.app !== appId) return null;
  return { appId: claims.app, room: claims.room, number: claims.n, ticketId: claims.tid, issuedAt: claims.iat, expiresAt: claims.exp };
}

/** The hosted waiting page address for a room. */
export function waitingRoomUrl({ appKey, room, returnUrl, host = 'https://ws.hibira.io', lang }: { appKey: string; room: string; returnUrl?: string; host?: string; lang?: string }): string {
  const u = new URL(`/wait/${encodeURIComponent(appKey)}/${encodeURIComponent(room)}`, host);
  if (returnUrl) u.searchParams.set('return', returnUrl);
  if (lang) u.searchParams.set('lang', lang);
  return u.toString();
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

type Req = IncomingMessage & { originalUrl?: string; protocol?: string; hibiraPass?: WaitingRoomPass; raw?: Req };

function requestUrl(req: Req): URL {
  const proto = req.protocol ?? ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  return new URL(proto + '://' + (req.headers.host ?? 'localhost') + (req.originalUrl ?? req.url ?? '/'));
}

/**
 * A Nest middleware that sends visitors without a pass for `room` to the
 * Hibira waiting room. Apply it to the routes to protect:
 *
 * ```ts
 * export class AppModule implements NestModule {
 *   configure(consumer: MiddlewareConsumer) {
 *     consumer.apply(WaitingRoom('presale')).forRoutes('drop');
 *   }
 * }
 * ```
 *
 * Non-GET requests without a pass get a 403. Read the pass with `@HibiraPass()`.
 */
export function WaitingRoom(room: string, options: WaitingRoomOptions = {}): Type<NestMiddleware> {
  @Injectable()
  class HibiraWaitingRoomMiddleware implements NestMiddleware {
    constructor(@Inject(HIBIRA_OPTIONS) private readonly hibira: ResolvedHibiraOptions) {}

    use(req: Req, res: ServerResponse, next: (error?: unknown) => void): void {
      const o = this.hibira;
      const secret = [o.secret, options.previousSecret].filter((s): s is string => !!s);
      const cookieName = options.cookieName ?? `hibira_wr_${room}`;
      const check = (token: unknown) => verifyPass(token, { secret, room, appId: o.appId || undefined });
      const url = requestUrl(req);
      const fresh = url.searchParams.get(PARAM);
      url.searchParams.delete(PARAM);
      res.setHeader('Cache-Control', 'no-store');

      const claims = fresh ? check(fresh) : null;
      if (fresh && claims) {
        const maxAge = Math.max(0, Math.floor(claims.expiresAt - Date.now() / 1000));
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${cookieName}=${fresh}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
        res.statusCode = 302;
        res.setHeader('Location', url.toString());
        res.end();
        return;
      }
      const pass = check(readCookie(req.headers.cookie, cookieName));
      if (pass) {
        req.hibiraPass = pass;
        res.removeHeader('Cache-Control');
        next();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'waiting_room', message: 'join the waiting room first' }));
        return;
      }
      const port = o.port && o.port !== (o.useTLS ? '443' : '80') ? `:${o.port}` : '';
      const host = options.host ?? `${o.useTLS ? 'https' : 'http'}://${o.host}${port}`;
      res.statusCode = 302;
      res.setHeader('Location', waitingRoomUrl({ appKey: o.key, room, host, lang: options.lang, returnUrl: url.toString() }));
      res.end();
    }
  }
  return mixin(HibiraWaitingRoomMiddleware);
}

/** The waiting room pass of the current request (set by the WaitingRoom middleware), or undefined. */
export const HibiraPass = createParamDecorator((_: unknown, ctx: ExecutionContext): WaitingRoomPass | undefined => {
  const req = ctx.switchToHttp().getRequest<Req>();
  return req.hibiraPass ?? req.raw?.hibiraPass;
});
