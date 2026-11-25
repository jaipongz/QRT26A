// SSH host key verification, OpenSSH-compatible.
// Order: keys the user trusted in QRT → ~/.ssh/known_hosts → /etc/ssh/ssh_known_hosts.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_FILES = [path.join(os.homedir(), '.ssh', 'known_hosts'), '/etc/ssh/ssh_known_hosts'];

function keyType(key) {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

// OpenSSH style: SHA256:<base64 without padding>
function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

// Name as written in known_hosts: "host" for port 22, "[host]:port" otherwise.
function hostName(host, port) {
  return Number(port) === 22 ? host : `[${host}]:${port}`;
}

function globToRegExp(p) {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

function patternMatches(pattern, name) {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    return crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash;
  }
  if (pattern.includes('*') || pattern.includes('?')) return globToRegExp(pattern).test(name);
  return pattern.toLowerCase() === name.toLowerCase();
}

// true if the comma-separated host list matches (negated "!pattern" entries veto).
function hostListMatches(list, name) {
  let hit = false;
  for (const p of list.split(',')) {
    if (p.startsWith('!')) {
      if (patternMatches(p.slice(1), name)) return false;
    } else if (patternMatches(p, name)) hit = true;
  }
  return hit;
}

function readKnownHosts(files = SYSTEM_FILES) {
  const entries = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      let marker = null;
      if (parts[0].startsWith('@')) marker = parts.shift();
      if (parts.length < 3) continue;
      entries.push({ marker, hosts: parts[0], type: parts[1], key: parts[2], file });
    }
  }
  return entries;
}

// → { status: 'match' | 'mismatch' | 'revoked' | 'unknown', known?: [{type, fingerprint, file}] }
function lookupSystem(host, port, key, files) {
  const name = hostName(host, port);
  const type = keyType(key);
  const b64 = key.toString('base64');
  const entries = readKnownHosts(files);
  if (entries.some((e) => e.marker === '@revoked' && e.key === b64)) return { status: 'revoked' };
  const forHost = entries.filter((e) => !e.marker && hostListMatches(e.hosts, name));
  if (forHost.some((e) => e.type === type && e.key === b64)) return { status: 'match' };
  const sameType = forHost.filter((e) => e.type === type);
  if (sameType.length) {
    return {
      status: 'mismatch',
      known: sameType.map((e) => ({ type: e.type, fingerprint: fingerprint(Buffer.from(e.key, 'base64')), file: e.file })),
    };
  }
  return { status: 'unknown', known: forHost.map((e) => ({ type: e.type, fingerprint: fingerprint(Buffer.from(e.key, 'base64')), file: e.file })) };
}

module.exports = { keyType, fingerprint, hostName, lookupSystem, hostListMatches };
