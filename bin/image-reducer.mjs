#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

export function parseDataImage(value) {
  if (typeof value !== "string") return null;
  const match = DATA_IMAGE.exec(value);
  if (!match || match[2].length % 4 === 1) return null;

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 && match[2].length > 0) return null;
  return {
    bytes,
    mediaType: match[1].toLowerCase(),
    sourceLength: Buffer.byteLength(value),
    hash: createHash("sha256").update(bytes).digest("hex")
  };
}

export function imageMarker(image, summary = "") {
  const base = `[image omitted from history; sha256=${image.hash}; media_type=${image.mediaType}; bytes=${image.bytes.length}]`;
  return summary ? `${base}\n[visual memory]\n${summary}` : base;
}

export class ImageLru {
  constructor(limit = 2048) {
    this.limit = limit;
    this.entries = new Map();
  }

  has(hash) {
    const entry = this.entries.get(hash);
    if (!entry) return false;
    this.entries.delete(hash);
    this.entries.set(hash, entry);
    return true;
  }

  get(hash) {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    this.entries.delete(hash);
    this.entries.set(hash, entry);
    return entry;
  }

  add(image, summary = "") {
    const previous = this.entries.get(image.hash);
    this.entries.delete(image.hash);
    this.entries.set(image.hash, {
      mediaType: image.mediaType,
      bytes: image.bytes.length,
      firstSeenAt: previous?.firstSeenAt ?? new Date().toISOString(),
      summary: typeof summary === "string" && summary ? summary : (previous?.summary ?? "")
    });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }

  setSummary(hash, summary) {
    const entry = this.get(hash);
    if (!entry) return;
    entry.summary = summary;
    this.entries.set(hash, entry);
  }
}

// This cache has no filesystem backing. Its key and encrypted image bytes die with the process.
export class SessionImageCache {
  constructor(limit = 2048) {
    this.limit = limit;
    this.entries = new Map();
    this.key = randomBytes(32);
  }

  remember(image) {
    if (!this.key) return;
    const previous = this.entries.get(image.hash);
    if (previous) {
      this.entries.delete(image.hash);
      this.entries.set(image.hash, previous);
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(image.bytes), cipher.final()]);
    this.entries.set(image.hash, {
      mediaType: image.mediaType,
      bytes: image.bytes.length,
      iv,
      ciphertext,
      tag: cipher.getAuthTag()
    });
    while (this.entries.size > this.limit) this.delete(this.entries.keys().next().value);
  }

  restore(hash) {
    if (!this.key) return null;
    const entry = this.entries.get(hash);
    if (!entry) return null;
    this.entries.delete(hash);
    this.entries.set(hash, entry);
    const decipher = createDecipheriv("aes-256-gcm", this.key, entry.iv);
    decipher.setAuthTag(entry.tag);
    return {
      mediaType: entry.mediaType,
      bytes: Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]),
      hash,
      sourceLength: entry.bytes
    };
  }

  delete(hash) {
    const entry = this.entries.get(hash);
    if (!entry) return;
    entry.iv.fill(0);
    entry.ciphertext.fill(0);
    entry.tag.fill(0);
    this.entries.delete(hash);
  }

  clear() {
    for (const hash of this.entries.keys()) this.delete(hash);
    this.key?.fill(0);
    this.key = null;
  }
}

function findNewestUserMessage(value) {
  let newest = null;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (node.role === "user") newest = node;
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return newest;
}

function collectHistoricalVisualMemories(value, images, newestUserMessage, preserve = false, found = new Map()) {
  if (typeof value === "string") {
    const image = parseDataImage(value);
    const summary = image && images.get(image.hash)?.summary;
    if (!preserve && image && summary) found.set(image.hash, { image, summary });
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHistoricalVisualMemories(item, images, newestUserMessage, preserve, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const nextPreserve = preserve || value === newestUserMessage;
  const image = imageFromContentItem(value);
  const summary = image && images.get(image.hash)?.summary;
  if (!nextPreserve && image && summary) found.set(image.hash, { image, summary });
  for (const child of Object.values(value)) collectHistoricalVisualMemories(child, images, newestUserMessage, nextPreserve, found);
  return found;
}

function textFromValue(value, texts = []) {
  if (typeof value === "string") {
    if (!parseDataImage(value)) texts.push(value);
    return texts;
  }
  if (Array.isArray(value)) {
    for (const item of value) textFromValue(item, texts);
    return texts;
  }
  if (!value || typeof value !== "object") return texts;
  for (const child of Object.values(value)) textFromValue(child, texts);
  return texts;
}

function imageFromContentItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.type === "input_image" && typeof value.image_url === "string") return parseDataImage(value.image_url);
  if (value.type === "image_url") {
    const url = typeof value.image_url === "string" ? value.image_url : value.image_url?.url;
    return parseDataImage(url);
  }
  return null;
}

