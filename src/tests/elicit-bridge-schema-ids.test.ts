// The upstream elicitation bridge against the REAL Server.elicitInput, not a
// mock: a ConnectServer serving the 2025-11-25 era over a linked
// InMemoryTransport, and a v2 client that accepts every form.
//
// @modelcontextprotocol/server 2.4.0's bundled Ajv (fast-uri 3.1.8) refuses to
// compile a schema whose $id has no valid URI scheme (`my_form:v1`), and
// Server.elicitInput compiles the forwarded requestedSchema to check an
// accepted answer. server.test.ts proves withoutSchemaIds strips the $id and
// that the stripped schema compiles; this file proves the bridge actually
// routes through it and that the SDK still validates where the helper
// assumes, so an SDK that moves or drops that validation fails here.

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectServer } from "../server.js";

let savedPrewarm: string | undefined;
let savedPersist: string | undefined;
const live: Array<() => Promise<void>> = [];

beforeEach(() => {
  savedPrewarm = process.env.YAW_MCP_PREWARM;
  savedPersist = process.env.YAW_MCP_DISABLE_PERSISTENCE;
  process.env.YAW_MCP_PREWARM = "0";
  process.env.YAW_MCP_DISABLE_PERSISTENCE = "1";
});

afterEach(async () => {
  for (const close of live.splice(0)) await close();
  if (savedPrewarm === undefined) delete process.env.YAW_MCP_PREWARM;
  else process.env.YAW_MCP_PREWARM = savedPrewarm;
  if (savedPersist === undefined) delete process.env.YAW_MCP_DISABLE_PERSISTENCE;
  else process.env.YAW_MCP_DISABLE_PERSISTENCE = savedPersist;
});

/** A legacy-era session whose client accepts every form with `content`. */
async function legacySession(content: Record<string, unknown>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new ConnectServer();
  const priv = server as any;
  priv.config = { servers: [], configVersion: "v1" };
  priv.stdioHandle = await priv.serve(serverSide);
  const client = new Client(
    { name: "elicit-bridge-schema-ids-test", version: "0.0.0" },
    { capabilities: { elicitation: { form: {} } } as never },
  );
  const asked: Array<Record<string, unknown>> = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    asked.push(request.params as unknown as Record<string, unknown>);
    return { action: "accept", content } as never;
  });
  await client.connect(clientSide);
  live.push(async () => {
    await client.close().catch(() => {});
    await server.shutdown();
  });
  return { priv, asked };
}

describe("upstream elicitation bridge vs the SDK's schema check", () => {
  it("serves the 2025 era, where the bridge forwards elicitation", async () => {
    const { priv } = await legacySession({});
    expect(priv.servedEra).toBe("legacy");
  });

  it("returns the user's accepted answer for a child schema with a colon $id", async () => {
    const { priv, asked } = await legacySession({ a: "x", tags: ["b"] });
    const params = {
      message: "Fill the form",
      requestedSchema: {
        $id: "my_form:v1",
        type: "object",
        properties: {
          a: { $id: "my_form:a", type: "string" },
          tags: { type: "array", items: { $id: "my_tag:item", type: "string", enum: ["a", "b"] } },
        },
        required: ["a"],
      },
    };
    const result = await priv.clientBridge.elicitInput(params, {});
    expect(result).toEqual({ action: "accept", content: { a: "x", tags: ["b"] } });
    // The client was sent the stripped schema -- root, field and items.
    expect(asked[0].requestedSchema).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
      required: ["a"],
    });
    // The child's own params object is not mutated.
    expect(params.requestedSchema.$id).toBe("my_form:v1");
    expect(params.requestedSchema.properties.a.$id).toBe("my_form:a");
    expect(params.requestedSchema.properties.tags.items.$id).toBe("my_tag:item");
  });

  it("still rejects an accepted answer that does not match the schema", async () => {
    // The SDK's own check survives the strip: dropping $id must not turn the
    // validation off.
    const { priv } = await legacySession({ a: 42 });
    await expect(
      priv.clientBridge.elicitInput(
        {
          message: "Fill the form",
          requestedSchema: { $id: "my_form:v1", type: "object", properties: { a: { type: "string" } } },
        },
        {},
      ),
    ).rejects.toThrow(/does not match requested schema/);
  });
});
