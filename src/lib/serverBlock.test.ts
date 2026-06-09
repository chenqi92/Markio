import { describe, expect, it } from "vitest";
import { parseServerSource } from "./serverBlock";

describe("server fenced block parser", () => {
  it("parses a single entry with canonical fields", () => {
    const [entry] = parseServerSource(
      [
        "name: 生产数据库",
        "type: MySQL",
        "host: 192.168.1.10",
        "port: 3306",
        "user: root",
        "password: s3cr3t",
        "note: 仅内网",
      ].join("\n"),
    );
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("生产数据库");
    expect(entry!.type).toBe("mysql");
    const kinds = entry!.fields.map((f) => f.kind);
    expect(kinds).toEqual(["host", "port", "user", "password", "note"]);
    expect(entry!.fields.find((f) => f.kind === "password")!.value).toBe("s3cr3t");
  });

  it("recognizes chinese and aliased keys", () => {
    const [entry] = parseServerSource(
      ["名称: 服务器A", "内网: 10.0.0.5", "账号: admin", "密码: pwd", "网址: https://a.test"].join(
        "\n",
      ),
    );
    expect(entry!.name).toBe("服务器A");
    const byKind = Object.fromEntries(entry!.fields.map((f) => [f.kind, f.value]));
    expect(byKind.lan).toBe("10.0.0.5");
    expect(byKind.user).toBe("admin");
    expect(byKind.password).toBe("pwd");
    expect(byKind.url).toBe("https://a.test");
  });

  it("keeps colons inside values (urls)", () => {
    const [entry] = parseServerSource("url: https://admin.example.com:8443/login");
    expect(entry!.fields[0]!.value).toBe("https://admin.example.com:8443/login");
  });

  it("splits multiple entries on --- separators", () => {
    const entries = parseServerSource(
      ["name: A", "host: 1.1.1.1", "---", "name: B", "host: 2.2.2.2"].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe("A");
    expect(entries[1]!.name).toBe("B");
  });

  it("treats a leading colon-less line as the name", () => {
    const [entry] = parseServerSource(["我的服务器", "host: 9.9.9.9"].join("\n"));
    expect(entry!.name).toBe("我的服务器");
    expect(entry!.fields[0]!.kind).toBe("host");
  });

  it("keeps unknown keys as generic text fields", () => {
    const [entry] = parseServerSource("机房: 北京-A区");
    expect(entry!.fields[0]!.kind).toBe("text");
    expect(entry!.fields[0]!.label).toBe("机房");
    expect(entry!.fields[0]!.value).toBe("北京-A区");
  });

  it("ignores comments and blank lines", () => {
    const entries = parseServerSource(["# 注释", "// also", "", "host: 5.5.5.5"].join("\n"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fields).toHaveLength(1);
  });
});
