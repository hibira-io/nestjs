// End-to-end test against a running Hibira (or any Pusher-compatible)
// server. Skipped unless HIBIRA_E2E_KEY is set:
//
//   HIBIRA_E2E_HOST=127.0.0.1 HIBIRA_E2E_PORT=8080 HIBIRA_E2E_TLS=0 \
//   HIBIRA_E2E_APP_ID=... HIBIRA_E2E_KEY=... HIBIRA_E2E_SECRET=... npm run test:e2e
//
// For the webhook check, point an app webhook (member_added) at
// http://127.0.0.1:${HIBIRA_E2E_APP_PORT:-3999}/hibira/webhook and set
// HIBIRA_E2E_WEBHOOKS=1.
import '../helpers';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type CanActivate, Controller, type ExecutionContext, Injectable, Module, Param, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PusherClient = require('pusher-js');

import { Broadcast, HibiraChannel, HibiraModule, HibiraService, OnHibiraWebhook, type WebhookEvent } from '../../src';

const env = process.env;
const skip = !env.HIBIRA_E2E_KEY && 'set HIBIRA_E2E_KEY to run';
const host = env.HIBIRA_E2E_HOST ?? '127.0.0.1';
const port = Number(env.HIBIRA_E2E_PORT ?? 8080);
const tls = env.HIBIRA_E2E_TLS === '1';
const appPort = Number(env.HIBIRA_E2E_APP_PORT ?? 3999);

@Injectable()
class UserFromHeader implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (req.headers['x-user']) req.user = { id: req.headers['x-user'], name: `User ${req.headers['x-user']}` };
    return true;
  }
}

@Injectable()
class Channels {
  @HibiraChannel('private-orders.{id}')
  order(user: { id: string }, { id }: { id: string }) {
    return id.startsWith(user.id);
  }

  @HibiraChannel('presence-room.{room}')
  room(user: { name: string }) {
    return { name: user.name };
  }
}

@Injectable()
class Hooks {
  events: WebhookEvent[] = [];
  @OnHibiraWebhook('member_added')
  added(event: WebhookEvent) {
    this.events.push(event);
  }
}

@Controller('orders')
class Orders {
  constructor(private readonly hibira: HibiraService) {}

  @Post(':id/ship')
  @Broadcast('private-orders.{id}', 'order.shipped')
  ship(@Param('id') id: string) {
    return { id, status: 'shipped' };
  }

  @Post(':id/explain')
  async explain(@Param('id') id: string) {
    async function* tokens() {
      for (const word of 'Your order left the warehouse this morning.'.split(/(?= )/)) yield word;
    }
    return this.hibira.stream(`private-orders.${id}`, tokens(), { interval: 20 });
  }
}

function waitFor<T>(check: () => T | undefined | false, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() > until) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('module on a real server: auth routes, @Broadcast, streams, webhooks', { skip }, async () => {
  @Module({
    imports: [
      HibiraModule.forRoot({
        appId: env.HIBIRA_E2E_APP_ID,
        key: env.HIBIRA_E2E_KEY,
        secret: env.HIBIRA_E2E_SECRET,
        host,
        port,
        useTLS: tls,
        auth: { guards: [UserFromHeader] },
        webhooks: true,
      }),
    ],
    controllers: [Orders],
    providers: [Channels, Hooks],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error', 'warn'] });
  await app.listen(appPort, '127.0.0.1');
  const base = `http://127.0.0.1:${appPort}`;

  const client = (user: string) =>
    new PusherClient(env.HIBIRA_E2E_KEY, {
      cluster: '',
      wsHost: host,
      wsPort: port,
      wssPort: port,
      forceTLS: tls,
      enabledTransports: ['ws'],
      channelAuthorization: { endpoint: `${base}/hibira/auth`, transport: 'ajax', headers: { 'x-user': user } },
    });

  const ann = client('a');
  const bob = client('b');
  try {
    // Private channel: Ann may, Bob may not.
    const received: any[] = [];
    const orders = ann.subscribe('private-orders.a1');
    orders.bind_global((event: string, data: any) => received.push({ event, data }));
    await waitFor(() => orders.subscribed, 'Ann subscribed to private-orders.a1');
    let refused = false;
    bob.subscribe('private-orders.a1').bind('pusher:subscription_error', () => (refused = true));
    await waitFor(() => refused, 'Bob refused on private-orders.a1');

    // Presence with user_info from the authorizer.
    const room = bob.subscribe('presence-room.lobby');
    await waitFor(() => room.subscribed, 'Bob in presence-room.lobby');
    assert.deepEqual(room.members.me, { id: 'b', info: { name: 'User b' } });

    // @Broadcast publishes the route result.
    const res = await fetch(`${base}/orders/a1/ship`, { method: 'POST' });
    assert.equal(res.status, 201);
    const shipped = await waitFor(() => received.find((r) => r.event === 'order.shipped'), 'order.shipped');
    assert.deepEqual(shipped.data, { id: 'a1', status: 'shipped' });

    // Streamed text arrives in order and ends with done.
    const out = await (await fetch(`${base}/orders/a1/explain`, { method: 'POST' })).json();
    const done = await waitFor(() => received.find((r) => r.event === 'ai-stream' && r.data.done), 'stream done');
    const deltas = received.filter((r) => r.event === 'ai-stream' && !r.data.done).map((r) => r.data.delta).join('');
    assert.equal(deltas, 'Your order left the warehouse this morning.');
    assert.equal(done.data.text, out.text);

    // Webhooks: Bob joining the room sent member_added.
    if (env.HIBIRA_E2E_WEBHOOKS === '1') {
      const hooks = app.get(Hooks);
      const ev = await waitFor(() => hooks.events.find((e) => e.channel === 'presence-room.lobby' && e.user_id === 'b'), 'member_added webhook', 10_000);
      assert.equal(ev.name, 'member_added');
    }

    // HTTP API reads through HibiraService.
    const hibira = app.get(HibiraService);
    const users = await hibira.users('presence-room.lobby');
    assert.deepEqual(users, [{ id: 'b' }]);
  } finally {
    ann.disconnect();
    bob.disconnect();
    await app.close();
  }
});
