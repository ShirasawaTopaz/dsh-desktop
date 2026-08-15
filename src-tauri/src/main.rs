#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shutdown;
mod sidecar;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Shared runtime state owned by the app.
pub struct AppState {
    /// The dsh sidecar, once spawned.
    pub sidecar: Mutex<Option<sidecar::Sidecar>>,
    /// Set once a graceful shutdown has been requested; guards double triggers.
    pub shutting_down: Arc<AtomicBool>,
}

/// Exit the app through the normal close path. Invoked by the Settings →
/// About update flow after the new version finished installing; the
/// `RunEvent::ExitRequested` handler routes it through the graceful shutdown
/// bridge (bounded dsh dispose) instead of killing the sidecar.
#[tauri::command]
fn desktop_exit(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![desktop_exit])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the existing window instead of forking a
            // second dsh process over the same ~/.dsh session store.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = Arc::new(AppState {
                sidecar: Mutex::new(None),
                shutting_down: Arc::new(AtomicBool::new(false)),
            });
            app.manage(state.clone());

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("DeepSeek Harness")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 600.0)
            .on_navigation(|url| sidecar::is_allowed_navigation(url))
            .build()?;

            sidecar::spawn(app.handle(), window, state)?;
            updater::arm(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the DeepSeek Harness desktop app")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                let state = app_handle.state::<Arc<AppState>>();
                if state.shutting_down.load(Ordering::Relaxed) {
                    return;
                }
                api.prevent_exit();
                shutdown::request(app_handle);
            }
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                let state = app_handle.state::<Arc<AppState>>();
                if state.shutting_down.load(Ordering::Relaxed) {
                    return;
                }
                api.prevent_close();
                shutdown::request(app_handle);
            }
            RunEvent::Exit => {
                // Final guard: never leave the sidecar running.
                shutdown::kill_sidecar(app_handle);
            }
            _ => {}
        });
}
