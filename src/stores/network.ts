/**
 * 网络状态。监听 window 的 online / offline 事件 + 初始 navigator.onLine。
 * 不持久化（每次启动重新探测）。
 *
 * 注意：navigator.onLine 在桌面 WebView 里相对可靠（系统认为没网就 false）；
 * 但 false positive 可能（连了 WiFi 实际没出口）。所以这里只做"显然离线"提示，
 * 不靠它做关键决策——同步 / AI 请求该发还得发，由服务器返回错误兜底。
 */
import { create } from "zustand";

interface NetworkState {
  online: boolean;
  setOnline: (v: boolean) => void;
}

export const useNetwork = create<NetworkState>((set) => ({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  setOnline: (online) => set({ online }),
}));

/** 在 App 顶层装一次。返回 cleanup。 */
export function installNetworkListeners() {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => useNetwork.getState().setOnline(true);
  const onOffline = () => useNetwork.getState().setOnline(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
