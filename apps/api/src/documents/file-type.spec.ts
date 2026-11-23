import { detectFileType, safeFileName } from './file-type';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);

describe('detectFileType', () => {
  it('recognises PDF, JPEG and PNG by their first bytes', () => {
    expect(detectFileType(Buffer.from('%PDF-1.7\n...'))).toEqual({ mime: 'application/pdf', extension: 'pdf' });
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toEqual({ mime: 'image/jpeg', extension: 'jpg' });
    expect(detectFileType(png)).toEqual({ mime: 'image/png', extension: 'png' });
  });

  it('refuses everything else, whatever it is called', () => {
    expect(detectFileType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(detectFileType(Buffer.from('MZ\x90\x00 this is an executable'))).toBeNull();
    expect(detectFileType(Buffer.from('PK\x03\x04 zip'))).toBeNull();
    expect(detectFileType(Buffer.from('%PD'))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(detectFileType(Buffer.from('hello %PDF-1.7'))).toBeNull(); // only the very start counts
  });
});

describe('safeFileName', () => {
  it('keeps a readable name and always ends with the detected extension', () => {
    expect(safeFileName('Passport scan.JPG', 'jpg')).toBe('Passport scan.jpg');
  });

  it('removes paths, control characters and markup', () => {
    expect(safeFileName('../../etc/passwd', 'pdf')).not.toMatch(/[/\\]/);
    expect(safeFileName('a<b>"c"\u0000\r\n.png', 'png')).toBe('abc.png');
    expect(safeFileName('', 'pdf')).toBe('document.pdf');
    expect(safeFileName('x'.repeat(300), 'pdf').length).toBeLessThanOrEqual(84);
  });
});
