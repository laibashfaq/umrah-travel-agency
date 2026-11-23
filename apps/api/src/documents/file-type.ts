export interface DetectedFile {
  mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  extension: 'pdf' | 'jpg' | 'png';
}

/**
 * Identifies an upload from its first bytes. The name and the content type the browser sent are never trusted:
 * a file only counts as a PDF, JPEG or PNG if it really starts like one.
 */
export function detectFileType(bytes: Buffer): DetectedFile | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', extension: 'pdf' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', extension: 'png' };
  return null;
}

/** A safe file name to show people and to send back as a download name: no paths, control characters or odd symbols. */
export function safeFileName(name: string, extension: string): string {
  const base = name.replace(/[/\\]/g, ' ').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} ._()-]/gu, '').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 80);
  return `${base || 'document'}.${extension}`;
}
