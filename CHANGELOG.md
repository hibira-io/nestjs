# Changelog

## 0.2.0

- Waiting rooms: `consumer.apply(WaitingRoom('presale')).forRoutes(...)`
  sends visitors without a pass to the Hibira queue and lets them in with a
  signed pass kept in an HttpOnly cookie; `@HibiraPass()` reads it.
  `verifyPass()` and `waitingRoomUrl()` are exported. Express and Fastify.
- README: cover image and screenshots of the new example app (`npm run example`).

## 0.1.0

- `HibiraModule.forRoot()` / `forRootAsync()`, configured from options or
  `HIBIRA_*` environment variables; global by default.
- `HibiraService`: trigger, batch, send to users, channel and presence
  reads, channel and user signatures, `clientConfig()`, `verifyWebhook()`.
- `@HibiraChannel()` authorizers with `{param}` patterns and the
  `/hibira/auth` and `/hibira/user-auth` routes for pusher-js and Laravel
  Echo, behind your own guards.
- `@OnHibiraWebhook()` handlers and the `/hibira/webhook` route, with
  previous-secret support during rotations.
- `@Broadcast()` publishes a route's result, leaving out `X-Socket-ID`.
- `hibira.stream()` / `streamToChannel()`: the @hibira-io/react, vue and
  nuxt stream protocol.
- Approvals: `requestApproval()`, `getApproval()`, `waitForApproval()`.
- `HibiraPushService`: publish to interests and users, user tokens, delete
  users.
- Nest 10, 11 and 12; Express and Fastify.
