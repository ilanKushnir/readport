import fs from 'node:fs';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

/**
 * A ZIP archive written as it is sent, out of files already on disk.
 *
 * Stored, not compressed: what goes in is audio, which is compressed
 * already, and deflating it again would spend a core per download to save
 * nothing. Written once, front to back - each file's CRC is taken as its
 * bytes go past and follows them in a data descriptor - so an audiobook of
 * any size costs one read of each file and a read buffer of memory, never
 * the archive in RAM or on disk. Every size is known before the first byte,
 * so the length is exact and a browser can show real progress.
 *
 * ZIP64 records are written only where a size or an offset passes what the
 * classic format can hold (4 GiB), so an ordinary archive stays readable by
 * the oldest unzip there is. Names are UTF-8 and flagged as such, because a
 * Hebrew or Japanese track name is still a track name.
 */

export interface ZipEntry {
  /** The path inside the archive, with `/` between folders. */
  name: string;
  /** Where the bytes are, on disk. */
  path: string;
  size: number;
  mtime: Date;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0008 | 0x0800;
/** Unix, and the version of the format this archive needs to be read. */
const MADE_BY_UNIX = 3 << 8;

/** A file's time as the two 16-bit halves ZIP stores it in: local, to two seconds. */
function dosTime(d: Date): { time: number; date: number } {
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Planned extends ZipEntry {
  nameBytes: Buffer;
  offset: number;
  /** The file itself is past 4 GiB: its sizes need 8 bytes wherever they appear. */
  big: boolean;
  /** Its local header starts past 4 GiB: the central directory needs 8 bytes for it. */
  far: boolean;
}

/** The ZIP64 extra field: the listed 8-byte values, in the order the format fixes. */
function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + values.length * 8);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  return b;
}

function localHeader(e: Planned): Buffer {
  const { time, date } = dosTime(e.mtime);
  // A file past 4 GiB says so here, with zeroed 8-byte sizes, so a reader
  // knows its data descriptor carries 8-byte sizes too.
  const extra = e.big ? zip64Extra([0, 0]) : Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(e.big ? 45 : 20, 4);
  h.writeUInt16LE(FLAGS, 6);
  h.writeUInt16LE(0, 8); // stored
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(0, 14); // CRC: in the descriptor
  h.writeUInt32LE(e.big ? MAX32 : 0, 18);
  h.writeUInt32LE(e.big ? MAX32 : 0, 22);
  h.writeUInt16LE(e.nameBytes.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, e.nameBytes, extra]);
}

function descriptor(e: Planned, crc: number): Buffer {
  const d = Buffer.alloc(e.big ? 24 : 16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc >>> 0, 4);
  if (e.big) {
    d.writeBigUInt64LE(BigInt(e.size), 8);
    d.writeBigUInt64LE(BigInt(e.size), 16);
  } else {
    d.writeUInt32LE(e.size, 8);
    d.writeUInt32LE(e.size, 12);
  }
  return d;
}

function centralEntry(e: Planned, crc: number): Buffer {
  const { time, date } = dosTime(e.mtime);
  const values = [...(e.big ? [e.size, e.size] : []), ...(e.far ? [e.offset] : [])];
  const extra = values.length ? zip64Extra(values) : Buffer.alloc(0);
  const version = values.length ? 45 : 20;
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(MADE_BY_UNIX | version, 4);
  h.writeUInt16LE(version, 6);
  h.writeUInt16LE(FLAGS, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(time, 12);
  h.writeUInt16LE(date, 14);
  h.writeUInt32LE(crc >>> 0, 16);
  h.writeUInt32LE(e.big ? MAX32 : e.size, 20);
  h.writeUInt32LE(e.big ? MAX32 : e.size, 24);
  h.writeUInt16LE(e.nameBytes.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attributes
  h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a plain, readable file
  h.writeUInt32LE(e.far ? MAX32 : e.offset, 42);
  return Buffer.concat([h, e.nameBytes, extra]);
}

function centralLength(e: Planned): number {
  const values = (e.big ? 2 : 0) + (e.far ? 1 : 0);
  return 46 + e.nameBytes.length + (values ? 4 + values * 8 : 0);
}

function end(count: number, cdOffset: number, cdSize: number, limit: number): Buffer {
  const needs64 = count >= MAX16 || cdOffset >= limit || cdSize >= limit;
  const parts: Buffer[] = [];
  if (needs64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4); // the size of what follows
    z.writeUInt16LE(MADE_BY_UNIX | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(z, locator);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(0, 4);
  e.writeUInt16LE(0, 6);
  e.writeUInt16LE(Math.min(count, MAX16), 8);
  e.writeUInt16LE(Math.min(count, MAX16), 10);
  e.writeUInt32LE(needs64 && cdSize >= limit ? MAX32 : cdSize, 12);
  e.writeUInt32LE(needs64 && cdOffset >= limit ? MAX32 : cdOffset, 16);
  e.writeUInt16LE(0, 20);
  parts.push(e);
  return Buffer.concat(parts);
}

/**
 * The archive of `entries`, in that order: its exact length in bytes, and
 * the stream that produces it. A file that is not the size it was when
 * this was called fails the stream rather than sending an archive that
 * lies about its contents.
 *
 * @param opts.limit where ZIP64 takes over; the format's own 4 GiB unless a
 *   test wants to see the ZIP64 records without writing gigabytes.
 */
export function zipStream(
  entries: ZipEntry[],
  { limit = MAX32 }: { limit?: number } = {},
): { length: number; stream: Readable } {
  const planned: Planned[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8');
    const big = e.size >= limit;
    const p: Planned = { ...e, nameBytes, offset, big, far: offset >= limit };
    planned.push(p);
    offset += 30 + nameBytes.length + (big ? 20 : 0) + e.size + (big ? 24 : 16);
  }
  const cdOffset = offset;
  const cdSize = planned.reduce((a, p) => a + centralLength(p), 0);
  const length = cdOffset + cdSize + end(planned.length, cdOffset, cdSize, limit).length;

  async function* produce(): AsyncGenerator<Buffer> {
    const crcs: number[] = [];
    for (const e of planned) {
      yield localHeader(e);
      let crc = 0;
      let sent = 0;
      for await (const chunk of fs.createReadStream(e.path, { highWaterMark: 1 << 20 })) {
        const buf = chunk as Buffer;
        sent += buf.length;
        if (sent > e.size) throw new Error(`${e.name} grew while it was being sent`);
        crc = crc32(buf, crc);
        yield buf;
      }
      if (sent !== e.size) throw new Error(`${e.name} shrank while it was being sent`);
      crcs.push(crc);
      yield descriptor(e, crc);
    }
    yield Buffer.concat(planned.map((e, i) => centralEntry(e, crcs[i]!)));
    yield end(planned.length, cdOffset, cdSize, limit);
  }

  return { length, stream: Readable.from(produce(), { objectMode: false }) };
}