function cloneAndTransform(value, context) {
  if (typeof value === "string") {
    const image = parseDataImage(value);
    if (!image) return value;

    const known = context.images.has(image.hash);
    context.images.add(image);
    context.imageCache?.remember(image);
    if (!context.preserve && context.reinspectHashes?.has(image.hash)) {
      context.metrics.imagesPassed += 1;
      return restoredImageUrl(image, context.imageCache) ?? value;
    }
    if (!context.preserve && (context.bootstrap || known)) {
      context.metrics.imagesReplaced += 1;
      context.metrics.imageBytesRemoved += image.sourceLength;
      return imageMarker(image, context.images.get(image.hash)?.summary);
    }
    context.metrics.imagesPassed += 1;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneAndTransform(item, context));
  if (!value || typeof value !== "object") return value;

  const preserve = context.preserve || value === context.newestUserMessage;
  const contentImage = imageFromContentItem(value);
  if (contentImage) {
    const known = context.images.has(contentImage.hash);
    context.images.add(contentImage);
    context.imageCache?.remember(contentImage);
    if (!preserve && context.reinspectHashes?.has(contentImage.hash)) {
      context.metrics.imagesPassed += 1;
      return withRestoredImage(value, contentImage, context.imageCache);
    }
    if (!preserve && (context.bootstrap || known)) {
      context.metrics.imagesReplaced += 1;
      context.metrics.imageBytesRemoved += contentImage.sourceLength;
      return {
        type: value.type === "input_image" ? "input_text" : "text",
        text: imageMarker(contentImage, context.images.get(contentImage.hash)?.summary)
      };
    }
    context.metrics.imagesPassed += 1;
    return value;
  }

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = cloneAndTransform(child, { ...context, preserve });
  }
  return next;
}

export function transformResponseBody(body, { images = new ImageLru(), imageCache = null, reinspectHashes = new Set(), bootstrap = false } = {}) {
  const newestUserMessage = findNewestUserMessage(body);
  const metrics = { imagesPassed: 0, imagesReplaced: 0, imageBytesRemoved: 0 };
  const transformed = cloneAndTransform(body, {
    bootstrap,
    images,
    imageCache,
    reinspectHashes,
    metrics,
    newestUserMessage,
    preserve: false
  });
  return { body: transformed, metrics };
}

function collectImages(value, images = new Map()) {
  if (typeof value === "string") {
    const image = parseDataImage(value);
    if (image) images.set(image.hash, image);
    return images;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, images);
    return images;
  }
  if (!value || typeof value !== "object") return images;
  const image = imageFromContentItem(value);
  if (image) images.set(image.hash, image);
  for (const child of Object.values(value)) collectImages(child, images);
  return images;
}

function responseText(body) {
  const texts = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "output_text" && typeof value.text === "string") texts.push(value.text);
    for (const child of Object.values(value)) visit(child);
  };
  visit(body?.output);
  return texts.join("\n").trim();
}

const VISUAL_MEMORY_PROMPT = [
  "Create a compact visual memory for this image for future questions.",
  "Return plain text, not markdown and not a preamble.",
  "Include all readable text exactly, important numbers, objects, layout, relationships, colors, controls, errors, chart/table values, and code visible in the image.",
  "Mark anything unreadable or uncertain. Prefer factual details over interpretation. Keep it under 1200 tokens."
].join(" ");

const REINSPECTION_PROMPT = [
  "Decide whether the latest user request needs original pixels that are missing from the visual memories.",
  "Return JSON only in the form {\"hashes\":[...]}, using only hashes supplied below.",
  "Select a hash only when the answer requires visual detail not stated in its summary; otherwise return an empty array."
].join(" ");

function imageUrl(image) {
  return `data:${image.mediaType};base64,${image.bytes.toString("base64")}`;
}

function restoredImageUrl(image, imageCache) {
  const restored = imageCache?.restore(image.hash);
  if (!restored) return null;
  const url = imageUrl(restored);
  restored.bytes.fill(0);
  return url;
}

