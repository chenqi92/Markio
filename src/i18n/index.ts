import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN.json";
import en from "./en.json";

export type Locale = "zh-CN" | "en";

function pickDefault(): Locale {
  // 仅作为 i18next 初始化时的临时默认；rehydrate 完成后 main.tsx 会从 settings store 同步真实值
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem("markio.locale");
    if (stored === "zh-CN" || stored === "en") return stored;
  }
  if (typeof navigator !== "undefined") {
    const lang = navigator.language || "";
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN";
  }
  return "en";
}

void i18next.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: pickDefault(),
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

/** 切换 i18next 当前语言；持久化由 settings store 负责（不再写 localStorage）。 */
export function setLocale(loc: Locale) {
  void i18next.changeLanguage(loc);
}

export function currentLocale(): Locale {
  return (i18next.language as Locale) || "zh-CN";
}
