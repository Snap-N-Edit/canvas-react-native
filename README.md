# @snapnedit/react-native

The [snapnedit](https://snapnedit.com) AI photo editor as a React Native
component. Drop `<SnapneditEditor>` into a screen and you get the full editor —
crop, adjust, text, layers, background removal and replacement, relight,
retouch, upscale, unblur, denoise, magic eraser, generative fill — running in a
[`react-native-webview`](https://github.com/react-native-webview/react-native-webview),
driven from TypeScript with a typed, promise-based client.

Using Expo? [`@snapnedit/expo`](https://github.com/Snap-N-Edit/canvas-expo)
adds photo-library/camera pick and save-to-file helpers on top of this package.

## Install

```sh
npm install @snapnedit/react-native react-native-webview
cd ios && pod install   # bare React Native only
```

Peer dependencies: `react` ≥ 18, `react-native` ≥ 0.72, `react-native-webview` ≥ 13.

## Twenty lines

```tsx
import { useRef } from 'react';
import { Button, View } from 'react-native';
import { SnapneditEditor, type SnapneditClient } from '@snapnedit/react-native';

export function PhotoStudio() {
  const editor = useRef<SnapneditClient>(null);
  return (
    <View style={{ flex: 1 }}>
      <SnapneditEditor
        ref={editor}
        publishableKey="pk_live_…"
        appId="com.acme.photos"
        style={{ flex: 1 }}
        onReady={(e) => e.loadImage('https://cdn.acme.com/photo.jpg')}
        onExport={({ blob }) => console.log('exported', blob.mime, blob.bytes)}
      />
      <Button title="Remove background" onPress={() => editor.current?.run('remove-background')} />
    </View>
  );
}
```

Calls made before the editor is ready are queued and sent once it is, so you
never have to race the load.

## Credentials

A native app has no browser origin, so it identifies itself with a **native app
id** — your bundle identifier or package name — sent as `native:<appId>`.

**Publishable key.** In the [dashboard](https://snapnedit.com/dashboard), open
your `pk_` key and add the id to **Allowed origins**:

```
https://app.example.com
native:com.acme.photos
```

The key ships inside your app and is public, exactly as on the web. Your real
controls are the key's **daily credit cap**, revocation, and host-minted tokens.

**Host-minted token** (per-user credit caps, operation allowlists). Mint it on
your backend with your secret key (`POST /embed/tokens`) and pass it instead of
the key, plus `getToken` so the editor can refresh it before it expires:

```tsx
<SnapneditEditor
  token={initialToken}
  appId="com.acme.photos"
  getToken={() => fetch('https://api.acme.com/photo-studio/token', { method: 'POST' }).then((r) => r.json()).then((b) => b.token)}
/>
```

Never put an `sk_` key in an app.

## The client

`ref` (and `onReady`'s first argument) is a `SnapneditClient`:

| Method | |
| --- | --- |
| `loadImage(url)` / `addImage(url)` | `data:` or `https:` URL. Keep `data:` URLs to a few MB; above that pass an `https:` URL. |
| `run(operation, params?)` | Any AI tool: `remove-background`, `replace-background`, `relight`, `retouch`, `upscale`, `unblur`, `ai-denoise`, `magic-eraser`, `generative-fill`, `resize-image`, … |
| `export(format?, options?)` | Resolves `{ blob: { dataUrl, mime, bytes }, width, height }`. `decodeDataUrl(blob.dataUrl)` gives the bytes. |
| `exportTo(target, options?)` | Uploads straight from the webview to a presigned URL (`{ url }`) or a saved destination (`{ destinationId: 'dst_…' }`) — the bytes never cross into JS. Prefer it for large files. |
| `newDocument`, `loadDocument`, `getDocument`, `getPages`, `getState` | Document state. |
| `undo`, `redo`, `select`, `openTool` | Editing. |
| `setTheme`, `setFeatures`, `setLocale` | Runtime appearance. |
| `listDestinations()` | The account's saved storage destinations. |
| `call(method, ...args)` | Any protocol method by name. |
| `on(event, fn)` | `ready`, `change`, `selection`, `job`, `export`, `save`, `close`, `error`, `token-expiring`. Returns an unsubscribe function. |

A failed call rejects with a `SnapneditError` whose `code` you can switch on
(`payment_required`, `rate_limited`, `origin_denied`, `invalid_input`, …).
AI calls can take a while (generative fill runs for a minute or more), so
there is no client-side timeout.

Component props mirror the events: `onReady`, `onChange`, `onJob` (use it to
meter your own users), `onExport`, `onSave`, `onClose`, `onError`.

## How it works

The component loads `https://snapnedit.com/embed?transport=native&…` and speaks
the snapnedit native protocol: messages in through
`window.SnapneditNativeBridge.receive`, out through
`window.ReactNativeWebView.postMessage`. The full wire contract is
[`protocol.json`](https://github.com/Snap-N-Edit/embed/blob/main/protocol.json);
the guide is [/docs/embed-native](https://snapnedit.com/docs/embed-native).

Mirrored from the snapnedit monorepo; changes land there.

## License

MIT
