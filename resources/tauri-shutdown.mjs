/**
 * dsh-desktop shutdown bridge — a wrapper-owned cordis function plugin.
 *
 * Mounted through the wrapper's `--patch` overlay (generated at launch with
 * this file's absolute file:// URL), it registers an exact `/api/tauri/shutdown`
 * route on the web profile's webserver so the desktop shell can request a
 * graceful, bounded disposal on every platform (Windows has no SIGTERM
 * semantics, so the route is the primary close path there and everywhere).
 *
 * Fail closed: the route answers 403 unless the request Host is a loopback
 * literal AND the `X-Dsh-Shutdown-Token` header matches the per-launch token
 * the shell passes through `DSH_TAURI_SHUTDOWN_TOKEN`. The token defeats
 * cross-site simple POSTs; loopback literals defeat DNS rebinding.
 */

export const name = 'tauri-shutdown'

export const inject = ['webServer']

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function apply(ctx) {
  const token = process.env.DSH_TAURI_SHUTDOWN_TOKEN
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tauri/shutdown',
    handler: (req, res) => {
      const hostname = (req.headers.host ?? '').split(':')[0]
      if (!LOOPBACK_HOSTS.has(hostname)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (token === undefined || req.headers['x-dsh-shutdown-token'] !== token) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      res.writeHead(204)
      res.end()
      // Let the response flush before the bounded disposal starts.
      setImmediate(() => {
        const exit = ctx.get('appExit')
        if (typeof exit === 'function') exit(0)
      })
    },
  }), 'tauri-shutdown: /api/tauri/shutdown route')
}
