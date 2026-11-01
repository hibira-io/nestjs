import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { type CanActivate, Controller, type ExecutionContext, Get, Injectable, type INestApplication, Module, Param, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Pusher from 'pusher';

import { Broadcast, HibiraChannel, HibiraModule, HibiraService, OnHibiraWebhook, type WebhookEvent } from '../src';
import { creds, fakeApi, post } from './helpers';

// Signs in whoever is named in the X-User header.
@Injectable()
class HeaderGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const name = req.headers['x-user'];
    if (name) req.user = { id: name === 'ann' ? 1 : 2, name };
    return true;
  }
}

@Injectable()
class Channels {
  @HibiraChannel('private-orders.{orderId}')
  order(user: { id: number }, { orderId }: { orderId: string }) {
    return orderId === `o${user.id}`;
  }

  @HibiraChannel('presence-room.{room}')
  async room(user: { id: number; name: string }, { room }: { room: string }) {
    return room === 'closed' ? false : { name: user.name };
  }

  @HibiraChannel('presence-team')
  team(user: { id: number }) {
    return { user_id: `u-${user.id}`, user_info: { team: true } };
  }

  @HibiraChannel(/^private-lobby-(?<code>[A-Z]+)$/, { guests: true })
  lobby(user: unknown, { code }: { code: string }) {
    return code === 'OPEN';
  }
}

@Injectable()
class Hooks {
  seen: Array<[string, WebhookEvent]> = [];

  @OnHibiraWebhook('member_added', 'member_removed')
  member(event: WebhookEvent) {
    this.seen.push(['member', event]);
  }

  @OnHibiraWebhook()
  all(event: WebhookEvent) {
    this.seen.push(['all', event]);
  }
}

@Controller('orders')
class Orders {
  @Post(':id/ship')
  @Broadcast('private-orders.{id}', 'order.shipped')
  ship(@Param('id') id: string) {
    return { id, status: 'shipped', customer: 'c9' };
  }

  @Post(':id/note')
  @Broadcast(['private-orders.{id}', 'private-customers.{customer}'], 'order.noted', { data: ({ result }) => ({ note: result.note }) })
  note(@Param('id') id: string) {
    return { id, customer: 'c9', note: 'fragile' };
  }

  @Get(':id/quiet')
  @Broadcast('private-orders.{id}', 'never', { when: () => false })
  quiet() {
    return { ok: true };
  }
}

