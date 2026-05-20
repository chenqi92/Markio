import { beforeEach, describe, expect, it } from "vitest";
import { useDialog } from "./dialog";

beforeEach(() => {
  useDialog.setState({ request: null });
});

describe("dialog store", () => {
  it("resolves confirm requests", async () => {
    const promise = useDialog.getState().confirm({ title: "Delete?" });

    expect(useDialog.getState().request?.kind).toBe("confirm");
    useDialog.getState().settle(true);

    await expect(promise).resolves.toBe(true);
    expect(useDialog.getState().request).toBeNull();
  });

  it("resolves prompt cancel as null", async () => {
    const promise = useDialog.getState().prompt({ title: "Name" });

    expect(useDialog.getState().request?.kind).toBe("prompt");
    useDialog.getState().settle(null);

    await expect(promise).resolves.toBeNull();
  });
});
