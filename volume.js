// The Field's volume rules, for the browser.

export const CHUNK = 4080;
// First free name in this series. Earlier files of the same series are taken
// off before the size is chosen. padd.ing is a retired name: it stays on the
// device and is counted, and a copy in the local folder is removed once.
export const PADDING_NAME = 'mtp-1f-pad.bin';
// Padding files written by earlier installs end in this and are treated as ours.
const isLegacyPad = (name) => /-install-padding\.bin$/.test(name);
export const RETIRED_LOCAL_PAD = 'padd.ing';
export const PARK_PREFIX = 'park.';
export const OBJECT_EDGE_MARGIN = 20;
export const LDR_MIN = 9488;
export const LDR_MAX = 8388096;
export const PUSH_ROUTES = { '.ldr': 'os.ldr', '.pack': 'user/pk/' };
export const PULL_ROUTES = { '.txt': 'logs/' };
// Running OS, SysEx command 4, payload [1, 2]. At 0x8fc8cbb4 mode 1 jumps to the
// Shift-held path (0x8fc8cd86, the mass-storage disk) and modes 2 and 3 share the
// path that releases Shift before T4 (0x8fc8cc52), which is MTP. 7-bit packed.
export const MTP_ENTER = [0x00, 0x20, 0x76, 0x00, 0x40, 0x60, 0x01, 0x04, 0x00, 0x01, 0x02];

export class Refused extends Error {}

const parts = (path) => path.split('/');
const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const suffix = (name) => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');

export function tnodesOf(size) {
  const c = Math.ceil(size / CHUNK);
  if (c < 16) return 1;
  let n = Math.floor(c / 16) + 1;
  for (let level = 1; c / 16 >= 8 ** (level - 1); level++) n += Math.floor(c / (16 * 8 ** level)) + 1;
  return n;
}

function batches(nObj, nTn) {
  return Math.max(1, Math.ceil(nObj / 100)) + Math.ceil(nTn / 100);
}

function residue(b, mount = 'checkpoint') {
  let k;
  if (mount === 'checkpoint') k = b <= 39 ? 0 : 1 + Math.floor((b - 40) / 9);
  else k = b === 1 ? 0 : b <= 39 ? 1 : 2 + Math.floor((b - 40) / 9);
  return (8 * (b + k)) % 32;
}

function margin(nObj, nTn) {
  const one = (n) => (n ? Math.min((n - 1) % 100, 100 - ((n - 1) % 100) - 1) : 0);
  return Math.min(one(nObj), one(nTn));
}

export function verdict(nObj, nTn) {
  const b = batches(nObj, nTn);
  return { n_obj: nObj, n_tnodes: nTn, batches: b, checkpoint: residue(b), scan: residue(b, 'scan'), margin: margin(nObj, nTn) };
}

export function objectEdgeMargin(nObj) {
  return Math.min((nObj - 1) % 100, 100 - ((nObj - 1) % 100) - 1);
}

export function parkFilesForEdge(nObjWithPad) {
  for (let extra = 0; extra < 60; extra++) if (objectEdgeMargin(nObjWithPad + extra) >= OBJECT_EDGE_MARGIN) return extra;
  throw new Refused('cannot move object count off a batch edge with parking files');
}

export function proposedNeedsPadding(nObj, nTn) {
  if (nObj < 4 || nTn < 0) throw new Refused('invalid volume count estimates');
  const after = verdict(nObj, nTn);
  return [!(after.checkpoint === 0 && after.margin >= OBJECT_EDGE_MARGIN), after];
}

export function paddingPlan(nObj, nTn, oldSizes = []) {
  if (nObj < 4 || nTn < 0) throw new Refused('invalid volume count estimates');
  nObj -= oldSizes.length;
  nTn -= oldSizes.reduce((sum, size) => sum + tnodesOf(size), 0);
  if (nTn < 0) throw new Refused('padding exceeds estimated tnodes');
  const parkCount = parkFilesForEdge(nObj + 1);
  const objects = nObj + 1 + parkCount;
  const tn = nTn + parkCount;
  const cap = Math.floor((64 * 1024 * 1024) / CHUNK);
  for (let batch = Math.floor(tn / 100) + 1; batch < Math.floor(tn / 100) + 16; batch++) {
    const extra = batch * 100 - 50 - tn;
    if (extra <= 0) continue;
    let lo = 1, hi = cap;
    if (tnodesOf(hi * CHUNK) < extra) break;
    while (lo < hi) {
      const middle = Math.floor((lo + hi) / 2);
      if (tnodesOf(middle * CHUNK) < extra) lo = middle + 1; else hi = middle;
    }
    const size = lo * CHUNK;
    const after = verdict(objects, tn + tnodesOf(size));
    if (after.checkpoint === 0 && after.margin >= OBJECT_EDGE_MARGIN) {
      return { padding_bytes: size, padding_tnodes: tnodesOf(size), after, park_count: parkCount };
    }
  }
  throw new Refused('no supported padding plan within the 64 MiB bound');
}

export function isOwnPad(remote) {
  return /^mtp-1f-pad(?:-[0-9]+)?\.bin$/.test(remote);
}

export function padName(taken) {
  const top = new Set([...taken].filter((name) => !name.includes('/')).map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? PADDING_NAME : 'mtp-1f-pad-' + n + '.bin';
    if (!top.has(name)) return name;
  }
}

export function transferPriority(remote) {
  if (remote === 'os.ldr') return 4;
  if (isOwnPad(remote)) return 3;
  if (remote.startsWith(PARK_PREFIX)) return 2;
  if (baseName(remote) === 'base.pack' && remote.startsWith('user/pk/')) return 1;
  return 0;
}

export function contentDestination(remote) {
  const p = parts(remote);
  if (!remote || remote.startsWith('/') || p.includes('..') || p.includes('') || p.includes('.')
      || remote.includes('\\') || [...remote].some((c) => c.charCodeAt(0) < 32)) return false;
  if (remote === 'os.ldr' || isOwnPad(remote) || remote === RETIRED_LOCAL_PAD || remote.startsWith(PARK_PREFIX)) return true;
  const leaf = baseName(remote);
  if (p[0] === 'upgrade' || leaf.startsWith('bootloader.') || leaf.startsWith('spiboot.')
      || suffix(leaf) === '.ldr') return false;
  return true;
}

// Names that appear as their own word ending in .svg. The firmware file holds the
// picture names it opens; this reads those words back out.
// A pack header names itself. Byte 16 is the first four bytes of the firmware
// file's SHA-256, little-endian. 0x1aeb34d1 is stock OS 1.7.3. 0xd67577f9 is stock OS 1.7.0.
export function packHeader(bytes) {
  if (!bytes || bytes.length < 96) return null;
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== 'OP1FPACK') return null;
  const word = (at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  if (word(8) !== 3 || word(12) < 96) return null;
  let name = '';
  for (let i = 40; i < 56 && bytes[i]; i++) {
    const c = bytes[i];
    if (c < 32 || c > 126) return null;
    name += String.fromCharCode(c);
  }
  if (!name) return null;
  return { format: 3, firmware: word(16), name, version: word(72), interface: word(76) };
}

