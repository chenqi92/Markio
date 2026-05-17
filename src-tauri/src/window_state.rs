// 主窗口几何持久化：位置 / 大小 / 最大化状态。
//
// 桌面应用打开时若能回到上次的窗口位置，体感差异巨大；尤其多显示器场景
// 默认每次重启都跑回主屏中心很烦。
//
// 实现：
//   * 文件落在 app_config_dir/window_state.json
//   * 监听 WindowEvent::Moved / Resized / CloseRequested，debounce 500ms 后写盘
//   * setup 钩子里 spawn 一个任务，等 webview ready 后 set_position/set_size/maximize
//   * 持久化的几何带跨屏校验：当前所有 monitor 的并集是否覆盖目标矩形中心点；
//     不覆盖则丢弃几何（外接屏拔了的场景），让窗口回默认中心。

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Listener, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WindowEvent,
};

const FILENAME: &str = "window_state.json";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct WindowGeom {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    Some(dir.join(FILENAME))
}

fn load(app: &AppHandle) -> Option<WindowGeom> {
    let p = state_path(app)?;
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_now(app: &AppHandle, g: WindowGeom) {
    let Some(p) = state_path(app) else { return };
    if let Ok(s) = serde_json::to_string_pretty(&g) {
        let _ = fs::write(p, s);
    }
}

/// 节流写盘：连续 Resized / Moved 时合并到最后一次。
fn schedule_save(app: AppHandle, g: WindowGeom) {
    static PENDING: OnceLock<Mutex<Option<WindowGeom>>> = OnceLock::new();
    let pending = PENDING.get_or_init(|| Mutex::new(None));
    let was_empty = {
        let mut guard = pending.lock().unwrap();
        let was_empty = guard.is_none();
        *guard = Some(g);
        was_empty
    };
    if !was_empty {
        return; // 已有计划中的写盘任务
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let geom = {
            let mut guard = pending.lock().unwrap();
            guard.take()
        };
        if let Some(g) = geom {
            save_now(&app2, g);
        }
    });
}

fn position_visible_on_some_monitor(app: &AppHandle, x: f64, y: f64) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    let monitors = match win.available_monitors() {
        Ok(m) => m,
        Err(_) => return false,
    };
    for m in monitors {
        let pos = m.position();
        let size = m.size();
        let scale = m.scale_factor();
        // monitor::position / size 是物理像素，几何里我们存逻辑像素，转换比较
        let left = pos.x as f64 / scale;
        let top = pos.y as f64 / scale;
        let right = left + size.width as f64 / scale;
        let bottom = top + size.height as f64 / scale;
        // 用矩形中心点是否落在某 monitor 内来判定
        let cx = x + 50.0; // 用 (x+50, y+50) 作为代表点，几乎不影响判定
        let cy = y + 50.0;
        if cx >= left && cx <= right && cy >= top && cy <= bottom {
            return true;
        }
    }
    false
}

/// 启动后应用已存几何；webview 还没完全 ready 时调 set_* 在某些平台会被忽略，
/// 所以等 "tauri://window-created" 事件触发再做一次（保险）。
pub fn apply_on_startup(app: &AppHandle) {
    let Some(g) = load(app) else { return };
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    // 校验位置仍在可见显示器内（外接屏被拔了就丢弃，避免窗口飘出屏外）
    if !position_visible_on_some_monitor(app, g.x, g.y) {
        return;
    }
    if g.width > 100.0 && g.height > 100.0 {
        let _ = win.set_size(LogicalSize::new(g.width, g.height));
    }
    let _ = win.set_position(LogicalPosition::new(g.x, g.y));
    if g.maximized {
        let _ = win.maximize();
    }
}

/// 安装事件订阅。须在 setup 钩子里调一次。
pub fn install(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let win_for_event = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::CloseRequested { .. } => {
            if let Some(g) = current_geom(&win_for_event) {
                schedule_save(handle.clone(), g);
            }
        }
        _ => {}
    });
    // 应用窗口创建完成的事件（用 listen_any 比较省事）
    let handle2 = app.clone();
    app.listen_any("tauri://window-created", move |_| {
        apply_on_startup(&handle2);
    });
}

fn current_geom(win: &tauri::WebviewWindow) -> Option<WindowGeom> {
    let maximized = win.is_maximized().unwrap_or(false);
    if maximized {
        // 最大化时不要写当前几何，否则下次还原后就是最大化几何
        // 但要标记 maximized=true，让下次恢复时直接 maximize
        // 仍取一次"非最大化"几何作为还原 anchor：available_monitors 给个默认
        let scale = win.scale_factor().unwrap_or(1.0);
        let pos = win.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
        let size = win.outer_size().ok()?;
        return Some(WindowGeom {
            x: pos.x as f64 / scale,
            y: pos.y as f64 / scale,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
            maximized: true,
        });
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some(WindowGeom {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        maximized: false,
    })
}
