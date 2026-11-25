// Read Chromium's localStorage LevelDB *write-ahead log* without a native module, so data that older
// builds stored under the file:// origin can be migrated before Chromium opens the database.
//
// Log format (leveldb/doc/log_format.md): 32 KiB blocks of records
//   checksum u32 | length u16 | type u8 (1 FULL, 2 FIRST, 3 MIDDLE, 4 LAST) | data
// Each logical record is a WriteBatch: sequence u64 | count u32 | entries
//   entry: tag u8 (1 put, 0 delete) | varint keyLen | key | [varint valLen | value]
// Chromium localStorage keys: "_" + origin + "\x00" + encodedKey; strings are prefixed with
//   0x00 (UTF-16LE) or 0x01 (Latin-1).
const fs = require('fs');
const path = require('path');

const BLOCK = 32768;

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    if (pos >= buf.length) throw new Error('truncated varint');
    b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function* logicalRecords(buf) {
  let pos = 0;
  let parts = null;
  while (pos + 7 <= buf.length) {
    const left = BLOCK - (pos % BLOCK);
    if (left < 7) {
      pos += left; // block trailer padding
      continue;
    }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    const data = buf.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 0) continue; // zero-filled preallocated space
    if (type === 1) yield data;
    else if (type === 2) parts = [data];
    else if (type === 3 && parts) parts.push(data);
    else if (type === 4 && parts) {
      parts.push(data);
      yield Buffer.concat(parts);
      parts = null;
    }
  }
}

function decodeString(b) {
  if (!b.length) return '';
  return b[0] === 0 ? b.subarray(1).toString('utf16le') : b.subarray(1).toString('latin1');
}

// → Map<string key, string value> for one origin (latest value wins; deletes applied).
function readOriginFromLog(logFile, origin, out = new Map()) {
  const buf = fs.readFileSync(logFile);
  const prefix = Buffer.from('_' + origin + '\x00', 'latin1');
  for (const rec of logicalRecords(buf)) {
    if (rec.length < 12) continue;
    const count = rec.readUInt32LE(8);
    let pos = 12;
    try {
      for (let i = 0; i < count && pos < rec.length; i++) {
        const tag = rec[pos++];
        let klen;
        [klen, pos] = readVarint(rec, pos);
        const key = rec.subarray(pos, pos + klen);
        pos += klen;
        let val = null;
        if (tag === 1) {
          let vlen;
          [vlen, pos] = readVarint(rec, pos);
          val = rec.subarray(pos, pos + vlen);
          pos += vlen;
        }
        if (key.length <= prefix.length || !key.subarray(0, prefix.length).equals(prefix)) continue;
        const k = decodeString(key.subarray(prefix.length));
        if (tag === 1) out.set(k, decodeString(val));
        else out.delete(k);
      }
    } catch {
      /* corrupt/truncated tail of the log: keep what was read so far */
    }
  }
  return out;
}

// Inspect a "Local Storage/leveldb" directory.
//   entries – Map of the origin's keys found in the log files
//   hasTables – true if compacted .ldb tables exist (not parsed here)
function readLegacyOrigin(dir, origin) {
  const result = { entries: new Map(), hasTables: false, exists: false };
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return result;
  }
  result.exists = true;
  result.hasTables = files.some((f) => f.endsWith('.ldb') || f.endsWith('.sst'));
  const logs = files.filter((f) => f.endsWith('.log')).sort(); // log numbers increase over time
  for (const f of logs) readOriginFromLog(path.join(dir, f), origin, result.entries); // in order, so later deletes apply
  return result;
}

module.exports = { readLegacyOrigin, readOriginFromLog };
