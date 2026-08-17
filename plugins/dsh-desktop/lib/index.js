/**
 * dsh-desktop wrapper plugin — host half.
 *
 * Mounted through the wrapper's `--patch` overlay as a bare-name row
 * `dsh-desktop` resolved from the staged `resources/dsh/node_modules` tree via
 * the profile module fallback. The node half registers two routes on the web
 * profile's webserver:
 *
 *   POST /api/tauri/shutdown → bounded dispose (token + loopback)
 *   GET  /api/tauri/version  → the wrapper's `version.json` payload
 *                              (dsh upstream version, Node runtime, target).
 *
 * The browser half (`./client.js`) renders the Settings → About section, which
 * reads the version route and drives the Tauri updater over IPC.
 *
 * Fail closed: both routes answer 403 unless the request Host is a loopback
 * literal (so a LAN-exposed server cannot leak the payload or trigger dispose
 * from other machines). Shutdown additionally requires the per-launch
 * `X-Dsh-Shutdown-Token` header matching `DSH_TAURI_SHUTDOWN_TOKEN`.
 */

import { readFileSync } from 'node:fs'

export const name = 'dsh-desktop'

export const inject = ['webServer']

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Absolute URL of the wrapper's version.json resource. The bundle layout puts
 * this package at `<resource_dir>/dsh/node_modules/dsh-desktop/lib/`, with
 * version.json a sibling of `dsh/`, so four hops up from this file's own
 * directory lands on it on every platform (Windows/Linux resource dirs and
 * macOS's flattened Contents/Resources share the same relative shape).
 */
const VERSION_URL = new URL('../../../../version.json', import.meta.url)

function loopbackForbidden(req, res) {
  const hostname = (req.headers.host ?? '').split(':')[0]
  if (!LOOPBACK_HOSTS.has(hostname)) {
    res.writeHead(403)
    res.end('forbidden')
    return true
  }
  return false
}

export function apply(ctx) {
  const token = process.env.DSH_TAURI_SHUTDOWN_TOKEN
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tauri/shutdown',
    handler: (req, res) => {
      if (loopbackForbidden(req, res)) return
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
  }), 'dsh-desktop: /api/tauri/shutdown route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tauri/version',
    handler: (req, res) => {
      if (loopbackForbidden(req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      let body
      try {
        body = readFileSync(VERSION_URL)
      } catch {
        res.writeHead(404)
        res.end('version.json not bundled')
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(body)
    },
  }), 'dsh-desktop: /api/tauri/version route')
}