export function firmwareWord(hex) {
  const text = String(hex || '').slice(0, 8);
  if (!/^[0-9a-fA-F]{8}$/.test(text)) return null;
  const b = text.match(/../g).map((part) => parseInt(part, 16));
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

// The OS the pack loader is for. A pack built for another OS is never the one to use when a build for this one exists.
export const LOADER_OS = '1.7.3';

export function knownOs(word) {
  if (word === 0x1aeb34d1) return '1.7.3';
  if (word === 0xd67577f9) return '1.7.0';
  return '';
}

export function osName(word) {
  const known = knownOs(word);
  return known ? 'OS ' + known : '';
}

// The two known words name an OS generation. Any other word is a built image, and the OS is not in the file.
export function firmwareLabel(word) {
  const known = knownOs(word);
  if (known) return 'OS ' + known;
  if (word == null) return '';
  return 'custom build';
}

export function firmwareFacts(locals, fieldDigest) {
  const local = [];
  for (const item of locals || []) {
    const word = firmwareWord(item && item.digest);
    if (word == null) continue;
    local.push({ path: item.path || item.name || '', word });
  }
  return { local, field: fieldDigest ? firmwareWord(fieldDigest) : null };
}

// A pack is compared with the Field only when the Field's os.ldr is one of the two known OS images.
// A file in the folder is not the device, and a built image does not name its OS generation.
export function packIdentity(header, facts) {
  if (!header) return null;
  const os = knownOs(header.firmware);
  const fieldOs = facts && knownOs(facts.field);
  let match = '';
  if (fieldOs && os && fieldOs === os) match = 'matches this Field';
  else if (fieldOs && os) match = 'this Field is OS ' + fieldOs;
  return {
    name: header.name, version: header.version, interface: header.interface,
    os: os ? 'for OS ' + os : '',
    match,
  };
}

// The pack loader's room and the three calls it makes for itself.
// A pack that meets one of those calls is left out, meeting "the loader".
const PACK_BASE = 0x8d2f4234;
const PACK_ROOM = 0x001f0000;
const LOADER_BASE = 0x8d2e4234;
const LOADER_NAME = 'op1f_loader_1';
const LOADER_SITES = [
  { kind: 0x10, site: 0x8490fc4c },
  { kind: 0x12, site: 0x8fcafc0a },
  { kind: 0x12, site: 0x8c0b43e4 },
];
const LEVELS_FROM_BASE = ['op1f_level_1', 'op1f_level_2', 'op1f_level_3'];

const u32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
let crcTable = null;
function crc32(bytes, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xedb88320) : (c >>> 1);
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
const hexSite = (site) => '0x' + (site >>> 0).toString(16).padStart(8, '0');
function beforeName(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.charCodeAt(i) < b.charCodeAt(i);
  return a.length < b.length;
}
function packFileName(name) {
  if (!name || name.length < 6 || name.length > 39) return false;
  const first = name.charCodeAt(0);
  if (first === 46 || first === 32) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || '/\\:*?"<>|'.includes(name[i])) return false;
  }
  const tail = name.slice(-5).toLowerCase();
  return tail === '.pack';
}
function cstring(bytes, offset) {
  let text = '';
  for (let i = offset; i < bytes.length && bytes[i]; i++) text += String.fromCharCode(bytes[i]);
  return text;
}
function shapeOf(kind) {
  let real = kind >>> 0;
  let trampoline = 0;
  let known = true;
  if (real > 5) {
    trampoline = real >>> 16;
    const low = real & 0xf;
    if ((real & 0xfff0) !== 0x10 || low > 5) known = false;
    if (trampoline !== 0 && (trampoline < 8 || trampoline > 14 || (trampoline & 1) || low === 0 || low === 5)) known = false;
    real = low;
  }
  const span = real === 0 ? 4 : (trampoline > 8 ? trampoline : 8);
  return { known, kind: real, trampoline, span };
}
function sitesMeet(a, b) {
  const aSpan = shapeOf(a.kind).span;
  const bSpan = shapeOf(b.kind).span;
  return a.site < ((b.site + bSpan) >>> 0) && b.site < ((a.site + aSpan) >>> 0);
}
function writePlace(body, bodyAddress, offset, kind, address) {
  const put16 = (at, value) => { body[at] = value & 0xff; body[at + 1] = (value >>> 8) & 0xff; };
  if (kind === 0) put16(offset, address >>> 16);
  else if (kind === 1) put16(offset, address & 0xffff);
  else if (kind === 2) { put16(offset, address & 0xffff); put16(offset + 2, address >>> 16); }
  else {
    const from = (bodyAddress + offset - 2) >>> 0;
    const steps = ((address - from) >>> 1) & 0xffffff;
    body[offset - 2] = (steps >>> 16) & 0xff;
    put16(offset, steps & 0xffff);
  }
}

