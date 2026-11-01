// Server side of the Hibira stream protocol, the same as streamToChannel in
// @hibira-io/react, @hibira-io/vue and @hibira-io/nuxt, so their useStream()
// hook and composable put the text back together in the browser.
//
// Tokens are batched: one event per `interval` ms rather than one per token.
// Each event stays under `maxBytes` (Free plans allow 4 KB per message), and
// events are sent one after another so they arrive in order.

export interface StreamToChannelOptions {
  /** Stream id, default a random UUID. */
  id?: string;
  /** Event name, default "ai-stream". */
  event?: string;
  /** ms to gather tokens before sending them, default 100. */
  interval?: number;
  /** Largest event payload in bytes, default 3500 (Free plans allow 4 KB). */
  maxBytes?: number;
  /** JSON sent with the first event (model, message id, author...). */
  meta?: unknown;
  /** Text of one chunk, when textOf() does not understand the source. */
  pick?: (chunk: any) => string | null | undefined;
  /** Leave out this connection (the sender's own tab). */
  socketId?: string;
  /** Stop reading; the stream ends with error "aborted" and the promise rejects. */
  signal?: AbortSignal;
}

export interface StreamResult {
  id: string;
  /** The whole text that was sent. */
  text: string;
  /** Events sent, including the final one. */
  events: number;
}

/** Anything with the `pusher` package's trigger method. */
export interface Triggerer {
  trigger(channel: string, event: string, data: any, params?: { socket_id?: string }): Promise<unknown>;
}

export type StreamSource = AsyncIterable<any> | Iterable<any> | ReadableStream<any>;

const STREAM_EVENT = 'ai-stream';
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

/**
 * Text of one chunk from the common LLM SDK streams, or '' when the chunk has
 * none. Handles strings and bytes, Anthropic (content_block_delta), OpenAI
 * chat completions and responses, Gemini (chunk.text) and the Vercel AI SDK.
 */
export function textOf(chunk: any, decoder: TextDecoder = new TextDecoder()): string {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return decoder.decode(chunk, { stream: true });
  if (chunk.type === 'content_block_delta') return chunk.delta?.type === 'text_delta' ? chunk.delta.text ?? '' : '';
  if (chunk.type === 'response.output_text.delta') return chunk.delta ?? '';
  if (chunk.type === 'text-delta') return chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
  if (Array.isArray(chunk.choices)) return chunk.choices[0]?.delta?.content ?? '';
  if (typeof chunk.text === 'string') return chunk.text;
  return '';
}

function iterate(source: StreamSource): AsyncIterable<any> | Iterable<any> {
  const s = source as any;
  if (s && typeof s[Symbol.asyncIterator] === 'function') return s;
  if (s && typeof s[Symbol.iterator] === 'function' && typeof s !== 'string') return s;
  if (s && typeof s.getReader === 'function') {
    return (async function* () {
      const reader = s.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
  throw new TypeError('streamToChannel: source must be an async iterable, an iterable or a ReadableStream');
}

// Split text so each piece's JSON-escaped size fits `budget` bytes, without
// cutting a character in two.
function split(text: string, budget: number): string[] {
  const out: string[] = [];
  let piece = '';
  let size = 0;
  for (const ch of text) {
    const n = bytes(JSON.stringify(ch)) - 2;
    if (size + n > budget && piece) {
      out.push(piece);
      piece = '';
      size = 0;
    }
    piece += ch;
    size += n;
  }
  if (piece) out.push(piece);
  return out;
}

function randomId(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Send a stream of text to a channel as events that useStream() in
 * @hibira-io/react, @hibira-io/vue and @hibira-io/nuxt put back together.
 * Resolves after the last event is sent.
 */
export async function streamToChannel(
  pusher: Triggerer,
  channel: string,
  source: StreamSource,
  options: StreamToChannelOptions = {},
): Promise<StreamResult> {
  const { id = randomId(), event = STREAM_EVENT, interval = 100, maxBytes = 3500, meta, pick, socketId, signal } = options;
  const params = socketId ? { socket_id: socketId } : undefined;
  const decoder = new TextDecoder();
  const envelope = bytes(JSON.stringify({ id, seq: 1e9, delta: '', meta }));
  const budget = maxBytes - envelope;
  if (budget < 16) throw new RangeError('streamToChannel: maxBytes is too small for the id and meta');

  let seq = 0;
  let text = '';
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let sendError: unknown = null;

  const send = (payload: Record<string, unknown>) => {
    chain = chain.then(async () => {
      if (sendError) return;
      try {
        await pusher.trigger(channel, event, payload, params);
      } catch (err) {
        sendError = err;
      }
    });
    return chain;
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!buffer) return;
    for (const delta of split(buffer, budget)) {
      const payload: Record<string, unknown> = { id, seq: seq++, delta };
      if (payload.seq === 0 && meta !== undefined) payload.meta = meta;
      send(payload);
    }
    buffer = '';
  };

  let error: unknown = null;
  try {
    for await (const chunk of iterate(source)) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (sendError) throw sendError;
      const delta = pick ? pick(chunk) ?? '' : textOf(chunk, decoder);
      if (!delta) continue;
      text += delta;
      buffer += delta;
      if (bytes(buffer) >= budget) flush();
      else if (!timer) timer = setTimeout(flush, interval);
    }
    const tail = decoder.decode();
    if (tail) {
      text += tail;
      buffer += tail;
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  } catch (err) {
    error = err;
  }
  flush();

  const done: Record<string, unknown> = { id, seq, done: true };
  if (seq === 0 && meta !== undefined) done.meta = meta;
  if (error) done.error = signal?.aborted ? 'aborted' : String((error as any)?.message ?? error);
  // The whole text lets late subscribers catch up; skip it when too big.
  if (bytes(JSON.stringify({ ...done, text })) <= maxBytes) done.text = text;
  seq++;
  await send(done);

  if (error) throw error;
  if (sendError) throw sendError;
  return { id, text, events: seq };
}
