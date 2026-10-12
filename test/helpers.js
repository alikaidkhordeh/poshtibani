import { inflateRawSync } from 'node:zlib';

// Reads the zip files this project writes: walks the local file headers. Returns {name: Buffer}.
export function readZipEntries(buf) {
  const files = {};
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    p = start + size;
  }
  return files;
}
