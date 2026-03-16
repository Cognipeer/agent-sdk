# Vision

This example shows the message shape for multimodal input with an image URL and a text prompt.

<div class="example-meta"><a class="example-source-link" href="https://github.com/Cognipeer/agent-sdk/blob/main/examples/vision/vision.ts" target="_blank" rel="noreferrer">Open source: examples/vision/vision.ts</a></div>

## Use this when

- your model supports image input
- you want to understand multimodal message format before putting it behind a full agent
- you need the smallest possible vision example

## What it shows

- image content in the message payload
- a model adapter capable of multimodal reasoning
- final output returned through the normal invoke flow

## Run it

```bash
cd examples
npm run example:vision
```

## Core code

```ts
const message = {
	role: "user",
	content: [
		{ type: "text", text: "What does this image contain?" },
		{
			type: "image_url",
			image_url: "https://fastly.picsum.photos/id/237/200/300.jpg?hmac=TmmQSbShHz9CdQm0NkEjx1Dyh_Y984R9LpNrpvH2D_U",
		},
	],
} as const;

const response = await model.invoke([message as any]);
```

## End-to-end flow

1. A multimodal-capable model is adapted.
2. The user message combines text and an `image_url` block.
3. The model receives the structured content array.
4. The response is returned through the same adapter contract as text-only calls.

## Why it matters

Vision support is not a separate framework path. It is the same agent runtime with a model that can understand image-bearing messages.

## How it works

The example talks directly to the adapted model instead of a full agent because the focus is multimodal message shape. Once that shape works, you can use the same content structure inside normal agent invocations.

## Production takeaway

Get the message shape right first. After that, vision can be layered into normal agent workflows without inventing a new runtime model.

## Expected output

- the model returns a short description of the image content
- the response arrives through the same adapter contract as text-only usage

## Common failure modes

- `OPENAI_API_KEY` is missing, so the script exits immediately
- the selected provider model does not support image inputs
- the image URL is inaccessible or blocked, leading to a degraded response
