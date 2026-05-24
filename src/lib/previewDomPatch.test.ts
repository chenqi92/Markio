// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { patchPreviewDom } from "./previewDomPatch";

describe("patchPreviewDom", () => {
  it("preserves unchanged preceding visual nodes when appending content below", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<p data-line=\"1\">intro</p>",
      "<div class=\"chart-block chart-rendered\" data-chart=\"same\" data-rendered=\"1\" data-line=\"3\"><figure>chart</figure></div>",
    ].join("");
    const chart = root.querySelector(".chart-block");

    patchPreviewDom(
      root,
      [
        "<p data-line=\"1\">intro</p>",
        "<div class=\"chart-block chart-rendered\" data-chart=\"same\" data-rendered=\"1\" data-line=\"3\"><figure>chart</figure></div>",
        "<p data-line=\"8\">new text</p>",
      ].join(""),
    );

    expect(root.querySelector(".chart-block")).toBe(chart);
    expect(root.textContent).toContain("new text");
  });

  it("treats decorated table hosts as equivalent to raw tables", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="md-table-host" data-md-table-index="0"><table data-md-table-index="0" data-line="2"><tbody><tr><td>a</td></tr></tbody></table><button class="md-table-add">+</button></div>';
    const host = root.firstElementChild;

    patchPreviewDom(
      root,
      '<table data-line="3"><tbody><tr><td>a</td></tr></tbody></table><p>after</p>',
    );

    expect(root.firstElementChild).toBe(host);
    expect(root.querySelector("table")?.getAttribute("data-line")).toBe("3");
    expect(root.textContent).toContain("after");
  });
});
