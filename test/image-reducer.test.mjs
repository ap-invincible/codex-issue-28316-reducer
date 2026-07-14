import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createImageReducerServer, ImageLru, imageMarker, parseDataImage, transformResponseBody } from "../bin/image-reducer.mjs";

const png = "data:image/png;base64,aGVsbG8=";
const pdf = "data:application/pdf;base64,aGVsbG8=";

function request(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const serialized = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": serialized.length, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(serialized);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("preserves the newest user image and handles nested Responses content arrays", () => {
  const first = transformResponseBody({ input: [{ role: "user", content: [{ type: "input_image", image_url: png }] }] });
  assert.equal(first.body.input[0].content[0].image_url, png);
  assert.equal(first.metrics.imagesPassed, 1);

  const image = parseDataImage(png);
  const second = transformResponseBody({ input: [{ role: "user", content: [[{ type: "input_image", image_url: png }]] }] });
  assert.equal(second.body.input[0].content[0][0].image_url, png);
  assert.ok(imageMarker(image).includes(image.hash));
});

test("stateful reducer replaces known history but always preserves explicit re-uploads", () => {
  const images = new ImageLru();
  transformResponseBody({ input: [{ role: "user", content: [{ image_url: png }] }] }, { images });
  const knownState = { images };
  const historical = transformResponseBody({ input: [
    { role: "tool", content: [{ type: "input_image", image_url: png }] },
    { role: "user", content: "next" }
  ] }, knownState);
  assert.equal(historical.body.input[0].content[0].type, "input_text");
  assert.match(historical.body.input[0].content[0].text, /^\[image omitted from history; sha256=/);

  const reupload = transformResponseBody({ input: [
    { role: "tool", content: [{ type: "input_image", image_url: png }] },
    { role: "user", content: [{ type: "input_image", image_url: png }] }
  ] }, knownState);
  assert.equal(reupload.body.input[0].content[0].type, "input_text");
  assert.equal(reupload.body.input[1].content[0].image_url, png);
});

test("does not alter ordinary base64, PDFs, or remote URLs", () => {
  const original = { input: [{ role: "user", content: [{ value: "aGVsbG8=" }, { value: pdf }, { image_url: "https://example.test/image.png" }] }] };
  assert.deepEqual(transformResponseBody(original).body, original);
});

test("bootstrap strips historical image data immediately", () => {
  const result = transformResponseBody({ input: [
    { role: "tool", content: [{ image_url: png }] },
    { role: "user", content: "continue" }
  ] }, { bootstrap: true });
  assert.match(result.body.input[0].content[0].image_url, /^\[image omitted/);
  assert.equal(result.metrics.imagesReplaced, 1);
});

test("proxy filters replayed history, preserves streamed responses, and rejects bypasses", async (t) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.end("data: second\n\n");
  });
  const upstreamPort = await listen(upstream);
  const metrics = [];
  const proxy = createImageReducerServer({ upstream: `http://127.0.0.1:${upstreamPort}`, onMetric: (metric) => metrics.push(metric) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const first = await request(proxyPort, "/responses", JSON.stringify({ input: [{ role: "user", content: [{ image_url: png }] }] }));
  assert.equal(first.status, 200);
  assert.equal(first.body, "data: first\n\ndata: second\n\n");
  const second = await request(proxyPort, "/responses", JSON.stringify({ input: [
    { role: "tool", content: [{ type: "input_image", image_url: png }] }, { role: "user", content: "next" }
  ] }));
  assert.equal(second.status, 200);
  assert.equal(received[1].input[0].content[0].type, "input_text");
  assert.match(received[1].input[0].content[0].text, /^\[image omitted/);
  assert.equal(metrics[1].imagesReplaced, 1);

  const compressed = await request(proxyPort, "/v1/responses", "{}", { "content-encoding": "gzip" });
  assert.equal(compressed.status, 415);
  const malformed = await request(proxyPort, "/v1/responses", "{");
  assert.equal(malformed.status, 400);
  assert.equal(received.length, 2);
});
