declare module "pdf-parse" {
    // Minimal typing for the pdf-parse library used by extract helpers and tests.
    // The real library returns an object with a `text` property and other metadata.
    export interface PDFParseResult {
        numpages?: number;
        numrender?: number;
        info?: Record<string, any>;
        metadata?: Record<string, any>;
        version?: string;
        text?: string;
        [key: string]: any;
    }

    // The module may export a function as default or named export.
    function pdfParse(
        data: Buffer | Uint8Array | ArrayBuffer,
        options?: any,
    ): Promise<PDFParseResult>;
    export default pdfParse;
    export { pdfParse };
}
