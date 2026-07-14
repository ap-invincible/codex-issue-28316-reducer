#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
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

export function imageMarker(image) {
  return `[image omitted from history; sha256=${image.hash}; media_type=${image.mediaType}; bytes=${image.bytes.length}]`;
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

  add(image) {
    this.entries.delete(image.hash);
    this.entries.set(image.hash, {
      mediaType: image.mediaType,
      bytes: image.bytes.length,
      firstSeenAt: new Date().toISOString()
    });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
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
    if (!context.preserve && (context.bootstrap || known)) {
      context.metrics.imagesReplaced += 1;
      context.metrics.imageBytesRemoved += image.sourceLength;
      return imageMarker(image);
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
    if (!preserve && (context.bootstrap || known)) {
      context.metrics.imagesReplaced += 1;
      context.metrics.imageBytesRemoved += contentImage.sourceLength;
      return {
        type: value.type === "input_image" ? "input_text" : "text",
        text: imageMarker(contentImage)
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

export function transformResponseBody(body, { images = new ImageLru(), bootstrap = false } = {}) {
  const newestUserMessage = findNewestUserMessage(body);
  const metrics = { imagesPassed: 0, imagesReplaced: 0, imageBytesRemoved: 0 };
  const transformed = cloneAndTransform(body, {
    bootstrap,
    images,
    metrics,
    newestUserMessage,
    preserve: false
  });
  return { body: transformed, metrics };
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

export function createImageReducerServer({ upstream, bootstrap = false, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, cacheSize = 2048, onMetric = () => {} }) {
  if (!upstream) fail("An upstream URL is required.");
  const upstreamUrl = new URL(upstream);
  if (!["http:", "https:"].includes(upstreamUrl.protocol)) fail("Upstream must use http or https.");
  const images = new ImageLru(cacheSize);
  let requestNumber = 0;
  let bootstrapPending = bootstrap;

  return http.createServer(async (request, response) => {
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

    const result = transformResponseBody(parsed, { images, bootstrap: bootstrapPending });
    bootstrapPending = false;
    const serialized = Buffer.from(JSON.stringify(result.body));
    const metric = {
      request: ++requestNumber,
      ...result.metrics,
      requestBytesBefore: original.length,
      requestBytesAfter: serialized.length,
      estimatedTokensSaved: Math.floor(result.metrics.imageBytesRemoved / 4)
    };
    onMetric(metric);
    forwardRequest(request, response, upstreamUrl, serialized, responsesDestination(upstreamUrl, request.url));
  });
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
  if (args[0] !== "start") fail("Usage: image-reducer start --listen HOST:PORT --upstream URL [--bootstrap=strip-history]");
  const options = { bootstrap: false };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--bootstrap=strip-history") options.bootstrap = true;
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
