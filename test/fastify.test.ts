import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Pusher from 'pusher';

import { HibiraChannel, HibiraModule, OnHibiraWebhook, type WebhookEvent } from '../src';
import { creds, post } from './helpers';

@Injectable()
class Bits {
  seen: WebhookEvent[] = [];

  @HibiraChannel('private-open', { guests: true })
  open() {
    return true;
  }

  @OnHibiraWebhook('channel_vacated')
  vacated(e: WebhookEvent) {
    this.seen.push(e);
  }
}

describe('fastify', () => {
  let app: NestFastifyApplication;
  let base: string;

  before(async () => {
    @Module({ imports: [HibiraModule.forRoot({ ...creds, auth: true, webhooks: true })], providers: [Bits] })
    class AppModule {}
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  after(() => app.close());

  it('reads the form body pusher-js sends', async () => {
    const r = await post(base, '/hibira/auth', 'socket_id=1.2&channel_name=private-open');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, new Pusher({ ...creds, host: 'x' }).authorizeChannel('1.2', 'private-open'));
  });

  it('verifies webhooks from the raw body', async () => {
    const body = JSON.stringify({ time_ms: 5, events: [{ name: 'channel_vacated', channel: 'news' }] });
    const sig = createHmac('sha256', creds.secret).update(body).digest('hex');
    const r = await post(base, '/hibira/webhook', body, { 'content-type': 'application/json', 'x-pusher-key': creds.key, 'x-pusher-signature': sig });
    assert.equal(r.status, 200, r.text);
    assert.equal(app.get(Bits).seen[0].channel, 'news');
  });
});
