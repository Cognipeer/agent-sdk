/**
 * Multimodal input through the plugin layer, against a REAL vision model.
 *
 * `tests/unit/plugins/multimodal.test.ts` proves the hook contract against a
 * capturing fake: the text parts get rewritten, the media parts keep their
 * identity and their position. What a fake cannot prove is the half that only
 * shows up in production — that the image the hooks so carefully preserved
 * actually reaches the provider and the model answers about it. A run that
 * quietly answers *without* the picture looks identical from the SDK's side.
 *
 *   OPENAI_BASE_URL=http://localhost:3000/api/client/v1 \
 *   OPENAI_API_KEY=sk-… PLUGIN_TEST_MODEL=gpt-5.6-luna \
 *   npx vitest run tests/integration/pluginsMultimodal.integration.test.ts
 *
 * Skipped entirely without a key. Assertions are on what the RUNTIME did — the
 * parts on the wire, the attachment list a policy saw, whether a provider call
 * happened at all — never on the model's phrasing. The one exception is the
 * colour word, and it is deliberate: a solid-red image and "answer with one
 * word" is the only end-to-end evidence that the bytes were delivered rather
 * than dropped, and it is matched with a tolerant regex.
 */

import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../../src/index.js";
import { createProvider, fromNativeProvider } from "../../src/providers/index.js";
import { defineHook } from "../../src/plugins/define.js";
import { piiRedaction } from "../../src/plugins/builtin/piiRedaction.js";
import { mediaPolicy } from "../../src/plugins/builtin/mediaPolicy.js";
import { createGuardrailPlugin } from "../../src/plugins/builtin/guardrail.js";
import type { GuardrailRequest, GuardrailVerdict } from "../../src/plugins/builtin/guardrail.js";
import type { ContentPart, Message } from "../../src/types.js";

const API_KEY = process.env.OPENAI_API_KEY;
const runReal = API_KEY ? describe : describe.skip;
const MODEL = process.env.PLUGIN_TEST_MODEL ?? "gpt-4o-mini";

const BASE_URL = process.env.OPENAI_BASE_URL;