// The whole pack, as the loader reads it. A failure here is the loader's own sentence.
// Nothing in the file is changed.
export function readPack(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  const fail = (why, sentence) => ({ ok: false, why, sentence, raw, name: '', works: [], exports: [], imports: [], marks: [], places: [], entries: [] });
  if (raw.length < 96) return fail('read', 'its file is too short to be a pack');
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(raw[i]);
  if (magic !== 'OP1FPACK') return fail('none', 'is not a pack');
  const format = u32(raw, 8);
  const headerBytes = u32(raw, 12);
  const firmware = u32(raw, 16);
  const link = u32(raw, 20);
  const bodyBytes = u32(raw, 24);
  const compare = u32(raw, 28);
  const zeroed = u32(raw, 32);
  const crc = u32(raw, 36);
  let name = '';
  for (let i = 40; i < 56 && raw[i]; i++) {
    const c = raw[i];
    if (c < 32 || c > 126) return fail('header', 'its header is damaged');
    name += String.fromCharCode(c);
  }
  if (!name) return fail('header', 'its header has no name');
  if (format !== 3) return fail('header', `its format (${format}) is not one this loader reads`);
  if (headerBytes === 96 && firmware !== 0x1aeb34d1) {
    const built = knownOs(firmware);
    return { ...fail('firmware', built ? `built for OS ${built}, not 1.7.3` : 'built for a different OS than 1.7.3'), name, firmware };
  }
  const table = u32(raw, 56);
  const tableEnd = u32(raw, 60);
  const listsBytes = u32(raw, 64);
  const extra = u32(raw, 68);
  const version = u32(raw, 72);
  const interface_ = u32(raw, 76);
  const align = u32(raw, 80);
  const cardPlace = u32(raw, 92);
  const pathPlace = u32(raw, 88);
  const alignOk = [1, 2, 4, 8, 16, 32].includes(align);
  const tableSpan = (tableEnd - table) >>> 0;
  const headerOk = headerBytes === 96 && firmware === 0x1aeb34d1 && (link & 3) === 0 && alignOk
    && bodyBytes !== 0 && (bodyBytes & 3) === 0 && bodyBytes <= PACK_ROOM && zeroed <= PACK_ROOM
    && listsBytes >= 24 && (listsBytes & 3) === 0 && listsBytes <= PACK_ROOM && extra <= 0x40000000
    && raw.length === 96 + bodyBytes + listsBytes + extra
    && compare !== 0 && compare <= bodyBytes
    && table >= link && tableEnd >= table && (tableEnd - link) >>> 0 <= compare
    && (table & 3) === 0 && tableSpan <= 4096 * 20 && tableSpan % 20 === 0
    && (pathPlace === 0 || ((pathPlace & 3) === 0 && bodyBytes >= 48 && pathPlace <= bodyBytes - 48));
  if (!headerOk) return fail('header', 'its header is damaged or does not describe this file');
  if (cardPlace !== 0 && ((cardPlace & 3) !== 0 || bodyBytes < 8 || cardPlace > bodyBytes - 8)) return fail('card', 'its card is malformed');
  const got = crc32(raw, 96, 96 + bodyBytes + listsBytes);
  if (got !== crc) return fail('sum', 'its contents do not match its checksum');
  if (cardPlace !== 0) {
    const mark = u32(raw, 96 + cardPlace);
    const size = u32(raw, 96 + cardPlace + 4);
    if (mark !== 0x44524143 || (size & 3) !== 0 || size < 8 || size > bodyBytes - cardPlace) return fail('card', 'its card is malformed');
  }
  const listsAt = 96 + bodyBytes;
  const counts = [0, 1, 2, 3, 4, 5].map((i) => u32(raw, listsAt + i * 4));
  const [worksN, exportsN, importsN, placesN, marksN, stringsN] = counts;
  const limit = listsBytes;
  const fixed = 24 + 12 * worksN + 8 * exportsN + 8 * importsN + 12 * placesN + 8 * marksN;
  if ([worksN, exportsN, importsN, placesN, marksN, stringsN].some((n) => n > limit) || importsN > 0xfffe
      || fixed > limit || fixed + stringsN !== limit || (stringsN & 3) !== 0) {
    return fail('lists', 'its tables are malformed');
  }
  let at = listsAt + 24;
  const stringsAt = at + 12 * worksN + 8 * exportsN + 8 * importsN + 12 * placesN + 8 * marksN;
  const strings = raw.subarray(stringsAt, stringsAt + stringsN);
  const named = worksN + exportsN + importsN > 0;
  if (named && (stringsN === 0 || strings[stringsN - 1] !== 0)) return fail('lists', 'its tables are malformed');
  const text = (offset) => (offset >= stringsN ? null : cstring(strings, offset));
  const works = [];
  for (let i = 0; i < worksN; i++) {
    const offset = u32(raw, at); const face = u32(raw, at + 4); const flags = u32(raw, at + 8); at += 12;
    if (offset >= stringsN) return fail('lists', 'its tables are malformed');
    works.push({ name: text(offset), interface: face, needed: (flags & 1) !== 0 });
  }
  const exports_ = [];
  for (let i = 0; i < exportsN; i++) {
    const offset = u32(raw, at); const bodyAt = u32(raw, at + 4); at += 8;
    if (offset >= stringsN || bodyAt >= bodyBytes + zeroed) return fail('lists', 'its tables are malformed');
    exports_.push({ name: text(offset), offset: bodyAt });
  }
  const imports_ = [];
  for (let i = 0; i < importsN; i++) {
    const offset = u32(raw, at); const flags = u32(raw, at + 4); at += 8;
    if (offset >= stringsN) return fail('lists', 'its tables are malformed');
    imports_.push({ name: text(offset), needed: (flags & 1) !== 0 });
  }
  const places = [];
  for (let i = 0; i < placesN; i++) {
    const where = u32(raw, at); const word = u32(raw, at + 4); const linked = u32(raw, at + 8); at += 12;
    const kind = word & 0xff; const wanted = word >>> 16;
    const size = kind === 2 ? 4 : 2; const low = kind === 3 ? 2 : 0;
    if (kind > 3 || (word & 0xff00) !== 0 || (where & 1) !== 0 || where < low || where > bodyBytes - size) return fail('lists', 'its tables are malformed');
    if (wanted > importsN) return fail('lists', 'its tables are malformed');
    if (kind === 3 && (wanted === 0 || !imports_[wanted - 1].needed)) return fail('lists', 'its tables are malformed');
    places.push({ offset: where, kind, wanted, linked });
  }
  const entryCount = tableSpan / 20;
  if (marksN > 64) return fail('lists', 'its tables are malformed');
  const marks = [];
  for (let i = 0; i < marksN; i++) {
    const entry = u32(raw, at); const work = u32(raw, at + 4); at += 8;
    if (entry >= entryCount || work >= worksN) return fail('lists', 'its tables are malformed');
    marks.push({ entry, work });
  }
  const entries = [];
  const tableAt = 96 + ((table - link) >>> 0);
  for (let i = 0; i < entryCount; i++) {
    const cursor = tableAt + i * 20;
    entries.push({ kind: u32(raw, cursor), site: u32(raw, cursor + 4), target: u32(raw, cursor + 8), sum: u32(raw, cursor + 12), room: u32(raw, cursor + 16) });
  }
  let release = '';
  const offered = exports_.find((row) => row.name === 'op1f_release');
  if (offered) {
    for (let i = 0; i < 16; i++) {
      if (offered.offset + i >= bodyBytes) { release = ''; break; }
      const c = raw[96 + offered.offset + i];
      if (c === 0) break;
      if (c < 0x21 || c > 0x7e) { release = ''; break; }
      release += String.fromCharCode(c);
      if (i === 15) release = '';
    }
  }
  return {
    ok: true, why: '', sentence: '', raw, name, firmware, version, interface: interface_, link, bodyBytes, zeroed,
    listsBytes, table, tableEnd, card: cardPlace !== 0, works, exports: exports_, imports: imports_, places, marks, entries, release,
  };
}

function placedEntries(pack, place) {
  const body = pack.raw.subarray(96, 96 + pack.bodyBytes).slice();
  const distance = (place - pack.link) >>> 0;
  for (const rec of pack.places) {
    if (rec.wanted) continue;
    writePlace(body, place, rec.offset, rec.kind, (rec.linked + distance) >>> 0);
  }
  const tableAt = (pack.table - pack.link) >>> 0;
  const count = ((pack.tableEnd - pack.table) >>> 0) / 20;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = tableAt + i * 20;
    entries.push({ kind: u32(body, at), site: u32(body, at + 4), target: u32(body, at + 8), sum: u32(body, at + 12), room: u32(body, at + 16) });
  }
  return entries;
}

function tableProblem(pack, place) {
  const entries = placedEntries(pack, place);
  const codeEnd = (place + pack.bodyBytes) >>> 0;
  const zeroEnd = (codeEnd + pack.zeroed) >>> 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const shape = shapeOf(entry.kind);
    if (!shape.known) return 'it uses a kind of patch this loader does not know';
    const l1 = shape.kind === 1 || shape.kind === 3;
    const low = l1 ? 0x11a00000 : 0x80000000;
    const high = l1 ? 0x11a10000 : 0x90000000;
    if (entry.site < low || entry.site > ((high - shape.span) >>> 0) || (entry.site & (shape.kind === 0 ? 3 : 1)) !== 0) {
      return 'it patches memory the firmware does not have, or at a misaligned address';
    }
    if (entry.target < place || entry.target >= codeEnd) return "one of its patches points outside the pack's own code";
    const need = shape.trampoline + 8;
    if (shape.trampoline === 0 ? entry.room !== 0
      : (zeroEnd < codeEnd || (zeroEnd - codeEnd) >>> 0 < need || entry.room < codeEnd || entry.room > ((zeroEnd - need) >>> 0) || (entry.room & 1) !== 0)) {
      return "a patch's trampoline space is outside the pack's zeroed data, or overlaps another's";
    }
    for (let other = 0; other < index; other++) {
      const prior = entries[other];
      const priorShape = shapeOf(prior.kind);
      if (sitesMeet(entry, prior)) return 'two of its patches overwrite the same bytes';
      if (shape.trampoline && priorShape.trampoline) {
        const priorNeed = priorShape.trampoline + 8;
        if (prior.room < ((entry.room + need) >>> 0) && entry.room < ((prior.room + priorNeed) >>> 0)) {
          return "a patch's trampoline space is outside the pack's zeroed data, or overlaps another's";
        }
      }
    }
  }
  pack.placed = entries;
  return '';
}

