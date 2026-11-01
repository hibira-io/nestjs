import { type DynamicModule, Inject, Module, type OnApplicationBootstrap, Optional, type Provider, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import Pusher from 'pusher';

import { HibiraBroadcastInterceptor } from './broadcast.interceptor';
import { createAuthController, createWebhookController } from './controllers';
import { HibiraExplorer } from './explorer';
import { HibiraService } from './hibira.service';
import {
  HIBIRA_OPTIONS,
  HIBIRA_PUSHER,
  type HibiraAuthOptions,
  type HibiraConnectionOptions,
  type HibiraModuleAsyncOptions,
  type HibiraModuleOptions,
  type HibiraRouteOptions,
  type HibiraWebhookOptions,
  resolveOptions,
  type ResolvedHibiraOptions,
} from './options';
import { HibiraPushService } from './push.service';

const HIBIRA_ROUTES = Symbol('HIBIRA_ROUTES');

function createPusher(options: ResolvedHibiraOptions): Pusher {
  if (options.pusher) return options.pusher;
  return new Pusher({
    appId: options.appId,
    key: options.key,
    secret: options.secret,
    host: options.host,
    ...(options.port ? { port: options.port } : {}),
    useTLS: options.useTLS,
    timeout: options.timeout,
    ...(options.encryptionMasterKeyBase64 ? { encryptionMasterKeyBase64: options.encryptionMasterKeyBase64 } : {}),
  });
}

/**
 * Hibira (Pusher-compatible realtime) for NestJS.
 *
 * ```ts
 * HibiraModule.forRoot({ auth: { guards: [JwtAuthGuard] }, webhooks: true })
 * ```
 *
 * reads HIBIRA_APP_ID, HIBIRA_KEY, HIBIRA_SECRET (and HIBIRA_HOST) from the
 * environment; pass them as options, or use forRootAsync() with ConfigService.
 */
@Module({})
export class HibiraModule implements OnApplicationBootstrap {
  constructor(
    private readonly explorer: HibiraExplorer,
    @Optional() @Inject(HIBIRA_ROUTES) private readonly routes?: HibiraRouteOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.routes?.auth) this.explorer.warnIfEmpty('channels');
    if (this.routes?.webhooks) this.explorer.warnIfEmpty('webhooks');
  }

  static forRoot(options: HibiraModuleOptions = {}): DynamicModule {
    const { auth, webhooks, isGlobal, ...connection } = options;
    return HibiraModule.build({ auth, webhooks, isGlobal }, [{ provide: HIBIRA_OPTIONS, useFactory: () => resolveOptions(connection) }]);
  }

  static forRootAsync(options: HibiraModuleAsyncOptions): DynamicModule {
    const { auth, webhooks, isGlobal, imports, useFactory, inject } = options;
    return HibiraModule.build(
      { auth, webhooks, isGlobal },
      [
        {
          provide: HIBIRA_OPTIONS,
          useFactory: async (...args: unknown[]) => resolveOptions((await useFactory(...args)) as HibiraConnectionOptions),
          inject: inject ?? [],
        },
      ],
      imports,
    );
  }

  private static build(routes: HibiraRouteOptions, optionProviders: Provider[], imports: DynamicModule['imports'] = []): DynamicModule {
    const controllers: Type[] = [];
    if (routes.auth) controllers.push(createAuthController(routes.auth === true ? {} : (routes.auth as HibiraAuthOptions)));
    if (routes.webhooks) controllers.push(createWebhookController(routes.webhooks === true ? {} : (routes.webhooks as HibiraWebhookOptions)));
    const exported = [HibiraService, HibiraPushService, HibiraExplorer, HibiraBroadcastInterceptor, HIBIRA_OPTIONS, HIBIRA_PUSHER];
    return {
      module: HibiraModule,
      global: routes.isGlobal !== false,
      imports: [DiscoveryModule, ...imports],
      controllers,
      providers: [
        ...optionProviders,
        { provide: HIBIRA_ROUTES, useValue: routes },
        { provide: HIBIRA_PUSHER, useFactory: createPusher, inject: [HIBIRA_OPTIONS] },
        HibiraService,
        HibiraPushService,
        HibiraExplorer,
        HibiraBroadcastInterceptor,
      ],
      exports: exported,
    };
  }
}
