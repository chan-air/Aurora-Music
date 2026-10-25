/**
 * 最小 ZIP 读写器（**只用 STORE，不压缩**）。
 *
 * 为什么自己写、且不引入依赖：
 *   · 离线环境装不了包；
 *   · 导出的音频本身已是压缩格式（mp3/m4a/flac），再 deflate 既没收益又费 CPU。
 *
 * 写出（buildStoreZip）严格按 PKZIP 规范写三块：
 *   1. 每个文件：Local File Header + 原始字节
 *   2. Central Directory：每个文件一条
 *   3. End of Central Directory（EOCD）
 * 并且正确计算 **CRC32**（ZIP 不压缩时这是唯一的内容校验）。
 *
 * 内存：**不**把全部字节拼成一个大数组，而是把每个文件的原始 `Blob` 直接放进
 * `parts: BlobPart[]`，最后 `new Blob(parts)` 交给浏览器自己拼 —— 避免内存翻倍。
 * 计算 CRC 时只临时读当前这一个文件。
 */

/** ZIP 里的一条待写入文件 */
export interface ZipEntryInput {
  /** 包内路径，例如 `song-settings.json` 或 `audio/31517309.mp3` */
  name: string;
  data: Blob;
}

/** 从 ZIP 里读出来的一条 */
export interface ZipEntryRead {
  name: string;
  data: Blob;
  size: number;
  crc: number;
  /** 解出来并校验通过 */
  ok: boolean;
  /** ok=false 时的原因（CRC 不符 / 不支持的压缩方式…） */
  error?: string;
}

export type ZipParseResult =
  | { ok: true; entries: ZipEntryRead[] }
  | { ok: false; message: string };

/* ---------------- CRC32 ---------------- */

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** 标准 CRC-32（IEEE 802.3，ZIP 用的就是它） */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- 小工具 ---------------- */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 写一个本地文件头（30 字节固定部分 + 文件名） */
function localHeader(opts: {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  time: number;
  date: number;
}): Uint8Array<ArrayBuffer> {
  const { nameBytes, crc, size, time, date } = opts;
  const buf = new Uint8Array(new ArrayBuffer(30 + nameBytes.length));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x04034b50, true); // 本地文件头签名
  dv.setUint16(4, 20, true); // 需要的版本 2.0
  // bit 11 = 文件名是 UTF-8（我们的条目名是 ASCII，但显式声明更稳妥）
  dv.setUint16(6, 0x0800, true);
  dv.setUint16(8, 0, true); // 压缩方法 0 = STORE
  dv.setUint16(10, time, true);
  dv.setUint16(12, date, true);
  dv.setUint32(14, crc, true);
  dv.setUint32(18, size, true); // 压缩后大小 = 原始大小（STORE）
  dv.setUint32(22, size, true); // 原始大小
  dv.setUint16(26, nameBytes.length, true);
  dv.setUint16(28, 0, true); // extra 长度
  buf.set(nameBytes, 30);
  return buf;
}

/** 写一条中央目录记录（46 字节固定部分 + 文件名） */
function centralEntry(opts: {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  time: number;
  date: number;
  localOffset: number;
}): Uint8Array<ArrayBuffer> {
  const { nameBytes, crc, size, time, date, localOffset } = opts;
  const buf = new Uint8Array(new ArrayBuffer(46 + nameBytes.length));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x02014b50, true); // 中央目录签名
  dv.setUint16(4, 20, true); // 制作版本
  dv.setUint16(6, 20, true); // 解压所需版本
  dv.setUint16(8, 0x0800, true); // UTF-8 文件名
  dv.setUint16(10, 0, true); // STORE
  dv.setUint16(12, time, true);
  dv.setUint16(14, date, true);
  dv.setUint32(16, crc, true);
  dv.setUint32(20, size, true);
  dv.setUint32(24, size, true);
  dv.setUint16(28, nameBytes.length, true);
  dv.setUint16(30, 0, true); // extra
  dv.setUint16(32, 0, true); // comment
  dv.setUint16(34, 0, true); // 起始磁盘号
  dv.setUint16(36, 0, true); // 内部属性
  dv.setUint32(38, 0, true); // 外部属性
  dv.setUint32(42, localOffset, true);
  buf.set(nameBytes, 46);
  return buf;
}

/** 写 EOCD（22 字节，无注释） */
function endOfCentralDirectory(opts: {
  count: number;
  centralSize: number;
  centralOffset: number;
}): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(22));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true); // 本磁盘号
  dv.setUint16(6, 0, true); // 中央目录起始磁盘
  dv.setUint16(8, opts.count, true); // 本磁盘条目数
  dv.setUint16(10, opts.count, true); // 总条目数
  dv.setUint32(12, opts.centralSize, true);
  dv.setUint32(16, opts.centralOffset, true);
  dv.setUint16(20, 0, true); // 注释长度
  return buf;
}

