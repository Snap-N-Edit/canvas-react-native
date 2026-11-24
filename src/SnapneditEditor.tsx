import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type ComponentType, type Ref } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import { buildEmbedUrl, DEFAULT_ORIGIN, SnapneditClient, type EmbedUrlOptions, type Events } from './client.js';

// react-native-webview 14 types its props as `WebViewProps & P` with `P = undefined`, i.e. `never` under strict mode.
const WebViewView = WebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebView> }>;

export type SnapneditEditorProps = EmbedUrlOptions & {
  style?: StyleProp<ViewStyle>;
  /** The editor is live; call methods on `editor` (or on the ref) from here on. */
  onReady?: (editor: SnapneditClient, data: Events['ready']) => void;
  onChange?: (data: Events['change']) => void;
  onJob?: (data: Events['job']) => void;
  /** The user exported from the editor's own menu. `data.blob.dataUrl` holds the file. */
  onExport?: (data: Events['export']) => void;
  onSave?: (data: Events['save']) => void;
  onClose?: () => void;
  onError?: (data: Events['error']) => void;
  /**
   * Return a fresh token from your backend (`POST /embed/tokens`) when the
   * current one is about to expire. Only for `token` sessions.
   */
  getToken?: () => Promise<string>;
};

/**
 * The snapnedit editor in a react-native-webview. The ref is the
 * {@link SnapneditClient}; calls made before `onReady` are queued.
 */
export const SnapneditEditor = forwardRef<SnapneditClient, SnapneditEditorProps>(function SnapneditEditor(props, ref) {
  const { appId, locale, origin, style, publishableKey } = props;
  const webview = useRef<WebView>(null);
  // Latest callbacks without re-creating the session when a handler identity changes.
  const handlers = useRef(props);
  handlers.current = props;
  // A token session boots with the first token; later ones arrive via getToken/refresh-token, never a reload.
  const firstToken = useRef(props.token);

  const uri = useMemo(
    () =>
      buildEmbedUrl({
        appId,
        ...(locale ? { locale } : {}),
        ...(origin ? { origin } : {}),
        ...(publishableKey ? { publishableKey } : { token: firstToken.current ?? '' }),
      }),
    [appId, locale, origin, publishableKey],
  );
  const client = useMemo(() => new SnapneditClient((script) => webview.current?.injectJavaScript(script)), [uri]);
  useImperativeHandle(ref, () => client, [client]);
  const subscribed = useRef(0);
  const current = useRef(client);
  current.current = client;

  useEffect(() => {
    const offs = [
      client.on('ready', (d) => handlers.current.onReady?.(client, d)),
      client.on('change', (d) => handlers.current.onChange?.(d)),
      client.on('job', (d) => handlers.current.onJob?.(d)),
      client.on('export', (d) => handlers.current.onExport?.(d)),
      client.on('save', (d) => handlers.current.onSave?.(d)),
      client.on('close', () => handlers.current.onClose?.()),
      client.on('error', (d) => handlers.current.onError?.(d)),
      client.on('token-expiring', () => {
        const getToken = handlers.current.getToken;
        if (!getToken) return;
        getToken().then(
          (token) => client.refreshToken(token),
          (err: unknown) => handlers.current.onError?.({ code: 'token_expired', message: `getToken failed: ${String(err)}` }),
        );
      }),
    ];
    subscribed.current += 1;
    return () => {
      offs.forEach((off) => off());
      subscribed.current -= 1;
      // StrictMode re-subscribes synchronously; only a real unmount/session change is still at 0 a microtask later.
      queueMicrotask(() => {
        if (subscribed.current === 0 || client !== current.current) client.destroy();
      });
    };
  }, [client]);

  return (
    <WebViewView
      ref={webview}
      source={{ uri }}
      style={style}
      // Matched against the origin only. The frame's own origin too, or a self-hosted http:// deployment opens in the system browser.
      originWhitelist={['https://*', (origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '')]}
      javaScriptEnabled
      domStorageEnabled
      onMessage={(e: WebViewMessageEvent) => client.handleMessage(e.nativeEvent.data)}
    />
  );
});
