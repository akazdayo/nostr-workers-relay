import type { Event, EventTemplate } from "nostr-tools/pure";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

const HTTP_AUTH_KIND = 27235;
const CRLF = "\r\n";
const textEncoder = new TextEncoder();

export type Nip96FileInput = File | Blob | ArrayBuffer | Uint8Array;
export type Nip96UploadSigner = (event: EventTemplate) => Promise<Event> | Event;

type AdditionalFieldValue = string | number | boolean;

type FormField = {
  name: string;
  value: string;
};

type MultipartFilePart = {
  fieldName: string;
  filename: string;
  contentType: string;
  blob: Blob;
};

export interface Nip94EventFragment {
  tags: string[][];
  content: string;
  [key: string]: unknown;
}

export interface Nip96UploadResponse {
  status: "success" | "error";
  message: string;
  nip94_event?: Nip94EventFragment;
  processing_url?: string;
  [key: string]: unknown;
}

export interface Nip96UploadResult {
  ok: boolean;
  statusCode: number;
  response: Nip96UploadResponse;
  rawBody: string;
  authorization: string;
}

export interface Nip96UploadOptions {
  apiUrl: string;
  authorizationUrl?: string;
  method?: "POST" | "PUT";
  file: Nip96FileInput;
  filename?: string;
  contentType?: string;
  caption?: string;
  alt?: string;
  expiration?: number | "";
  mediaType?: "avatar" | "banner";
  noTransform?: boolean;
  additionalFields?: Record<string, AdditionalFieldValue | undefined>;
  includeSizeField?: boolean;
  includePayloadTag?: boolean;
  secretKey?: Uint8Array | string;
  signer?: Nip96UploadSigner;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export async function uploadImage(options: Nip96UploadOptions): Promise<Nip96UploadResult> {
  const {
    apiUrl,
    authorizationUrl,
    method = "POST",
    includeSizeField = true,
    includePayloadTag = true,
    headers,
    fetch: fetchImpl,
    signal
  } = options;

  const targetUrl = ensureAbsoluteUrl(apiUrl);
  const authUrl = ensureAbsoluteUrl(authorizationUrl ?? apiUrl, targetUrl);
  const upperMethod = method.toUpperCase();

  const { blob, filename, contentType } = normalizeFile(options.file, options.filename, options.contentType);
  ensureImageMime(contentType);

  const fields = buildFormFields({
    options,
    contentType,
    size: blob.size,
    includeSizeField
  });

  const boundary = createBoundary();
  const bodyBlob = createMultipartBody(boundary, fields, {
    fieldName: "file",
    filename,
    contentType,
    blob
  });

  let payloadHash: string | null = null;
  if (includePayloadTag) {
    const bodyBuffer = await bodyBlob.arrayBuffer();
    payloadHash = await hashArrayBuffer(bodyBuffer);
  }

  const signer = resolveSigner(options);
  const authorization = await buildAuthorizationHeader({
    signer,
    method: upperMethod,
    url: authUrl,
    payloadHash,
    includePayloadTag
  });

  const requestHeaders = new Headers({
    Authorization: authorization,
    "Content-Type": `multipart/form-data; boundary=${boundary}`
  });

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value);
    }
  }

  const response = await (fetchImpl ?? fetch)(targetUrl, {
    method: upperMethod,
    headers: requestHeaders,
    body: bodyBlob,
    signal
  });

  const rawBody = await response.text();
  const parsed = parseJsonBody(rawBody);

  if (!parsed || typeof parsed.status !== "string" || typeof parsed.message !== "string") {
    throw new Error(`Unexpected NIP-96 response (status ${response.status}): ${rawBody}`);
  }

  return {
    ok: response.ok && parsed.status === "success",
    statusCode: response.status,
    response: parsed,
    rawBody,
    authorization
  };
}

function resolveSigner(options: Nip96UploadOptions): Nip96UploadSigner {
  if (options.signer) {
    return options.signer;
  }
  if (!options.secretKey) {
    throw new Error("Either signer or secretKey must be provided to sign the NIP-98 authorization event.");
  }
  const secretKey = normalizeSecretKey(options.secretKey);
  return (event: EventTemplate) => finalizeEvent(cloneEventTemplate(event), secretKey);
}

function cloneEventTemplate(event: EventTemplate): EventTemplate {
  return {
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags.map((tag) => [...tag])
  };
}

async function buildAuthorizationHeader(params: {
  signer: Nip96UploadSigner;
  method: string;
  url: string;
  payloadHash: string | null;
  includePayloadTag: boolean;
}): Promise<string> {
  const { signer, method, url, payloadHash, includePayloadTag } = params;
  const eventTemplate: EventTemplate = {
    kind: HTTP_AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["u", url],
      ["method", method]
    ]
  };

  if (includePayloadTag && payloadHash) {
    eventTemplate.tags.push(["payload", payloadHash]);
  }

  const signedEvent = await signer(eventTemplate);
  if (signedEvent.kind !== HTTP_AUTH_KIND) {
    throw new Error(`Signer returned unexpected event kind ${signedEvent.kind}; expected ${HTTP_AUTH_KIND}.`);
  }
  if (!verifyEvent(signedEvent)) {
    throw new Error("Invalid signature on authorization event.");
  }

  const serialized = JSON.stringify(signedEvent);
  const token = encodeBase64(textEncoder.encode(serialized));
  return `Nostr ${token}`;
}

