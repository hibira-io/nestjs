import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  InternalServerErrorException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  type Type,
} from '@nestjs/common';

import { HibiraExplorer } from './explorer';
import { HibiraService, InvalidWebhookError } from './hibira.service';
import type { HibiraAuthOptions, HibiraWebhookOptions } from './options';

const SOCKET_ID = /^\d+\.\d+$/;

// pusher-js and Laravel Echo send a form body; some setups send JSON, and
// Fastify without @fastify/formbody leaves the form unparsed.
function fields(request: any): Record<string, string> {
  let body = request.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if ((body === undefined || body === null || (typeof body === 'object' && Object.keys(body).length === 0)) && request.rawBody) {
    body = Buffer.isBuffer(request.rawBody) ? request.rawBody.toString('utf8') : String(request.rawBody);
  }
  if (typeof body === 'string') {
    const text = body.trim();
    if (text.startsWith('{')) {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(text));
  }
  return body && typeof body === 'object' ? body : {};
}

function socketIdOf(f: Record<string, string>): string {
  const socketId = String(f.socket_id ?? '');
  if (!SOCKET_ID.test(socketId)) throw new BadRequestException('socket_id is missing or malformed');
  return socketId;
}

function idOf(options: HibiraAuthOptions, user: any): string {
  const id = options.userId ? options.userId(user) : (user?.id ?? user?.sub);
  if (id === undefined || id === null || id === '') {
    throw new InternalServerErrorException('Hibira: cannot tell the user ID; set auth.userId in HibiraModule options');
  }
  return String(id);
}

export function createAuthController(options: HibiraAuthOptions): Type {
  const path = options.path ?? 'hibira/auth';
  const userPath = options.userPath === undefined ? 'hibira/user-auth' : options.userPath;
  const userOf = (request: any) => (options.user ? options.user(request) : request.user);

  @Controller()
  class HibiraAuthController {
    constructor(
      readonly hibira: HibiraService,
      readonly explorer: HibiraExplorer,
    ) {}

    async authorize(@Req() request: any) {
      const f = fields(request);
      const socketId = socketIdOf(f);
      const channel = String(f.channel_name ?? '');
      if (!channel) throw new BadRequestException('channel_name is missing');
      if (!/^(private-|presence-)/.test(channel)) throw new ForbiddenException('only private and presence channels need authorization');
      const match = this.explorer.matchChannel(channel);
      if (!match) throw new ForbiddenException(`no @HibiraChannel() authorizer matches ${channel}`);
      const user = userOf(request);
      if ((user === undefined || user === null) && !match.route.guests) throw new ForbiddenException('sign in to join this channel');
      const answer = await match.route.handler(user, match.params, { channel, socketId, request });
      if (!answer) throw new ForbiddenException(`not allowed on ${channel}`);
      if (channel.startsWith('presence-')) {
        const member =
          typeof answer === 'object' && 'user_id' in (answer as object)
            ? { ...(answer as any), user_id: String((answer as any).user_id) }
            : { user_id: idOf(options, user), ...(typeof answer === 'object' ? { user_info: answer as Record<string, unknown> } : {}) };
        return this.hibira.authorizeChannel(socketId, channel, member);
      }
      return this.hibira.authorizeChannel(socketId, channel);
    }

    async signin(@Req() request: any) {
      const f = fields(request);
      const socketId = socketIdOf(f);
      const user = userOf(request);
      if (user === undefined || user === null) throw new UnauthorizedException('sign in first');
      const extra = options.userData?.(user) ?? {};
      return this.hibira.authenticateUser(socketId, { id: idOf(options, user), ...extra });
    }
  }

  const route = (decorators: MethodDecorator[], name: 'authorize' | 'signin') => {
    const descriptor = Object.getOwnPropertyDescriptor(HibiraAuthController.prototype, name)!;
    for (const d of decorators) d(HibiraAuthController.prototype, name, descriptor);
  };
  route([Post(path), HttpCode(200)], 'authorize');
  if (userPath) route([Post(userPath), HttpCode(200)], 'signin');
  if (options.guards?.length) UseGuards(...options.guards)(HibiraAuthController);
  return HibiraAuthController;
}

export function createWebhookController(options: HibiraWebhookOptions): Type {
  const path = options.path ?? 'hibira/webhook';

  @Controller()
  class HibiraWebhookController {
    constructor(
      readonly hibira: HibiraService,
      readonly explorer: HibiraExplorer,
    ) {}

    @Post(path)
    @HttpCode(200)
    async receive(@Req() request: any) {
      const raw = request.rawBody ?? (Buffer.isBuffer(request.body) || typeof request.body === 'string' ? request.body : undefined);
      if (raw === undefined) {
        throw new InternalServerErrorException(
          'Hibira webhooks need the raw request body: NestFactory.create(AppModule, { rawBody: true })',
        );
      }
      let payload;
      try {
        payload = this.hibira.verifyWebhook(request.headers ?? {}, raw, options.previousSecret);
      } catch (err) {
        if (err instanceof InvalidWebhookError) throw new UnauthorizedException(err.message);
        throw err;
      }
      const handled = await this.explorer.dispatch(payload, request);
      return { ok: true, events: payload.events.length, handled };
    }
  }

  return HibiraWebhookController;
}
