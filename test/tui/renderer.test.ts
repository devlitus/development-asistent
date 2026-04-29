/**
 * Tests for TuiRenderer — DX-01 + DX-02
 */

import { describe, it, expect } from "bun:test";
import { TuiRenderer } from "../../scripts/tui/renderer.ts";
import type { Writer } from "../../scripts/tui/renderer.ts";

function makeWriter() {
  const chunks: string[] = [];
  const writer: Writer = {
    write(s: string) { chunks.push(s); },
  };
  const getOutput = () => chunks.join("");
  return { writer, getOutput };
}

describe("TuiRenderer.renderRoutingInfo", () => {
  it("should render the agent name in output", () => {
    const { writer, getOutput } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.renderRoutingInfo("code-agent");

    expect(getOutput()).toContain("code-agent");
  });

  it("should end with a newline", () => {
    const { writer, getOutput } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.renderRoutingInfo("code-agent");

    expect(getOutput().endsWith("\n")).toBe(true);
  });

  it("should contain the → arrow indicator", () => {
    const { writer, getOutput } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.renderRoutingInfo("git-agent");

    expect(getOutput()).toContain("→");
  });

  it("should sanitize dangerous ANSI sequences in agent name", () => {
    const { writer, getOutput } = makeWriter();
    const renderer = new TuiRenderer(writer);

    // OSC sequence that should be stripped
    renderer.renderRoutingInfo("agent\x1b]0;evil\x07name");

    expect(getOutput()).toContain("agentname");
    expect(getOutput()).not.toContain("\x1b]0;evil\x07");
  });
});
