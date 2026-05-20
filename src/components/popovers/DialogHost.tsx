import { useEffect, useState } from "react";
import { useDialog } from "@/stores/dialog";
import { classNames } from "@/lib/utils";

export function DialogHost() {
  const request = useDialog((s) => s.request);
  const settle = useDialog((s) => s.settle);
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(request?.kind === "prompt" ? request.defaultValue ?? "" : "");
  }, [request]);

  if (!request) return null;

  const isPrompt = request.kind === "prompt";
  const close = () => settle(isPrompt ? null : false);
  const submit = () => settle(isPrompt ? value.trim() : true);

  return (
    <div className="dialog-scrim" role="presentation" onClick={close}>
      <div
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !isPrompt)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="app-dialog-title" id="app-dialog-title">
          {request.title}
        </div>
        {request.message && <div className="app-dialog-message">{request.message}</div>}
        {isPrompt && (
          <input
            autoFocus
            className="app-dialog-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        )}
        <div className="app-dialog-actions">
          {request.kind !== "alert" && (
            <button type="button" className="app-dialog-btn" onClick={close}>
              {request.cancelLabel ?? "取消"}
            </button>
          )}
          <button
            type="button"
            className={classNames("app-dialog-btn", "primary", request.danger && "danger")}
            onClick={submit}
          >
            {request.confirmLabel ?? "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
