// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  hydrateMarkdownTaskCheckboxes,
  markdownTaskLines,
  toggleMarkdownTaskLine,
} from "./markdownTasks";

describe("markdown task helpers", () => {
  it("finds task lines and checked state", () => {
    expect(markdownTaskLines("# A\n- [ ] one\n  * [x] two\ntext")).toEqual([
      { line: 2, checked: false },
      { line: 3, checked: true },
    ]);
  });

  it("toggles only the requested task line", () => {
    expect(toggleMarkdownTaskLine("- [ ] one\n- [x] two", 2)).toBe(
      "- [ ] one\n- [ ] two",
    );
    expect(toggleMarkdownTaskLine("plain", 1)).toBeNull();
  });

  it("hydrates rendered task checkboxes as enabled source-backed controls", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<ul><li><input disabled type="checkbox"> one</li><li><input disabled checked type="checkbox"> two</li></ul>';

    expect(hydrateMarkdownTaskCheckboxes(root, "- [ ] one\n- [x] two")).toBe(2);

    const boxes = root.querySelectorAll<HTMLInputElement>("input");
    expect(boxes[0].disabled).toBe(false);
    expect(boxes[0].hasAttribute("disabled")).toBe(false);
    expect(boxes[0].dataset.sourceLine).toBe("1");
    expect(boxes[0].checked).toBe(false);
    expect(boxes[0].classList.contains("md-task-checkbox")).toBe(true);
    expect(boxes[1].dataset.sourceLine).toBe("2");
    expect(boxes[1].checked).toBe(true);
  });
});
