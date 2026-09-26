import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ExtractionError, epubToBlocks } from "./extract.js";

function epub(extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    "META-INF/container.xml":
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    "OEBPS/content.opf": `<package><manifest>
        <item id="c2" href="text/ch2.xhtml"/><item id="c1" href="text/ch1.xhtml"/>
      </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    "OEBPS/text/ch1.xhtml": "<html><body><h1>Base</h1><p>Easy volume.</p></body></html>",
    "OEBPS/text/ch2.xhtml": "<html><body><h1>Build</h1><p>Add intensity.</p></body></html>",
    ...extra,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

describe("epubToBlocks", () => {
  it("reads chapters in spine order", () => {
    expect(epubToBlocks(epub()).map((b) => b.text)).toEqual([
      "Base",
      "Easy volume.",
      "Build",
      "Add intensity.",
    ]);
  });

  it("accepts font obfuscation but refuses DRM", () => {
    const font =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>';
    expect(epubToBlocks(epub({ "META-INF/encryption.xml": font }))).toHaveLength(4);
    const adept =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>';
    expect(() => epubToBlocks(epub({ "META-INF/encryption.xml": adept }))).toThrow(ExtractionError);
    expect(() => epubToBlocks(epub({ "META-INF/rights.xml": "<rights/>" }))).toThrow(
      ExtractionError,
    );
  });
});
