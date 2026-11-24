// The snapnedit embed protocol over a native webview — pure, no React Native
// imports, so it is unit-testable and reusable. Wire contract:
// https://snapnedit.com/docs/embed-native and `protocol.json` in @snapnedit/embed.

export const DEFAULT_ORIGIN = 'https://snapnedit.com';
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;

export type Credential = { publishableKey: string; token?: never } | { token: string; publishableKey?: never };

export type EmbedUrlOptions = Credential & {
  /** Your bundle id / package name, allowlisted on the key as `native:<appId>`. */
  appId: string;
  locale?: string;
  /** Self-hosted deployments only. */
  origin?: string;
};

/** The frame URL a webview loads. */
export function buildEmbedUrl(options: EmbedUrlOptions): string {
  if (!APP_ID.test(options.appId)) {
    throw new Error(`snapnedit: appId "${options.appId}" must be 2-128 letters, digits, ".", "_" or "-", starting with a letter or digit`);
  }
  const query = new URLSearchParams({ transport: 'native', origin: `native:${options.appId}` });
  if (options.publishableKey) query.set('key', options.publishableKey);
  else if (options.token) query.set('token', options.token);
  else throw new Error('snapnedit: pass publishableKey or token');
  if (options.locale) query.set('locale', options.locale);
  return `${(options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '')}/embed?${query.toString()}`;
}

/** JavaScript that hands one message to the frame. JSON.stringify makes the string a safe JS literal. */
export function receiveScript(json: string): string {
  return `window.SnapneditNativeBridge&&window.SnapneditNativeBridge.receive(${JSON.stringify(json)});true;`;
}

export type ErrorCode =
  | 'invalid_input' | 'unsupported_mime' | 'too_large' | 'not_found' | 'input_fetch_failed' | 'provider_failed'
  | 'provider_exhausted' | 'rate_limited' | 'bot_check_failed' | 'unauthorized' | 'forbidden' | 'payment_required'
  | 'internal' | 'not_ready' | 'mask_required' | 'timeout' | 'origin_denied' | 'destroyed' | 'token_expired'
  | 'network_error' | 'upload_failed' | 'unsupported';

export class SnapneditError extends Error {
  constructor(readonly code: ErrorCode | (string & {}), message: string, readonly details?: unknown) {
    super(message);
    this.name = 'SnapneditError';
  }
}

export type ExportFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'svg' | 'pdf';
/** A Blob as it crosses the native boundary. */
export interface EncodedBlob { dataUrl: string; mime: string; bytes: number }
export interface ExportResult { blob: EncodedBlob; width: number; height: number }
/** A presigned upload URL your backend minted, or a saved storage destination's id (`dst_…`). */
export type ExportTarget =
  | { url: string; method?: 'PUT' | 'POST'; headers?: Record<string, string>; format?: ExportFormat }
  | { destinationId: string; headers?: Record<string, string>; format?: ExportFormat };

export interface Events {
  ready: { version: string };
  change: { dirty: boolean; pageCount: number };
  selection: { ids: string[]; kind: string | null };
  job: { operation: string; status: 'started' | 'succeeded' | 'failed'; jobId?: string; credits: number; cached: boolean; deliveryOnly: boolean; durationMs?: number; error?: { code: ErrorCode; message: string }; endUserId?: string };
  export: { format: ExportFormat | 'gif'; blob: EncodedBlob; width: number; height: number };
  save: { document: unknown; pages: unknown[] };
  close: Record<string, never>;
  error: { code: ErrorCode; message: string };
  'token-expiring': { expiresAt?: string };
}
export type EventName = keyof Events;

interface Envelope { snapnedit?: unknown; type?: unknown; id?: unknown; payload?: unknown }

/**
 * One editor session. `inject` evaluates JavaScript in the webview. Calls made
 * before the editor reports `ready` are queued and sent in order once it does.
 */
