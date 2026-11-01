import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { HibiraModule, HibiraPushService, HibiraService, resolveOptions, streamToChannel, textOf } from '../src';
import { creds, fakeApi } from './helpers';

const ENV = ['HIBIRA_APP_ID', 'HIBIRA_KEY', 'HIBIRA_SECRET', 'HIBIRA_HOST', 'HIBIRA_PORT', 'HIBIRA_USE_TLS', 'HIBIRA_PUSH_INSTANCE_ID', 'HIBIRA_PUSH_SECRET_KEY', 'HIBIRA_PUSH_ENDPOINT'];

describe('options', () => {
  afterEach(() => ENV.forEach((k) => delete process.env[k]));

  it('reads the environment, with ws.hibira.io and TLS by default', () => {
    Object.assign(process.env, { HIBIRA_APP_ID: '5', HIBIRA_KEY: 'k', HIBIRA_SECRET: 's' });
    const o = resolveOptions();
    assert.equal(o.appId, '5');
    assert.equal(o.host, 'ws.hibira.io');
    assert.equal(o.useTLS, true);
    assert.equal(o.push, undefined);
  });

  it('prefers explicit options and turns push on when both push values are set', () => {
    Object.assign(process.env, { HIBIRA_APP_ID: '5', HIBIRA_KEY: 'k', HIBIRA_SECRET: 's', HIBIRA_USE_TLS: 'false', HIBIRA_PUSH_INSTANCE_ID: 'inst', HIBIRA_PUSH_SECRET_KEY: 'sk' });
    const o = resolveOptions({ appId: '9', host: 'h.example' });
    assert.equal(o.appId, '9');
    assert.equal(o.host, 'h.example');
    assert.equal(o.useTLS, false);
    assert.deepEqual(o.push, { instanceId: 'inst', secretKey: 'sk', endpoint: 'https://ws.hibira.io' });
    assert.equal(resolveOptions({ push: false }).push, undefined);
  });

  it('names the missing values', () => {
    assert.throws(() => resolveOptions({ appId: '1' }), /missing key, secret.*HIBIRA_KEY, HIBIRA_SECRET/);
  });
});

describe('forRootAsync', () => {
  it('builds the client from an injected config', async () => {
    @Injectable()
    class Config {
      get(name: string) {
        return ({ id: '77', key: 'kk', secret: 'ss' } as Record<string, string>)[name];
      }
    }
    @Module({ providers: [Config], exports: [Config] })
    class ConfigModule {}
    const ref = await Test.createTestingModule({
      imports: [
        HibiraModule.forRootAsync({
          imports: [ConfigModule],
          inject: [Config],
          useFactory: (c: Config) => ({ appId: c.get('id'), key: c.get('key'), secret: c.get('secret') }),
        }),
      ],
    }).compile();
    const hibira = ref.get(HibiraService);
    assert.equal(hibira.key, 'kk');
    assert.equal(String((hibira.pusher as any).config.appId), '77');
    assert.equal(ref.get(HibiraPushService).enabled, false);
    await ref.close();
  });
});

describe('streamToChannel', () => {
  it('batches deltas, keeps order and ends with the whole text', async () => {
    const sent: any[] = [];
    const fake = { trigger: async (channel: string, event: string, data: any) => void sent.push({ channel, event, data }) };
    async function* tokens() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } };
      yield { choices: [{ delta: { content: 'lo ' } }] };
      yield 'wor';
      yield new TextEncoder().encode('ld');
    }
    const result = await streamToChannel(fake, 'private-chat', tokens(), { meta: { model: 'm' }, interval: 5 });
    assert.equal(result.text, 'Hello world');
    const last = sent.at(-1).data;
    assert.equal(last.done, true);
    assert.equal(last.text, 'Hello world');
    const joined = sent.filter((s) => !s.data.done).map((s) => s.data.delta).join('');
    assert.equal(joined, 'Hello world');
    assert.deepEqual(sent[0].data.meta, { model: 'm' });
    assert.ok(sent.every((s) => s.event === 'ai-stream' && s.channel === 'private-chat'));
    assert.deepEqual(sent.map((s) => s.data.seq), sent.map((_, i) => i));
  });

  it('splits big text under maxBytes without breaking characters', async () => {
    const sent: any[] = [];
    const fake = { trigger: async (_c: string, _e: string, data: any) => void sent.push(data) };
    const big = '日本語テキスト'.repeat(400);
    await streamToChannel(fake, 'c', [big], { maxBytes: 1000 });
    assert.ok(sent.every((d) => Buffer.byteLength(JSON.stringify(d)) <= 1000));
    assert.equal(sent.filter((d) => !d.done).map((d) => d.delta).join(''), big);
    assert.equal(sent.at(-1).text, undefined);
  });

  it('reports a failing source in the final event and rethrows', async () => {
    const sent: any[] = [];
    const fake = { trigger: async (_c: string, _e: string, data: any) => void sent.push(data) };
    async function* broken() {
      yield 'a';
      throw new Error('model down');
    }
    await assert.rejects(streamToChannel(fake, 'c', broken()), /model down/);
    assert.equal(sent.at(-1).error, 'model down');
  });

  it('textOf understands the AI SDK and OpenAI responses', () => {
    assert.equal(textOf({ type: 'text-delta', text: 'x' }), 'x');
    assert.equal(textOf({ type: 'response.output_text.delta', delta: 'y' }), 'y');
    assert.equal(textOf({ type: 'message_start' }), '');
  });
});

