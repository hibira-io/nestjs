// A small live order page that uses every part of @hibira-io/nestjs.
// Run it with `npm run example` (see example/README.md).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { Broadcast, HibiraChannel, HibiraModule, HibiraService, OnHibiraWebhook, type WebhookEvent } from '../src';

const PEOPLE: Record<string, { name: string; role: string }> = {
  ann: { name: 'Ann', role: 'customer' },
  bo: { name: 'Bo', role: 'support' },
  kei: { name: 'Kei', role: 'warehouse' },
};

// Demo sign-in: the user named in the X-User header. Use your real guard.
@Injectable()
class DemoUserGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const id = String(req.headers['x-user'] ?? '');
    if (PEOPLE[id]) req.user = { id, ...PEOPLE[id] };
    return true;
  }
}

@Injectable()
class Channels {
  @HibiraChannel('private-orders.{orderId}')
  order() {
    return true;
  }

  @HibiraChannel('presence-order.{orderId}')
  watchers(user: { name: string; role: string }) {
    return { name: user.name, role: user.role };
  }

  @HibiraChannel('private-ops')
  ops(user: { role: string }) {
    return user.role !== 'customer';
  }
}

@Injectable()
class WebhookLog {
  constructor(private readonly hibira: HibiraService) {}

  // Every verified webhook is shown on the page's log.
  @OnHibiraWebhook()
  async log(event: WebhookEvent) {
    if (event.channel === 'private-ops') return;
    await this.hibira.trigger('private-ops', 'webhook', { name: event.name, channel: event.channel, user_id: event.user_id ?? null, at: Date.now() });
  }
}

const STEPS = ['placed', 'packed', 'shipped', 'delivered'];

@Controller()
class OrdersController {
  constructor(private readonly hibira: HibiraService) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  page() {
    return readFileSync(join(__dirname, '../../example/public/index.html'), 'utf8');
  }

  @Get('pusher.js')
  @Header('content-type', 'text/javascript; charset=utf-8')
  pusherJs() {
    return readFileSync(require.resolve('pusher-js/dist/web/pusher.min.js'), 'utf8');
  }

  @Get('config')
  config() {
    return this.hibira.clientConfig();
  }

  @Post('orders/:id/status')
  @Broadcast('private-orders.{id}', 'order.updated')
  update(@Param('id') id: string, @Body() body: { status: string }) {
    if (!STEPS.includes(body.status)) return { id, status: 'placed', at: Date.now() };
    return { id, status: body.status, at: Date.now() };
  }

  @Post('orders/:id/explain')
  explain(@Param('id') id: string, @Body() body: { lang?: string }) {
    const text =
      body.lang === 'zh-TW'
        ? '您的包裹今天早上 9:40 從桃園倉庫出貨，目前由黑貓宅急便配送中。預計明天中午前送達；如果需要改地址，在下午 6 點前告訴我們就來得及。'
        : 'Your parcel left the Osaka warehouse at 9:40 this morning and is now with the courier. It should arrive before noon tomorrow; if you need a different address, tell us before 6 pm and we can still change it.';
    async function* tokens() {
      for (const piece of text.match(/.{1,4}/gsu) ?? []) {
        await new Promise((r) => setTimeout(r, 35));
        yield piece;
      }
    }
    this.hibira.stream(`private-orders.${id}`, tokens(), { meta: { role: 'assistant' }, interval: 80 }).catch(() => undefined);
    return { ok: true };
  }
}

@Module({
  imports: [HibiraModule.forRoot({ auth: { guards: [DemoUserGuard] }, webhooks: true })],
  controllers: [OrdersController],
  providers: [Channels, WebhookLog],
})
class AppModule {}

async function main() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(Number(process.env.PORT ?? 3999));
  console.log(`open http://localhost:${process.env.PORT ?? 3999}/?user=ann`);
}

main();