describe('routes', () => {
  let api: Awaited<ReturnType<typeof fakeApi>>;
  let app: INestApplication;
  let base: string;
  const verifier = new Pusher({ ...creds, host: '127.0.0.1' });

  before(async () => {
    api = await fakeApi(() => ({ body: {} }));
    @Module({
      imports: [
        HibiraModule.forRoot({
          ...creds,
          host: '127.0.0.1',
          port: api.port,
          useTLS: false,
          auth: { guards: [HeaderGuard], userData: (u) => ({ user_info: { name: u.name } }) },
          webhooks: { previousSecret: 'old-secret-0123456789' },
        }),
      ],
      controllers: [Orders],
      providers: [Channels, Hooks],
    })
    class AppModule {}
    app = await NestFactory.create(AppModule, { rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  after(async () => {
    await app.close();
    await api.close();
  });

  it('authorizes a private channel the user may see', async () => {
    const r = await post(base, '/hibira/auth', 'socket_id=123.456&channel_name=private-orders.o1', { 'x-user': 'ann' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, verifier.authorizeChannel('123.456', 'private-orders.o1'));
  });

  it('refuses a private channel the user may not see', async () => {
    const r = await post(base, '/hibira/auth', 'socket_id=123.456&channel_name=private-orders.o2', { 'x-user': 'ann' });
    assert.equal(r.status, 403);
  });

  it('refuses visitors who are not signed in', async () => {
    const r = await post(base, '/hibira/auth', 'socket_id=123.456&channel_name=private-orders.o1');
    assert.equal(r.status, 403);
  });

  it('lets guests in where the authorizer allows them, with RegExp groups', async () => {
    const ok = await post(base, '/hibira/auth', 'socket_id=1.2&channel_name=private-lobby-OPEN');
    assert.equal(ok.status, 200);
    const no = await post(base, '/hibira/auth', 'socket_id=1.2&channel_name=private-lobby-SHUT');
    assert.equal(no.status, 403);
  });

  it('refuses channels no authorizer matches, and public channels', async () => {
    assert.equal((await post(base, '/hibira/auth', 'socket_id=1.2&channel_name=private-other', { 'x-user': 'ann' })).status, 403);
    assert.equal((await post(base, '/hibira/auth', 'socket_id=1.2&channel_name=news', { 'x-user': 'ann' })).status, 403);
  });

  it('rejects a malformed socket_id', async () => {
    const r = await post(base, '/hibira/auth', 'socket_id=abc&channel_name=private-orders.o1', { 'x-user': 'ann' });
    assert.equal(r.status, 400);
  });

  it('signs presence channels with the user ID and returned user_info', async () => {
    const r = await post(base, '/hibira/auth', 'socket_id=123.456&channel_name=presence-room.lobby', { 'x-user': 'bob' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.json.channel_data), { user_id: '2', user_info: { name: 'bob' } });
    assert.deepEqual(r.json, verifier.authorizeChannel('123.456', 'presence-room.lobby', { user_id: '2', user_info: { name: 'bob' } }));
    assert.equal((await post(base, '/hibira/auth', 'socket_id=1.2&channel_name=presence-room.closed', { 'x-user': 'bob' })).status, 403);
  });

  it('uses a full member object as is', async () => {
    const r = await post(base, '/hibira/auth', JSON.stringify({ socket_id: '1.2', channel_name: 'presence-team' }), {
      'x-user': 'ann',
      'content-type': 'application/json',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.json.channel_data), { user_id: 'u-1', user_info: { team: true } });
  });

  it('signs users in', async () => {
    const r = await post(base, '/hibira/user-auth', 'socket_id=123.456', { 'x-user': 'ann' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, verifier.authenticateUser('123.456', { id: '1', user_info: { name: 'ann' } } as any));
    assert.equal((await post(base, '/hibira/user-auth', 'socket_id=123.456')).status, 401);
  });

  const sign = (body: string, secret = creds.secret) => createHmac('sha256', secret).update(body).digest('hex');
  const webhook = (body: string, headers: Record<string, string>) =>
    post(base, '/hibira/webhook', body, { 'content-type': 'application/json', 'x-pusher-key': creds.key, ...headers });

  it('dispatches signed webhooks to matching handlers in order', async () => {
    const hooks = app.get(Hooks);
    hooks.seen = [];
    const body = JSON.stringify({
      time_ms: 1,
      events: [
        { name: 'channel_occupied', channel: 'news' },
        { name: 'member_added', channel: 'presence-room.1', user_id: '7' },
      ],
    });
    const r = await webhook(body, { 'x-pusher-signature': sign(body) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, events: 2, handled: 3 });
    assert.deepEqual(
      hooks.seen.map(([k, e]) => `${k}:${e.name}`),
      ['all:channel_occupied', 'member:member_added', 'all:member_added'],
    );
  });

  it('refuses webhooks with a bad signature or key', async () => {
    const body = JSON.stringify({ time_ms: 1, events: [] });
    assert.equal((await webhook(body, { 'x-pusher-signature': sign(body, 'nope') })).status, 401);
    assert.equal((await webhook(body, { 'x-pusher-signature': sign(body), 'x-pusher-key': 'other' })).status, 401);
    assert.equal((await webhook(body, {})).status, 401);
  });

  it('accepts the previous secret during a rotation', async () => {
    const body = JSON.stringify({ time_ms: 1, events: [] });
    const r = await webhook(body, { 'x-pusher-signature': sign(body, 'new-secret'), 'x-hibira-previous-signature': sign(body, 'old-secret-0123456789') });
    assert.equal(r.status, 200);
  });

  it('broadcasts a route result, leaving out the X-Socket-ID connection', async () => {
    api.requests.length = 0;
    const r = await post(base, '/orders/42/ship', '', { 'x-socket-id': '99.1' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { id: '42', status: 'shipped', customer: 'c9' });
    const sent = api.requests.find((q) => q.path === `/apps/${creds.appId}/events`);
    assert.ok(sent, 'trigger request sent');
    const body = JSON.parse(sent!.body);
    assert.equal(body.name, 'order.shipped');
    assert.deepEqual(body.channels, ['private-orders.42']);
    assert.equal(body.socket_id, '99.1');
    assert.deepEqual(JSON.parse(body.data), { id: '42', status: 'shipped', customer: 'c9' });
  });

  it('fills channel names from result fields and shapes data', async () => {
    api.requests.length = 0;
    await post(base, '/orders/7/note', '', { 'x-socket-id': 'not-a-socket' });
    const body = JSON.parse(api.requests.find((q) => q.path.endsWith('/events'))!.body);
    assert.deepEqual(body.channels, ['private-orders.7', 'private-customers.c9']);
    assert.equal(body.socket_id, undefined);
    assert.deepEqual(JSON.parse(body.data), { note: 'fragile' });
  });

  it('skips the broadcast when `when` says so', async () => {
    api.requests.length = 0;
    const res = await fetch(base + '/orders/7/quiet');
    assert.equal(res.status, 200);
    assert.equal(api.requests.length, 0);
  });

  it('exposes HibiraService with signed API calls', async () => {
    api.requests.length = 0;
    const hibira = app.get(HibiraService);
    await hibira.trigger('news', 'hello', { a: 1 }, { info: ['subscription_count'] });
    const q = api.requests[0];
    assert.equal(q.method, 'POST');
    assert.equal(q.query.get('auth_key'), creds.key);
    assert.ok(q.query.get('auth_signature'));
    assert.equal(JSON.parse(q.body).info, 'subscription_count');
    assert.deepEqual(hibira.clientConfig(), {
      key: creds.key,
      wsHost: '127.0.0.1',
      wsPort: api.port,
      forceTLS: false,
      enabledTransports: ['ws', 'wss'],
      cluster: '',
    });
  });
});

describe('webhooks without rawBody', () => {
  it('answers 500 with how to fix it', async () => {
    @Module({ imports: [HibiraModule.forRoot({ ...creds, webhooks: true })] })
    class AppModule {}
    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const r = await post(await app.getUrl(), '/hibira/webhook', '{"time_ms":1,"events":[]}', { 'content-type': 'application/json' });
    await app.close();
    assert.equal(r.status, 500);
    assert.match(r.text, /rawBody: true/);
  });
});

describe('custom paths', () => {
  it('serves the auth route at broadcasting/auth with sign-in off', async () => {
    @Injectable()
    class Ch {
      @HibiraChannel('private-x', { guests: true })
      x() {
        return true;
      }
    }
    @Module({ imports: [HibiraModule.forRoot({ ...creds, auth: { path: 'broadcasting/auth', userPath: false } })], providers: [Ch] })
    class AppModule {}
    const app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const ok = await post(base, '/api/broadcasting/auth', 'socket_id=1.2&channel_name=private-x');
    const gone = await post(base, '/api/hibira/user-auth', 'socket_id=1.2');
    await app.close();
    assert.equal(ok.status, 200);
    assert.equal(gone.status, 404);
  });
});
