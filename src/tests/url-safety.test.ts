import { describe, expect, it } from "vitest";
import { isLoopbackHost, validateApiBase } from "../url-safety.js";

describe("isLoopbackHost", () => {
  it("returns true for localhost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("returns true for 127.0.0.1", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("returns true for [::1]", () => {
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("returns true across 127.0.0.0/8, not just 127.0.0.1", () => {
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("127.255.255.254")).toBe(true);
  });

  it("returns true for *.localhost subdomains (RFC 6761)", () => {
    expect(isLoopbackHost("api.localhost")).toBe(true);
    expect(isLoopbackHost("a.b.localhost")).toBe(true);
  });

  it("does not treat a localhost-prefixed domain as loopback", () => {
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
    expect(isLoopbackHost(".localhost")).toBe(false);
  });

  it("does not treat a 127-prefixed domain or malformed quad as loopback", () => {
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
    expect(isLoopbackHost("127.0.0")).toBe(false);
    expect(isLoopbackHost("1127.0.0.1")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });

  it("returns false for example.com", () => {
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("returns false for 192.168.1.1", () => {
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });

  it("returns false for 10.0.0.1", () => {
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });

  it("returns false for 0.0.0.0", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("validateApiBase", () => {
  it("accepts https:// URLs unconditionally", () => {
    const result = validateApiBase("https://example.com/api");
    expect(result).toBeInstanceOf(URL);
    expect(result.href).toBe("https://example.com/api");
  });

  it("accepts https:// URL and returns parsed URL with correct properties", () => {
    const result = validateApiBase("https://api.example.com");
    expect(result.protocol).toBe("https:");
    expect(result.hostname).toBe("api.example.com");
  });

  it("accepts http://localhost", () => {
    const result = validateApiBase("http://localhost");
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe("localhost");
  });

  it("accepts http://127.0.0.1", () => {
    const result = validateApiBase("http://127.0.0.1");
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe("127.0.0.1");
  });

  it("accepts http://[::1]", () => {
    const result = validateApiBase("http://[::1]");
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe("[::1]");
  });

  it("rejects http://::1 (bare IPv6 without brackets -- invalid URL)", () => {
    // The WHATWG URL parser requires brackets for IPv6 literals.
    // http://::1 is not a valid URL and throws before the loopback check.
    expect(() => validateApiBase("http://::1")).toThrow("apiBase must be a valid URL (got: http://::1)");
  });

  it("accepts http:// to any 127.0.0.0/8 address", () => {
    expect(validateApiBase("http://127.0.0.2:8080").hostname).toBe("127.0.0.2");
    expect(validateApiBase("http://127.1.2.3").hostname).toBe("127.1.2.3");
  });

  it("accepts http:// to a *.localhost subdomain", () => {
    expect(validateApiBase("http://stub.localhost:3000").hostname).toBe("stub.localhost");
  });

  it("rejects http:// to a localhost-prefixed domain", () => {
    expect(() => validateApiBase("http://localhost.evil.com")).toThrow(
      "apiBase must use https (or http for loopback only). Got: http://localhost.evil.com",
    );
  });

  it("rejects http:// to a non-loopback host", () => {
    expect(() => validateApiBase("http://example.com")).toThrow(
      "apiBase must use https (or http for loopback only). Got: http://example.com",
    );
  });

  it("rejects http:// to a private non-loopback IP", () => {
    expect(() => validateApiBase("http://192.168.1.1")).toThrow(
      "apiBase must use https (or http for loopback only). Got: http://192.168.1.1",
    );
  });

  it("throws on an unparseable URL string", () => {
    expect(() => validateApiBase("not a url")).toThrow("apiBase must be a valid URL (got: not a url)");
  });

  it("throws on an empty string", () => {
    expect(() => validateApiBase("")).toThrow("apiBase must be a valid URL (got: )");
  });

  it("returns a URL instance with correct href on success", () => {
    const input = "https://my.server.com/base";
    const result = validateApiBase(input);
    expect(result).toBeInstanceOf(URL);
    expect(result.href).toBe(input);
    expect(result.protocol).toBe("https:");
    expect(result.hostname).toBe("my.server.com");
    expect(result.pathname).toBe("/base");
  });
});
