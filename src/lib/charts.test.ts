import { describe, expect, it } from "vitest";
import { parseChartSource } from "./charts";

describe("chart fenced block parser", () => {
  it("parses json bar chart config", () => {
    const chart = parseChartSource(`{
      "type": "bar",
      "title": "收入",
      "labels": ["一月", "二月"],
      "series": [
        { "name": "收入", "data": [12, 18] },
        { "name": "成本", "data": [8, 11] }
      ]
    }`);
    expect(chart.type).toBe("bar");
    expect(chart.labels).toEqual(["一月", "二月"]);
    expect(chart.series).toHaveLength(2);
    expect(chart.series[1]!.data).toEqual([8, 11]);
  });

  it("parses loose series syntax", () => {
    const chart = parseChartSource(`
type: line
title: 趋势
labels: Jan, Feb, Mar
series:
  收入: 12, 18, 21
  成本: 8, 10, 13
`);
    expect(chart.type).toBe("line");
    expect(chart.title).toBe("趋势");
    expect(chart.series.map((item) => item.name)).toEqual(["收入", "成本"]);
  });

  it("normalizes object data into pie slices", () => {
    const chart = parseChartSource(`{
      "type": "pie",
      "data": { "桌面": 42, "移动": 58 }
    }`);
    expect(chart.type).toBe("pie");
    expect(chart.labels).toEqual(["桌面", "移动"]);
    expect(chart.series[0]!.data).toEqual([42, 58]);
  });

  it("accepts area and scatter as cartesian types", () => {
    for (const type of ["area", "scatter"]) {
      const chart = parseChartSource(`{
        "type": "${type}",
        "labels": ["A", "B", "C"],
        "series": [{ "name": "v", "data": [1, 2, 3] }]
      }`);
      expect(chart.type).toBe(type);
      expect(chart.series[0]!.data).toEqual([1, 2, 3]);
    }
  });

  it("treats donut like pie (positive slices)", () => {
    const chart = parseChartSource(`{
      "type": "donut",
      "labels": ["a", "b"],
      "values": [3, 1]
    }`);
    expect(chart.type).toBe("donut");
    expect(chart.labels).toEqual(["a", "b"]);
    expect(chart.series[0]!.data).toEqual([3, 1]);
  });

  it("rejects unknown chart types", () => {
    expect(() => parseChartSource('{ "type": "radar", "values": [1] }')).toThrow();
  });
});
