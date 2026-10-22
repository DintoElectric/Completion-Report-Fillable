// The "legacy" build of PDF.js works on older Safari (tablets that have not been updated) and ships without type declarations.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(src: { data: Uint8Array }): { promise: Promise<unknown> };
}
