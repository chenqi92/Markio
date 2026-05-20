import { beforeEach, describe, expect, it } from "vitest";
import { useUI } from "./ui";

beforeEach(() => {
  useUI.setState({
    findQuery: "",
    findIndex: 0,
    findCaseSensitive: false,
    findWholeWord: false,
    findRegex: false,
    lineJump: null,
  });
});

describe("ui store find state", () => {
  it("resets find index when query or options change", () => {
    useUI.getState().setFindIndex(4);
    useUI.getState().setFindQuery("alpha");
    expect(useUI.getState().findIndex).toBe(0);

    useUI.getState().setFindIndex(3);
    useUI.getState().setFindOptions({ findRegex: true });
    const state = useUI.getState();
    expect(state.findRegex).toBe(true);
    expect(state.findIndex).toBe(0);
  });

  it("tracks and clears pending line jumps by nonce", () => {
    useUI.getState().jumpToLine("/repo/a.md", 12);
    const jump = useUI.getState().lineJump;
    expect(jump).toMatchObject({ path: "/repo/a.md", line: 12 });

    useUI.getState().clearLineJump((jump?.nonce ?? 0) + 1);
    expect(useUI.getState().lineJump).toBe(jump);

    useUI.getState().clearLineJump(jump?.nonce);
    expect(useUI.getState().lineJump).toBeNull();
  });
});
