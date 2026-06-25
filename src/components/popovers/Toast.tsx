import { useUI } from "@/stores/ui";

export function ToastHost() {
  const toast = useUI((s) => s.toast);
  if (!toast) return null;
  const isError = toast.stage === "error";
  return (
    <div
      className="upload-toast"
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      style={
        isError
          ? {
              borderColor: "var(--danger, #c1432f)",
              color: "var(--danger, #c1432f)",
            }
          : undefined
      }
    >
      {isError && (
        <span
          style={{
            display: "inline-flex",
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--danger, #c1432f)",
            color: "white",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 700,
            flexShrink: 0,
          }}
          aria-hidden
        >
          !
        </span>
      )}
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