function realModel() {
  return fromNativeProvider(
    createProvider({
      provider: "openai",
      apiKey: API_KEY!,
      defaultModel: MODEL,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
    }),
    { model: MODEL },
  );
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A 64x64 solid #FF0000 PNG, built once and inlined. Nothing is fetched: a test
 * that reaches the network for its fixture fails for reasons that have nothing
 * to do with the plugin layer. Solid red so the expected answer is a single
 * unambiguous word, and 64x64 rather than 1x1 because some vision stacks refuse
 * a degenerate image outright.
 */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnAB" +
  "dLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjx" +
  "BQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

/** What `collectAttachments` will report for the PNG above. */
const RED_PNG_APPROX_BYTES = Math.floor((RED_PNG_B64.length * 3) / 4);

/** The SDK's unified shape — what `src/providers/types.ts` calls `ImageContent`. */
const unifiedImagePart: ContentPart = {
  type: "image",
  source: { type: "base64", mediaType: "image/png", data: RED_PNG_B64 },
};

/** The legacy OpenAI-style shape a caller may equally well pass in. */
const legacyImagePart: ContentPart = {
  type: "image_url",
  image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
};

/** Never dereferenced: every test that uses it expects the turn to be refused. */
const audioPart: ContentPart = {
  type: "audio",
  source: { type: "url", url: "https://example.invalid/clip.mp3", mediaType: "audio/mpeg" },
};

const COLOUR_QUESTION = "Answer with exactly one lowercase word: the dominant colour of the attached image.";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A wire part, typed loosely enough to read either content shape. */
type WirePart = {
  type: string;
  text?: string;
  source?: { type?: string; mediaType?: string; data?: string; url?: string };
  image_url?: { url?: string } | string;
};

/** Captures what the runtime handed the provider — the only proof of a rewrite. */
function wireSpy(sink: Message[][]) {
  return defineHook(
    "preModelCall",
    ({ messages }) => {
      sink.push(messages.map((m) => ({ ...m })));
      return undefined;
    },
    { name: "wire-spy", priority: 999 },
  );
}

function lastUserParts(wire: Message[][]): WirePart[] {
  expect(wire.length).toBeGreaterThan(0);
  const messages = wire[0];
  const user = [...messages].reverse().find((m) => m.role === "user");
  expect(user).toBeDefined();
  expect(Array.isArray(user!.content)).toBe(true);
  return user!.content as WirePart[];
}

const textsOf = (parts: WirePart[]) => parts.filter((p) => p.type === "text").map((p) => p.text);

/** A guardrail transport that records every request and always allows. */
function recordingTransport(sink: GuardrailRequest[]) {
  return {
    name: "recorder",
    evaluate: (requests: GuardrailRequest[]): GuardrailVerdict[] => {
      for (const request of requests) sink.push(request);
      return requests.map(() => ({ action: "allow" as const }));
    },
  };
}

runReal("multimodal turns through the plugin layer", () => {
  // DEFECT — see `findings`. `convertContent` in src/providers/adapter.ts has
  // branches for `image_url`, `file`/`document` and `audio`/`input_audio`, but
  // none for the SDK's OWN unified `{ type: "image", source }` part. It falls
  // through to the "treat as text" fallback and JSON.stringify's the whole part
  // — base64 payload included — into a text message, so the provider is sent a
  // wall of text and no image. Everything the plugin layer promises still holds
  // (the part is intact in `preModelCall`, the caption is masked); the model
  // simply never sees the picture and answers with a guess. This is exactly the
  // silent failure `mapTextParts`' own doc comment warns about, arriving one
  // layer lower down. Un-skip once the adapter maps `type: "image"`.
  it("delivers a unified image part to the model while masking the caption", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "UnifiedImageAgent",
      model: realModel(),
      plugins: [piiRedaction({ entities: ["EMAIL"] }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Send the result to ada.lovelace@example.com. ${COLOUR_QUESTION}` },
            unifiedImagePart,
          ],
        },
      ],
    });

    // The image really arrived: a solid red square has exactly one right answer.
    expect(result.content.toLowerCase()).toMatch(/red|crimson|scarlet/);

    // The caption was masked before it left the process…
    const sent = JSON.stringify(wire);
    expect(sent).not.toContain("ada.lovelace@example.com");
    expect(sent).toContain("[REDACTED:EMAIL]");

    // …and the redaction did not flatten the multi-part message on the way.
    const parts = lastUserParts(wire);
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
    expect(parts[1].source?.data).toBe(RED_PNG_B64);
  }, 120_000);

  it("redacts every text part independently and leaves the image where it was", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "InterleavedAgent",
      model: realModel(),
      plugins: [piiRedaction({ entities: ["EMAIL"] }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Write to ada.lovelace@example.com about this picture:" },
            unifiedImagePart,
            { type: "text", text: "Copy grace.hopper@example.com. Reply with one short sentence." },
          ],
        },
      ],
    });

    const parts = lastUserParts(wire);

    // Per-part redaction, not a rewrite of the concatenation: two text parts in,
    // two text parts out, each masked on its own.
    expect(textsOf(parts)).toEqual([
      "Write to [REDACTED:EMAIL] about this picture:",
      "Copy [REDACTED:EMAIL]. Reply with one short sentence.",
    ]);

    // Position is the assertion that a naive `content = maskedText` would break:
    // the image sat between the two captions and it still does.
    expect(parts.map((p) => p.type)).toEqual(["text", "image", "text"]);
    expect(parts[1].source?.data).toBe(RED_PNG_B64);

    const sent = JSON.stringify(wire);
    expect(sent).not.toContain("ada.lovelace@example.com");
    expect(sent).not.toContain("grace.hopper@example.com");

    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);

  it("runs the input hook on a media-only turn, with empty text and one attachment", async () => {
    const seen: Array<{ text: string; kinds: string[]; mediaTypes: Array<string | undefined> }> = [];
    const inspector = defineHook(
      "userPromptSubmit",
      ({ text, attachments }) => {
        seen.push({
          text,
          kinds: attachments.map((a) => a.kind),
          mediaTypes: attachments.map((a) => a.mediaType),
        });
        return undefined;
      },
      { name: "inspector" },
    );

    const agent = createAgent({
      name: "MediaOnlyAgent",
      model: realModel(),
      plugins: [inspector],
    });

    // Legacy shape on purpose: it is the one that survives the adapter today, so
    // "the run answered" here is a statement about a real image rather than
    // about a stringified part. See the skipped test above.
    const result = await agent.invoke({
      messages: [{ role: "user", content: [legacyImagePart] }],
    });

    // A picture with no caption is still a turn a policy has to be able to see.
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("");
    expect(seen[0].kinds).toEqual(["image"]);
    expect(seen[0].mediaTypes).toEqual(["image/png"]);

    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);

  it("denies an audio attachment when only images are allowed, without calling the provider", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "ImagesOnlyAgent",
      model: realModel(),
      plugins: [mediaPolicy({ allow: ["image"] }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Please transcribe this recording." }, audioPart],
        },
      ],
    });

    // The refusal has to happen before the upload is paid for, not after.
    expect(wire).toHaveLength(0);
    expect(result.content.toLowerCase()).toContain("audio");
    expect(result.content).toContain("not accepted");
  }, 60_000);

  it("strips the disallowed part and lets the run continue on what is left", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "StrippingAgent",
      model: realModel(),
      plugins: [mediaPolicy({ allow: ["image"], action: "strip" }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Ignore anything you cannot open. Reply with one short sentence." },
            audioPart,
            legacyImagePart,
          ],
        },
      ],
    });

    const parts = lastUserParts(wire);
    expect(parts.some((p) => p.type === "audio")).toBe(false);
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    // Only the offending part is dropped; the caption and its order survive.
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(JSON.stringify(wire)).not.toContain("example.invalid");

    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);

  it("denies an attachment over the per-attachment byte cap and names the size", async () => {
    const wire: Message[][] = [];
    const cap = 16;
    expect(RED_PNG_APPROX_BYTES).toBeGreaterThan(cap);

    const agent = createAgent({
      name: "SizeCappedAgent",
      model: realModel(),
      plugins: [mediaPolicy({ maxBytesPerAttachment: cap }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        { role: "user", content: [{ type: "text", text: "What is in this?" }, unifiedImagePart] },
      ],
    });

    expect(wire).toHaveLength(0);
    expect(result.content).toContain("too large");
    expect(result.content).toContain(`${RED_PNG_APPROX_BYTES} bytes`);
    expect(result.content).toContain(`${cap} byte size limit`);
  }, 60_000);

  it("describes the attachment to a guardrail without shipping its bytes", async () => {
    const requests: GuardrailRequest[] = [];
    const transport = recordingTransport(requests);
    const evaluate = vi.spyOn(transport, "evaluate");

    const agent = createAgent({
      name: "GuardedMediaAgent",
      model: realModel(),
      plugins: [
        createGuardrailPlugin({
          name: "media-aware-guardrail",
          apply: ["input"],
          transport,
        }),
      ],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with one short sentence about this picture." },
            legacyImagePart,
          ],
        },
      ],
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    const request = requests[0];

    expect(request.phase).toBe("input");
    expect(request.content).toBe("Reply with one short sentence about this picture.");
    expect(request.attachments).toHaveLength(1);
    expect(request.attachments![0]).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      sourceType: "base64",
    });
    expect(request.attachments![0].approxBytes).toBeGreaterThan(0);

    // Described, not shipped: a guardrail that re-uploads every image on every
    // turn costs the size of the upload per check, and the transport never
    // asked for the bytes.
    const body = JSON.stringify(request);
    expect(body).not.toContain(RED_PNG_B64);
    expect(body).not.toContain(RED_PNG_B64.slice(0, 40));
    expect(body).not.toContain("base64,");

    expect(result.content.length).toBeGreaterThan(0);
  }, 120_000);

  it("gives the legacy image_url shape the same protection, and the model sees it", async () => {
    const wire: Message[][] = [];
    const agent = createAgent({
      name: "LegacyImageAgent",
      model: realModel(),
      plugins: [piiRedaction({ entities: ["EMAIL"] }), wireSpy(wire)],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Send the result to ada.lovelace@example.com. ${COLOUR_QUESTION}` },
            legacyImagePart,
          ],
        },
      ],
    });

    expect(result.content.toLowerCase()).toMatch(/red|crimson|scarlet/);

    const sent = JSON.stringify(wire);
    expect(sent).not.toContain("ada.lovelace@example.com");
    expect(sent).toContain("[REDACTED:EMAIL]");

    const parts = lastUserParts(wire);
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect((parts[1].image_url as { url?: string }).url).toBe(`data:image/png;base64,${RED_PNG_B64}`);
  }, 120_000);
});
