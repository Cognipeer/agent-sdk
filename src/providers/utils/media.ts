// Shared media helpers for provider wire-format conversion of
// image / file / audio content parts.

const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  webm: "audio/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
};

/** Infers a MIME type from a URL or file name extension. */
export function inferMediaTypeFromUrl(urlOrName: string | undefined): string | undefined {
  if (!urlOrName) return undefined;
  const cleaned = urlOrName.split("?")[0].split("#")[0];
  const ext = cleaned.split(".").pop()?.toLowerCase();
  if (!ext || ext === cleaned.toLowerCase()) return undefined;
  return EXTENSION_MIME[ext];
}

/** Maps an audio MIME type to the OpenAI `input_audio.format` value. */
export function audioMimeToOpenAIFormat(mediaType: string | undefined): string {
  const m = (mediaType ?? "").toLowerCase();
  if (m.includes("wav")) return "wav";
  return "mp3";
}

const BEDROCK_DOC_FORMATS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
};

/** Maps a document MIME type / file name to a Bedrock Converse document format. */
export function documentMimeToBedrockFormat(
  mediaType: string | undefined,
  fileName?: string,
): string | undefined {
  if (mediaType && BEDROCK_DOC_FORMATS[mediaType.toLowerCase()]) {
    return BEDROCK_DOC_FORMATS[mediaType.toLowerCase()];
  }
  const inferred = inferMediaTypeFromUrl(fileName);
  if (inferred && BEDROCK_DOC_FORMATS[inferred]) return BEDROCK_DOC_FORMATS[inferred];
  return undefined;
}

/** Bedrock document names allow only alphanumerics, whitespace, hyphens,
 * parentheses and square brackets, with no consecutive whitespace. */
export function sanitizeBedrockDocName(name: string | undefined, fallback = "document"): string {
  const cleaned = (name ?? "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9\s\-()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}