/* ---------------- 写出 ---------------- */

/**
 * 把若干条文件打成一个 **STORE（不压缩）** ZIP。
 *
 * 逐条：读一次字节算 CRC32 → 写本地头 → 把**原始 Blob** 放进 parts。
 * 这样任意时刻只多占"当前这一条"的内存，不会把整个包复制一遍。
 */
export async function buildStoreZip(entries: ZipEntryInput[], when = new Date()): Promise<Blob> {
  const { time, date } = dosDateTime(when);
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8Encoder.encode(entry.name);
    // 只为算 CRC 临时读这一条
    const bytes = new Uint8Array(await entry.data.arrayBuffer());
    const crc = crc32(bytes);
    const size = bytes.length;

    const head = localHeader({ nameBytes, crc, size, time, date });
    // 原始 Blob 直接进 parts（浏览器自己拼，不复制成 JS 数组）
    parts.push(head as BlobPart, entry.data);
    central.push(centralEntry({ nameBytes, crc, size, time, date, localOffset: offset }));
    offset += head.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) {
    parts.push(c as BlobPart);
    centralSize += c.length;
  }
  parts.push(
    endOfCentralDirectory({ count: central.length, centralSize, centralOffset: centralStart }) as BlobPart,
  );
  return new Blob(parts, { type: "application/zip" });
}

/* ---------------- 读入 ---------------- */

/** 不是合法 ZIP / 结构损坏时返回 ok:false（由调用方给用户提示） */
export async function readZip(blob: Blob): Promise<ZipParseResult> {
  const buf = blob.size > 0 ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
  if (buf.length < 22) return { ok: false, message: "文件太小，不是有效的 ZIP 包" };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 1) 从尾部找 EOCD（可能带注释，最长 65535 字节）
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, message: "这个文件不是有效的 ZIP 包（找不到目录结尾）" };

  const count = dv.getUint16(eocd + 10, true);
  const centralSize = dv.getUint32(eocd + 12, true);
  const centralOffset = dv.getUint32(eocd + 16, true);
  if (centralOffset + centralSize > buf.length) {
    return { ok: false, message: "ZIP 包已损坏（目录越界）" };
  }

  // 2) 遍历中央目录
  const entries: ZipEntryRead[] = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) {
      return { ok: false, message: "ZIP 包已损坏（中央目录条目不完整）" };
    }
    const method = dv.getUint16(p + 10, true);
    const crcExpected = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = utf8Decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // 3) 定位数据区（本地头的 name/extra 长度可能与中央目录不同，必须重新读）
    if (localOffset + 30 > buf.length || dv.getUint32(localOffset, true) !== 0x04034b50) {
      return { ok: false, message: `ZIP 包已损坏（${name} 的本地头无效）` };
    }
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      return { ok: false, message: `ZIP 包已损坏（${name} 的数据越界）` };
    }

    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Blob;
    if (method === 0) {
      data = new Blob([raw as unknown as BlobPart], { type: guessType(name) });
    } else if (method === 8) {
      // 兼容别处生成的 deflate 包（我们导出时永远用 STORE）
      try {
        const stream = new Blob([raw as unknown as BlobPart]).stream().pipeThrough(
          new DecompressionStream("deflate-raw"),
        );
        data = new Blob([await new Response(stream).arrayBuffer()], { type: guessType(name) });
      } catch {
        entries.push({
          name,
          data: new Blob([]),
          size,
          crc: crcExpected,
          ok: false,
          error: "不支持的压缩方式",
        });
        continue;
      }
    } else {
      entries.push({
        name,
        data: new Blob([]),
        size,
        crc: crcExpected,
        ok: false,
        error: `不支持的压缩方式 ${method}`,
      });
      continue;
    }

    // 4) CRC 校验（ZIP 的内容完整性就靠它）
    const actual = crc32(new Uint8Array(await data.arrayBuffer()));
    if (actual !== crcExpected) {
      entries.push({
        name,
        data,
        size,
        crc: crcExpected,
        ok: false,
        error: `CRC 校验失败（期望 ${crcExpected.toString(16)}，实际 ${actual.toString(16)}）`,
      });
      continue;
    }
    entries.push({ name, data, size, crc: crcExpected, ok: true });
  }

  return { ok: true, entries };
}

/** 按扩展名给个 MIME（只用于让恢复出来的 Blob 更像原始文件） */
function guessType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "opus":
      return "audio/opus";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** 判断一个 Blob/File 是不是 ZIP（看前 4 字节的 PK\x03\x04） */
export async function looksLikeZip(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}
