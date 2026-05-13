import { useUI } from "@/stores/ui";

export function ToastHost() {
  const toast = useUI((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="upload-toast">
      {toast.stage === "uploading" && (
        <span
          style={{
            width: 14,
            height: 14,
            border: "2px solid var(--border-strong)",
            borderTopColor: "var(--accent)",
            borderRadius: "50%",
            animation: "spin 1s linear infinite",
            display: "inline-block",
          }}
        />
      )}
      {toast.stage === "done" && (
        <span
          style={{
            display: "inline-flex",
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--accent)",
            color: "white",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
          }}
        >
          ✓
        </span>
      )}
      <span>{toast.message}</span>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
