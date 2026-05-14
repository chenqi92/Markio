import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN.json";
import en from "./en.json";

export type Locale = "zh-CN" | "en";

function pickDefault(): Locale {
  const stored = (typeof localStorage !== "undefined"
    ? localStorage.getItem("markio.locale")
    : null) as Locale | null;
  if (stored === "zh-CN" || stored === "en") return stored;
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

export function setLocale(loc: Locale) {
  localStorage.setItem("markio.locale", loc);
  void i18next.changeLanguage(loc);
}

export function currentLocale(): Locale {
  return (i18next.language as Locale) || "zh-CN";
}
