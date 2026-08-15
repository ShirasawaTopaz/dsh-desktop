# dsh-desktop

DeepSeek Harness 的 Tauri 桌面封装:内嵌上游 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 发布的 Web GUI 与 Node.js 运行时,以原生窗口呈现,并在上游发布新版本后由 GitHub CI 自动构建对应版本的安装包。

## 工作原理

```
WebView ──加载──> http://127.0.0.1:<随机端口>  (dsh web 本地服务,与浏览器体验一致)
   ▲                                            │
   └────────── Rust 壳 ──sidecar──> node lib/bin.js --profile web --host 127.0.0.1 --port 0
```

- **运行负载**:CI 以 `npm install @deepseek-ai/dsh@<版本>` 组装(整个 `@deepseek-ai/dsh-*` 家族通过 npm `overrides` 钉死到同一版本),嵌入 `resources/dsh`。
- **Node 运行时**:官方二进制(版本固定于工作流 `NODE_RUNTIME_VERSION`,须满足 dsh 的 engines `^22.19 || >=24`),按 Tauri sidecar 约定命名后嵌入。
- **就绪契约**:Rust 壳解析 sidecar stdout 的 `dsh web: http://127.0.0.1:<port>` 就绪行,再导航 WebView;`--port 0` 由系统分配端口。
- **优雅关停**:关窗/退出时先 `POST /api/tauri/shutdown`(每启动随机 token 鉴权,由 `resources/tauri-shutdown.mjs` 插件提供,经启动时生成的 `--patch` 覆盖层注入),走 dsh 自身的有界 dispose;失败则回退 kill。
- **设置页「关于」**:启动覆盖层同时注入 wrapper 自有的 `tauri-update` 插件(源码在 `plugins/tauri-update/`,由 `npm run stage` 组装进负载树),在 dsh Web 设置页新增「关于」页:显示当前 dsh 版本 / Node 运行时 / 平台架构,并提供手动「检查更新」「下载并安装」按钮,走与自动更新相同的 GitHub Release + minisign 验签通道,进度与结果在页面内呈现。
- **数据目录**:沿用 `~/.dsh`,与 dsh CLI 互通会话、配置与凭据。日志在 `~/.dsh/logs/dsh-desktop-*.log`。
- **单实例**:二次启动聚焦已有窗口,避免两个进程并发写同一会话存储。

## 本地构建

前置:Node ≥ 22.19、Rust stable、[Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
# 1. 组装运行负载(下载 Node 运行时 + npm 安装指定上游版本)
DSH_NODE_VERSION=24.13.0 npm run stage -- --version 0.1.0-rc.6

# 2. 负载冒烟(就绪行 / __DSH_BOOT__ 注入 / 客户端 bundle / 关停路由)
npm run smoke

# 3. 写入构建版本并打包
node scripts/set-version.mjs 0.1.0-rc.6
cd src-tauri && npx --yes @tauri-apps/cli@^2 build
```

注意:`tauri build`/`tauri dev` 会自动把 `resources/` 与 `binaries/` 摆放到产物目录;若用裸 `cargo run` 运行,需手动把 `resources/` 内容与 `src-tauri/binaries/node-<triple>.exe` 复制(或 junction)到 `target/debug/` 下。

## 上游发版自动构建

`.github/workflows/build-desktop.yml` 三通道触发:

1. **定时轮询**(每天一次,02:00 UTC):npm registry `@deepseek-ai/dsh` 的 dist-tags(`latest` + `next`,上游 rc 版发布到 `next`),GitHub tags(`dsh-v*`)兜底;已在本仓库发布过 `dsh-<版本>` Release 的版本自动跳过;
2. **手动触发**:`workflow_dispatch`,输入 `auto` 或具体版本;
3. **repository_dispatch**(预留)。

构建矩阵:Windows x64(NSIS+MSI)、macOS arm64(dmg)、Linux x64(AppImage+deb)。每个平台先组装、冒烟,再经 `tauri-action` 构建并上传到同一 Release。

## 签名与自动更新

- 自动更新已接入(tauri-plugin-updater):应用启动 20 秒后首次检查,之后每 6 小时一次,发现新版本即弹出原生对话框询问是否安装;设置 →「关于」页另提供手动检查与下载安装入口(更新按钮在发现新版本后可用)。
- CI 检测到上述 secrets 时,`tauri-action` 会为更新包签名并随 Release 发布 `latest.json` 与 `.sig`;未配置时产物为未签名构建(Windows 有 SmartScreen 提示,macOS 需右键打开或 `xattr -dr com.apple.quarantine`)。

## 已知限制

- 会话导出等浏览器下载行为在 WebView 中的表现需按平台验证;如有问题将改用 Tauri 下载事件落地文件(二期)。
- `dsh plugin`(pnpm 插件管理)不在桌面版暴露;可编辑 `~/.dsh/profiles/web/cordis.patch.yml`,配置热重载。
- 安装体积约 150–250MB(Node 运行时 + npm 依赖树)。
