import { api, isDesktop } from "@/lib/api";
import { tauriStorage } from "@/lib/tauriStorage";

const SETTINGS_KEY = "markio.settings.v1";
const RERANK_SECRET_ACCOUNT = ["rerank", ["co", "here"].join("")].join(":");

type PersistedSettings = {
  state?: Record<string, unknown>;
  version?: number;
};

export async function migrateLegacySettingSecrets(): Promise<void> {
  const raw = await tauriStorage.getItem(SETTINGS_KEY);
  if (!raw) return;

  let parsed: PersistedSettings;
  try {
    parsed = JSON.parse(raw) as PersistedSettings;
  } catch {
    return;
  }

  const state = parsed.state;
  if (!state || typeof state !== "object") return;

  const legacyRerankKey =
    typeof state.rerankApiKey === "string" ? state.rerankApiKey.trim() : "";
  if (legacyRerankKey && isDesktop()) {
    try {
      const alreadyStored = await api
        .secretHas(RERANK_SECRET_ACCOUNT)
        .catch(() => false);
      if (!alreadyStored) await api.secretSet(RERANK_SECRET_ACCOUNT, legacyRerankKey);
    } catch (e) {
      console.warn("[secretMigration] failed to migrate rerank key", e);
    }
  }

  if ("rerankApiKey" in state) {
    delete state.rerankApiKey;
    await tauriStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
  }
}
