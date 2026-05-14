import { create } from "zustand";
import { api, isDesktop } from "@/lib/api";

export interface CustomThemeMeta {
  id: string;
  name: string;
  path: string;
  size: number;
}

interface State {
  list: CustomThemeMeta[];
  /** 当前已应用的自定义主题 id（null 表示未应用） */
  activeId: string | null;
  /** 已注入的 <style> 节点的 css 来源 id（避免重复 inject） */
  injectedFor: string | null;
  refresh: () => Promise<void>;
  importFrom: (sourcePath: string) => Promise<CustomThemeMeta>;
  remove: (id: string) => Promise<void>;
  apply: (id: string | null) => Promise<void>;
}

const STYLE_TAG_ID = "markio-custom-theme";

function setInjectedCss(id: string | null, css: string | null) {
  const head = document.head;
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!css) {
    if (tag) tag.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement("style");
    tag.id = STYLE_TAG_ID;
    head.appendChild(tag);
  }
  tag.dataset.themeId = id ?? "";
  tag.textContent = css;
}

export const useCustomThemes = create<State>((set, get) => ({
  list: [],
  activeId: null,
  injectedFor: null,
  refresh: async () => {
    if (!isDesktop()) return;
    try {
      const list = await api.themeList();
      set({ list });
    } catch {
      /* ignore */
    }
  },
  importFrom: async (sourcePath) => {
    const meta = await api.themeImport(sourcePath);
    await get().refresh();
    return meta;
  },
  remove: async (id) => {
    await api.themeDelete(id);
    if (get().activeId === id) {
      setInjectedCss(null, null);
      set({ activeId: null, injectedFor: null });
    }
    await get().refresh();
  },
  apply: async (id) => {
    if (id === null) {
      setInjectedCss(null, null);
      set({ activeId: null, injectedFor: null });
      return;
    }
    if (get().injectedFor === id) {
      set({ activeId: id });
      return;
    }
    try {
      const css = await api.themeRead(id);
      setInjectedCss(id, css);
      set({ activeId: id, injectedFor: id });
    } catch {
      setInjectedCss(null, null);
      set({ activeId: null, injectedFor: null });
    }
  },
}));
