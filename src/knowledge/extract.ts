import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, posix } from "node:path";
import { promisify } from "node:util";
import { strFromU8, unzipSync } from "fflate";
import { parse } from "node-html-parser";
import { type Block, htmlToBlocks, jatsToBlocks, markdownToBlocks } from "./blocks.js";
import { pdfPagesToBlocks } from "./pdf-cleanup.js";

// Source file → blocks (ADR-014). Local CLI only: PDFs need poppler's `pdftotext` on PATH
// (`brew install poppler`). A scan must already carry an OCR text layer (any OCR scanning app
// or `ocrmypdf` adds one).

export class ExtractionError extends Error {
  override readonly name = "ExtractionError";
}

const run = promisify(execFile);

// Below this many characters per page, a PDF is taken to have no usable text layer.
const MIN_CHARS_PER_PAGE = 200;

export async function extractBlocks(file: string): Promise<Block[]> {
  const extension = extname(file).toLowerCase();
  switch (extension) {
    case ".md":
    case ".markdown":
    case ".txt":
      return markdownToBlocks(await readFile(file, "utf8"));
    case ".html":
    case ".htm":
    case ".xhtml":
      return htmlToBlocks(await readFile(file, "utf8"));
    case ".xml":
      // JATS full text, e.g. https://www.ebi.ac.uk/europepmc/webservices/rest/PMC…/fullTextXML
      return jatsToBlocks(await readFile(file, "utf8"));
    case ".epub":
      return epubToBlocks(await readFile(file));
    case ".pdf":
      return pdfToBlocks(file);
    default:
      throw new ExtractionError(
        `Unsupported file type ${extension || "(none)"}: use .pdf, .epub, .html, .xml (JATS), .md or .txt`,
      );
  }
}

async function pdfToBlocks(file: string): Promise<Block[]> {
  let stdout: string;
  try {
    ({ stdout } = await run("pdftotext", ["-enc", "UTF-8", file, "-"], {
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new ExtractionError(
      missing ? "pdftotext not found: brew install poppler" : `pdftotext failed: ${String(error)}`,
    );
  }
  const pages = stdout.split("\f");
  if (pages.at(-1)?.trim() === "") pages.pop();
  const characters = pages.reduce((sum, page) => sum + page.trim().length, 0);
  if (pages.length === 0 || characters / pages.length < MIN_CHARS_PER_PAGE) {
    throw new ExtractionError(
      "The PDF has (almost) no text layer. Run OCR first (the scanning app's OCR export, or `ocrmypdf in.pdf out.pdf`).",
    );
  }
  return pdfPagesToBlocks(pages);
}

// Font obfuscation (IDPF, Adobe) is allowed in DRM-free EPUBs; any other encryption is DRM.
const FONT_OBFUSCATION = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

function isDrmProtected(files: Record<string, Uint8Array>): boolean {
  if (files["META-INF/rights.xml"]) return true;
  const encryption = files["META-INF/encryption.xml"];
  if (!encryption) return false;
  return parse(strFromU8(encryption))
    .querySelectorAll("*")
    .filter((node) => node.rawTagName.toLowerCase().endsWith("encryptionmethod"))
    .some((node) => !FONT_OBFUSCATION.has(node.getAttribute("Algorithm") ?? ""));
}

// DRM-free EPUBs only (ADR-014): the reading order comes from the OPF spine.
export function epubToBlocks(data: Uint8Array): Block[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch (error) {
    throw new ExtractionError(`Not a readable EPUB (zip): ${String(error)}`);
  }
  const text = (path: string) => {
    const bytes = files[path];
    if (!bytes) throw new ExtractionError(`EPUB is missing ${path}`);
    return strFromU8(bytes);
  };
  if (isDrmProtected(files)) {
    throw new ExtractionError("The EPUB is DRM-protected; ADR-014 rules out removing DRM.");
  }

  const container = parse(text("META-INF/container.xml"));
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new ExtractionError("EPUB container.xml names no rootfile");
  const opf = parse(text(opfPath));
  const base = posix.dirname(opfPath);
  const hrefs = new Map(
    opf
      .querySelectorAll("item")
      .map((item) => [item.getAttribute("id"), item.getAttribute("href")]),
  );
  return opf.querySelectorAll("itemref").flatMap((ref) => {
    const href = hrefs.get(ref.getAttribute("idref"));
    if (!href) return [];
    const path = posix.normalize(posix.join(base, decodeURIComponent(href)));
    return files[path] ? htmlToBlocks(text(path)) : [];
  });
}
