/**
 * Opt-in end-to-end check against a real OpenTelemetry Collector.
 *
 *   OTLP_COLLECTOR_E2E=1 npx vitest run tests/e2e/otlpCollector.e2e.test.ts
 *
 * Needs Docker. It starts ONE container with a unique name on a random loopback
 * port (the Docker daemon may be shared: nothing else is touched), runs a
 * scripted agent (a tool, a sub-agent, a pause and a resume) over each protocol
 * with gzip off and on, reads what the collector's debug exporter printed, and
 * removes the container. Override the image with OTLP_COLLECTOR_IMAGE.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createSmartAgent, createTool, otlpSink } from "../../src/index.js";
import { captureSnapshot, restoreSnapshot } from "../../src/utils/stateSnapshot.js";
import type { Message, SubagentDef } from "../../src/types.js";

const ENABLED = process.env.OTLP_COLLECTOR_E2E === "1";
const IMAGE = process.env.OTLP_COLLECTOR_IMAGE ?? "otel/opentelemetry-collector:0.130.0";
const NAME = `agent-sdk-otlp-e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** The container's output; the collector logs to stderr. */
const containerLogs = () => {
  const out = spawnSync("docker", ["logs", NAME], { encoding: "utf8" });
  return `${out.stdout}\n${out.stderr}`;
};

const CONFIG = `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function scripted(name: string, script: Array<Partial<Message> & { usage?: unknown }>) {
  let turn = 0;
  const model: any = {
    modelName: name,
    bindTools() { return model; },
    async invoke() {
      const step = script[Math.min(turn++, script.length - 1)];
      return { role: "assistant", content: "", ...step };
    },
  };
  return model;
}
const echo = () => createTool({ name: "echo", description: "echoes", schema: z.object({}), func: async () => "echoed" });
const dangerous = () => createTool({ name: "dangerous", description: "needs approval", schema: z.object({}), needsApproval: true, func: async () => "executed" });

let port = 0;
let workDir = "";

async function runScenario(service: string, protocol: "http/json" | "http/protobuf", compression: "none" | "gzip") {
  const def: SubagentDef = {
    name: "helper", header: "h",
    model: scripted("child", [{ tool_calls: [call("c1", "dangerous")] }, { content: "child-final" }]),
    tools: [dangerous()],
  };
  const agent = createSmartAgent({
    name: service,
    model: scripted("parent", [
      { tool_calls: [call("p0", "echo")], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
      { tool_calls: [call("p1", "delegate_to", { subagent: "helper", input: "go" })] },
      { content: "parent-final", usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
    ]),
    tools: [echo()],
    subagents: [def],
    summarization: false,
    tracing: {
      enabled: true,
      sink: otlpSink({ endpoint: `http://127.0.0.1:${port}/v1/traces`, protocol, compression, serviceName: service }),
    },
  } as any);
  const paused: any = await agent.invoke({ messages: [{ role: "user", content: "go" }] } as any);
  const state = restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(paused.state)))) as any;
  const pending = state.pendingApprovals.find((x: any) => x.status === "pending");
  await agent.invoke(agent.resolveToolApproval(state, { id: pending.id, approved: true, decidedBy: "e2e" }) as any);
}

/** The debug exporter's text for the spans of one service. */
function spansFor(logs: string, service: string): string[] {
  const blocks = logs.split(/(?=ResourceSpans #)/).filter((block) => block.includes(`-> service.name: Str(${service})`));
  return blocks.flatMap((block) => block.split(/(?=^Span #\d+$)/m).filter((part) => part.startsWith("Span #")));
}

describe.skipIf(!ENABLED)("OTLP against a real collector", () => {
  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-e2e-"));
    const configPath = path.join(workDir, "config.yaml");
    fs.writeFileSync(configPath, CONFIG);
    docker("run", "-d", "--name", NAME, "-p", "127.0.0.1::4318", "-v", `${configPath}:/etc/otelcol/config.yaml:ro`, IMAGE, "--config=/etc/otelcol/config.yaml");
    const mapped = docker("port", NAME, "4318/tcp").trim().split("\n")[0];
    port = Number(mapped.slice(mapped.lastIndexOf(":") + 1));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (response.status > 0) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`collector did not start:\n${containerLogs()}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, 120_000);

  afterAll(() => {
    try {
      docker("rm", "-f", NAME);
    } catch {
      // already gone
    }
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("accepts both protocols, with and without gzip, and prints the same spans", async () => {
    const matrix: Array<["http/json" | "http/protobuf", "none" | "gzip"]> = [
      ["http/json", "none"], ["http/json", "gzip"], ["http/protobuf", "none"], ["http/protobuf", "gzip"],
    ];
    const services = matrix.map(([protocol, compression], i) => `e2e-${protocol.split("/")[1]}-${compression}-${i}`);
    for (let i = 0; i < matrix.length; i++) await runScenario(services[i], matrix[i][0], matrix[i][1]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const logs = containerLogs();

    const shapes = services.map((service) => {
      const spans = spansFor(logs, service);
      expect(spans.length, service).toBeGreaterThan(8);
      const text = spans.join("\n");
      expect(text, service).toMatch(/Name\s+: invoke_agent /);
      expect(text, service).toMatch(/Name\s+: chat /);
      expect(text, service).toMatch(/Name\s+: execute_tool /);
      expect(text, service).toContain("gen_ai.operation.name: Str(chat)");
      expect(text, service).toContain("gen_ai.usage.input_tokens: Int(");
      expect(text, service).toMatch(/Status code\s+: Unset/);
      // One root (no parent) and no span id twice across the two legs.
      const nameOf = (span: string) => /Name\s+: (.*)/.exec(span)?.[1];
      const roots = spans.filter((span) => /Parent ID\s+: *\n/.test(span));
      expect(roots.map(nameOf), service).toEqual([`invoke_agent ${service}`]);
      const ids = spans.map((span) => /\n\s+ID\s+: (\w+)/.exec(span)?.[1]);
      expect(new Set(ids).size, service).toBe(ids.length);
      // The sub-agent is one span, not two.
      expect(spans.filter((span) => nameOf(span) === "invoke_agent helper"), service).toHaveLength(1);
      return spans.map((span) => nameOf(span)?.replace(service, "<agent>")).sort();
    });
    for (const shape of shapes.slice(1)) expect(shape).toEqual(shapes[0]);
  }, 120_000);
});