function withRestoredImage(value, image, imageCache) {
  const url = restoredImageUrl(image, imageCache);
  if (!url) return value;
  if (value.type === "input_image") return { ...value, image_url: url };
  if (typeof value.image_url === "string") return { ...value, image_url: url };
  return { ...value, image_url: { ...value.image_url, url } };
}

function requestJson(destination, headers, body) {
  const transport = destination.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(destination, {
      method: "POST",
      headers: { ...headers, host: destination.host, "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(`Visual memory request failed with HTTP ${response.statusCode}.`));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error("Visual memory provider returned malformed JSON.")); }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function ensureVisualMemory(body, images, request, upstreamUrl, model) {
  if (!model) return;
  const headers = request.headers.authorization ? { authorization: request.headers.authorization } : {};
  for (const image of collectImages(body).values()) {
    images.add(image);
    const existing = images.get(image.hash);
    if (existing?.summary) continue;
    const payload = JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: VISUAL_MEMORY_PROMPT },
        { type: "input_image", image_url: imageUrl(image) }
      ] }],
      store: false,
      max_output_tokens: 1200
    });
    try {
      const result = await requestJson(responsesDestination(upstreamUrl, "/responses"), headers, payload);
      const summary = responseText(result);
      if (summary) images.setSummary(image.hash, summary);
    } catch {
      // The original image request must remain available if the optional summary call fails.
    }
  }
}

function selectedHashes(text, candidates) {
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    if (!Array.isArray(parsed.hashes)) return new Set();
    return new Set(parsed.hashes.filter((hash) => typeof hash === "string" && candidates.has(hash)));
  } catch {
    return new Set();
  }
}

async function selectImagesForReinspection(body, images, request, upstreamUrl, model) {
  if (!model) return new Set();
  const newestUserMessage = findNewestUserMessage(body);
  const candidates = collectHistoricalVisualMemories(body, images, newestUserMessage);
  if (candidates.size === 0) return new Set();
  const userText = newestUserMessage ? textFromValue(newestUserMessage.content).join("\n").slice(0, 12_000) : "";
  const visualMemories = [...candidates.entries()].map(([hash, value]) => ({ hash, summary: value.summary }));
  const headers = request.headers.authorization ? { authorization: request.headers.authorization } : {};
  const payload = JSON.stringify({
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: `${REINSPECTION_PROMPT}\nLatest user request:\n${userText}\nVisual memories:\n${JSON.stringify(visualMemories)}` }] }],
    store: false,
    max_output_tokens: 200
  });
  try {
    const result = await requestJson(responsesDestination(upstreamUrl, "/responses"), headers, payload);
    return selectedHashes(responseText(result), candidates);
  } catch {
    return new Set();
  }
}

function sendError(response, status, message) {
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(message) });
  response.end(message);
}

function isResponsesRequest(request) {
  if (request.method !== "POST") return false;
  const path = new URL(request.url, "http://localhost").pathname;
  return path === "/responses" || path === "/v1/responses";
}

async function readBody(request, maxBodyBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) fail("Request body exceeds configured limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function responsesDestination(upstream, requestUrl) {
  const destination = new URL(upstream);
  destination.pathname = `${destination.pathname.replace(/\/$/, "")}/responses`;
  destination.search = new URL(requestUrl, "http://localhost").search;
  return destination;
}

function forwardRequest(request, response, upstream, body, destinationOverride) {
  const destination = destinationOverride ?? new URL(request.url, upstream);
  const transport = destination.protocol === "https:" ? https : http;
  const headers = { ...request.headers, host: destination.host };
  if (body) {
    headers["content-length"] = Buffer.byteLength(body);
    delete headers["transfer-encoding"];
    delete headers["content-encoding"];
  }

  const upstreamRequest = transport.request(destination, {
    method: request.method,
    headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", () => {
    if (!response.headersSent) sendError(response, 502, '{"error":"Upstream request failed."}');
    else response.destroy();
  });
  if (body) upstreamRequest.end(body);
  else request.pipe(upstreamRequest);
}

