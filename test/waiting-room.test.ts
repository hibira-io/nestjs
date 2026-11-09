import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Controller, Get, type MiddlewareConsumer, Module, type NestModule, Post, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';

import { HibiraModule, HibiraPass, verifyPass, WaitingRoom, type WaitingRoomPass } from '../src';
import { creds } from './helpers';

// Signed by the Hibira server (internal/waitroom NewPass) at 1800000000, ttl 30 min.
const SECRET = 'wr-secret-0123456789';
const PASS =
  'eyJ2IjoxLCJhcHAiOiJ3ci1hcHAiLCJyb29tIjoicHJlc2FsZSIsIm4iOjQyLCJ0aWQiOiJkNzlmZTc4OWEzOGI4NjMxYjUiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMTgwMH0.q7Uc_O6XKwNA_LVLQITlgv_YtDi9dIwiRzUUUSsGa08';
const TICKET =
  'eyJ2IjoxLCJhcHAiOiJ3ci1hcHAiLCJyb29tIjoicHJlc2FsZSIsIm4iOjQyLCJ0aWQiOiJkNzlmZTc4OWEzOGI4NjMxYjUiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDA4NjQwMH0.l-KNMOVwV_xJJCQaQ-JXQKsrj-XlEdsTxG7X4Kp_2ck';
const NOW = 1800000100 * 1000;

function sign(claims: object, secret = creds.secret) {
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return p + '.' + createHmac('sha256', secret).update('hibira-waitroom-pass.' + p).digest('base64url');
}
const fresh = (room = 'presale') => {
  const now = Math.floor(Date.now() / 1000);
  return sign({ v: 1, app: creds.appId, room, n: 7, tid: 't7', iat: now, exp: now + 600 });
};

describe('verifyPass', () => {
  it('accepts a pass signed by the server', () => {
    assert.deepEqual(verifyPass(PASS, { secret: SECRET, room: 'presale', appId: 'wr-app', now: NOW }), {
      appId: 'wr-app', room: 'presale', number: 42, ticketId: 'd79fe789a38b8631b5', issuedAt: 1800000000, expiresAt: 1800001800,
    });
    assert.ok(verifyPass(PASS, { secret: ['old', SECRET], now: NOW }));
  });

  it('rejects forged, expired, foreign and ticket tokens', () => {
    const o = { secret: SECRET, now: NOW };
    assert.equal(verifyPass(PASS, { ...o, secret: 'wrong' }), null);
    assert.equal(verifyPass(PASS, { ...o, room: 'other' }), null);
    assert.equal(verifyPass(PASS, { ...o, appId: 'other' }), null);
    assert.equal(verifyPass(PASS, { ...o, now: 1800001800 * 1000 }), null);
    assert.equal(verifyPass(TICKET, o), null);
    assert.equal(verifyPass(PASS.slice(0, -3) + 'AAA', o), null);
    for (const bad of ['', null, 'a.b.c', '!!.??']) assert.equal(verifyPass(bad, o), null);
  });
});

@Controller()
class Pages {
  @Get('drop/:id')
  drop(@HibiraPass() pass: WaitingRoomPass) {
    return `in #${pass.number}`;
  }

  @Post('drop/:id')
  buy(@HibiraPass() pass: WaitingRoomPass) {
    return `bought #${pass.number}`;
  }

  @Get('open')
  open() {
    return 'open';
  }
}

@Module({ imports: [HibiraModule.forRoot({ ...creds, host: 'ws.example.com' })], controllers: [Pages] })
class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(WaitingRoom('presale')).forRoutes('drop/*path');
  }
}

for (const platform of ['express', 'fastify'] as const) {
  describe(`WaitingRoom middleware on ${platform}`, () => {
    let app: INestApplication;
    let base: string;

    before(async () => {
      app = platform === 'express'
        ? await NestFactory.create(AppModule, { logger: false })
        : await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    });
    after(() => app.close());

    const req = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: 'manual', ...init });

    it('sends visitors without a pass to the queue', async () => {
      const res = await req('/drop/1?a=b');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `https://ws.example.com/wait/test-key/presale?return=${encodeURIComponent(base + '/drop/1?a=b')}`);
      assert.equal(await (await req('/open')).text(), 'open');
      const post = await req('/drop/1', { method: 'POST' });
      assert.equal(post.status, 403);
      assert.equal((await post.json()).error, 'waiting_room');
    });

    it('turns ?hibira_pass into a cookie, then lets the visitor in', async () => {
      const pass = fresh();
      const res = await req('/drop/1?a=b&hibira_pass=' + pass);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), base + '/drop/1?a=b');
      assert.match(res.headers.get('set-cookie') ?? '', /^hibira_wr_presale=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
      const cookie = `hibira_wr_presale=${pass}`;
      assert.equal(await (await req('/drop/1', { headers: { cookie } })).text(), 'in #7');
      assert.equal(await (await req('/drop/1', { method: 'POST', headers: { cookie } })).text(), 'bought #7');
      assert.equal((await req('/drop/1', { headers: { cookie: `hibira_wr_presale=${fresh('other')}` } })).status, 302);
    });
  });
}