describe('approvals and push', () => {
  it('requests an approval and waits for the answer', async () => {
    let reads = 0;
    const api = await fakeApi((req) => {
      if (req.method === 'POST') return { status: 201, body: { approval_id: 'apr_1', status: 'pending', url: 'https://hibira.io/approve/apr_1/x' } };
      reads++;
      return { body: { approval_id: 'apr_1', status: reads < 2 ? 'pending' : 'approved', choice: 'Refund' } };
    });
    const ref = await Test.createTestingModule({
      imports: [HibiraModule.forRoot({ ...creds, host: '127.0.0.1', port: api.port, useTLS: false })],
    }).compile();
    const hibira = ref.get(HibiraService);
    const created = await hibira.requestApproval({ title: 'Refund #1042?', options: ['Refund', 'Decline'], expiresInMinutes: 30, pushInterests: ['ops'] });
    assert.equal(created.url, 'https://hibira.io/approve/apr_1/x');
    assert.deepEqual(JSON.parse(api.requests[0].body), { title: 'Refund #1042?', options: ['Refund', 'Decline'], expires_in_minutes: 30, push_interests: ['ops'] });
    assert.equal(api.requests[0].path, `/apps/${creds.appId}/approvals`);
    assert.ok(api.requests[0].query.get('body_md5'));
    const answer = await hibira.waitForApproval('apr_1', { timeoutMs: 60_000 });
    assert.equal(answer.status, 'approved');
    assert.equal(api.requests[2].query.get('wait'), '25');
    await ref.close();
    await api.close();
  });

  it('publishes push notifications and signs user tokens', async () => {
    const api = await fakeApi(() => ({ body: { publishId: 'pub-1' } }));
    const ref = await Test.createTestingModule({
      imports: [HibiraModule.forRoot({ ...creds, push: { instanceId: 'inst-1', secretKey: 'push-secret', endpoint: api.url + '/' } })],
    }).compile();
    const push = ref.get(HibiraPushService);
    assert.equal(push.enabled, true);
    const out = await push.publishToUsers([42], { web: { notification: { title: 'Hi' } } });
    assert.equal(out.publishId, 'pub-1');
    const req = api.requests[0];
    assert.equal(req.path, '/publish_api/v1/instances/inst-1/publishes/users');
    assert.equal(req.headers.authorization, 'Bearer push-secret');
    assert.deepEqual(JSON.parse(req.body), { web: { notification: { title: 'Hi' } }, users: ['42'] });

    const { token } = push.generateToken('u-7', { expiresIn: 60 });
    const [h, c, s] = token.split('.');
    assert.equal(createHmac('sha256', 'push-secret').update(`${h}.${c}`).digest('base64url'), s);
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.equal(claims.sub, 'u-7');
    assert.ok(claims.exp - claims.iat === 60);
    await ref.close();
    await api.close();
  });

  it('turns API errors into HibiraPushError', async () => {
    const api = await fakeApi(() => ({ status: 401, body: { error: 'Unauthorized', description: 'bad key' } }));
    const ref = await Test.createTestingModule({
      imports: [HibiraModule.forRoot({ ...creds, push: { instanceId: 'i', secretKey: 'k', endpoint: api.url } })],
    }).compile();
    await assert.rejects(ref.get(HibiraPushService).publishToInterests(['a'], {}), (err: any) => err.status === 401 && /bad key/.test(err.message));
    await ref.close();
    await api.close();
  });
});