// files: [{file, bytes, onUnit, inFolder}]. The set is what user/pk will hold.
// The packs/ mirror is not passed twice. Same pack name: the higher version is placed.
// How many pack files the loader looks at. The page assumes this figure and
// then trusts the Field: at every boot the loader logs how many pack files it looked at and how many it left
// unread. A log that shows pack files left unread says where the loader stopped; a log that shows more looked at
// than the figure says the limit was raised.
export const PACK_LIMIT = 32;
const LOADER_FOLDER_LINE = /loader: the folder .*?: (\d+) pack\(s\) of the new kind and (\d+) of the old in (\d+) file\(s\); (\d+) more not looked at/g;
export function packLimitFromLog(text, known = PACK_LIMIT) {
  let last = null;
  for (const match of String(text || '').matchAll(LOADER_FOLDER_LINE)) last = match;
  if (!last) return null;
  const looked = Number(last[3]);
  const unread = Number(last[4]);
  if (unread > 0) return { limit: looked, source: 'log' };
  if (looked > known) return { limit: looked, source: 'log' };
  return { limit: known, source: 'known' };
}

// Of packs given as {file, firmware}, those built for a known OS other than `os`: the loader for `os` leaves them
// out at every boot, so they only take up one of its pack slots.
export function packsForOtherOs(packs, os) {
  return (packs || []).filter((pack) => {
    const built = knownOs(pack.firmware);
    return built && built !== os;
  }).map((pack) => ({ file: pack.file, os: knownOs(pack.firmware) }));
}

// Pack files that will sit in user/pk, by name (the Field's names do not tell capitals apart).
export function packSetSize(names) {
  return new Set((names || []).map((name) => String(name).toLowerCase())).size;
}

export function settlePacks(files, limit = PACK_LIMIT) {
  const rows = (files || []).map((item) => ({
    file: String(item.file || ''),
    onUnit: !!item.onUnit,
    inFolder: item.inFolder !== false,
    pack: readPack(item.bytes),
    state: 'new',
    why: '',
    sentence: '',
    detail: '',
    other: '',
    otherFile: '',
    site: '',
    place: 0,
  }));
  rows.sort((a, b) => (beforeName(a.file, b.file) ? -1 : a.file === b.file ? 0 : 1));
  const unread = [];
  const looked = [];
  for (const row of rows) {
    if (!packFileName(row.file)) {
      unread.push({ file: row.file, onUnit: row.onUnit, sentence: `${row.file} is skipped: the loader does not accept this file name (6 to 39 characters ending in .pack, none of / \\ : * ? " < > |).` });
      continue;
    }
    if (looked.length >= limit) {
      unread.push({ file: row.file, onUnit: row.onUnit, sentence: `${row.file} is skipped: the loader reads at most ${limit} pack files, in name order.` });
      continue;
    }
    looked.push(row);
  }
  for (const row of looked) {
    if (!row.pack.ok && row.pack.why === 'none') { row.state = 'none'; continue; }
    if (!row.pack.ok) {
      row.state = 'out'; row.why = row.pack.why;
      row.sentence = `${row.pack.name || row.file.replace(/\.pack$/i, '')} is left out: ${row.pack.sentence}`;
    }
    else row.state = 'new';
  }
  let next = PACK_BASE;
  const roomEnd = (PACK_BASE + PACK_ROOM) >>> 0;
  for (let i = 0; i < looked.length; i++) {
    const row = looked[i];
    while (row.state === 'new') {
      let best = row;
      for (let k = i; k < looked.length; k++) {
        const other = looked[k];
        if (other.state === 'new' && other.pack.name === row.pack.name && (other.pack.version >>> 0) > (best.pack.version >>> 0)) best = other;
      }
      const foot = best.pack.bodyBytes + Math.max(best.pack.listsBytes, best.pack.zeroed);
      const place = (next + (((best.pack.link - next) >>> 0) & 31)) >>> 0;
      if (place > roomEnd || foot > ((roomEnd - place) >>> 0)) {
        best.state = 'out'; best.why = 'room';
        best.sentence = `${best.pack.name} is left out: it does not fit in the memory the loader has for packs`;
        continue;
      }
      best.pack.placed = placedEntries(best.pack, place);
      best.state = 'in';
      best.place = place;
      next = (place + ((foot + 3) & ~3)) >>> 0;
      for (const other of looked) {
        if (other !== best && other.state === 'new' && other.pack.name === best.pack.name) {
          other.state = 'spare';
          other.otherFile = best.file;
          other.sentence = `${other.file} (${other.pack.name} version ${other.pack.version}) is ignored: ${best.file} has version ${best.pack.version} of the same pack.`;
        }
      }
    }
  }
  const running = () => looked.filter((row) => row.state === 'in');
  const named = (name, but) => running().find((row) => row !== but && row.pack.name === name);
  const inFolder = (name) => looked.some((row) => row.pack.name === name && (
    row.state === 'in' || row.state === 'spare' || (row.state === 'out' && ['needs', 'interface', 'name', 'import', 'reach', 'table', 'claim'].includes(row.why))));
  const addressOf = (name, self) => {
    if (name === LOADER_NAME) return LOADER_BASE;
    for (const row of looked) {
      if (row === self || row.state !== 'in') continue;
      const found = row.pack.exports.find((item) => item.name === name);
      if (found) return (row.place + found.offset) >>> 0;
    }
    return 0;
  };
  const markedAway = (row, index) => row.pack.marks.some((mark) => mark.entry === index && named(row.pack.works[mark.work].name, row));
  const judge = (row) => {
    const problem = tableProblem(row.pack, row.place);
    if (problem) { row.why = 'table'; return `${row.pack.name} is left out: ${problem}`; }
    for (const work of row.pack.works) {
      const other = named(work.name, row);
      if (!other && work.needed) {
        row.detail = inFolder(work.name) ? '' : work.name;
        row.why = 'needs';
        return `${row.pack.name} is left out: it needs the ${work.name} pack, which is not loading`;
      }
      if (other && other.pack.interface !== work.interface) {
        row.detail = work.name;
        row.why = 'interface';
        return `${row.pack.name} is left out: it was built for a different version of the ${work.name} pack`;
      }
    }
    for (const item of row.pack.exports) {
      if (item.name.startsWith('op1f_loader_')) {
        row.detail = item.name; row.why = 'name';
        return `${row.pack.name} is left out: it uses ${item.name}, a name reserved for the loader`;
      }
      for (const earlier of looked) {
        if (earlier === row) break;
        if (earlier.state !== 'in') continue;
        if (earlier.pack.exports.some((exp) => exp.name === item.name)) {
          row.detail = item.name; row.other = earlier.pack.name; row.otherFile = earlier.file; row.why = 'name';
          return `${row.pack.name} is left out: ${earlier.pack.name} already provides ${item.name}`;
        }
      }
    }
    for (const item of row.pack.imports) {
      if (item.needed && addressOf(item.name, row) === 0) {
        row.detail = item.name; row.why = 'import';
        return `${row.pack.name} is left out: ` + (LEVELS_FROM_BASE.includes(item.name) ? 'it needs the base pack, which is not loading' : `it needs ${item.name}, which no loaded pack provides`);
      }
    }
    const entries = row.pack.placed || row.pack.entries;
    for (let index = 0; index < entries.length; index++) {
      if (markedAway(row, index)) continue;
      const entry = entries[index];
      if (LOADER_SITES.some((site) => sitesMeet(entry, site))) {
        row.site = hexSite(entry.site); row.other = 'the loader'; row.why = 'claim';
        return `${row.pack.name} is left out: it patches the firmware at ${row.site}, which the loader itself uses`;
      }
      for (const earlier of looked) {
        if (earlier === row) break;
        if (earlier.state !== 'in') continue;
        const theirs = earlier.pack.placed || earlier.pack.entries;
        for (let t = 0; t < theirs.length; t++) {
          if (markedAway(earlier, t)) continue;
          if (sitesMeet(entry, theirs[t])) {
            row.site = hexSite(entry.site); row.other = earlier.pack.name; row.otherFile = earlier.file; row.why = 'claim';
            return `${row.pack.name} is left out: it patches the firmware at ${row.site}, which ${earlier.pack.name} already patches`;
          }
        }
      }
    }
    return '';
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of looked) {
      if (row.state !== 'in') continue;
      const sentence = judge(row);
      if (sentence) { row.state = 'out'; row.sentence = sentence; changed = true; }
    }
  }
  const live = running();
  const outRows = looked.filter((row) => row.state === 'out');
  const left = outRows.map((row) => {
    let fix = 'omit';
    if (row.why === 'needs') fix = row.detail ? 'stage' : 'none';
    if (row.why === 'import' && LEVELS_FROM_BASE.includes(row.detail)) fix = looked.some((item) => item.pack.name === 'base') ? 'none' : 'stage';
    if (row.why === 'claim' && row.other && row.other !== 'the loader') fix = 'keep';
    return {
      file: row.file, name: row.pack.name || row.file.replace(/\.pack$/i, ''), why: row.why, sentence: row.sentence,
      fix, detail: row.why === 'import' && fix === 'stage' ? 'base' : row.detail,
      other: row.other, otherFile: row.otherFile, site: row.site, onUnit: row.onUnit,
    };
  });
  const notes = [];
  for (const row of looked) {
    if (row.state !== 'in') continue;
    for (const item of row.pack.imports) {
      if (!item.needed && addressOf(item.name, row) === 0) notes.push({ file: row.file, name: row.pack.name, sentence: `${row.pack.name} runs; ${item.name} is absent` });
    }
  }
  for (const row of live) {
    if (row.onUnit && !row.inFolder) notes.push({ file: row.file, name: row.pack.name, sentence: `${row.pack.name} is on the Field but not in your folder. It still runs.` });
  }
  const aside = looked.filter((row) => row.state === 'spare').map((row) => ({ file: row.file, name: row.pack.name, sentence: row.sentence, onUnit: row.onUnit }));
  const clashes = left.filter((row) => row.why === 'claim' && row.other && row.other !== 'the loader').map((row) => {
    const earlier = looked.find((item) => item.file === row.otherFile);
    const later = looked.find((item) => item.file === row.file);
    return { ...row, sequencers: !!(earlier && later && earlier.pack.card && later.pack.card && earlier.pack.name !== 'base' && later.pack.name !== 'base') };
  });
  return {
    blocked: left.length > 0 || unread.length > 0,
    running: live.map((row) => ({ file: row.file, name: row.pack.name, version: row.pack.version, onUnit: row.onUnit, inFolder: row.inFolder })),
    aside, notes, left, unread, clashes,
  };
}

