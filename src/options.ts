import type { CanActivate, ModuleMetadata, Type } from '@nestjs/common';
import type Pusher from 'pusher';

export const HIBIRA_OPTIONS = Symbol('HIBIRA_OPTIONS');
export const HIBIRA_PUSHER = Symbol('HIBIRA_PUSHER');

/** Where the app lives and how to sign requests. Every field falls back to an environment variable. */
export interface HibiraConnectionOptions {
  /** App ID. Default: `HIBIRA_APP_ID`. */
  appId?: string;
  /** App key. Default: `HIBIRA_KEY`. */
  key?: string;
  /** App secret. Default: `HIBIRA_SECRET`. Never send it to a browser. */
  secret?: string;
  /** API host, as shown on the app page. Default: `HIBIRA_HOST`, then `ws.hibira.io`. */
  host?: string;
  /** API port. Default: `HIBIRA_PORT`, then 443 (or 80 without TLS). */
  port?: number | string;
  /** Use HTTPS. Default: `HIBIRA_USE_TLS` (unless "false"), then true. */
  useTLS?: boolean;
  /** Request timeout in milliseconds. Default 10000. */
  timeout?: number;
  /** Base64 of 32 bytes, for `private-encrypted-*` channels. Default: `HIBIRA_ENCRYPTION_MASTER_KEY`. */
  encryptionMasterKeyBase64?: string;
  /** Use this `pusher` instance instead of building one from the fields above. */
  pusher?: Pusher;
  /** Hibira Push (Beams-compatible): set it to use HibiraPushService. Default: `HIBIRA_PUSH_INSTANCE_ID` + `HIBIRA_PUSH_SECRET_KEY`. */
  push?: HibiraPushOptions | false;
}

export interface HibiraPushOptions {
  /** Instance ID, from the Push section of the app page. */
  instanceId: string;
  /** Secret key, from the same place. Never send it to a browser. */
  secretKey: string;
  /** Push API URL. Default: `HIBIRA_PUSH_ENDPOINT`, then `https://ws.hibira.io`. */
  endpoint?: string;
}

/** The channel authorization routes pusher-js and Laravel Echo call. */
export interface HibiraAuthOptions {
  /** Route for private and presence channels (pusher-js `channelAuthorization.endpoint`). Default `hibira/auth`. */
  path?: string;
  /** Route for user sign-in (pusher-js `userAuthentication.endpoint`). Default `hibira/user-auth`; false turns it off. */
  userPath?: string | false;
  /** Guards run before the routes, e.g. your JWT or session guard that sets `request.user`. */
  guards?: Array<Type<CanActivate> | CanActivate>;
  /** The signed-in user of a request. Default `request.user`. */
  user?: (request: any) => unknown;
  /** The user's ID for presence channels and sign-in. Default `user.id`. */
  userId?: (user: any) => string | number;
  /** `user_info` and `watchlist` sent on sign-in. Default none. */
  userData?: (user: any) => { user_info?: Record<string, unknown>; watchlist?: string[] } | undefined;
}

/** The route that receives Hibira webhooks. */
export interface HibiraWebhookOptions {
  /** Route path. Default `hibira/webhook`. */
  path?: string;
  /** Also accept requests signed with this older secret (`X-Hibira-Previous-Signature`) while a rotation settles. */
  previousSecret?: string;
}

/** Routes are fixed when the module is defined, so they sit outside the (possibly async) connection options. */
export interface HibiraRouteOptions {
  /** Serve the channel authorization routes. Off unless set. */
  auth?: HibiraAuthOptions | boolean;
  /** Serve the webhook route. Off unless set. */
  webhooks?: HibiraWebhookOptions | boolean;
  /** Register the module globally. Default true. */
  isGlobal?: boolean;
}

export interface HibiraModuleOptions extends HibiraConnectionOptions, HibiraRouteOptions {}

export interface HibiraModuleAsyncOptions extends HibiraRouteOptions, Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => HibiraConnectionOptions | Promise<HibiraConnectionOptions>;
  inject?: any[];
}

/** Connection options with the environment applied. */
export interface ResolvedHibiraOptions {
  appId: string;
  key: string;
  secret: string;
  host: string;
  port?: string;
  useTLS: boolean;
  timeout: number;
  encryptionMasterKeyBase64?: string;
  pusher?: Pusher;
  push?: Required<HibiraPushOptions>;
}

function env(name: string): string | undefined {
  const value = typeof process !== 'undefined' ? process.env[name] : undefined;
  return value === undefined || value === '' ? undefined : value;
}

export function resolveOptions(options: HibiraConnectionOptions = {}): ResolvedHibiraOptions {
  const tls = options.useTLS ?? (env('HIBIRA_USE_TLS') ? env('HIBIRA_USE_TLS') !== 'false' : true);
  const port = options.port ?? env('HIBIRA_PORT');
  const resolved: ResolvedHibiraOptions = {
    appId: String(options.appId ?? env('HIBIRA_APP_ID') ?? ''),
    key: options.key ?? env('HIBIRA_KEY') ?? '',
    secret: options.secret ?? env('HIBIRA_SECRET') ?? '',
    host: options.host ?? env('HIBIRA_HOST') ?? 'ws.hibira.io',
    port: port === undefined ? undefined : String(port),
    useTLS: tls,
    timeout: options.timeout ?? 10_000,
    encryptionMasterKeyBase64: options.encryptionMasterKeyBase64 ?? env('HIBIRA_ENCRYPTION_MASTER_KEY'),
    pusher: options.pusher,
  };
  if (!resolved.pusher) {
    const missing = (['appId', 'key', 'secret'] as const).filter((k) => !resolved[k]);
    if (missing.length > 0) {
      const names = missing.map((k) => ({ appId: 'HIBIRA_APP_ID', key: 'HIBIRA_KEY', secret: 'HIBIRA_SECRET' })[k]);
      throw new Error(
        `@hibira-io/nestjs: missing ${missing.join(', ')}. Pass them to HibiraModule.forRoot() or set ${names.join(', ')} (from the app page at https://hibira.io).`,
      );
    }
  }
  if (options.push !== false) {
    const instanceId = options.push?.instanceId ?? env('HIBIRA_PUSH_INSTANCE_ID');
    const secretKey = options.push?.secretKey ?? env('HIBIRA_PUSH_SECRET_KEY');
    if (instanceId && secretKey) {
      const endpoint = options.push?.endpoint ?? env('HIBIRA_PUSH_ENDPOINT') ?? 'https://ws.hibira.io';
      resolved.push = { instanceId, secretKey, endpoint: endpoint.replace(/\/+$/, '') };
    }
  }
  return resolved;
}