export function createImageReducerServer({ upstream, bootstrap = false, visualMemory = false, sessionImageCache = false, autoReinspect = false, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, cacheSize = 2048, onMetric = () => {} }) {
  if (!upstream) fail("An upstream URL is required.");
  const upstreamUrl = new URL(upstream);
  if (!["http:", "https:"].includes(upstreamUrl.protocol)) fail("Upstream must use http or https.");
  const images = new ImageLru(cacheSize);
  const imageCache = sessionImageCache || autoReinspect ? new SessionImageCache(cacheSize) : null;
  let requestNumber = 0;
  let bootstrapPending = bootstrap;

  const server = http.createServer(async (request, response) => {
    if (!isResponsesRequest(request)) {
      forwardRequest(request, response, upstreamUrl);
      return;
    }
    if ((request.headers["content-encoding"] ?? "identity").toLowerCase() !== "identity") {
      sendError(response, 415, '{"error":"Compressed /v1/responses requests are not supported by image-reducer."}');
      request.resume();
      return;
    }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendError(response, 415, '{"error":"/v1/responses must use application/json."}');
      request.resume();
      return;
    }

    let original;
    let parsed;
    try {
      original = await readBody(request, maxBodyBytes);
      parsed = JSON.parse(original.toString("utf8"));
    } catch (error) {
      const status = error.message === "Request body exceeds configured limit." ? 413 : 400;
      sendError(response, status, JSON.stringify({ error: error.message === "Request body exceeds configured limit." ? error.message : "Malformed JSON /v1/responses request." }));
      return;
    }

    if (visualMemory || autoReinspect) await ensureVisualMemory(parsed, images, request, upstreamUrl, parsed.model);
    const reinspectHashes = autoReinspect ? await selectImagesForReinspection(parsed, images, request, upstreamUrl, parsed.model) : new Set();
    const finalResult = transformResponseBody(parsed, { images, imageCache, reinspectHashes, bootstrap: bootstrapPending });
    bootstrapPending = false;
    const serialized = Buffer.from(JSON.stringify(finalResult.body));
    const metric = {
      request: ++requestNumber,
      ...finalResult.metrics,
      requestBytesBefore: original.length,
      requestBytesAfter: serialized.length,
      estimatedTokensSaved: Math.floor(finalResult.metrics.imageBytesRemoved / 4)
    };
    onMetric(metric);
    forwardRequest(request, response, upstreamUrl, serialized, responsesDestination(upstreamUrl, request.url));
  });
  server.on("close", () => imageCache?.clear());
  return server;
}

function parseListen(value) {
  const index = value.lastIndexOf(":");
  if (index <= 0) fail("--listen must be HOST:PORT.");
  const host = value.slice(0, index);
  const port = Number(value.slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--listen port must be between 1 and 65535.");
  return { host, port };
}

export function parseArgs(args) {
  if (args[0] !== "start") fail("Usage: image-reducer start --listen HOST:PORT --upstream URL [--bootstrap=strip-history] [--visual-memory=summary] [--session-image-cache] [--auto-reinspect]");
  const options = { bootstrap: false, visualMemory: false, sessionImageCache: false, autoReinspect: false };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--bootstrap=strip-history") options.bootstrap = true;
    else if (argument === "--visual-memory=summary") options.visualMemory = true;
    else if (argument === "--session-image-cache") options.sessionImageCache = true;
    else if (argument === "--auto-reinspect") options.autoReinspect = true;
    else if (argument === "--listen" || argument === "--upstream") options[argument.slice(2)] = args[++index];
    else fail(`Unknown argument: ${argument}`);
  }
  if (!options.listen || !options.upstream) fail("--listen and --upstream are required.");
  return { ...options, ...parseListen(options.listen) };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const green = "\x1b[32m";
  const white = "\x1b[37m";
  const reset = "\x1b[0m";
  const metricLine = (name, value) => `${green}${name}${white}=${value}${reset}`;
  const server = createImageReducerServer({
    upstream: options.upstream,
    bootstrap: options.bootstrap,
    visualMemory: options.visualMemory,
    sessionImageCache: options.sessionImageCache,
    autoReinspect: options.autoReinspect,
    onMetric: (metric) => process.stderr.write(
      `${white}image-reducer ${metricLine("request", metric.request)}\n` +
      `${metricLine("images_passed", metric.imagesPassed)}\n` +
      `${metricLine("images_replaced", metric.imagesReplaced)}\n` +
      `${metricLine("bytes_removed", metric.imageBytesRemoved)}\n` +
      `${metricLine("request_bytes", `${metric.requestBytesBefore}->${metric.requestBytesAfter}`)}\n` +
      `${metricLine("estimated_tokens_saved", metric.estimatedTokensSaved)}\n\n`
    )
  });
  await new Promise((resolve) => server.listen(options.port, options.host, resolve));
  process.stderr.write(`image-reducer listening on http://${options.host}:${options.port}; upstream=${new URL(options.upstream).origin}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`image-reducer: ${error.message}\n`);
    process.exitCode = 1;
  });
}