export class SnapneditClient {
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: SnapneditError) => void }>();
  private queue: string[] | null = [];
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private destroyed = false;

  constructor(private readonly inject: (script: string) => void) {}

  /** Feed every string the webview posts out (react-native-webview's `onMessage` data). Non-snapnedit messages are ignored. */
  handleMessage(raw: string): void {
    let msg: Envelope;
    try {
      msg = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (this.destroyed || msg === null || typeof msg !== 'object' || msg.snapnedit !== 1) return;
    if (msg.type === 'result' && typeof msg.id === 'string') {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      const p = (msg.payload ?? {}) as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string; details?: unknown } };
      if (p.ok) call.resolve(p.value);
      else call.reject(new SnapneditError(p.error?.code ?? 'internal', p.error?.message ?? 'call failed', p.error?.details));
      return;
    }
    if (msg.type === 'event') {
      const { name, data } = (msg.payload ?? {}) as { name?: string; data?: unknown };
      if (typeof name !== 'string') return;
      if (name === 'ready' && this.queue) {
        const queued = this.queue;
        this.queue = null;
        for (const json of queued) this.inject(receiveScript(json));
      }
      if (name === 'error' && this.queue && (data as { code?: string } | undefined)?.code === 'origin_denied') {
        this.failAll(new SnapneditError('origin_denied', (data as { message?: string }).message ?? 'origin denied'));
      }
      this.listeners.get(name)?.forEach((fn) => fn(data));
    }
  }

  on<E extends EventName>(name: E, fn: (data: Events[E]) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(fn as (data: unknown) => void);
    return () => set.delete(fn as (data: unknown) => void);
  }

  /** Low-level: any protocol method. Long-running AI calls have no client-side timeout. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (this.destroyed) return Promise.reject(new SnapneditError('destroyed', 'editor was destroyed'));
    const id = String(this.nextId++);
    const json = JSON.stringify({ snapnedit: 1, type: 'call', id, payload: { method, args } });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (this.queue) this.queue.push(json);
      else this.inject(receiveScript(json));
    });
  }

  /** Answer `token-expiring` with a token your backend minted (`POST /embed/tokens`). */
  refreshToken(token: string): void {
    if (!this.destroyed) this.inject(receiveScript(JSON.stringify({ snapnedit: 1, type: 'refresh-token', payload: { token } })));
  }

  /** `data:` or `https:` URL. Keep data URLs to a few MB. */
  loadImage(url: string, options?: { name?: string }): Promise<void> { return this.call('loadImage', url, ...(options ? [options] : [])); }
  addImage(url: string, options?: { name?: string }): Promise<void> { return this.call('addImage', url, ...(options ? [options] : [])); }
  newDocument(width: number, height: number): Promise<void> { return this.call('newDocument', width, height); }
  loadDocument(document: unknown): Promise<void> { return this.call('loadDocument', document); }
  getDocument<T = unknown>(): Promise<T> { return this.call('getDocument'); }
  getPages<T = unknown>(): Promise<T[]> { return this.call('getPages'); }
  /** Run an AI operation (e.g. `remove-background`) on the current image. */
  run(operation: string, params?: Record<string, unknown>): Promise<void> { return this.call('run', operation, ...(params ? [params] : [])); }
  openTool(tool: string): Promise<void> { return this.call('openTool', tool); }
  undo(): Promise<void> { return this.call('undo'); }
  redo(): Promise<void> { return this.call('redo'); }
  select(ids: string[]): Promise<void> { return this.call('select', ids); }
  getState<T = unknown>(): Promise<T> { return this.call('getState'); }
  export(format: ExportFormat = 'png', options?: Record<string, unknown>): Promise<ExportResult> { return this.call('export', format, ...(options ? [options] : [])); }
  /** Upload straight from the webview to a presigned URL or saved destination — bytes never cross into JS. */
  exportTo<T = unknown>(target: ExportTarget, options?: Record<string, unknown>): Promise<T> {
    return this.call('exportTo', target, ...(options ? [options] : []));
  }
  listDestinations<T = unknown>(): Promise<T[]> { return this.call('listDestinations'); }
  setTheme(theme: Record<string, unknown>): Promise<void> { return this.call('setTheme', theme); }
  setFeatures(features: Record<string, unknown>): Promise<void> { return this.call('setFeatures', features); }
  setLocale(locale: string): Promise<void> { return this.call('setLocale', locale); }

  /** Rejects every pending/queued call with `destroyed`. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.failAll(new SnapneditError('destroyed', 'editor was destroyed'));
    this.destroyed = true;
    this.listeners.clear();
  }

  private failAll(err: SnapneditError): void {
    for (const call of this.pending.values()) call.reject(err);
    this.pending.clear();
    if (this.queue) this.queue = [];
  }
}

/** Decodes an exported `dataUrl` to bytes (base64 body, needs a global `atob`, which Hermes has). */
export function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) {
    throw new SnapneditError('invalid_input', 'not a base64 data: URL');
  }
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