export function creatableFolders(missing, current) {
  const want = new Set(missing);
  if (want.has('user') && [...want].some((p) => p === 'user/pk' || p.startsWith('user/pk/'))) {
    throw new Refused('the unit has no folder user; a pack file has nowhere to go');
  }
  const ordered = [...want].sort((a, b) => parts(a).length - parts(b).length || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of ordered) {
    const parent = parentOf(path);
    if (parent === '.') throw new Refused('refusing to create top-level folder over MTP: ' + path);
    if (!(parent in current) && !want.has(parent)) throw new Refused(`cannot create ${path}: parent ${parent} is absent`);
    if (parent in current && current[parent].kind !== 'folder') throw new Refused(`cannot create ${path}: parent ${parent} is a file`);
  }
  return ordered;
}

// Rows are {id, parent, name, kind, size}; returns {path: row}. A partial tree is refused.
export function inventoryPaths(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.id) || row.id <= 0 || byId.has(row.id) || !Number.isInteger(row.parent) || row.parent < 0
        || !['file', 'folder'].includes(row.kind) || !Number.isInteger(row.size) || row.size < 0
        || typeof row.name !== 'string' || !row.name || row.name === '.' || row.name === '..'
        || /[\/\\]/.test(row.name) || [...row.name].some((c) => c.charCodeAt(0) < 32)) {
      throw new Refused('invalid or duplicate MTP object');
    }
    byId.set(row.id, row);
  }
  const result = {}, resolved = new Map(), active = new Set();
  const resolve = (id) => {
    if (resolved.has(id)) return resolved.get(id);
    if (!byId.has(id) || active.has(id)) throw new Refused('incomplete or cyclic MTP folder tree');
    active.add(id);
    const row = byId.get(id);
    let path = row.name;
    if (row.parent !== 0 && row.parent !== 0xffffffff) {
      const prefix = resolve(row.parent);
      if (byId.get(row.parent).kind !== 'folder') throw new Refused('MTP object has a file as its parent');
      path = prefix + '/' + row.name;
    }
    if (path in result) throw new Refused('duplicate MTP path: ' + path);
    active.delete(id);
    resolved.set(id, path);
    result[path] = row;
    return path;
  };
  for (const id of byId.keys()) resolve(id);
  return result;
}

// The running instrument's MTP is the virtual tree. The boot menu's volume is the installer disk.
export function volumeKind(current) {
  return Object.keys(current).some((path) => /^(tapes|mixdown|synth|drum)(\/|$)/.test(path)) ? 'instrument' : 'boot';
}

// Where .pack files already live. The boot volume uses user/pk. The instrument disk does not.
function folderName(current, path) {
  return (current[path] && current[path].name) || path.split('/').pop();
}

