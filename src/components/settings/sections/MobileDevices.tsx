import { SelectBtn, Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useDialog } from "@/stores/dialog";
import { SectionHeader } from "../_shared";

const MOBILE_DEVICE_KINDS: Array<{
  value: "iphone" | "ipad" | "android" | "mac" | "windows" | "other";
  label: string;
}> = [
  { value: "iphone", label: "iPhone" },
  { value: "ipad", label: "iPad" },
  { value: "android", label: "Android" },
  { value: "mac", label: "Mac" },
  { value: "windows", label: "Windows" },
  { value: "other", label: "其它" },
];

export function MobileDevices() {
  const p2p = useSettings((s) => s.mobileP2pEnabled);
  const devices = useSettings((s) => s.mobileDevices);
  const setPreference = useSettings((s) => s.setPreference);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);

  const addDevice = async () => {
    const name = await promptDialog({
      title: "登记新设备",
      message: "起一个易识别的名字（如「我的 iPhone」「公司 Mac」）",
      defaultValue: "新设备",
      confirmLabel: "登记",
    });
    if (!name) return;
    const id = `dev_${Date.now().toString(36)}`;
    setPreference("mobileDevices", [
      ...devices,
      { id, name, kind: "iphone", pairedAt: Date.now() },
    ]);
  };

  const removeDevice = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: "解除配对",
      message: `${name} 将不再出现在已配对列表里。`,
      confirmLabel: "解除",
      danger: true,
    });
    if (!ok) return;
    setPreference(
      "mobileDevices",
      devices.filter((d) => d.id !== id),
    );
  };

  const setKind = (id: string, kind: typeof MOBILE_DEVICE_KINDS[number]["value"]) => {
    setPreference(
      "mobileDevices",
      devices.map((d) => (d.id === id ? { ...d, kind } : d)),
    );
  };

  return (
    <>
      <SectionHeader id="mobile" />

      <div className="settings-banner">
        macOS 启用前需在 Info.plist 加 NSLocalNetworkUsageDescription；mDNS + WS
        握手后端开发中。当前可登记设备清单，握手通道上线后即可激活。
      </div>

      <div className="settings-card">
        <div className="settings-card-h">P2P 直连</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">局域网内直连</div>
            <div className="settings-help">
              通过 mDNS 自动发现局域网内的 markio 实例，传输不经云端
            </div>
          </div>
          <Toggle on={p2p} onChange={(v) => setPreference("mobileP2pEnabled", v)} />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">已配对设备 ({devices.length})</div>
        {devices.length === 0 ? (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label" style={{ color: "var(--text-3)" }}>
                还没有配对任何设备
              </div>
              <div className="settings-help">点右侧「登记」开始</div>
            </div>
            <button className="settings-btn primary" onClick={() => void addDevice()}>
              登记设备
            </button>
          </div>
        ) : (
          <>
            {devices.map((d) => (
              <div className="settings-row" key={d.id}>
                <div className="settings-row-l">
                  <div className="settings-label">{d.name}</div>
                  <div className="settings-help">
                    配对于 {new Date(d.pairedAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <SelectBtn
                    value={d.kind}
                    options={MOBILE_DEVICE_KINDS.map((k) => ({
                      value: k.value,
                      label: k.label,
                    }))}
                    onChange={(v) => setKind(d.id, v)}
                  />
                  <button
                    className="settings-btn settings-btn-danger"
                    onClick={() => void removeDevice(d.id, d.name)}
                  >
                    解除
                  </button>
                </div>
              </div>
            ))}
            <div className="settings-row" style={{ justifyContent: "flex-end" }}>
              <button className="settings-btn primary" onClick={() => void addDevice()}>
                登记设备
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
