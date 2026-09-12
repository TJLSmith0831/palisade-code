// macOS rounded corners plugin for Tauri v2 (cloudworxx/tauri-plugin-mac-rounded-corners, MIT).
// Uses only public AppKit APIs — App Store compatible.
#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use tauri::{AppHandle, Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
use cocoa::{
    appkit::{NSView, NSWindow, NSWindowStyleMask, NSWindowTitleVisibility},
    base::id,
    foundation::NSPoint,
};

#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl};
use crate::Res;

pub struct TrafficLightsConfig {
    pub offset_x: f64,
    pub offset_y: f64,
}

impl Default for TrafficLightsConfig {
    fn default() -> Self {
        Self {
            offset_x: 0.0,
            offset_y: 0.0,
        }
    }
}

/// Enables rounded corners for the window (macOS only).
#[tauri::command]
pub fn enable_rounded_corners<R: Runtime>(
    _app: AppHandle<R>,
    window: WebviewWindow<R>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
) -> Res<()> {
    #[cfg(target_os = "macos")]
    {
        let config = TrafficLightsConfig {
            offset_x: offset_x.unwrap_or(0.0),
            offset_y: offset_y.unwrap_or(0.0),
        };

        window
            .with_webview(move |webview| unsafe {
                let ns_window = webview.ns_window() as id;
                let mut style_mask = ns_window.styleMask();
                style_mask |= NSWindowStyleMask::NSFullSizeContentViewWindowMask;
                style_mask |= NSWindowStyleMask::NSTitledWindowMask;
                style_mask |= NSWindowStyleMask::NSClosableWindowMask;
                style_mask |= NSWindowStyleMask::NSMiniaturizableWindowMask;
                style_mask |= NSWindowStyleMask::NSResizableWindowMask;
                ns_window.setStyleMask_(style_mask);
                ns_window.setTitlebarAppearsTransparent_(cocoa::base::YES);
                let content_view = ns_window.contentView();
                content_view.setWantsLayer(cocoa::base::YES);
                position_traffic_lights(ns_window, config.offset_x, config.offset_y);
            })
            .map_err(|e| crate::PalisadeError::from(e.to_string()))?;

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (_app, window, offset_x, offset_y);
        Ok(())
    }
}

/// Enables modern window style with rounded corners and shadow.
#[tauri::command]
pub fn enable_modern_window_style<R: Runtime>(
    _app: AppHandle<R>,
    window: WebviewWindow<R>,
    corner_radius: Option<f64>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
) -> Res<()> {
    #[cfg(target_os = "macos")]
    {
        let config = TrafficLightsConfig {
            offset_x: offset_x.unwrap_or(0.0),
            offset_y: offset_y.unwrap_or(0.0),
        };
        let radius = corner_radius.unwrap_or(12.0);

        window
            .with_webview(move |webview| unsafe {
                let ns_window = webview.ns_window() as id;
                let mut style_mask = ns_window.styleMask();
                style_mask |= NSWindowStyleMask::NSFullSizeContentViewWindowMask;
                style_mask |= NSWindowStyleMask::NSTitledWindowMask;
                style_mask |= NSWindowStyleMask::NSClosableWindowMask;
                style_mask |= NSWindowStyleMask::NSMiniaturizableWindowMask;
                style_mask |= NSWindowStyleMask::NSResizableWindowMask;
                ns_window.setStyleMask_(style_mask);
                ns_window.setTitlebarAppearsTransparent_(cocoa::base::YES);
                ns_window.setTitleVisibility_(NSWindowTitleVisibility::NSWindowTitleHidden);
                ns_window.setHasShadow_(cocoa::base::YES);
                ns_window.setOpaque_(cocoa::base::NO);
                let content_view = ns_window.contentView();
                content_view.setWantsLayer(cocoa::base::YES);
                let layer: id = msg_send![content_view, layer];
                if !layer.is_null() {
                    let _: () = msg_send![layer, setCornerRadius: radius];
                    let _: () = msg_send![layer, setMasksToBounds: cocoa::base::YES];
                }
                position_traffic_lights(ns_window, config.offset_x, config.offset_y);
            })
            .map_err(|e| crate::PalisadeError::from(e.to_string()))?;

        // Keep them put across a live resize. AppKit re-lays-out the titlebar
        // on every step of a drag, which drops the buttons back at their
        // default spot; the correction has to land in the same main-thread
        // pass or you see both positions. Driving it from the webview
        // (`window.onResized` -> IPC -> `with_webview`) put two async hops in
        // between, so the correction arrived a frame or more late and the
        // buttons visibly jumped — the flicker. Tauri runs this handler on
        // the event-loop thread, so the reposition happens before the frame
        // is presented.
        let (dx, dy) = (offset_x.unwrap_or(0.0), offset_y.unwrap_or(0.0));
        let handle = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let Ok(ns_window) = handle.ns_window() {
                    unsafe { position_traffic_lights(ns_window as id, dx, dy) };
                }
            }
        });

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (_app, window, corner_radius, offset_x, offset_y);
        Ok(())
    }
}

/// Repositions Traffic Lights only (useful after fullscreen toggle).
#[tauri::command]
pub fn reposition_traffic_lights<R: Runtime>(
    _app: AppHandle<R>,
    window: WebviewWindow<R>,
    offset_x: Option<f64>,
    offset_y: Option<f64>,
) -> Res<()> {
    #[cfg(target_os = "macos")]
    {
        let config = TrafficLightsConfig {
            offset_x: offset_x.unwrap_or(0.0),
            offset_y: offset_y.unwrap_or(0.0),
        };

        window
            .with_webview(move |webview| unsafe {
                let ns_window = webview.ns_window() as id;
                position_traffic_lights(ns_window, config.offset_x, config.offset_y);
            })
            .map_err(|e| crate::PalisadeError::from(e.to_string()))?;

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (_app, window, offset_x, offset_y);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
unsafe fn position_traffic_lights(ns_window: id, offset_x: f64, offset_y: f64) {
    let default_x = 20.0;
    let default_y = 0.0;

    let close_button: id = msg_send![ns_window, standardWindowButton: 0];
    let miniaturize_button: id = msg_send![ns_window, standardWindowButton: 1];
    let zoom_button: id = msg_send![ns_window, standardWindowButton: 2];

    let new_x = default_x + offset_x;
    let new_y = default_y - offset_y;

    if !close_button.is_null() {
        let frame: cocoa::foundation::NSRect = msg_send![close_button, frame];
        let new_frame =
            cocoa::foundation::NSRect::new(NSPoint::new(new_x, new_y), frame.size);
        let _: () = msg_send![close_button, setFrame: new_frame];
    }

    if !miniaturize_button.is_null() {
        let frame: cocoa::foundation::NSRect = msg_send![miniaturize_button, frame];
        let new_frame =
            cocoa::foundation::NSRect::new(NSPoint::new(new_x + 20.0, new_y), frame.size);
        let _: () = msg_send![miniaturize_button, setFrame: new_frame];
    }

    if !zoom_button.is_null() {
        let frame: cocoa::foundation::NSRect = msg_send![zoom_button, frame];
        let new_frame =
            cocoa::foundation::NSRect::new(NSPoint::new(new_x + 40.0, new_y), frame.size);
        let _: () = msg_send![zoom_button, setFrame: new_frame];
    }
}
