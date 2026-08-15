/**
 * dsh-desktop tauri-update plugin — browser half.
 *
 * Hand-written `__ModuleLoader__.load` bundle (no upstream build toolchain):
 * registers one `settings.section` entry ("about") that renders the wrapper's
 * version payload plus a manual update flow driven over the Tauri IPC bridge.
 *
 *   - version rows:      fetch('/api/tauri/version') (host-half route)
 *   - update check:      invoke('plugin:updater|check')
 *   - download+install:  invoke('plugin:updater|download_and_install', { rid, onEvent })
 *   - restart:           invoke('desktop-exit') → graceful shutdown → installer relaunch
 *
 * Only seed modules are imported: react / react/jsx-runtime (platform seed
 * words) and the primitives Button. The `slots` service comes from the fiber
 * inject declaration, exactly like the shipped client plugins.
 */

window.__ModuleLoader__.load({
  id: 'tauri-update',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var { jsx, jsxs } = require('react/jsx-runtime')
    var { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    var SLOT = 'settings.section'
    var VERSION_URL = '/api/tauri/version'

    /** Same-origin fetch of the wrapper version payload (host-half route). */
    function fetchVersionInfo() {
      return fetch(VERSION_URL, { headers: { accept: 'application/json' } })
        .then((res) => {
          if (!res.ok) return null
          return res.json().catch(() => null)
        })
        .catch(() => null)
    }

    /** Tauri IPC invoke with a graceful absence check (plain-browser context). */
    function invoke(command, args) {
      var tauri = window.__TAURI_INTERNALS__
      if (tauri === undefined || typeof tauri.invoke !== 'function') {
        return Promise.reject(new Error('Tauri IPC unavailable'))
      }
      return tauri.invoke(command, args)
    }

    /**
     * Channel argument for download_and_install, shaped exactly like
     * @tauri-apps/api's Channel: the internals register the callback and the
     * JSON serialization carries `{ __TAURI_CHANNEL__: id }`.
     */
    function makeChannel(onmessage) {
      var tauri = window.__TAURI_INTERNALS__
      var id = tauri.Channel(onmessage)
      return {
        toJSON: function () {
          return { __TAURI_CHANNEL__: id }
        },
      }
    }

    /** Section heading + row copy; zh-primary with a minimal en fallback. */
    function labelOf(zh, en) {
      var lang = typeof document !== 'undefined' ? (document.documentElement.lang || '') : ''
      return lang.toLowerCase().startsWith('en') ? en : zh
    }

    /**
     * Render one version/status row: label left, value right.
     * @param {string} label
     * @param {string} value
     * @param {object} [valueStyle]
     */
    function Row({ label, value, valueStyle }) {
      return jsx('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '10px 14px',
          borderRadius: '10px',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
        children: [
          jsx('span', { style: { fontSize: '13px', opacity: 0.65 }, children: label }),
          jsx('span', {
            style: Object.assign({ fontSize: '13px', color: 'var(--dsw-alias-label-primary)', fontWeight: 500, textAlign: 'right' }, valueStyle),
            children: value,
          }),
        ],
      })
    }

    /**
     * The About section: version rows + the manual update state machine.
     * @param {object} props - settings.section owner props (close etc.).
     */
    function AboutSection(props) {
      var _s = React.useState('loading') // idle | checking | up-to-date | available | downloading | done | error
      var status = _s[0]
      var setStatus = _s[1]
      var _v = React.useState(null) // version.json payload {version,nodeVersion,target,platform,arch}
      var version = _v[0]
      var setVersion = _v[1]
      var _m = React.useState(null) // updater metadata (check result)
      var update = _m[0]
      var setUpdate = _m[1]
      var _p = React.useState(null) // download progress 0..100
      var progress = _p[0]
      var setProgress = _p[1]
      var _e = React.useState('') // error message
      var error = _e[0]
      var setError = _e[1]

      React.useEffect(function () {
        var cancelled = false
        fetchVersionInfo().then(function (payload) {
          if (cancelled) return
          if (payload !== null && typeof payload.version === 'string') {
            setVersion(payload)
          } else {
            // Fallback: the Tauri app version (equals the dsh version after
            // set-version; degraded rows show only the version).
            invoke('plugin:app|version')
              .then(function (appVersion) {
                if (!cancelled && typeof appVersion === 'string') setVersion({ version: appVersion })
              })
              .catch(function () {})
          }
        })
        return function () {
          cancelled = true
        }
      }, [])

      function handleCheck() {
        setStatus('checking')
        setError('')
        setUpdate(null)
        invoke('plugin:updater|check')
          .then(function (meta) {
            if (meta === null) setStatus('up-to-date')
            else {
              setUpdate(meta)
              setStatus('available')
            }
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err))
            setStatus('error')
          })
      }

      function handleInstall() {
        if (update === null) return
        setStatus('downloading')
        setError('')
        setProgress(0)
        var received = 0
        var total = 0
        var channel = makeChannel(function (event) {
          if (event === null || typeof event !== 'object') return
          var data = event.data
          if (event.event === 'Started') {
            total = data !== null && typeof data === 'object' ? Number(data.contentLength) || 0 : 0
            received = 0
            setProgress(0)
          } else if (event.event === 'Progress') {
            received += data !== null && typeof data === 'object' ? Number(data.chunkLength) || 0 : 0
            if (total > 0) setProgress(Math.min(100, Math.round((received / total) * 100)))
          } else if (event.event === 'Finished') {
            setProgress(100)
          }
        })
        invoke('plugin:updater|download_and_install', { rid: update.rid, onEvent: channel })
          .then(function () {
            setStatus('done')
            // The installer staged the new version; exit through the graceful
            // shutdown bridge (Windows NSIS relaunches the app).
            invoke('desktop-exit').catch(function () {})
          })
          .catch(function (err) {
            setError(String(err && err.message ? err.message : err))
            setStatus('error')
          })
      }

      var busy = status === 'checking' || status === 'downloading'
      var t = labelOf

      var statusLine
      if (status === 'checking') statusLine = t('正在检查更新…', 'Checking for updates…')
      else if (status === 'up-to-date') statusLine = t('已是最新版本', 'You are up to date')
      else if (status === 'available' && update !== null) {
        statusLine = t('发现新版本 {0}', 'New version {0} available').replace('{0}', update.version)
      } else if (status === 'downloading') {
        statusLine = progress === null || progress < 0
          ? t('正在下载更新…', 'Downloading update…')
          : t('正在下载更新… {0}%', 'Downloading update… {0}%').replace('{0}', String(progress))
      } else if (status === 'done') statusLine = t('更新完成,正在重启…', 'Update installed, restarting…')
      else if (status === 'error') statusLine = t('更新检查失败', 'Update check failed')
      else statusLine = ''

      var action
      if (status === 'idle' || status === 'up-to-date' || status === 'error') {
        action = jsx(Button, {
          variant: 'primary',
          size: 'md',
          disabled: busy,
          onClick: handleCheck,
          children: t('检查更新', 'Check for updates'),
        })
      } else if (status === 'available' && update !== null) {
        action = jsx(Button, {
          variant: 'primary',
          size: 'md',
          disabled: busy,
          onClick: handleInstall,
          children: t('下载并安装', 'Download and install'),
        })
      } else if (status === 'downloading') {
        action = jsx(Button, { variant: 'primary', size: 'md', disabled: true, children: t('更新中…', 'Updating…') })
      } else if (status === 'done') {
        action = jsx(Button, { variant: 'ghost', size: 'md', disabled: true, children: t('已安装', 'Installed') })
      }

      var nodeVersion = version !== null && version.nodeVersion ? version.nodeVersion : '—'
      var platform = version !== null && version.platform ? version.platform + (version.arch ? '-' + version.arch : '') : '—'

      return jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 2px', maxWidth: '640px' },
        children: [
          jsx(Row, { label: t('当前版本', 'Current version'), value: version !== null ? version.version : '…' }),
          jsx(Row, { label: t('Node 运行时', 'Node runtime'), value: nodeVersion }),
          jsx(Row, { label: t('平台 / 架构', 'Platform / arch'), value: platform }),
          jsx('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '12px 14px',
              borderRadius: '10px',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
            children: [
              jsx('div', {
                style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
                children: [
                  jsx('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }, children: statusLine }),
                  status === 'error' && error !== ''
                    ? jsx('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all' }, children: error })
                    : null,
                  status === 'available' && update !== null && typeof update.body === 'string' && update.body !== ''
                    ? jsx('span', {
                        style: { fontSize: '12px', opacity: 0.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
                        children: update.body,
                      })
                    : null,
                ],
              }),
              action,
            ],
          }),
        ],
      })
    }

    /** Register the About page once the settings section slot is declared. */
    function apply(ctx) {
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'about',
        // After every shipped section (general=0, models=10, plugins=15,
        // agent-presets=20) so the About page sits last in the nav.
        order: 30,
        label: () => labelOf('关于', 'About'),
      }, AboutSection))
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
