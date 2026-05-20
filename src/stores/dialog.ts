import { create } from "zustand";

type DialogKind = "alert" | "confirm" | "prompt";

interface BaseDialog {
  kind: DialogKind;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface AlertDialog extends BaseDialog {
  kind: "alert";
  resolve: () => void;
}

interface ConfirmDialog extends BaseDialog {
  kind: "confirm";
  resolve: (value: boolean) => void;
}

interface PromptDialog extends BaseDialog {
  kind: "prompt";
  defaultValue?: string;
  placeholder?: string;
  resolve: (value: string | null) => void;
}

export type DialogRequest = AlertDialog | ConfirmDialog | PromptDialog;

type AlertOptions = Omit<BaseDialog, "kind">;
type ConfirmOptions = Omit<BaseDialog, "kind">;
type PromptOptions = Omit<BaseDialog, "kind"> & {
  defaultValue?: string;
  placeholder?: string;
};

interface DialogState {
  request: DialogRequest | null;
  alert: (options: AlertOptions) => Promise<void>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  settle: (value?: string | boolean | null) => void;
}

export const useDialog = create<DialogState>((set, get) => ({
  request: null,
  alert: (options) =>
    new Promise<void>((resolve) => {
      set({
        request: {
          kind: "alert",
          confirmLabel: "知道了",
          ...options,
          resolve,
        },
      });
    }),
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      set({
        request: {
          kind: "confirm",
          confirmLabel: "确认",
          cancelLabel: "取消",
          ...options,
          resolve,
        },
      });
    }),
  prompt: (options) =>
    new Promise<string | null>((resolve) => {
      set({
        request: {
          kind: "prompt",
          confirmLabel: "确认",
          cancelLabel: "取消",
          ...options,
          resolve,
        },
      });
    }),
  settle: (value) => {
    const req = get().request;
    if (!req) return;
    set({ request: null });
    if (req.kind === "alert") {
      req.resolve();
    } else if (req.kind === "confirm") {
      req.resolve(Boolean(value));
    } else {
      req.resolve(typeof value === "string" ? value : null);
    }
  },
}));
