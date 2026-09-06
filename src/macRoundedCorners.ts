// macOS rounded corners helper — calls the Rust plugin commands.
// Adapted from cloudworxx/tauri-plugin-mac-rounded-corners (MIT).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface RoundedCornersConfig {
  cornerRadius?: number;
  offsetX?: number;
  offsetY?: number;
}

let currentConfig: RoundedCornersConfig | null = null;

// No resize listener here on purpose. Repositioning the traffic lights from
// the webview meant `onResized` -> IPC -> `with_webview`, two async hops that
// landed the correction a frame or more after AppKit had already drawn the
// buttons at their default spot — the flicker. The Rust side now does it
// synchronously on the event-loop thread (see `mac_rounded_corners.rs`).
// `repositionTrafficLights` stays for one-off nudges, e.g. after fullscreen.

export async function repositionTrafficLights(): Promise<void> {
  if (!currentConfig) return;
  try {
    const window = getCurrentWebviewWindow();
    await invoke("reposition_traffic_lights", {
      window,
      offsetX: currentConfig.offsetX ?? 0.0,
      offsetY: currentConfig.offsetY ?? 0.0,
    });
  } catch (error) {
    console.error("Failed to reposition traffic lights:", error);
  }
}

export async function enableModernWindowStyle(
  config?: RoundedCornersConfig,
): Promise<void> {
  // Silently skip in non-Tauri environments (e.g. jsdom tests).
  if (!(window as any).__TAURI_INTERNALS__) return;
  try {
    currentConfig = config || {};
    const win = getCurrentWebviewWindow();
    await invoke("enable_modern_window_style", {
      window: win,
      cornerRadius: config?.cornerRadius ?? 12.0,
      offsetX: config?.offsetX ?? 0.0,
      offsetY: config?.offsetY ?? 0.0,
    });
  } catch (error) {
    console.error("Failed to enable modern window style:", error);
    throw error;
  }
}

export function cleanupRoundedCorners(): void {
  currentConfig = null;
}
