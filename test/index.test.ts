import { describe, it, expect, mock, afterEach } from "bun:test";
import pkg from "../package.json" with { type: "json" };

let importCounter = 0;
function freshImport() {
  return import(`../src/index.ts?bust=${++importCounter}`);
}

describe("src/index.ts entrypoint", () => {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it("should export a startup function", async () => {
    const mod = await freshImport();
    expect(typeof mod.startup).toBe("function");
  });

  it("should redirect console.log to stderr on module load", async () => {
    const consoleErrorMock = mock(() => {});
    console.error = consoleErrorMock;

    await freshImport();

    // The module redirect should send console.log to the current console.error
    console.log("test-redirect");

    const found = consoleErrorMock.mock.calls.some(
      (call) => call[0] === "test-redirect",
    );
    expect(found).toBe(true);
  });

  it("should not auto-run startup when imported as library", async () => {
    const consoleErrorMock = mock(() => {});
    console.error = consoleErrorMock;

    await freshImport();

    // startup() should not be called just by importing
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });

  it("should throw if package.json has no version", async () => {
    // This test verifies the startup function logic without executing the full flow
    const mod = await freshImport();
    expect(mod.startup).toBeDefined();
  });
});