function normalizeFile(file: Nip96FileInput, filename?: string, overrideContentType?: string): {
  blob: Blob;
  filename: string;
  contentType: string;
} {
  const isFile = typeof File !== "undefined" && file instanceof File;
  const isBlob = typeof Blob !== "undefined" && file instanceof Blob;

  let blob: Blob;
  if (isFile || isBlob) {
    blob = file as Blob;
  } else if (file instanceof Uint8Array) {
    blob = new Blob([file.slice()]);
  } else if (file instanceof ArrayBuffer) {
    blob = new Blob([file]);
  } else {
    throw new Error("Unsupported file type provided to uploadImage.");
  }

  const contentType = overrideContentType ?? (blob.type || "application/octet-stream");
  const nameFromFile = isFile ? (file as File).name : undefined;
  const derivedFilename = filename ?? nameFromFile ?? buildDefaultFilename(contentType);

  return { blob, filename: derivedFilename, contentType };
}

function ensureImageMime(contentType: string) {
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`uploadImage expects an image mime type, received \"${contentType}\".`);
  }
}

function buildFormFields(params: {
  options: Nip96UploadOptions;
  contentType: string;
  size: number;
  includeSizeField: boolean;
}): FormField[] {
  const { options, contentType, size, includeSizeField } = params;
  const fields = new Map<string, string>();

  fields.set("content_type", contentType);
  if (includeSizeField) {
    fields.set("size", String(size));
  }
  if (options.caption !== undefined) {
    fields.set("caption", options.caption);
  }
  if (options.alt !== undefined) {
    fields.set("alt", options.alt);
  }
  if (options.expiration !== undefined) {
    fields.set("expiration", options.expiration === "" ? "" : String(options.expiration));
  }
  if (options.mediaType) {
    fields.set("media_type", options.mediaType);
  }
  if (options.noTransform) {
    fields.set("no_transform", "true");
  }

  if (options.additionalFields) {
    for (const [key, value] of Object.entries(options.additionalFields)) {
      if (value === undefined) {
        continue;
      }
      fields.set(key, String(value));
    }
  }

  return Array.from(fields.entries()).map(([name, value]) => ({ name, value }));
}

function createMultipartBody(boundary: string, fields: FormField[], file: MultipartFilePart): Blob {
  const chunks: Array<Blob | string> = [];

  for (const field of fields) {
    chunks.push(`--${boundary}${CRLF}`);
    chunks.push(`Content-Disposition: form-data; name="${escapeQuotes(field.name)}"${CRLF}${CRLF}`);
    chunks.push(`${field.value}${CRLF}`);
  }

  chunks.push(`--${boundary}${CRLF}`);
  chunks.push(
    `Content-Disposition: form-data; name="${escapeQuotes(file.fieldName)}"; filename="${escapeQuotes(file.filename)}"${CRLF}`
  );
  chunks.push(`Content-Type: ${file.contentType}${CRLF}${CRLF}`);
  chunks.push(file.blob);
  chunks.push(CRLF);
  chunks.push(`--${boundary}--${CRLF}`);

  return new Blob(chunks);
}

async function hashArrayBuffer(buffer: ArrayBuffer): Promise<string> {
  const subtle = getSubtleCrypto();
  const digest = await subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(digest));
}

function normalizeSecretKey(secretKey: Uint8Array | string): Uint8Array {
  if (typeof secretKey === "string") {
    const hex = secretKey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error("Secret key string must be a 32-byte hex value.");
    }
    return hexToBytes(hex);
  }
  if (!(secretKey instanceof Uint8Array)) {
    throw new Error("Secret key must be provided as a hex string or Uint8Array.");
  }
  if (secretKey.length !== 32) {
    throw new Error("Secret key Uint8Array must be 32 bytes long.");
  }
  return new Uint8Array(secretKey);
}

function hexToBytes(hex: string): Uint8Array {
  const length = hex.length;
  const bytes = new Uint8Array(length / 2);
  for (let i = 0; i < length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function buildDefaultFilename(contentType: string): string {
  const extension = guessExtension(contentType);
  return `image.${extension}`;
}

function guessExtension(contentType: string): string {
  const parts = contentType.split("/");
  if (parts.length < 2) {
    return "bin";
  }
  const subtype = parts[1].split(";")[0].trim();
  if (!subtype) {
    return "bin";
  }
  if (subtype === "jpeg") {
    return "jpg";
  }
  return subtype;
}

function createBoundary(): string {
  const randomSuffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(16).slice(2);
  return `----nostr-upload-${randomSuffix}`;
}

function escapeQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

function ensureAbsoluteUrl(url: string, base?: string): string {
  try {
    const resolved = base ? new URL(url, base) : new URL(url);
    return resolved.toString();
  } catch (error) {
    throw new Error(`Invalid URL provided: ${url}`);
  }
}

function parseJsonBody(rawBody: string): Nip96UploadResponse | null {
  try {
    return JSON.parse(rawBody) as Nip96UploadResponse;
  } catch (_error) {
    return null;
  }
}

function getSubtleCrypto(): SubtleCrypto {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    return crypto.subtle;
  }
  const globalCrypto = (globalThis as { webcrypto?: Crypto }).webcrypto;
  if (globalCrypto?.subtle) {
    return globalCrypto.subtle;
  }
  throw new Error("SubtleCrypto is not available in this environment.");
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  const bufferCtor = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString("base64");
  }
  throw new Error("Base64 encoding is not available in this environment.");
}
