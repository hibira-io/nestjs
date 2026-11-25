import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { Test } from '@nestjs/testing';
import { HibiraChatError, HibiraModule, HibiraService, liveChatUserHash } from '../src';
import { creds, fakeApi, type Recorded } from './helpers';

// The Pusher HTTP API signature, recomputed from a recorded request.
function signatureOf(req: Recorded): string {
  const q = new URLSearchParams(req.query);
  q.delete('auth_signature');
  const sorted = [...q.keys()].sort().map((k) => `${k}=${q.get(k)}`).join('&');
  return createHmac('sha256', creds.secret).update(`${req.method}\n${decodeURIComponent(req.path)}\n${sorted}`).digest('hex');
}

async function setup(reply?: (req: Recorded) => { status?: number; body?: unknown }) {
  const api = await fakeApi(reply);
  const ref = await Test.createTestingModule({
    imports: [HibiraModule.forRoot({ ...creds, host: '127.0.0.1', port: api.port, useTLS: false, liveChatIdentitySecret: 'lcid_s' })],
  }).compile();
  return { api, ref, hibira: ref.get(HibiraService) };
}

describe('Chat API', () => {
  it('signs like the pusher library does', async () => {
    const { api, ref, hibira } = await setup();
    await hibira.pusher.post({ path: '/chat/conversations/c1/system', body: { text: 'x' } as any });
    await hibira.chat.systemMessage('c1', 'x');
    const [lib, ours] = api.requests;
    assert.equal(ours.path, lib.path);
    assert.equal(ours.query.get('body_md5'), lib.query.get('body_md5'));
    assert.equal(signatureOf(lib), lib.query.get('auth_signature'), 'the recomputation matches pusher');
    assert.equal(signatureOf(ours), ours.query.get('auth_signature'));
    assert.equal(ours.query.get('body_md5'), createHash('md5').update(ours.body).digest('hex'));
    await ref.close();
    await api.close();
  });

  it('calls each route', async () => {
    const { api, ref, hibira } = await setup(() => ({ body: { ok: true } }));
    const c = hibira.chat;
    await c.putConversation('order 42', { name: 'Order', members: ['u1', 'agent'], roles: { agent: 'staff' } });
    await c.sendMessage('order 42', 7, 'Hi', { push: 'always', visibleTo: ['staff'], pushTitle: 'New' });
    await c.listMessages('order 42', { after: 10, limit: 50 });
    await c.getConversation('c1');
    await c.addMembers('c1', [2]);
    await c.removeMember('c1', 'u/2');
    await c.markRead('c1', 'u1', 12);
    await c.userConversations('u1', { limit: 20 });
    await c.deleteConversation('c1');
    await c.request('POST', '/conversations/c1/typing', {}, { user_id: 'u1' });
    const base = `/apps/${creds.appId}/chat`;
    assert.deepEqual(
      api.requests.map((r) => `${r.method} ${r.path.slice(base.length)}`),
      [
        'PUT /conversations/order%2042',
        'POST /conversations/order%2042/messages',
        'GET /conversations/order%2042/messages',
        'GET /conversations/c1',
        'POST /conversations/c1/members',
        'DELETE /conversations/c1/members/u%2F2',
        'POST /conversations/c1/read',
        'GET /users/u1/conversations',
        'DELETE /conversations/c1',
        'POST /conversations/c1/typing',
      ],
    );
    assert.deepEqual(JSON.parse(api.requests[0].body), { name: 'Order', members: ['u1', 'agent'], roles: { agent: 'staff' } });
    assert.deepEqual(JSON.parse(api.requests[1].body), { user_id: '7', text: 'Hi', push: 'always', push_title: 'New', visible_to: ['staff'] });
    assert.equal(api.requests[2].query.get('after'), '10');
    assert.deepEqual(JSON.parse(api.requests[4].body), { user_ids: ['2'] });
    for (const r of api.requests) assert.equal(signatureOf(r), r.query.get('auth_signature'), r.path);
    await ref.close();
    await api.close();
  });

  it('throws HibiraChatError on an error status', async () => {
    const { api, ref, hibira } = await setup(() => ({ status: 404, body: { error: 'conversation not found' } }));
    await assert.rejects(hibira.chat.getConversation('nope'), (err: unknown) => err instanceof HibiraChatError && err.status === 404 && /not found/.test(err.message));
    await ref.close();
    await api.close();
  });
});

describe('Live Chat verified visitors', () => {
  it('hashes the user ID with the identity secret', async () => {
    assert.equal(liveChatUserHash('lcid_s', 42), createHmac('sha256', 'lcid_s').update('42').digest('hex'));
    assert.throws(() => liveChatUserHash('', 1));
    const { api, ref, hibira } = await setup();
    assert.deepEqual(hibira.liveChatIdentity({ id: 42, name: 'Aiko', email: 'a@example.com' }), {
      id: '42',
      hash: liveChatUserHash('lcid_s', 42),
      name: 'Aiko',
      email: 'a@example.com',
    });
    assert.equal(hibira.liveChatIdentity({ id: '' }), null);
    await ref.close();
    await api.close();
  });
});
