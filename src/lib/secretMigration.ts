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

  let mutated = false;

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
    mutated = true;
  }

  // P2P 对端金库 token：旧版本明文存在 mobileDevices[].token（落 store.bin），
  // 迁移进 OS 钥匙串后从持久化里剥掉。迁移失败则保留明文，避免丢失已配对设备。
  if (isDesktop() && Array.isArray(state.mobileDevices)) {
    for (const dev of state.mobileDevices as Array<Record<string, unknown>>) {
      const token = typeof dev.token === "string" ? dev.token.trim() : "";
      if (!token) continue;
      const peerId = typeof dev.peerId === "string" ? dev.peerId : "";
      if (!peerId) {
        // 无 peerId 的孤立 token：无法迁移也无用途，直接剥离。
        delete dev.token;
        mutated = true;
        continue;
      }
      try {
        await api.p2pTokenSet(peerId, token);
        delete dev.token;
        mutated = true;
      } catch (e) {
        console.warn("[secretMigration] failed to migrate p2p token", e);
      }
    }
  }

  if (mutated) {
    await tauriStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
  }
}
