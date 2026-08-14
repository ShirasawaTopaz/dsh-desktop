use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::sidecar;
use crate::AppState;

/// Start a graceful shutdown on a worker thread and exit the app when done.
/// Called from the run loop, where blocking would stall the event loop.
pub fn request(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        graceful(&app);
        app.exit(0);
    });
}

/// Prefer the shutdown route (bounded disposal on every platform), then fall
/// back to a process kill.
pub fn graceful(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    state.shutting_down.store(true, Ordering::Relaxed);
    let mut guard = state.sidecar.lock().expect("sidecar lock");
    let Some(sidecar) = guard.as_mut() else {
        return;
    };
    if let Some(port) = sidecar.port {
        let url = format!("http://127.0.0.1:{port}/api/tauri/shutdown");
        // Any response (or refusal) falls through to the kill fallback; the
        // route result only decides how long we wait.
        let _ = ureq::post(&url)
            .set("X-Dsh-Shutdown-Token", &sidecar.token)
            .timeout(sidecar::SHUTDOWN_ROUTE_TIMEOUT)
            .call();
        if sidecar.exited.recv_timeout(sidecar::GRACE_AFTER_ROUTE).is_ok() {
            return;
        }
    }
    if let Some(child) = sidecar.child.take() {
        let _ = child.kill();
    }
    let _ = sidecar.exited.recv_timeout(Duration::from_secs(5));
}

/// Final guard: never leave the sidecar running.
pub fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let mut guard = state.sidecar.lock().expect("sidecar lock");
    if let Some(sidecar) = guard.as_mut() {
        if let Some(child) = sidecar.child.take() {
            let _ = child.kill();
        }
    }
}
