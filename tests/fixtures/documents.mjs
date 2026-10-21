import { deflateRawSync, crc32 } from 'node:zlib';

// 可复现的标准 ZIP/PDF 输入，不包含用户文件或下载样本。
export function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text), compressed = deflateRawSync(data), filename = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20,4); l.writeUInt16LE(0x800,6); l.writeUInt16LE(8,8);
    l.writeUInt32LE(crc32(data),14); l.writeUInt32LE(compressed.length,18); l.writeUInt32LE(data.length,22); l.writeUInt16LE(filename.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8); c.writeUInt16LE(8,10);
    c.writeUInt32LE(crc32(data),16); c.writeUInt32LE(compressed.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(filename.length,28); c.writeUInt32LE(offset,42);
    local.push(l,filename,compressed); central.push(c,filename); offset += l.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length/2,8); end.writeUInt16LE(central.length/2,10);
  end.writeUInt32LE(Buffer.concat(central).length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
export function docx(text='DOCX_FIXTURE 中文附件与表格', extras={}) {
  const escaped = text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return zip({'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容 TABLE_CELL</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,...extras});
}
export function pdf(text='PDF_FIXTURE 中文文档', pages=1) {
  const encoded = Buffer.from(text,'utf16le').swap16().toString('hex');
  const stream = text ? `BT /F1 12 Tf 40 760 Td <${encoded}> Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${pages} /Kids [${Array.from({length:pages},(_,i)=>`${7+i} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-250 -250 1100 1100] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
    ...Array.from({length:pages},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>')];
  let file = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(file));file+=`${i+1} 0 obj\n${value}\nendobj\n`;});
  const xref=Buffer.byteLength(file);file+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  return Buffer.from(file+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
