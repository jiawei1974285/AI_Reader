// Copy pdf.js CMaps and standard fonts into public/ so Vite serves them
// at /cmaps/ and /standard_fonts/ in both dev and build.
//
// We need these for pdf.js to decode CJK PDFs whose fonts aren't embedded.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const pairs = [
  ["node_modules/pdfjs-dist/cmaps", "public/cmaps"],
  ["node_modules/pdfjs-dist/standard_fonts", "public/standard_fonts"],
];

for (const [src, dst] of pairs) {
  const srcAbs = join(root, src);
  const dstAbs = join(root, dst);
  if (!existsSync(srcAbs)) {
    console.warn(`[copy-pdfjs-assets] source missing: ${srcAbs}`);
    continue;
  }
  mkdirSync(dirname(dstAbs), { recursive: true });
  cpSync(srcAbs, dstAbs, { recursive: true });
  console.log(`[copy-pdfjs-assets] ${src} -> ${dst}`);
}
