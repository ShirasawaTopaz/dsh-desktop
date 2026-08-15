/**
 * dsh-desktop tauri-update plugin — host half.
 *
 * Mounted through the wrapper's `--patch` overlay (the same mechanism as the
 * shutdown bridge), as a bare-name row `tauri-update` resolved from the staged
 * `resources/dsh/node_modules` tree via the profile module fallback. The node
 * half registers one read-only route on the web profile's webserver:
 *
 *   GET /api/tauri/version  → the wrapper's `version.json` payload
 *                             (dsh upstream version, Node runtime, target).
 *
 * The browser half (`./client.js`) renders the Settings → About section, which
 * reads this route for the version rows and drives the Tauri updater over IPC.
 *
 * Fail closed like the shutdown bridge: the route answers 403 unless the
 * request Host is a loopback literal, so a LAN-exposed server cannot leak the
 * payload to other machines.
 */

import { readFileSync } from 'node:fs'

export const name = 'tauri-update'

export const inject = ['webServer']

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Absolute URL of the wrapper's version.json resource. The bundle layout puts
 * this package at `<resource_dir>/dsh/node_modules/tauri-update/lib/`, with
 * version.json a sibling of `dsh/`, so four hops up from this file's own
 * directory lands on it on every platform (Windows/Linux resource dirs and
 * macOS's flattened Contents/Resources share the same relative shape).
 */
const VERSION_URL = new URL('../../../../version.json', import.meta.url)

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tauri/version',
    handler: (req, res) => {
      const hostname = (req.headers.host ?? '').split(':')[0]
      if (!LOOPBACK_HOSTS.has(hostname)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
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
  }), 'tauri-update: /api/tauri/version route')
}
