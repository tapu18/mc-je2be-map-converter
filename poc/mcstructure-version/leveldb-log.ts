// このPoCが新規ワールドに保存した構造物を、停止後のLevelDB WALから取り出す。
// SST・圧縮・CRC検証は扱わない。汎用DBリーダーではなく、WALにない場合は失敗させる。
// 形式の根拠: https://github.com/google/leveldb/blob/main/doc/log_format.md
// WriteBatch: https://github.com/google/leveldb/blob/main/db/write_batch.cc
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function* records(bytes: Buffer): Generator<Buffer> {
  let fragments: Buffer[] | undefined;
  for (let block = 0; block < bytes.length; block += 32768) {
    const end = Math.min(block + 32768, bytes.length);
    for (let pos = block; pos + 7 <= end;) {
      const size = bytes.readUInt16LE(pos + 4);
      const type = bytes[pos + 6]!;
      if (type === 0 && size === 0) break;
      if (pos + 7 + size > end) throw new Error("truncated LevelDB record");
      const data = bytes.subarray(pos + 7, pos + 7 + size);
      pos += 7 + size;
      if (type === 1) {
        if (fragments) throw new Error("unfinished LevelDB record");
        yield data;
      } else if (type === 2) {
        if (fragments) throw new Error("unfinished LevelDB record");
        fragments = [data];
      } else if (type === 3 || type === 4) {
        if (!fragments) throw new Error("missing LevelDB first fragment");
        fragments.push(data);
        if (type === 4) { yield Buffer.concat(fragments); fragments = undefined; }
      } else throw new Error(`unknown LevelDB record type ${type}`);
    }
  }
  if (fragments) throw new Error("truncated LevelDB fragmented record");
}

export function readSavedStructure(db: string, name: string): Buffer {
  const wanted = Buffer.from(`structuretemplate_${name}`);
  let latest = -1n;
  let result: Buffer | undefined;
  for (const file of readdirSync(db).filter((f) => /^\d+\.log$/.test(f))) {
    for (const batch of records(readFileSync(join(db, file)))) {
      if (batch.length < 12) throw new Error("truncated LevelDB batch");
      const sequence = batch.readBigUInt64LE(0);
      const count = batch.readUInt32LE(8);
      let pos = 12;
      const slice = (): Buffer => {
        let size = 0;
        let shift = 0;
        for (;;) {
          if (pos >= batch.length || shift > 28) throw new Error("invalid LevelDB varint");
          const b = batch[pos++]!;
          size += (b & 127) * 2 ** shift;
          if (!(b & 128)) break;
          shift += 7;
        }
        if (pos + size > batch.length) throw new Error("truncated LevelDB value");
        const data = batch.subarray(pos, pos + size);
        pos += size;
        return data;
      };
      for (let i = 0; i < count; i++) {
        const type = batch[pos++];
        if (type !== 0 && type !== 1) throw new Error(`unknown LevelDB batch type ${type}`);
        const key = slice();
        const value = type === 1 ? slice() : undefined;
        const seq = sequence + BigInt(i);
        if (key.equals(wanted) && seq > latest) { latest = seq; result = value; }
      }
      if (pos !== batch.length) throw new Error("invalid LevelDB batch count");
    }
  }
  if (!result) throw new Error(`${name} not found in WAL; use a fresh PoC world (SST is unsupported)`);
  return result;
}
