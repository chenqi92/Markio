import { beforeEach, describe, expect, it } from "vitest";
import { useAISessions } from "./aiSessions";

beforeEach(() => {
  useAISessions.setState({ sessions: [], activeId: null });
});

describe("aiSessions store", () => {
  it("creates a session and sets it active", () => {
    const id = useAISessions.getState().createSession("ws1", "ask");
    const st = useAISessions.getState();
    expect(st.activeId).toBe(id);
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].mode).toBe("ask");
  });

  it("appends messages and updates title from first user message", () => {
    const id = useAISessions.getState().createSession("ws1", "ask");
    useAISessions.getState().appendMessage(id, {
      id: "m1",
      role: "user",
      text: "How do I run tests?",
      time: 100,
    });
    const s = useAISessions.getState().sessions[0];
    expect(s.messages).toHaveLength(1);
    expect(s.title).toContain("How do I run tests");
  });

  it("appendChunk concatenates streaming deltas", () => {
    const id = useAISessions.getState().createSession("ws1", "ask");
    useAISessions.getState().appendMessage(id, {
      id: "a1",
      role: "assistant",
      text: "",
      time: 100,
    });
    useAISessions.getState().appendChunk(id, "a1", "Hello ");
    useAISessions.getState().appendChunk(id, "a1", "world");
    const msg = useAISessions.getState().sessions[0].messages[0];
    expect(msg.text).toBe("Hello world");
  });

  it("patchMessage replaces partial fields", () => {
    const id = useAISessions.getState().createSession("ws1", "ask");
    useAISessions.getState().appendMessage(id, {
      id: "a1",
      role: "assistant",
      text: "draft",
      time: 100,
    });
    useAISessions.getState().patchMessage(id, "a1", { text: "final" });
    const msg = useAISessions.getState().sessions[0].messages[0];
    expect(msg.text).toBe("final");
    expect(msg.role).toBe("assistant");
  });
});
