use std::time::Duration;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// First update check after launch (lets the GUI settle first).
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
/// Interval between update checks.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);

/// Arm the periodic update checker on a worker thread. Checks are best-effort:
/// any failure (offline, endpoint 404, prerelease policy) is logged and skipped
/// until the next interval.
pub fn arm(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("updater runtime");
        loop {
            runtime.block_on(check_once(&app));
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

async fn check_once(app: &tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            eprintln!("[updater] init failed: {error}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[updater] check failed: {error}");
            return;
        }
    };
    let version = update.version.to_string();
    let install = app
        .dialog()
        .message(format!("检测到新版本 {version},是否现在下载安装?"))
        .title("DeepSeek Harness 更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "安装更新".into(),
            "稍后".into(),
        ))
        .blocking_show();
    if !install {
        return;
    }
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(_) => {
            // The new version is staged; restart to run it.
            app.exit(0);
        }
        Err(error) => {
            eprintln!("[updater] install failed: {error}");
        }
    }
}