// A pk or packs directory, or the instrument folder that already holds the packs.
// No such directory means this disk has no pack folder.
export function packDirectory(current) {
  const folders = Object.keys(current || {}).filter((path) => current[path] && current[path].kind === 'folder');
  const named = folders.filter((path) => folderName(current, path) === 'pk' || folderName(current, path) === 'packs');
  if (volumeKind(current || {}) !== 'instrument') {
    if (folders.includes('user/pk')) return 'user/pk';
    return named[0] || null;
  }
  const packs = Object.keys(current || {}).filter((path) => current[path].kind === 'file' && path.toLowerCase().endsWith('.pack'));
  if (packs.length) {
    const dirs = packs.map((path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''));
    const counts = new Map();
    for (const dir of dirs) counts.set(dir, (counts.get(dir) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  }
  return named[0] || null;
}

// USB identity for the chooser. Android and other MTP devices use other vendors.
export function isOp1Usb(device) {
  if (!device || device.vendorId !== 0x2367) return false;
  if (device.productId !== 0x0102 && device.productId !== 0x8102) return false;
  const name = device.productName || '';
  return !name || /^op-?1\b/i.test(name);
}

// PTP ObjectInfo dates look like 20261119T183045. Empty and unreadable dates are unknown.
export function mtpDate(text) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(text || '');
  if (!match) return null;
  const value = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
  return Number.isNaN(value) ? null : value;
}

// Field DateTime minus this computer's clock. Pack stamps are shifted by it before compare or display.
export function clockOffset(fieldNow, localNow) {
  if (!fieldNow || !localNow) return 0;
  return fieldNow - localNow;
}

export function shiftStamp(stamp, offset) {
  return stamp ? stamp - (offset || 0) : stamp;
}

// Remote dates stay as the device reported them. This copy is shifted by that device's clock.
function timedRow(row, offset) {
  if (!row || !offset) return row;
  return {
    ...row,
    created: shiftStamp(row.created, offset) || 0,
    modified: shiftStamp(row.modified, offset) || 0,
    added: shiftStamp(row.added, offset) || 0,
  };
}

// Newest of created, modified and added. Missing dates do not count.
export function fileStamp(file) {
  if (!file) return 0;
  const times = [file.created, file.modified, file.added].map((n) => Number(n) || 0).filter((n) => n > 0);
  return times.length ? Math.max(...times) : 0;
}

// The newest os.ldr. Locals are files on this computer. remote is the Field's os.ldr.
// A Field time within two seconds of the newest local file does not win, so a same-age
// copy is read from the computer.
export function newestFirmware(locals, remote, offset = 0) {
  const rows = [];
  for (const copy of locals || []) {
    if (!copy || !copy.file) continue;
    rows.push({ where: 'local', stamp: fileStamp(copy), label: copy.path || 'os.ldr', file: copy.file });
  }
  if (remote && remote.kind !== 'folder' && remote.id) {
    rows.push({
      where: 'field',
      stamp: fileStamp({
        created: shiftStamp(remote.created, offset) || 0,
        modified: shiftStamp(remote.modified, offset) || 0,
        added: shiftStamp(remote.added, offset) || 0,
      }),
      label: 'os.ldr on the Field',
      id: remote.id,
    });
  }
  if (!rows.length) return null;
  const top = Math.max(...rows.map((row) => row.stamp || 0));
  const near = rows.filter((row) => top - (row.stamp || 0) < 2000);
  near.sort((a, b) => (a.where === 'local' ? 0 : 1) - (b.where === 'local' ? 0 : 1)
    || (b.stamp - a.stamp) || (a.label < b.label ? -1 : 1));
  return near[0];
}

// Which way one file should move. direction is push, pull, or both.
// Same size with no newer date stays. A size change with no dates is left alone.
export function syncChoice(local, remote, direction) {
  const push = direction !== 'pull';
  const pull = direction !== 'push';
  if (!remote) return push ? 'push' : 'same';
  if (!local) return pull ? 'pull' : 'same';
  const localTime = fileStamp(local);
  const remoteTime = fileStamp(remote);
  if (local.size === remote.size && (!localTime || !remoteTime || Math.abs(localTime - remoteTime) < 2000)) return 'same';
  if (localTime && remoteTime) {
    if (localTime > remoteTime + 2000) return push ? 'push' : 'keep';
    if (remoteTime > localTime + 2000) return pull ? 'pull' : 'keep';
  }
  if (local.size === remote.size) return 'same';
  return 'unsure';
}

function routable(files) {
  return files.filter((f) => !f.name.startsWith('.') && !(f.path || '').split('/').some((part) => part.startsWith('.')));
}

// A log is a log_*.txt anywhere, or a .txt sitting directly in a folder named logs.
// The folder can be the dev-disk root or a folder on the instrument disk beside packs.
export function isDeviceLog(path, name) {
  const base = String(name || '').trim() || String(path || '').split('/').pop();
  if (!base || !base.toLowerCase().endsWith('.txt')) return false;
  if (base.toLowerCase().startsWith('log_')) return true;
  const parts = String(path || '').split('/');
  return parts.length >= 2 && parts[parts.length - 2].toLowerCase() === 'logs';
}

function isLogName(name, path) {
  return isDeviceLog(path || name, name);
}

const osOfHeader = (header) => (header ? knownOs(header.firmware) : '');

// One group per file name. Packs, firmware and logs all use this.
function namedCopies(files, current, acceptLocal, acceptRemote, offset = 0) {
  const groups = new Map();
  const add = (name, copy) => {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(copy);
  };
  for (const file of routable(files)) {
    if (!acceptLocal(file)) continue;
    add(file.name, {
      side: 'local', path: file.path || file.name, size: file.size,
      created: file.created || 0, modified: file.modified || 0, added: file.added || 0,
      digest: file.digest || '', file, os: osOfHeader(file.header),
    });
  }
  for (const [path, row] of Object.entries(current || {})) {
    if (!row || row.kind !== 'file' || !acceptRemote(path, row)) continue;
    const timed = timedRow(row, offset);
    add(row.name || baseName(path), {
      side: 'remote', path, size: row.size,
      created: timed.created || 0, modified: timed.modified || 0, added: timed.added || 0,
      digest: row.digest || '', file: null, os: osOfHeader(row.header),
    });
  }
  for (const copies of groups.values()) {
    for (const copy of copies) copy.stamp = fileStamp(copy);
  }
  return groups;
}

function packCopies(files, current, offset = 0) {
  const pack = (name) => suffix(name) === '.pack';
  return namedCopies(files, current, (file) => pack(file.name), (path, row) => pack(row.name || baseName(path)), offset);
}

// Proven different bytes. Same size with no hash yet is not a choice.
export function copiesVary(copies) {
  if (!copies || copies.length < 2) return false;
  if (new Set(copies.map((copy) => copy.size)).size > 1) return true;
  const digests = copies.map((copy) => copy.digest).filter(Boolean);
  return digests.length === copies.length && new Set(digests).size > 1;
}

// Every copy shares one SHA-256. The first one found is enough.
export function copiesSame(copies) {
  if (!copies || copies.length < 2) return false;
  if (new Set(copies.map((copy) => copy.size)).size > 1) return false;
  const digests = copies.map((copy) => copy.digest).filter(Boolean);
  return digests.length === copies.length && new Set(digests).size === 1;
}

function copiesClash(copies) {
  const stamped = copies.filter((copy) => copy.stamp > 0);
  const pool = stamped.length ? stamped.filter((copy) => copy.stamp >= Math.max(...stamped.map((item) => item.stamp)) - 1999) : copies;
  return new Set(pool.map((copy) => copy.size)).size > 1
    || copies.some((copy) => !copy.stamp && pool.some((item) => item.stamp && item.size !== copy.size));
}

function preferCopy(copies) {
  const score = (copy) => (copy.path === `packs/${copy.path.split('/').pop()}` || copy.path.startsWith('packs/') ? 0 : copy.side === 'remote' ? 1 : 2);
  return copies.slice().sort((a, b) => score(a) - score(b) || (a.path < b.path ? -1 : 1))[0];
}

// The newest dated copy wins. A tie of the same size is one pack. Different sizes
// at that date, or different sizes with no dates, have no winner.
function autoWinner(copies) {
  if (copiesClash(copies)) return null;
  const stamped = copies.filter((copy) => copy.stamp > 0);
  if (!stamped.length) return preferCopy(copies);
  const newest = Math.max(...stamped.map((copy) => copy.stamp));
  return preferCopy(stamped.filter((copy) => newest - copy.stamp < 2000));
}

function remoteTarget(remotes, packDir, name) {
  if (packDir) {
    const exact = remotes.find((copy) => copy.path === `${packDir}/${name}`);
    if (exact) return exact;
  }
  if (remotes.length) return remotes.slice().sort((a, b) => b.stamp - a.stamp || (a.path < b.path ? -1 : 1))[0];
  if (packDir === null || packDir === undefined) return null;
  return { side: 'remote', path: packDir ? `${packDir}/${name}` : name, size: 0, stamp: 0, missing: true };
}

function localTarget(locals) {
  if (!locals.length) return null;
  const score = (copy) => (copy.path.startsWith('packs/') ? 0 : 1);
  return locals.slice().sort((a, b) => b.stamp - a.stamp || score(a) - score(b) || (a.path < b.path ? -1 : 1))[0];
}

function sameFile(a, b) {
  if (!a || !b || b.missing) return false;
  // A copied pack keeps the Field's own clock, so the later stamp can be the same bytes.
  if (a.digest && b.digest && a.digest === b.digest) return true;
  if (a.size !== b.size) return false;
  if (a.stamp && b.stamp && Math.abs(a.stamp - b.stamp) >= 2000) return false;
  return true;
}

function firstCopy(copies) {
  const locals = copies.filter((copy) => copy.side === 'local');
  return (locals.length ? locals : copies)[0];
}

function publicCopy(copy) {
  return {
    side: copy.side, path: copy.path, size: copy.size, stamp: copy.stamp || 0,
    created: copy.created || 0, modified: copy.modified || 0, added: copy.added || 0,
    digest: copy.digest || '', os: copy.os || '',
  };
}

function resolvePack(name, copies, choicePath, packDir, options = {}) {
  const direction = options.direction || 'both';
  const role = options.role || 'pack';
  const held = !!options.held;
  const locals = copies.filter((copy) => copy.side === 'local');
  const remotes = copies.filter((copy) => copy.side === 'remote');
  // Builds for another OS than the loader's are set aside when a build for the loader's OS exists. They stay in
  // `copies` for anyone who wants to look, and take no part in deciding which copy is used.
  const fits = copies.filter((copy) => !copy.os || copy.os === LOADER_OS);
  const setAside = role === 'pack' && fits.some((copy) => copy.os === LOADER_OS) && fits.length < copies.length;
  const eligible = setAside ? fits : copies;
  const vary = copiesVary(eligible);
  const same = copiesSame(eligible);
  const chosen = (vary || setAside) && choicePath ? copies.find((copy) => copy.path === choicePath) : null;
  const clash = vary && copiesClash(eligible);
  const used = chosen || (clash ? null : same ? firstCopy(eligible) : autoWinner(eligible));
  const stamps = copies.map((copy) => copy.stamp).filter((n) => n > 0);
  let local = null;
  let remote = null;
  let action = 'conflict';
  if (used && used.side === 'local') {
    local = used;
    remote = remoteTarget(remotes, packDir, name);
    if ((!remote || remote.missing) && options.destination) {
      remote = { side: 'remote', path: options.destination, size: 0, stamp: 0, missing: true };
    }
    action = remote && !remote.missing && sameFile(used, remote) ? 'same' : 'push';
  } else if (used) {
    remote = used;
    local = localTarget(locals);
    action = local && sameFile(used, local) ? 'same' : 'pull';
  }
  if (held) {
    action = 'same';
    remote = null;
  } else if (direction === 'push' && action === 'pull') action = 'keep';
  else if (direction === 'pull' && action === 'push') action = 'keep';
  const shown = used || copies[0];
  return {
    name,
    path: local ? local.path : null,
    size: shown.size,
    modified: shown.modified || 0,
    created: shown.created || 0,
    added: shown.added || 0,
    stamp: shown.stamp || 0,
    newest: stamps.length ? Math.max(...stamps) : 0,
    oldest: stamps.length ? Math.min(...stamps) : 0,
    file: local ? local.file : null,
    remote: held || !remote ? null : remote.path,
    localPath: local ? local.path : null,
    usedPath: used ? used.path : null,
    role,
    held,
    action,
    conflict: !held && !used,
    choose: vary,
    others: setAside ? copies.length - eligible.length : 0,
    chosen: chosen ? chosen.path : null,
    copies: copies.map(publicCopy),
  };
}

function stampCopy(copy) {
  copy.stamp = fileStamp(copy);
  return copy;
}

// Every .ldr is a copy of the one os.ldr the boot disk will take.
function firmwareCopies(files, current, offset, includeRemote) {
  const copies = [];
  for (const file of routable(files)) {
    if (suffix(file.name) !== '.ldr') continue;
    copies.push(stampCopy({
      side: 'local', path: file.path || file.name, size: file.size,
      created: file.created || 0, modified: file.modified || 0, added: file.added || 0,
      digest: file.digest || '', file,
    }));
  }
  const row = includeRemote && current && current['os.ldr'];
  if (row && row.kind === 'file') {
    const timed = timedRow(row, offset);
    copies.push(stampCopy({
      side: 'remote', path: 'os.ldr', size: row.size,
      created: timed.created || 0, modified: timed.modified || 0, added: timed.added || 0,
      digest: row.digest || '', file: null,
    }));
  }
  return copies;
}

// Pair local files with the connected disk. Firmware, packs and logs share one
// copy rule: group the copies, keep the first when the bytes match, and ask
// when they do not. Firmware copies all become the one os.ldr. Logs only come
// back from the Field. choices maps a name to the path the user picked.
export function linkPlan(files, current, choices = {}, offset = 0) {
  const kind = volumeKind(current);
  const packDir = packDirectory(current);
  const held = kind === 'instrument';
  const items = [];
  const firmware = firmwareCopies(files, current, offset, !held);
  if (firmware.length) {
    const localNames = [...new Set(firmware.filter((copy) => copy.side === 'local').map((copy) => copy.file.name))];
    const name = localNames.length === 1 ? localNames[0] : 'os.ldr';
    items.push(resolvePack(name, firmware, choices[name] || null, null, {
      role: 'firmware', direction: 'push', held, destination: held ? null : 'os.ldr',
    }));
  }
  const grouped = packCopies(files, current, offset);
  for (const name of [...grouped.keys()].sort()) {
    items.push(resolvePack(name, grouped.get(name), choices[name] || null, packDir));
  }
  const logGroups = namedCopies(
    files,
    current,
    (file) => isLogName(file.name, file.path),
    (path, row) => isDeviceLog(path, row.name),
    offset,
  );
  const logs = [];
  for (const name of [...logGroups.keys()].sort()) {
    const copies = logGroups.get(name);
    const onDisk = copies.some((copy) => copy.side === 'remote');
    logs.push(resolvePack(name, copies, choices[name] || null, 'logs', {
      role: 'log', direction: 'pull', held: held && !onDisk,
    }));
  }
  return { kind, packDir, items, logs };
}

// A file is already on disk when any copy in the tree has this name and size.
export function alreadyHave(files, name, size) {
  return files.some((f) => f.name === name && f.size === size && suffix(f.name) === '.txt');
}

// Local files {name, size, path?} from anywhere under one folder, routed by extension.
// Two routable files with the same name are refused; where they sit does not matter.
export function pushPlan(files) {
  const routed = files.filter((f) => suffix(f.name) in PUSH_ROUTES && !f.name.startsWith('.')
      && !(f.path || '').split('/').some((part) => part.startsWith('.')))
    .sort((a, b) => ((a.path || a.name) < (b.path || b.name) ? -1 : 1));
  const seen = new Map();
  for (const f of routed) {
    const where = f.path || f.name;
    if (seen.has(f.name)) throw new Refused(`${f.name} appears twice (${seen.get(f.name)} and ${where}); keep one`);
    seen.set(f.name, where);
  }
  const ldrs = routed.filter((f) => suffix(f.name) === '.ldr');
  if (ldrs.length > 1) {
    throw new Refused(`${ldrs.length} .ldr files (${ldrs.map((f) => f.path || f.name).join(', ')}); keep only the one to flash`);
  }
  return routed.map((f) => {
    const route = PUSH_ROUTES[suffix(f.name)];
    const remote = route.endsWith('/') ? route + f.name : route;
    if (!contentDestination(remote)) throw new Refused(`${f.name} cannot go on the Field: this page does not send that kind of file.`);
    return { ...f, remote };
  });
}

// Device files to back up: {remote, name, size} for each PULL_ROUTES folder, flat.
export function pullPlan(current) {
  const out = [];
  for (const [ext, folder] of Object.entries(PULL_ROUTES)) {
    for (const path of Object.keys(current).sort()) {
      const row = current[path];
      if (row.kind === 'file' && path.startsWith(folder) && !path.slice(folder.length).includes('/')
          && path.toLowerCase().endsWith(ext)) out.push({ remote: path, folder: folder.slice(0, -1), name: row.name, size: row.size });
    }
  }
  return out;
}

export function ldrCheck(bytes) {
  if (bytes.length < LDR_MIN || bytes.length > LDR_MAX) throw new Refused('os.ldr is outside the size range the installer is known to accept.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 16 > bytes.length) throw new Refused('os.ldr is not a plain firmware image: its header is cut short.');
    let x = 0;
    for (let i = 0; i < 16; i++) x ^= bytes[offset + i];
    const code = view.getUint32(offset, true), count = view.getUint32(offset + 8, true);
    if (x || code >>> 24 !== 0xad) throw new Refused(`os.ldr is not a plain firmware image: bad record header at byte ${offset}.`);
    const end = offset + 16 + (code & 0x100 ? 0 : count);
    if (end > bytes.length) throw new Refused('os.ldr is not a plain firmware image: a block is cut short.');
    offset = end;
    if (code & 0x8000) {
      if (offset !== bytes.length) throw new Refused('os.ldr is not a plain firmware image: there are bytes after its final record.');
      return true;
    }
  }
  throw new Refused('os.ldr is not a plain firmware image: its final record is missing.');
}

// The whole copy for one press of Send: what goes where, in order, and what it predicts.
// pairs: [{remote, size}] already routed; current: inventoryPaths; free: bytes.
const reservedRemote = (remote) => isOwnPad(remote) || remote === RETIRED_LOCAL_PAD
  || isLegacyPad(remote) || remote.startsWith(PARK_PREFIX);

export function planCopy(pairs, current, free) {
  for (const { remote } of pairs) {
    if (reservedRemote(remote)) throw new Refused('That file name is reserved for the installer.');
    if (!contentDestination(remote)) throw new Refused(`${remote} is reserved for the installer and cannot be replaced.`);
    if (current[remote] && current[remote].kind !== 'file') throw new Refused(`${remote} is a folder on the Field, so a file cannot go there.`);
  }
  const missing = new Set();
  for (const { remote } of pairs) {
    for (let p = parentOf(remote); p !== '.'; p = parentOf(p)) {
      if (!(p in current)) missing.add(p);
      else if (current[p].kind !== 'folder') throw new Refused(`${p} is a file on the Field, so nothing can go inside it.`);
    }
  }
  const folders = creatableFolders(missing, current);
  const proposed = { ...current };
  for (const { remote, size } of pairs) proposed[remote] = { kind: 'file', size, name: baseName(remote) };
  for (const path of folders) proposed[path] = { kind: 'folder', size: 0, name: baseName(path) };
  const entries = Object.values(proposed);
  const nObj = entries.length + 4;
  const nTn = entries.filter((r) => r.kind === 'file').reduce((sum, r) => sum + tnodesOf(r.size), 0);
  const [needPad, predicted] = proposedNeedsPadding(nObj, nTn);
  const withLdr = pairs.some((p) => p.remote === 'os.ldr');
  const extra = [];
  let after = predicted, padding = null;
  const own = Object.keys(current).filter((name) => isOwnPad(name) && current[name].kind === 'file');
  for (const name of Object.keys(current)) {
    if (reservedRemote(name) && current[name].kind !== 'file') throw new Refused('padding destination is a directory: ' + name);
  }
  let retire = [];
  if (withLdr && needPad) {
    retire = own;
    padding = paddingPlan(nObj, nTn, own.map((name) => current[name].size));
    after = padding.after;
    const taken = new Set([...Object.keys(current).filter((name) => !own.includes(name)), ...pairs.map((p) => p.remote)]);
    for (let index = 0; extra.length < padding.park_count; index++) {
      const name = PARK_PREFIX + String(index).padStart(2, '0');
      if (!taken.has(name)) { extra.push({ remote: name, size: 1, kind: 'park' }); taken.add(name); }
    }
    extra.push({ remote: padName(taken), size: padding.padding_bytes, kind: 'padding' });
  }
  const all = [...pairs.map((p) => ({ ...p, kind: 'file' })), ...extra];
  const need = all.reduce((sum, item) => sum + item.size - ((current[item.remote] && !retire.includes(item.remote)) ? current[item.remote].size : 0), 0);
  if (need + 4 * 1024 * 1024 > free) throw new Refused('Not enough free space on the Field for these files. A 4 MiB margin is kept free.');
  all.sort((a, b) => transferPriority(a.remote) - transferPriority(b.remote));
  return {
    folders, items: all, padding, after, withLdr, retire,
    // Content without an .ldr is not padded; if an os.ldr is already waiting, say its padding went stale.
    stale: !withLdr && needPad && 'os.ldr' in current,
  };
}

// Only the size matters. The bytes repeat so the file is not stored as a hole.
export function paddingBytes(size) {
  const out = new Uint8Array(size);
  const period = new Uint8Array(256);
  for (let i = 0; i < 256; i++) period[i] = Math.imul(i, 2654435761) & 0xff;
  for (let at = 0; at < size; at += 256) out.set(period.subarray(0, Math.min(256, size - at)), at);
  return out;
}
