import { describe, expect, test } from 'vitest';
import { buildEmbedUrl, decodeDataUrl, receiveScript, SnapneditClient, SnapneditError } from '../src/client.js';

const msg = (o: object) => JSON.stringify({ snapnedit: 1, ...o });
const ready = msg({ type: 'event', payload: { name: 'ready', data: { version: '0.4.0' } } });

/** A client whose injected scripts are decoded back into the envelopes they deliver. */
function harness() {
  const sent: Array<{ type: string; id?: string; payload: { method?: string; args?: unknown[]; token?: string } }> = [];
  const client = new SnapneditClient((script) => {
    const literal = /receive\((".*")\);true;$/.exec(script)?.[1];
    if (!literal) throw new Error(`unexpected script: ${script}`);
    sent.push(JSON.parse(JSON.parse(literal) as string));
  });
  return { client, sent };
}

describe('buildEmbedUrl', () => {
  test('native transport, app id as origin, key or token, locale, self-hosted origin', () => {
    expect(buildEmbedUrl({ publishableKey: 'pk_live_x', appId: 'net.crossly.app' })).toBe(
      'https://snapnedit.com/embed?transport=native&origin=native%3Anet.crossly.app&key=pk_live_x',
    );
    expect(buildEmbedUrl({ token: 't.k', appId: 'app', locale: 'en', origin: 'https://edit.example.com/' })).toBe(
      'https://edit.example.com/embed?transport=native&origin=native%3Aapp&token=t.k&locale=en',
    );
  });
  test('rejects a bad app id or a missing credential', () => {
    expect(() => buildEmbedUrl({ publishableKey: 'pk', appId: '-bad' })).toThrow(/appId/);
    expect(() => buildEmbedUrl({ publishableKey: 'pk', appId: 'a b' })).toThrow(/appId/);
    expect(() => buildEmbedUrl({ appId: 'app' } as never)).toThrow(/publishableKey or token/);
  });
});

test('receiveScript makes hostile JSON a safe string literal', () => {
  const json = msg({ type: 'call', id: '1', payload: { method: 'x', args: ['");alert(1);// </script>'] } });
  const script = receiveScript(json);
  // Evaluating it hands the frame exactly the original string.
  let got = '';
  new Function('window', script)({ SnapneditNativeBridge: { receive: (s: string) => (got = s) } });
  expect(got).toBe(json);
});

describe('SnapneditClient', () => {
  test('queues calls until ready, then sends them in order and resolves results', async () => {
    const { client, sent } = harness();
    const a = client.loadImage('data:image/png;base64,AAAA');
    const b = client.run('remove-background');
    expect(sent).toEqual([]);
    client.handleMessage(msg({ type: 'ready-for-init' }));
    expect(sent).toEqual([]);
    client.handleMessage(ready);
    expect(sent.map((m) => [m.type, m.id, m.payload.method, m.payload.args])).toEqual([
      ['call', '1', 'loadImage', ['data:image/png;base64,AAAA']],
      ['call', '2', 'run', ['remove-background']],
    ]);
    client.handleMessage(msg({ type: 'result', id: '2', payload: { ok: true, value: null } }));
    client.handleMessage(msg({ type: 'result', id: '1', payload: { ok: true, value: null } }));
    await expect(Promise.all([a, b])).resolves.toEqual([null, null]);
    // After ready, calls go straight out.
    void client.undo();
    expect(sent.at(-1)?.payload.method).toBe('undo');
  });

  test('a failed result rejects with the protocol error code', async () => {
    const { client } = harness();
    client.handleMessage(ready);
    const p = client.run('upscale', { factor: '4' });
    client.handleMessage(msg({ type: 'result', id: '1', payload: { ok: false, error: { code: 'payment_required', message: 'out of credits' } } }));
    await expect(p).rejects.toMatchObject({ name: 'SnapneditError', code: 'payment_required', message: 'out of credits' });
  });

  test('events reach listeners; unsubscribe works; junk and foreign messages are ignored', () => {
    const { client } = harness();
    const jobs: unknown[] = [];
    const off = client.on('job', (d) => jobs.push(d.status));
    for (const junk of ['not json', 'null', '{"type":"event"}', msg({ type: 'event', payload: {} }), msg({ type: 'result', id: '99', payload: { ok: true } })]) {
      client.handleMessage(junk);
    }
    client.handleMessage(msg({ type: 'event', payload: { name: 'job', data: { status: 'started' } } }));
    off();
    client.handleMessage(msg({ type: 'event', payload: { name: 'job', data: { status: 'succeeded' } } }));
    expect(jobs).toEqual(['started']);
  });

  test('origin_denied before ready fails the queued calls', async () => {
    const { client } = harness();
    const p = client.getState();
    client.handleMessage(msg({ type: 'event', payload: { name: 'error', data: { code: 'origin_denied', message: 'native:x not allowed' } } }));
    await expect(p).rejects.toMatchObject({ code: 'origin_denied' });
  });

  test('refreshToken sends the refresh-token envelope', () => {
    const { client, sent } = harness();
    client.refreshToken('fresh');
    expect(sent).toEqual([{ snapnedit: 1, type: 'refresh-token', payload: { token: 'fresh' } }]);
  });

  test('destroy rejects pending and later calls', async () => {
    const { client } = harness();
    client.handleMessage(ready);
    const p = client.export('png');
    client.destroy();
    await expect(p).rejects.toBeInstanceOf(SnapneditError);
    await expect(client.undo()).rejects.toMatchObject({ code: 'destroyed' });
  });
});

test('decodeDataUrl', () => {
  expect([...decodeDataUrl('data:image/png;base64,iVBORw==')]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(() => decodeDataUrl('https://x')).toThrow(SnapneditError);
});
