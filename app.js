import { FieldMTP, FIELD_FILTERS, INSTALL_PRODUCT, isField, FieldBusy, FieldStalled, FieldNotMtp } from './mtp.js';
import { Refused, MTP_ENTER, inventoryPaths, planCopy, ldrCheck, paddingBytes, linkPlan, mtpDate, volumeKind, fileStamp, clockOffset, isDeviceLog, packHeader, firmwareFacts, firmwareLabel, packIdentity, settlePacks, packDirectory, packLimitFromLog, packSetSize, PACK_LIMIT, knownOs, packsForOtherOs, LOADER_OS } from './volume.js';

const app = document.getElementById('app');
// A page that frames this one could steer clicks onto Send or Remove. The host cannot
// send frame-ancestors, so the page refuses to run anywhere but its own tab.
if (window.top !== window.self) {
  app.textContent = 'MTP-1F runs only in its own tab. Open it directly.';
  throw new Error('MTP-1F does not run inside a frame');
}
const S = {
  phase: navigator.usb ? 'plug' : 'chrome',
  device: null, info: null, space: null, current: null,
  dir: null, dirName: null, dirAllowed: false, folderFiles: [], dropped: new Map(), saved: new Map(),
  firmware: null, plan: null, refusal: null, firmwareRefusal: null, progress: null, message: '', sentFirmware: false,
  activity: [], firmwareFacts: { local: [], field: null }, packBytes: new Map(), settle: null,
  installVolume: false, links: null, folderError: '',
  looking: false, sentMidi: false,
  packLimit: { limit: PACK_LIMIT, source: 'known' }, dialog: null, quiet: false, packMode: {}, packKeep: {}, packSettled: new Map(), receipts: new Map(), packShow: { changes: true, same: true, conflicts: true },
  packQuery: '', openPack: null, packScroll: 0, packFocus: false, packCaret: 0, clocks: {}, deviceKey: '', headline: '', rebootNames: new Set(),
  dirName: (() => { try { return localStorage.getItem('field-folder-name'); } catch { return null; } })(),
};
let quietUntil = 0;
const hush = () => { quietUntil = Date.now() + 4000; };

const mb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    // Set through CSSOM: the page's CSP allows no inline style attributes.
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

// sync sends the chosen copy, remove deletes the Field copies, skip leaves them.
function packWant(item) {
  const set = S.packMode[item.name];
  if (set === 'sync' || set === 'skip' || set === 'remove') return set;
  // New logs on the Field are staged for copying here unless switched off. Nothing else is.
  if (item.role === 'log' && item.action === 'pull' && viewMode() === 'both') return 'sync';
  return 'skip';
}

// ---- folder (File System Access), remembered across visits ----
const db = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('field-transfer', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('handles');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function remember(handle) {
  localStorage.setItem('field-folder-name', handle.name);
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'folder');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('could not remember the folder'));
  });
}
async function recall() {
  const d = await db();
  return new Promise((resolve) => {
    const req = d.transaction('handles').objectStore('handles').get('folder');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function takeFolder(dir) {
  await remember(dir);
  S.dir = dir; S.dirName = dir.name; S.dirPath = typeof dir.path === 'string' ? dir.path : '';
  S.dirAllowed = true; S.folderError = '';
  await readFolder();
}

// The picker has to start in the click, before any await. A stored handle is reopened
// with requestPermission in that same click. A remembered name cannot reopen the directory.
function onFolderClick() {
  const pending = S.dir && !S.dirAllowed
    ? S.dir.requestPermission({ mode: 'readwrite' })
    : window.showDirectoryPicker({ id: 'field', mode: 'readwrite' });
  pending.then(async (result) => {
    if (result === 'granted') { S.dirAllowed = true; S.folderError = ''; await readFolder(); return; }
    if (result && result.kind === 'directory') { await takeFolder(result); return; }
    S.folderError = 'Chrome did not give this page the folder. Press the button again.';
    render();
  }).catch((error) => {
    if (error && error.name === 'AbortError' && /user aborted/i.test(error.message || '')) return;
    S.folderError = (error && error.message) || 'The folder picker did not open.';
    render();
  });
}

async function walkFolder(dir, prefix, out) {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') await walkFolder(entry, path, out);
    else if (entry.kind === 'file') {
      const file = await entry.getFile();
      out.push({ name: file.name, path, size: file.size, modified: file.lastModified, file, parent: dir });
    }
  }
}

async function retireLocalPadding() {
  if (!S.dir || !S.dirAllowed) return;
  try { await S.dir.removeEntry('padd.ing'); } catch (e) { /* already gone */ }
}

async function readFolder() {
  S.folderFiles = [];
  S.saved = new Map();
  await retireLocalPadding();
  if (S.dir && S.dirAllowed) await walkFolder(S.dir, '', S.folderFiles);
  await replan();
}

// ---- the plan for what is on screen ----
function settledFile(file) {
  const receipt = S.receipts.get('local:' + (file.path || file.name));
  if (receipt && receipt.size === file.size && !(file.modified > receipt.at + 2000)) file.digest = receipt.digest;
  const mark = S.packSettled.get(file.path || file.name);
  if (!mark || mark.size !== file.size || file.modified > mark.pulledAt + 2000) return file;
  return { ...file, created: mark.stamp, modified: mark.stamp, added: mark.stamp };
}
const localFiles = () => [...S.folderFiles, ...S.dropped.values()].map(settledFile);

async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Same size with a different clock may still be the same pack. Several copies of one name need a hash too.
function isLogFile(file) {
  return isDeviceLog(file.path || '', file.name);
}
function localsFor(row) {
  const locals = localFiles();
  if (row.name === 'os.ldr') return locals.filter((file) => file.name && file.name.toLowerCase().endsWith('.ldr'));
  if (isLogFile({ name: row.name, path: row.path || '' })) return locals.filter((file) => file.name === row.name && isLogFile(file));
  if (row.name.toLowerCase().endsWith('.pack')) return locals.filter((file) => file.name === row.name);
  return [];
}
function packsToConfirm() {
  if (!S.current) return [];
  const counts = new Map();
  const consider = (name) => { if (name) counts.set(name, (counts.get(name) || 0) + 1); };
  for (const file of localFiles()) {
    if (file.name && (file.name.toLowerCase().endsWith('.pack') || file.name.toLowerCase().endsWith('.ldr') || isLogFile(file))) consider(file.name.toLowerCase().endsWith('.ldr') ? 'os.ldr' : file.name);
  }
  for (const [path, row] of Object.entries(S.current)) {
    if (!row || row.kind !== 'file' || !row.name) continue;
    if (path === 'os.ldr' || row.name.toLowerCase().endsWith('.pack') || isDeviceLog(path, row.name)) consider(row.name);
  }
  const jobs = [];
  for (const [path, row] of Object.entries(S.current)) {
    if (!row || row.kind !== 'file' || !row.name || row.digest) continue;
    const wanted = path === 'os.ldr' || row.name.toLowerCase().endsWith('.pack') || isDeviceLog(path, row.name);
    if (!wanted) continue;
    const group = localsFor({ ...row, path });
    const remoteTime = fileStamp(row);
    const aligned = group.some((file) => file.size === row.size && fileStamp(file) && remoteTime && Math.abs(fileStamp(file) - remoteTime) < 2000);
    if ((counts.get(row.name) || 0) > 1 || (group.some((file) => file.size === row.size) && !aligned)) jobs.push(row);
  }
  return jobs;
}

async function hashLocalGroups() {
  const groups = new Map();
  const add = (key, file) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  };
  for (const file of localFiles()) {
    if (!file.name || file.name.startsWith('.')) continue;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.pack')) add(file.name, file);
    else if (lower.endsWith('.ldr')) add('os.ldr', file);
    else if (isLogFile(file)) add(file.name, file);
  }
  const pending = [...groups.values()].filter((group) => group.length > 1).flat().filter((file) => !file.digest);
  for (const [index, file] of pending.entries()) {
    if (!S.quiet) { S.progress = { label: 'Checking ' + file.name, done: index, total: pending.length }; render(); }
    const blob = file.file || file;
    file.digest = await sha256(new Uint8Array(await blob.arrayBuffer()));
  }
}

// Every pack in the Field's pack folder is read in the session that lists it, so the set on the unit can be
// counted and judged against this folder without opening the drive a second time.
async function readFieldPacks(mtp) {
  const dir = packDirectory(S.current || {});
  if (!dir) return;
  const rows = Object.entries(S.current).filter(([path, row]) => row && row.kind === 'file' && row.id
    && path.startsWith(dir + '/') && path.toLowerCase().endsWith('.pack'));
  for (const [index, [path, row]] of rows.entries()) {
    const key = path + ':' + row.size;
    let bytes = S.packBytes.get(key);
    if (!bytes) {
      activity(`Reading ${row.name} from the Field, ${index + 1} of ${rows.length}`, index, rows.length, `Read ${rows.length} ${rows.length === 1 ? 'pack' : 'packs'} from the Field`);
      bytes = new Uint8Array(await mtp.get(row.id));
      S.packBytes.set(key, bytes);
    }
    row.bytes = bytes;
    row.header = packHeader(bytes);
  }
}

async function confirmPackBytes(mtp) {
  const jobs = packsToConfirm();
  const locals = localFiles();
  for (const [index, row] of jobs.entries()) {
    activity(`Comparing ${row.name} byte for byte, ${index + 1} of ${jobs.length}`, index, jobs.length, `Compared ${row.name} byte for byte`);
    const bytes = row.bytes && row.bytes.length === row.size ? row.bytes : await mtp.get(row.id);
    row.digest = await sha256(bytes);
    for (const file of locals) {
      const same = row.name === 'os.ldr' ? file.name && file.name.toLowerCase().endsWith('.ldr') : file.name === row.name;
      if (!same || file.digest) continue;
      const blob = file.file || file;
      file.digest = await sha256(new Uint8Array(await blob.arrayBuffer()));
    }
  }
}

function applyReceipts() {
  const now = Date.now();
  for (const [path, row] of Object.entries(S.current || {})) {
    const mark = S.receipts.get('remote:' + path);
    if (!mark || !row || row.kind !== 'file' || row.size !== mark.size || now > mark.at + 60 * 60 * 1000) continue;
    row.digest = mark.digest;
  }
}

async function digestOf(file) {
  if (file.digest) return file.digest;
  const blob = file.file || file;
  file.digest = await sha256(new Uint8Array(await blob.arrayBuffer()));
  return file.digest;
}

function activity(text, done, total, doneText) {
  // A copy and a connect both keep a running log; anything else only moves the progress bar.
  const logged = S.phase === 'working' || S.phase === 'reading';
  if (S.quiet && !logged) return;
  if (!logged) {
    S.progress = { label: text, done: done || 0, total: Math.max(1, total || 1) };
    render();
    return;
  }
  const list = S.activity || (S.activity = []);
  const key = String(text).split(',')[0];
  const last = list[list.length - 1];
  if (last && last.state === 'now' && last.key === key) {
    last.text = text;
    if (doneText) last.doneText = doneText;
  } else {
    if (last && last.state === 'now') {
      last.state = 'done';
      if (last.doneText) last.text = last.doneText;
    }
    list.push({ key, text, state: 'now', doneText: doneText || '' });
  }
  S.progress = { label: text, done: done || 0, total: Math.max(1, total || 1) };
  render();
}

function activityFinish() {
  const last = (S.activity || [])[(S.activity || []).length - 1];
  if (last && last.state === 'now') {
    last.state = 'done';
    if (last.doneText) last.text = last.doneText;
  }
  S.progress = null;
}

async function readRemoteHeaders(mtp) {
  const packs = Object.entries(S.current || {}).filter(([, row]) => row && row.kind === 'file' && (row.name || '').toLowerCase().endsWith('.pack') && !row.header && row.id);
  for (let index = 0; index < packs.length; index++) {
    const [path, row] = packs[index];
    const name = row.name || path;
    activity(`Reading ${name}, ${index + 1} of ${packs.length}`, index, packs.length, `Read ${name}`);
    try {
      row.header = packHeader(await mtp.peek(row.id, 96));
    } catch (error) {
      if (error instanceof FieldStalled || error instanceof FieldBusy || error instanceof FieldNotMtp) throw error;
      row.header = null;
    }
  }
}

async function readLocalFacts() {
  const files = localFiles();
  for (const file of files) {
    const lower = (file.name || '').toLowerCase();
    const blob = file.file || file;
    if (lower.endsWith('.pack') && !file.header && blob.slice) {
      file.header = packHeader(new Uint8Array(await blob.slice(0, 96).arrayBuffer()));
    }
    if (lower.endsWith('.ldr') && !file.digest && blob.arrayBuffer) {
      activity('Reading ' + file.name, 0, 1, 'Read ' + file.name);
      file.digest = await sha256(new Uint8Array(await blob.arrayBuffer()));
    }
  }
  const remote = S.current && S.current['os.ldr'];
  S.firmwareFacts = firmwareFacts(
    files.filter((file) => file.name && file.name.toLowerCase().endsWith('.ldr')),
    remote && remote.digest);
}

async function readInventory(mtp, label) {
  activity(label, 0, 1, label);
  // The finished line says what was found, so a finished read never looks like one still running.
  const rows = await mtp.inventory((done, total) => activity(`${label}, ${done} of ${total}`, done, total, `Listed ${total} ${total === 1 ? 'item' : 'items'} on the Field`));
  for (const row of rows) {
    row.created = mtpDate(row.created);
    row.modified = mtpDate(row.modified);
    row.added = mtpDate(row.added);
  }
  S.current = inventoryPaths(rows);
  S.installVolume = volumeKind(S.current) !== 'instrument';
  await readRemoteHeaders(mtp);
}

function rememberCopy(localPath, remotePath, size, digest) {
  const mark = { size, digest, at: Date.now() };
  if (localPath) S.receipts.set('local:' + localPath, mark);
  if (remotePath) S.receipts.set('remote:' + remotePath, mark);
}

function spokenName(name) {
  return String(name || '').replace(/\.(pack|txt)$/i, '');
}
function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length < 2) return list[0] || '';
  if (list.length === 2) return list[0] + ' and ' + list[1];
  return list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1];
}

function titleCase(name) {
  const text = String(name || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
// The folder the loader reads, as this drive shows it: user/pk on the boot-menu drive, packs/ on the running
// unit's drive. The set of packs, the limit and the judgement all belong to this folder, whichever drive it is.
function packFolder() {
  return (S.current && S.links && S.links.packDir) || null;
}
function inPackFolder(path) {
  const dir = packFolder();
  return !!(dir && path && String(path).startsWith(dir + '/'));
}
function unitHolds(file) {
  const dir = packFolder();
  const row = dir && S.current && S.current[dir + '/' + file];
  return !!(row && row.kind === 'file');
}
function packMembers() {
  const items = (S.links && S.links.items || []).filter((item) => item.role === 'pack');
  const connected = !!(S.current && packFolder());
  const out = [];
  for (const item of items) {
    const want = packWant(item);
    const local = shownCopy(item, 'local');
    const remote = shownCopy(item, 'remote');
    const remotePath = remote && remote.path;
    const onUnit = !!(inPackFolder(remotePath) && S.current[remotePath] && S.current[remotePath].kind === 'file');
    if (!connected) {
      if (want === 'remove' || S.packMode[item.name] === 'skip') continue;
      if (!local || stashed(item)) continue;
      out.push({ file: item.name, localPath: local.path, path: '', onUnit: false, inFolder: true });
      continue;
    }
    if (want === 'remove') continue;
    if (want === 'sync' && item.action === 'push' && local && inPackFolder(item.remote)) {
      out.push({ file: item.name, localPath: local.path, path: item.remote, onUnit, inFolder: true });
    } else if (onUnit) {
      out.push({ file: item.name, localPath: '', path: remotePath, onUnit: true, inFolder: !!local });
    }
  }
  return out;
}
// The pack files that will sit in user/pk once this sync is done: what is on the Field and stays, plus what is
// staged, minus what is staged for removal. Only counted against a Field (the loader's limit is its folder's).
function packRoom() {
  const counted = !!(S.current && packFolder());
  const names = counted ? packMembers().filter((member) => !member.path || inPackFolder(member.path)).map((member) => member.file) : [];
  const limit = S.packLimit.limit;
  const count = packSetSize(names);
  return { counted, names: new Set(names.map((name) => name.toLowerCase())), count, limit, full: counted && count >= limit, over: counted && count > limit };
}
function limitWords(room) {
  return `You're at the pack limit (${room.limit}), sorry. Remove some packs from the Field, or unstage some, if you want to add more.`;
}
// Staging a pack the Field does not already hold, with no room left, is refused and the reason shown.
function refuseIfFull(name) {
  const room = packRoom();
  if (!room.counted || room.names.has(String(name).toLowerCase()) || room.count < room.limit) return false;
  showLimit();
  return true;
}
// The loader's own log says how many pack files it looked at, so the limit follows the loader that is installed.
async function readLoaderLimit(mtp) {
  const logs = Object.entries(S.current || {})
    .filter(([path, row]) => row && row.kind === 'file' && row.id && isDeviceLog(path, row.name))
    .map(([, row]) => row)
    .sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, 3);
  for (const row of logs) {
    try {
      const text = new TextDecoder().decode(await mtp.peek(row.id, Math.min(row.size || 262144, 262144)));
      const found = packLimitFromLog(text, PACK_LIMIT);
      if (found) { S.packLimit = found; return; }
    } catch (error) {
      if (error instanceof FieldStalled || error instanceof FieldBusy || error instanceof FieldNotMtp) throw error;
    }
  }
  S.packLimit = { limit: PACK_LIMIT, source: 'known' };
}
async function localPackBytes(path) {
  const file = localFiles().find((item) => (item.path || item.name) === path);
  if (!file) return null;
  if (file.bytes && file.bytes.length === file.size) return file.bytes;
  const blob = file.file || file;
  if (!blob.arrayBuffer) return null;
  file.bytes = new Uint8Array(await blob.arrayBuffer());
  return file.bytes;
}
async function packBodies() {
  const members = packMembers();
  const ready = [];
  const missing = [];
  for (const member of members) {
    if (member.localPath) {
      ready.push({ ...member, bytes: await localPackBytes(member.localPath) });
    } else {
      const row = S.current && S.current[member.path];
      const cached = row && S.packBytes.get(member.path + ':' + row.size);
      if (cached) ready.push({ ...member, bytes: cached });
      else missing.push(member);
    }
  }
  // The running unit's drive is read once, in the connect session (readFieldPacks). Only the boot-menu drive
  // is opened again here.
  if (missing.length && S.device && S.installVolume) {
    let mtp;
    try {
      mtp = await FieldMTP.connect(S.device);
      await mtp.openSession();
      for (let i = 0; i < missing.length; i++) {
        const member = missing[i];
        const row = S.current[member.path];
        if (!row || !row.id) continue;
        activity(`Reading ${member.file}, ${i + 1} of ${missing.length}`, i, missing.length, `Read ${member.file}`);
        const bytes = new Uint8Array(await mtp.get(row.id));
        S.packBytes.set(member.path + ':' + row.size, bytes);
        row.header = packHeader(bytes);
        row.bytes = bytes;
      }
      hush();
      await mtp.close();
      mtp = null;
    } catch (error) {
      S.progress = null;
      if (error instanceof FieldBusy) S.phase = 'busy';
      else if (error instanceof FieldNotMtp) S.phase = 'console';
      else if (error instanceof FieldStalled) S.phase = 'stalled';
      else if (error instanceof Refused) { S.phase = 'ready'; S.refusal = error.message; }
      else { S.phase = 'error'; S.message = String(error && error.message || error); }
      render();
      return null;
    } finally {
      if (mtp && S.device) { hush(); await S.device.close().catch(() => {}); }
    }
  }
  for (const member of missing) {
    const row = S.current && S.current[member.path];
    const bytes = row && S.packBytes.get(member.path + ':' + row.size);
    ready.push({ ...member, bytes: bytes || new Uint8Array() });
  }
  return ready;
}
function leavePack(file) {
  S.packMode[file] = unitHolds(file) ? 'remove' : 'skip';
  S.activity = [];
  replanQuiet().catch(fail);
}
function itemForPack(packName) {
  const items = (S.links && S.links.items || []).filter((item) => item.role === 'pack');
  return items.find((row) => row.name.toLowerCase() === String(packName).toLowerCase() + '.pack')
    || items.find((row) => (identityOf(row) || {}).name === packName) || null;
}
// Which of these packs could not run if staged, and which pack does each need?
async function missingPrereqs(names) {
  const was = names.map((name) => [name, S.packMode[name]]);
  for (const name of names) S.packMode[name] = 'sync';
  let report = null;
  try {
    const bodies = await packBodies();
    report = bodies ? settlePacks(bodies.map((item) => ({ file: item.file, bytes: item.bytes || new Uint8Array(), onUnit: item.onUnit, inFolder: item.inFolder })), S.packLimit.limit) : null;
  } finally {
    for (const [name, mode] of was) { if (mode === undefined) delete S.packMode[name]; else S.packMode[name] = mode; }
  }
  if (!report) return [];
  const asked = new Set(names);
  return report.left.filter((row) => asked.has(row.file) && (row.why === 'needs' || row.why === 'import') && /needs the .+ pack/.test(row.sentence))
    .map((row) => ({ file: row.file, need: neededName(row) }));
}
// A change to what is staged redraws in place: no progress block appears and disappears around it.
async function replanQuiet() {
  S.quiet = true;
  try { await replan(); } finally { S.quiet = false; }
}
// A pack that cannot run alone is staged together with what it needs, or not at all.
async function stageItems(startItems, ask) {
  const names = startItems.map((item) => item.name);
  const blocked = [];
  for (let round = 0; round < 4; round++) {
    let added = false;
    for (const found of await missingPrereqs(names)) {
      const need = itemForPack(found.need);
      if (need && sideCopies(need, 'local').length && !wrongOs(need)) {
        if (!names.includes(need.name)) { names.push(need.name); added = true; }
      } else if (!blocked.some((row) => row.file === found.file)) blocked.push({ ...found, needName: found.need });
    }
    if (!added) break;
  }
  const apply = (list) => {
    let skipped = 0;
    for (const name of list) {
      const room = packRoom();
      if (room.counted && !room.names.has(name.toLowerCase()) && room.count >= room.limit) { skipped += 1; continue; }
      S.packMode[name] = 'sync';
    }
    S.message = ''; S.headline = ''; S.activity = [];
    replanQuiet().catch(fail);
    return skipped;
  };
  const spoken = (name) => spokenName(name);
  if (ask) {
    if (blocked.length) {
      showDialog(`${spoken(blocked[0].file)} can't run without ${blocked[0].needName}, and ${blocked[0].needName}.pack isn't in this folder.`, [{ label: 'OK' }]);
      return;
    }
    const extra = names.slice(startItems.length);
    if (extra.length) {
      showDialog(`${spoken(startItems[0].name)} can't run without ${joinNames(extra.map(spoken))}. Stage ${extra.length === 1 ? 'both' : 'all'}?`,
        [{ label: extra.length === 1 ? 'Stage both' : 'Stage all', run: () => { if (apply(names)) showLimit(); } }, { label: 'Cancel' }]);
      return;
    }
    if (apply(names)) showLimit();
    return;
  }
  const dependents = new Set(blocked.map((row) => row.file));
  const skipped = apply(names.filter((name) => !dependents.has(name)));
  if (blocked.length) {
    showDialog(`Not staged, because what they need isn't in this folder: ${joinNames(blocked.map((row) => `${spoken(row.file)} (needs ${row.needName})`))}.`, [{ label: 'OK' }]);
  } else if (skipped) showLimit();
}
function stageNamed(packName) {
  const item = itemForPack(packName);
  if (!item) return;
  if (S.packMode[item.name] !== 'sync') stageItems([item], true).catch(fail);
}
async function replan() {
  S.refusal = null; S.firmwareRefusal = null; S.plan = null; S.firmware = null;
  let pairs = [];
  try {
    applyReceipts();
    await hashLocalGroups();
    await readLocalFacts();
    if (packsToConfirm().length && S.device) {
      const ok = await withField(async () => {});
      if (!ok) return;
    }
    await readLocalFacts();
    const links = linkPlan(localFiles(), S.current || {}, S.packKeep, S.clocks[S.deviceKey] || 0);
    S.links = links;
    for (const item of links.items) if (item.role === 'pack' && S.packMode[item.name] === 'sync' && stashed(item)) delete S.packMode[item.name];
    const room = packRoom();
    if (room.over && packMembers().some((member) => member.localPath && !S.current[member.path])) throw new Refused(limitWords(room));
    const staged = links.items.filter((item) => item.action === 'push' && item.remote && packWant(item) === 'sync');
    const packs = staged.filter((item) => item.remote !== 'os.ldr');
    const ldr = staged.find((item) => item.remote === 'os.ldr');
    if (ldr) {
      try {
        const blob = ldr.file.file || ldr.file;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        ldrCheck(bytes);
        const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
        S.firmware = { name: ldr.name, sha, release: null };
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        S.firmwareRefusal = error.message;
      }
    }
    pairs = S.firmwareRefusal ? packs : staged;
    const twice = duplicatePackSend(pairs);
    if (twice) throw new Refused(twice);
    if (S.current && pairs.length) {
      try {
        S.plan = planCopy(pairs.map((item) => ({ remote: item.remote, size: item.size })), S.current, S.space.free);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        if (ldr && !S.firmwareRefusal && packs.length) {
          S.firmwareRefusal = error.message;
          pairs = packs;
          S.plan = planCopy(packs.map((item) => ({ remote: item.remote, size: item.size })), S.current, S.space.free);
        } else throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    S.refusal = error.message;
    S.plan = null;
  }
  S.pairs = S.plan ? pairs : [];
  if (S.current && !packFolder()) S.settle = null;
  else {
    const bodies = await packBodies();
    S.settle = bodies ? settlePacks(bodies.map((item) => ({ file: item.file, bytes: item.bytes || new Uint8Array(), onUnit: item.onUnit, inFolder: item.inFolder })), S.packLimit.limit) : null;
  }
  if (!['working', 'reading', 'looking'].includes(S.phase)) activityFinish();
  render();
}

// ---- the Field ----
async function withField(job) {
  if (!S.device && navigator.usb) {
    const known = (await navigator.usb.getDevices()).filter(isField);
    // 0x0102 is the shared drive, boot menu or running unit alike.
    S.device = known.find((device) => device.productId === INSTALL_PRODUCT) || known[0] || null;
  }
  if (!S.device) return;
  let mtp;
  try {
    mtp = await FieldMTP.connect(S.device);
    S.info = await mtp.deviceInfo();
    S.deviceKey = (S.info && S.info.serial) || `field-${S.device.productId || 0}`;
    S.space = await mtp.openSession();
    const fieldNow = mtpDate(await mtp.deviceTime());
    if (fieldNow) S.clocks[S.deviceKey] = clockOffset(fieldNow, Date.now());
    await readInventory(mtp, 'Reading the Field');
    await readLoaderLimit(mtp);
    await readFieldPacks(mtp);
    await confirmPackBytes(mtp);
    await job(mtp);
    hush();
    await mtp.close();
    mtp = null;
    S.progress = null;
    return true;
  } catch (error) {
    S.progress = null;
    if (error instanceof FieldBusy) S.phase = 'busy';
    else if (error instanceof FieldNotMtp) S.phase = 'console';
    else if (error instanceof FieldStalled) S.phase = 'stalled';
    else if (error instanceof Refused) { S.phase = 'ready'; S.refusal = error.message; }
    else { S.phase = 'error'; S.message = String(error && error.message || error); }
    render();
    return false;
  } finally {
    if (mtp && S.device) { hush(); await S.device.close().catch(() => {}); }
  }
}

function dropLink() {
  hush();
  Object.assign(S, {
    device: null, info: null, current: null, space: null, plan: null, progress: null,
    installVolume: false, phase: 'plug', message: '',
  });
  render();
}

// Disconnect sends CloseSession, which on the running instrument leaves MTP.
async function disconnect() {
  if (!S.device && navigator.usb) {
    const known = (await navigator.usb.getDevices()).filter(isField);
    S.device = known.find((device) => device.productId === INSTALL_PRODUCT) || known[0] || null;
  }
  S.phase = 'working';
  render();
  let mtp;
  try {
    if (S.device) {
      mtp = await FieldMTP.connect(S.device);
      await mtp.endSession();
    }
  } catch (error) {
    if (error instanceof FieldBusy) { S.phase = 'busy'; render(); return; }
  } finally {
    if (mtp) { hush(); await mtp.close().catch(() => {}); }
  }
  dropLink();
}

async function askForMtp() {
  if (!navigator.requestMIDIAccess) return false;
  let access;
  try { access = await navigator.requestMIDIAccess({ sysex: true }); }
  catch { return false; }
  let sent = false;
  for (const output of access.outputs.values()) {
    if (!/op-?1/i.test(output.name || '')) continue;
    output.send([0xf0, ...MTP_ENTER, 0xf7]);
    sent = true;
  }
  return sent;
}

// The button starts this. It never runs on load. A permitted boot-menu volume
// opens at once. Anything else gets one MTP request over MIDI, then USB is
// watched until five seconds from the click.
// Without a folder to compare against, a connected Field has nothing to be compared with. The folder comes first.
function needsFolder() {
  return !!window.showDirectoryPicker && !(S.dir && S.dirAllowed);
}
async function look() {
  if (S.looking || needsFolder()) return;
  S.looking = true;
  S.sentMidi = false;
  S.phase = 'looking';
  render();
  const tried = new Set();
  const key = (device) => device.serialNumber || String(device.productId);
  let candidate = null;
  let granted = false;
  let midiTried = false;
  if (navigator.usb) {
    const known = (await navigator.usb.getDevices()).filter(isField);
    granted = known.length > 0;
    candidate = known.find((device) => device.productId === INSTALL_PRODUCT) || known[0] || null;
    if (!known.length) {
      try { candidate = await navigator.usb.requestDevice({ filters: FIELD_FILTERS }); granted = !!candidate; }
      catch (error) {
        if (!error || error.name !== 'NotFoundError') { S.looking = false; throw error; }
      }
    }
    if (candidate && !isField(candidate)) {
      S.looking = false;
      S.phase = 'plug';
      S.message = 'Connect an OP-1. Other USB devices are left alone.';
      render();
      return;
    }
  }
  const until = Date.now() + 5000;
  const onUsb = (event) => {
    if (!isField(event.device)) return;
    tried.delete(key(event.device));
    candidate = event.device;
  };
  if (navigator.usb) navigator.usb.addEventListener('connect', onUsb);
  try {
    while (S.looking && Date.now() < until) {
      const device = candidate;
      candidate = null;
      if (device && !tried.has(key(device))) {
        S.device = device;
        S.installVolume = device.productId === INSTALL_PRODUCT;
        S.info = null;
        S.phase = 'reading';
        S.activity = [];
        render();
        const ok = await withField(async () => {});
        if (ok) { S.looking = false; S.phase = 'ready'; S.message = ''; S.rebootNames = new Set(); S.sentFirmware = false; await replan(); return; }
        if (S.phase === 'busy' || S.phase === 'stalled' || S.phase === 'error') { S.looking = false; return; }
        if (device.productId === INSTALL_PRODUCT) { S.looking = false; return; }
        tried.add(key(device));
        S.device = null;
        S.phase = 'looking';
        render();
      }
      if (!midiTried && granted) { midiTried = true; S.sentMidi = await askForMtp(); tried.clear(); }
      if (S.phase === 'looking') render();
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!candidate && navigator.usb) {
        const again = (await navigator.usb.getDevices()).filter(isField);
        candidate = again.find((device) => device.productId === INSTALL_PRODUCT && !tried.has(key(device)))
          || (S.sentMidi ? again.find((device) => !tried.has(key(device))) : null);
      }
    }
  } finally {
    if (navigator.usb) navigator.usb.removeEventListener('connect', onUsb);
    if (S.looking) { S.looking = false; if (S.phase === 'looking') S.phase = 'plug'; }
  }
  render();
}

function sourceFor(item, files) {
  if (item.kind === 'padding') {
    const head = paddingBytes(Math.min(item.size, 64));
    return { size: item.size, read: async (offset, length) => {
      const out = new Uint8Array(length);
      if (offset < head.length) out.set(head.subarray(offset, Math.min(head.length, offset + length)));
      return out;
    } };
  }
  if (item.kind === 'park') return { size: 1, read: async () => new Uint8Array(1) };
  const file = files.get(item.remote);
  const blob = file.file || file;
  return { size: file.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}

async function writeLocal(name, bytes, folderName, existing) {
  if (existing && existing.parent) {
    const out = await (await existing.parent.getFileHandle(name, { create: true })).createWritable();
    await out.write(bytes); await out.close();
    return;
  }
  if (S.dir && S.dirAllowed) {
    const folder = await S.dir.getDirectoryHandle(folderName, { create: true });
    const out = await (await folder.getFileHandle(name, { create: true })).createWritable();
    await out.write(bytes); await out.close();
    return;
  }
  const a = h('a', { href: URL.createObjectURL(new Blob([bytes])), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function pullChanges(mtp) {
  const logs = (S.links && S.links.logs || []).filter((item) => item.action === 'pull' && packWant(item) === 'sync');
  const packs = (S.links && S.links.items || []).filter((item) => item.role === 'pack' && item.action === 'pull' && packWant(item) === 'sync');
  const wanted = [...logs.map((item) => ({ ...item, folderName: 'logs' })), ...packs.map((item) => ({ ...item, folderName: 'packs' }))];
  for (const [index, item] of wanted.entries()) {
    const bytes = await mtp.get(S.current[item.remote].id, (done, total) => {
      activity(`Copying ${item.name} here, ${index + 1} of ${wanted.length}`, done, total, `Copied ${item.name} here`);
    });
    const existing = (item.localPath && S.folderFiles.find((file) => file.path === item.localPath))
      || S.folderFiles.find((file) => file.name === item.name);
    await writeLocal(item.name, bytes, item.folderName, existing);
    S.packSettled.set(existing ? existing.path : `${item.folderName}/${item.name}`, {
      size: bytes.length, stamp: item.stamp || item.modified || Date.now(), pulledAt: Date.now(),
    });
    S.saved.set(item.name, bytes.length);
    const digest = await sha256(bytes);
    rememberCopy(existing ? existing.path : `${item.folderName}/${item.name}`, item.remote, bytes.length, digest);
  }
  return wanted;
}

// The pack name inside a file, for a local path or a path on the Field.
function packNameAt(side, path) {
  if (side === 'remote') { const row = S.current && S.current[path]; return (row && row.header && row.header.name) || ''; }
  const file = localFiles().find((item) => (item.path || item.name) === path);
  return (file && file.header && file.header.name) || '';
}
// A copy may never leave two files of one pack on the Field: two staged files that hold the same pack, or a staged
// file whose pack the Field already holds under another file name. Returns the sentence that says which, or ''.
function duplicatePackSend(pairs) {
  const dir = packFolder();
  const leaving = new Set((S.links && S.links.items || []).filter((item) => packWant(item) === 'remove').flatMap((item) => sideCopies(item, 'remote').map((copy) => copy.path)));
  const seen = new Map();
  for (const pair of pairs) {
    if (!(pair.remote || '').toLowerCase().endsWith('.pack')) continue;
    const name = packNameAt('local', pair.localPath || pair.path || '');
    if (!name) continue;
    if (seen.has(name)) return `${spokenName(seen.get(name).split('/').pop())} and ${spokenName(pair.remote.split('/').pop())} are the same pack (${name}). Only one of them can go on the Field.`;
    seen.set(name, pair.remote);
    for (const [path, row] of Object.entries(S.current || {})) {
      if (!row || row.kind !== 'file' || path === pair.remote || leaving.has(path)) continue;
      if (dir && !path.startsWith(dir + '/')) continue;
      if (row.header && row.header.name === name) {
        return `The Field already holds ${name} as ${row.name}. Sending ${pair.remote.split('/').pop()} would put the same pack on it twice.`;
      }
    }
  }
  return '';
}
async function sendFiles(mtp) {
  const routed = S.pairs;
  const twice = duplicatePackSend(routed);
  if (twice) throw new Refused(twice);
  const files = new Map(routed.map((p) => [p.remote, p.file]));
  const plan = planCopy(routed.map((p) => ({ remote: p.remote, size: p.size })), S.current, S.space.free);
  for (const name of plan.retire || []) {
    const row = S.current[name];
    if (row && row.kind === 'file') await mtp.remove(row.id);
    delete S.current[name];
  }
  const sources = Object.fromEntries(plan.items.map((item) => [item.remote, sourceFor(item, files)]));
  let last = null;
  const count = plan.items.length;
  await mtp.applyCopy(S.current, plan, sources, (remote, done, total) => {
    const index = plan.items.findIndex((item) => item.remote === remote);
    const kind = index >= 0 ? plan.items[index].kind : 'file';
    const name = kind === 'padding' ? 'the spacer the installer needs' : remote;
    if (remote !== last) last = remote;
    activity(`Sending ${name}, ${index + 1} of ${count}`, done, total, `Sent ${name}`);
  });
  plan.sent = new Set(plan.items.map((item) => item.remote));
  return plan;
}

async function fileBytes(file) {
  if (file.bytes && file.bytes.length === file.size) return file.bytes;
  const blob = file.file || file;
  if (!blob.arrayBuffer) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
function bytesMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function heldLocally(name, bytes) {
  for (const local of localFiles().filter((file) => file.name === name)) {
    if (await bytesMatch(await fileBytes(local), bytes)) return true;
  }
  return false;
}
async function copyHome(name, bytes) {
  if (!S.dir || !S.dirAllowed) return false;
  const occupied = new Set(localFiles().map((file) => file.path));
  let folderName = 'packs';
  let path = `packs/${name}`;
  let n = 0;
  while (occupied.has(path)) {
    n += 1;
    folderName = n === 1 ? 'from-field' : `from-field-${n}`;
    path = `${folderName}/${name}`;
  }
  await writeLocal(name, bytes, folderName, null);
  return true;
}
async function deletePacks(mtp) {
  const doomed = (S.links && S.links.items || []).filter((item) => item.role === 'pack' && packWant(item) === 'remove');
  let count = 0;
  let freed = 0;
  for (const item of doomed) {
    for (const copy of item.copies.filter((row) => row.side === 'remote')) {
      const live = S.current[copy.path];
      if (!live || live.kind !== 'file') continue;
      let bytes = S.packBytes.get(copy.path + ':' + live.size);
      if (!bytes) bytes = new Uint8Array(await mtp.get(live.id));
      if (!(await heldLocally(item.name, bytes))) {
        activity(`Copying ${item.name} here`, count, doomed.length, `Copied ${item.name} here`);
        if (!(await copyHome(item.name, bytes))) throw new Refused(item.name + ' is only on the Field. Choose a folder so a copy can be kept on this computer.');
      }
      activity(`Removing ${copy.path}`, count, doomed.length, `Removed ${copy.path}`);
      await mtp.remove(live.id);
      freed += live.size || 0;
      delete S.current[copy.path];
      S.packMode[item.name] = 'skip';
      count += 1;
    }
  }
  if (freed && S.space) S.space = { ...S.space, free: S.space.free + freed };
  return count;
}

async function run(what) {
  S.phase = 'working'; S.refusal = null; S.message = ''; S.headline = ''; S.rebootNames = new Set();
  S.activity = []; S.progress = null; render();
  let pulled = [], removed = 0, plan = null;
  const sending = S.pairs.slice();
  const isPack = (pair) => pair.role === 'pack' || (pair.remote || '').toLowerCase().endsWith('.pack');
  const ok = await withField(async (mtp) => {
    removed = await deletePacks(mtp);
    if (what !== 'send') pulled = await pullChanges(mtp);
    if (what !== 'pull' && sending.length) plan = await sendFiles(mtp);
    await readInventory(mtp, 'Checking the Field');
  });
  if (!ok) return;
  const landed = [];
  const missed = [];
  for (const pair of (plan ? sending : [])) {
    // The running unit's drive can list a file it has just accepted a moment later, so a file the Field accepted
    // counts as landed unless the new listing shows it at another size.
    const row = S.current && S.current[pair.remote];
    const accepted = !!(plan.sent && plan.sent.has(pair.remote));
    if (row ? (row.kind === 'file' && row.size === pair.size) : accepted) landed.push(pair);
    else missed.push(pair);
  }
  for (const pair of landed) {
    const digest = await digestOf(pair.file || pair);
    rememberCopy(pair.path || (pair.file && pair.file.path) || pair.name, pair.remote, pair.size, digest);
    if (S.packMode[pair.name] === 'sync') delete S.packMode[pair.name];
  }
  for (const item of pulled) {
    if (S.packMode[item.name] === 'sync') delete S.packMode[item.name];
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const sentPacks = landed.filter(isPack).length;
  const sentFirmware = landed.some((pair) => pair.remote === 'os.ldr');
  const logsCopied = pulled.filter((item) => item.role === 'log').length;
  const packsCopied = pulled.length - logsCopied;
  const bits = [];
  if (landed.length) bits.push('Sent ' + [sentFirmware ? 'firmware' : '', sentPacks ? plural(sentPacks, 'pack') : ''].filter(Boolean).join(' and '));
  if (pulled.length) bits.push('Copied ' + [logsCopied ? plural(logsCopied, 'log') : '', packsCopied ? plural(packsCopied, 'pack') : ''].filter(Boolean).join(' and ') + ' here');
  if (removed) bits.push(`Removed ${plural(removed, 'pack')}`);
  if (missed.length) bits.push((missed.length > 3 ? plural(missed.length, 'file') : joinNames(missed.map((pair) => spokenName(pair.name)))) + ' did not land');
  const fresh = landed.filter(isPack);
  S.rebootNames = new Set(fresh.map((pair) => pair.name));
  S.message = bits.length ? bits.join('. ') + '.' : '';
  S.sentFirmware = !!(plan && plan.withLdr && landed.some((pair) => pair.remote === 'os.ldr'));
  S.headline = missed.length ? 'Stopped' : !S.message ? 'Ready' : removed && !landed.length && !pulled.length ? 'Removed' : 'Synced';
  S.phase = 'ready';
  activityFinish();
  S.packBytes.clear();
  if (S.dir && S.dirAllowed) await readFolder(); else await replan();
}

// ---- drawing ----
const WORDS = {
  chrome: ['Chrome', 'This page needs Chrome.'],
  plug: ['MTP-1F', ''],
  looking: ['Looking', 'Watching USB for five seconds.'],
  reading: ['Reading', 'Reading what is on the Field.'],
  busy: ['Busy', 'Another app has the Field.'],
  console: ['Not shared', 'The Field is in its boot menu.'],
  stalled: ['Stalled', 'The Field stopped answering. Files already sent stay.'],
  error: ['Stopped', ''],
  working: ['Copying', 'Keep the Field plugged in.'],
  flash: ['Copied', 'The firmware is on the Field.'],
};


function copyStatus() {
  const busy = ['working', 'reading', 'looking'].includes(S.phase);
  const done = (S.activity || []).filter((row) => row.state === 'done' || row.state === 'now');
  if (!S.progress && !done.length) return null;
  // The label and bar always take their space, so the block does not change size as a copy starts and ends.
  const progress = S.progress || { label: '\u00a0', done: 0, total: 1 };
  return h('div', { class: 'activity' },
    h('p', { class: 'progress-label' }, progress.label),
    h('div', { class: 'progress', role: 'progressbar', 'aria-label': S.progress ? progress.label : 'Progress',
      'aria-valuenow': progress.done, 'aria-valuemax': progress.total },
      h('span', { style: `width:${S.progress ? (100 * progress.done / Math.max(1, progress.total)).toFixed(1) : 0}%` })),
    done.length ? h('ol', {}, done.map((row) => h('li', { class: row.state }, row.text))) : null);
}

function render() {
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : '';
  const scrolls = [...document.querySelectorAll('.pack-scroll')].map((el) => el.scrollTop);
  const pageY = window.scrollY;
  const unconfigured = S.current && S.links && !S.links.packDir;
  const mode = viewMode();
  const readyText = unconfigured
    ? 'This device has no pack folder.'
    : mode === 'field'
    ? 'Choose a folder to copy from.'
    : '';
  const [word, text] = S.phase === 'ready'
    ? [S.headline || (S.message ? 'Synced' : 'Ready'), S.message || readyText]
    : WORDS[S.phase];
  const caption = S.message && (S.phase === 'error' || S.phase === 'plug') ? S.message
    : S.phase === 'error' ? S.message
    : S.phase === 'flash' && S.message ? S.message + ' ' + text
    : S.phase === 'looking' && S.sentMidi ? 'Asked the Field to share its drive. Watching for five seconds.'
    : text;
  const alarm = ['busy', 'stalled', 'error', 'console'].includes(S.phase);
  const linked = S.device || (S.current && S.phase === 'ready');
  const info = S.info ? `${S.info.model || 'OP-1 Field'}${S.info.serial ? ' · ' + S.info.serial : ''}` : null;
  app.replaceChildren(...[
    h('div', { class: 'band' },
      h('div', {}, h('h1', { class: 'word' + (alarm ? ' alarm' : '') }, word),
        caption ? h('p', { class: 'caption' }, caption) : null),
      h('div', { class: 'marks', role: 'img', 'aria-label': `${linked ? 'Field connected' : 'No Field'}, ${S.dir && S.dirAllowed ? 'folder chosen' : 'no folder'}` },
        h('span', { class: 'mark' + (linked ? ' on' : ''), title: info || 'no Field' }),
        h('span', { class: 'mark' + (S.dir && S.dirAllowed ? ' on' : ''), title: S.dirName || 'no folder' }))),
    S.dialog ? dialogView() : null,
    actions(),
    S.space && capacity(),
    copyStatus(),
    lanes(),
  ].filter(Boolean));
  document.querySelectorAll('.pack-scroll').forEach((el, index) => { if (scrolls[index]) el.scrollTop = scrolls[index]; });
  if (window.scrollY !== pageY) window.scrollTo(0, pageY);
  const feed = document.querySelector('.activity ol');
  if (feed) feed.scrollTop = feed.scrollHeight;
  if (focusKey && !S.dialog) {
    const back = [...document.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === focusKey);
    if (back) back.focus({ preventScroll: true });
  }
  const status = document.getElementById('status');
  if (status) status.textContent = [word, caption].filter(Boolean).join('. ');
  if (S.dialog) { const ok = document.querySelector('.notice button'); if (ok) ok.focus(); }
  const find = document.querySelector('.pack-find');
  if (find && S.packFocus) {
    find.focus();
    const caret = S.packCaret || 0;
    find.setSelectionRange(caret, caret);
  }
}

let dialogClose = null;
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && S.dialog && dialogClose) dialogClose(); });
function showDialog(text, buttons) { S.dialog = { text, buttons }; render(); }
function showLimit() { showDialog(limitWords(packRoom()), [{ label: 'OK' }]); }
function dialogView() {
  const close = () => { S.dialog = null; render(); };
  dialogClose = close;
  return h('div', { class: 'scrim', onclick: (event) => { if (event.target === event.currentTarget) close(); } },
    h('div', { class: 'notice', role: 'alertdialog', 'aria-label': 'Notice' },
      h('p', {}, S.dialog.text),
      h('div', { class: 'settle-actions' }, S.dialog.buttons.map((button, index) => h('button', {
        class: index === 0 ? 'primary' : 'secondary',
        onclick: () => { S.dialog = null; if (button.run) button.run(); else render(); },
      }, button.label)))));
}

// The scarce thing is pack slots, so they are the picture: kept on the Field, added by this sync, over the limit.
function slotStrip(room) {
  const members = packMembers().filter((member) => !member.path || inPackFolder(member.path));
  const kept = new Set(members.filter((member) => member.onUnit).map((member) => member.file.toLowerCase())).size;
  const added = room.count - kept;
  const cells = Math.max(room.limit, room.count);
  const slots = [];
  for (let i = 0; i < cells; i++) {
    slots.push(h('span', { class: 'slot' + (i < kept ? ' kept' : i < kept + added ? ' added' : '') + (i >= room.limit ? ' over' : '') }));
  }
  return h('div', {},
    h('div', { class: 'slots', role: 'img', 'aria-label': `${room.count} of ${room.limit} pack slots used on the Field` }, slots),
    h('div', { class: 'space' }, h('span', {}, `${room.count} of ${room.limit} packs`), h('span', {}, mb(S.space.free) + ' free')));
}
function capacity() {
  const room = packRoom();
  if (room.counted) return slotStrip(room);
  const { capacity: total, free } = S.space;
  const adding = S.plan ? S.plan.items.reduce((sum, i) => sum + i.size - (S.current[i.remote] ? S.current[i.remote].size : 0), 0) : 0;
  const pct = (n) => `${Math.max(0, 100 * n / total).toFixed(2)}%`;
  return h('div', {},
    h('div', { class: 'capacity', 'aria-label': 'Field storage' },
      h('span', { class: 'used', style: `width:${pct(total - free)}` }),
      h('span', { class: 'adding', style: `width:${pct(Math.max(0, adding))}` })),
    h('div', { class: 'space' }, h('span', {}, info()), h('span', {}, mb(free) + ' free')));
}
const info = () => (S.info ? [S.info.model || 'OP-1 Field', S.info.serial].filter(Boolean).join(' · ') : '');

// Newest of the file's created, modified, and added times, in the browser's zone.
function formatWhen(ms) {
  if (!ms) return '';
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone: zone, day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('day')} ${part('month')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
function dateKind(copy) {
  const times = [copy.modified || 0, copy.created || 0, copy.added || 0].filter((time) => time > 0);
  if (!times.length) return 'no time';
  return formatWhen(Math.max(...times));
}
function sideCopies(item, side) {
  return item.copies.filter((copy) => copy.side === side);
}
function shownCopy(item, side) {
  const copies = sideCopies(item, side);
  if (!copies.length) return null;
  const picked = item.chosen || item.usedPath;
  return copies.find((copy) => copy.path === picked)
    || copies.slice().sort((a, b) => (b.stamp || 0) - (a.stamp || 0) || (a.path < b.path ? -1 : 1))[0];
}
function isNewer(copy, other) {
  return !!(copy && other && copy.stamp && other.stamp && copy.stamp > other.stamp + 2000);
}
function needsReboot(item) {
  return !!(item && item.role === 'pack' && item.action === 'same' && S.rebootNames && S.rebootNames.has(item.name));
}
function statusOf(item) {
  if (packWant(item) === 'remove') return ['remove', 'Remove'];
  if (wrongOs(item)) return ['wrongos', 'Wrong OS'];
  if (item.conflict) return ['choose', 'Choose'];
  if (needsReboot(item)) return ['reboot', 'Loads on next boot'];
  if (item.action === 'same') return ['same', 'Same'];
  if (packWant(item) !== 'sync') return ['skip', 'Skip'];
  if (item.action === 'push') return ['send', 'Send'];
  if (item.action === 'pull') return ['get', 'Get'];
  return ['same', 'Same'];
}
function packShown(item, query) {
  if (query && !item.name.toLowerCase().includes(query) && !item.copies.some((copy) => copy.path.toLowerCase().includes(query))) return false;
  if (item.conflict) return S.packShow.conflicts;
  if (packWant(item) === 'remove' || item.action === 'push' || item.action === 'pull') return S.packShow.changes;
  return S.packShow.same;
}
function setPackMode(item, mode) {
  if (mode === 'sync' && item.role === 'pack' && wrongOs(item)) return;
  if (mode === 'sync' && item.role === 'pack' && packWant(item) !== 'sync') { stageItems([item], true).catch(fail); return; }
  S.packMode[item.name] = packWant(item) === mode ? 'skip' : mode;
  S.message = '';
  S.headline = '';
  S.activity = [];
  replanQuiet().catch(fail);
}
// One press stages every change this page would otherwise ask for row by row, up to the loader's limit.
function stageableItems() {
  if (viewMode() !== 'both' || S.refusal) return [];
  return (S.links && S.links.items || []).filter((item) => item.role === 'pack' && !item.held && !wrongOs(item) && !stashed(item)
    && (item.action === 'push' || item.action === 'pull') && packWant(item) !== 'sync' && packWant(item) !== 'remove');
}
function stageAll() { stageItems(stageableItems(), false).catch(fail); }
function stagedItems() {
  return (S.links && S.links.items || []).filter((item) => item.role === 'pack' && (item.action === 'push' || item.action === 'pull') && packWant(item) === 'sync');
}
function unstageAll() {
  for (const item of stagedItems()) S.packMode[item.name] = 'skip';
  S.message = ''; S.headline = ''; S.activity = [];
  replanQuiet().catch(fail);
}
function keepCopy(name, path) {
  if (S.packMode[name] !== 'sync' && refuseIfFull(name)) return;
  S.packKeep[name] = path;
  S.packMode[name] = 'sync';
  S.openPack = name;
  replanQuiet().catch(fail);
}

function dirLabel(path) {
  if (!path) return '';
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}
function shortSha(copy) {
  return copy && copy.digest ? copy.digest.slice(0, 8) : '';
}
function impliedDir(copy, item) {
  const dir = dirLabel(copy && copy.path);
  if (!dir) return true;
  if (item && item.role === 'log' && dir === 'logs/') return true;
  if (item && item.role === 'firmware' && dir === 'firmware/') return true;
  const home = S.links && S.links.packDir;
  return !!(home && (dir === home || dir === `${home}/`));
}
function rowName(item) {
  if (item.role === 'pack') return item.name.replace(/\.pack$/i, '');
  if (item.role === 'log') return item.name.replace(/\.txt$/i, '');
  return item.name;
}
function viewMode() {
  const folder = !!(S.dir && S.dirAllowed);
  if (S.current && folder) return 'both';
  if (S.current) return 'field';
  if (folder || S.dropped.size) return 'local';
  return 'empty';
}
function packSentence(item) {
  const mode = viewMode();
  if (item.held) return 'On this computer only. Manage it in Dev Mode MTP.';
  if (packWant(item) === 'remove') return 'Remove from the Field';
  const wrong = wrongOs(item);
  if (wrong) return wrong.twin ? `Superseded by ${wrong.twin}` : 'Will not load';
  if (mode === 'local') return '';
  if (mode === 'field') return sideCopies(item, 'remote').length ? 'On the Field' : 'Only on this computer';
  if (mode === 'both' && item.role === 'log' && item.action === 'pull' && !item.conflict) return '';
  if (item.conflict && sideCopies(item, 'remote').length && sideCopies(item, 'local').length) return 'Copies differ: choose one';
  if (item.conflict) return sideCopies(item, 'remote').length ? 'Only on the Field' : 'Only on this computer';
  if (needsReboot(item)) return 'Loads on next boot';
  if (item.action === 'same') return 'Same on both';
  if (!sideCopies(item, 'remote').length) return 'Only on this computer';
  if (!sideCopies(item, 'local').length) return 'Only on the Field';
  if (item.action === 'keep') {
    const local = shownCopy(item, 'local');
    const remote = shownCopy(item, 'remote');
    return isNewer(local, remote) ? 'Newer on this computer' : 'Newer on the Field';
  }
  if (item.action === 'push') return 'Newer on this computer';
  if (item.action === 'pull') return 'Newer on the Field';
  return '';
}

function headerFor(copy) {
  if (!copy) return null;
  if (copy.side === 'remote') return (S.current && S.current[copy.path] && S.current[copy.path].header) || null;
  const file = localFiles().find((item) => item.path === copy.path);
  return (file && file.header) || null;
}
function identityOf(item) {
  const header = headerFor(shownCopy(item, 'local')) || headerFor(shownCopy(item, 'remote'));
  return packIdentity(header, S.firmwareFacts);
}
// The loader is for one OS. A pack built for another is left out at every boot, so sending it only uses one of
// the loader's pack slots. When the folder holds a build of the same pack for this OS, the row says which.
function wrongOs(item) {
  if (!item || item.role !== 'pack') return null;
  const header = headerFor(shownCopy(item, 'local') || shownCopy(item, 'remote'));
  const os = header && knownOs(header.firmware);
  if (!os || os === LOADER_OS) return null;
  const twin = (S.links && S.links.items || []).find((other) => {
    if (other === item || other.role !== 'pack') return false;
    const found = headerFor(shownCopy(other, 'local') || shownCopy(other, 'remote'));
    return found && found.name === header.name && knownOs(found.firmware) === LOADER_OS;
  });
  return { os, twin: twin ? twin.name : '' };
}
// Packs already on the Field that were built for another OS than the loader's. Loading a new OS is when this
// matters most: the new loader leaves every one of them out, and they keep using pack slots.
function staleFieldPacks() {
  if (!S.current || !packFolder()) return [];
  const remote = (S.links && S.links.items || []).filter((item) => item.role === 'pack' && sideCopies(item, 'remote').length && packWant(item) !== 'remove'
    && !sideCopies(item, 'local').some((copy) => copy.os === LOADER_OS));
  const rows = remote.map((item) => {
    const header = headerFor(shownCopy(item, 'remote'));
    return { file: item.name, firmware: header && header.firmware };
  });
  return packsForOtherOs(rows, LOADER_OS);
}
function stalePanel() {
  const stale = staleFieldPacks();
  if (!stale.length) return null;
  const loading = !!(S.firmware || (S.links && S.links.items || []).some((item) => item.role === 'firmware' && item.action === 'push' && packWant(item) === 'sync'));
  const names = stale.map((row) => row.file.replace(/\.pack$/i, ''));
  const old = [...new Set(stale.map((row) => row.os))].join(' and ');
  return h('div', { class: 'settle-clash' },
    h('p', { class: 'warn' }, `${loading ? 'New OS: ' : ''}${stale.length === 1 ? '1 pack on the Field is' : `${stale.length} packs on the Field are`} built for OS ${old} and won't load on ${LOADER_OS}: ${joinNames(names)}.`),
    h('div', { class: 'settle-actions' },
      h('button', { class: 'secondary', onclick: () => {
        for (const row of stale) S.packMode[row.file] = 'remove';
        S.message = ''; S.headline = ''; S.activity = [];
        replanQuiet().catch(fail);
      } }, stale.length === 1 ? 'Remove it from the Field' : `Remove these ${stale.length} from the Field`)));
}
// A pack built for the wrong OS whose own build for the right OS sits in the folder under another name is not
// shown as a row of its own. It is listed under that build, for anyone who wants to look.
// Files are grouped by the pack name inside them, not by file name: loopback.pack and loopback-1.7.3.pack can be
// the same pack. One file of a group is the row; the others are listed under it and are never sent.
function packNameOf(item) {
  if (!item || item.role !== 'pack') return '';
  const header = headerFor(shownCopy(item, 'local') || shownCopy(item, 'remote'));
  return header ? header.name : '';
}
function versionOf(item) {
  const header = headerFor(shownCopy(item, 'local') || shownCopy(item, 'remote'));
  return header && Number.isInteger(header.version) ? header.version : -1;
}
function samePackGroup(item) {
  const name = packNameOf(item);
  if (!name) return [item];
  return (S.links && S.links.items || []).filter((other) => other.role === 'pack' && packNameOf(other) === name);
}
// The row a group shows: the loader's OS, then the highest version, then the file on the Field, then the plain
// <name>.pack, then the newest.
function groupLead(group) {
  const onField = (item) => sideCopies(item, 'remote').length > 0;
  const plain = (item) => item.name.toLowerCase() === packNameOf(item).toLowerCase() + '.pack';
  return group.slice().sort((a, b) => (wrongOs(a) ? 1 : 0) - (wrongOs(b) ? 1 : 0)
    || versionOf(b) - versionOf(a)
    || (onField(b) ? 1 : 0) - (onField(a) ? 1 : 0)
    || (plain(b) ? 1 : 0) - (plain(a) ? 1 : 0)
    || (b.newest || 0) - (a.newest || 0)
    || (a.name < b.name ? -1 : 1))[0];
}
// A file that is not its group's row is listed under that row. One already on the Field stays a row of its own,
// so it can be removed.
function stashed(item) {
  if (sideCopies(item, 'remote').length) return false;
  const group = samePackGroup(item);
  return group.length > 1 && groupLead(group) !== item;
}
function strayBuilds(item) {
  const group = samePackGroup(item);
  if (group.length < 2 || groupLead(group) !== item) return [];
  return group.filter((other) => other !== item && stashed(other));
}
function buildsOf(item) {
  const seen = [];
  for (const copy of item.copies || []) {
    const header = headerFor(copy);
    if (!header) continue;
    const id = packIdentity(header, null);
    const key = [id.os, id.version, id.interface].join('|');
    if (!seen.some((row) => row.key === key)) seen.push({ key, id });
  }
  return seen;
}
function firmwareLine() {
  const facts = S.firmwareFacts || { local: [], field: null };
  const bits = [...new Set((facts.local || []).map((row) => firmwareLabel(row.word)).filter(Boolean))];
  if (viewMode() !== 'local') {
    if (facts.field != null) bits.push('On the Field: ' + firmwareLabel(facts.field));
    else if (S.current && S.current['os.ldr']) bits.push('On the Field: not read yet');
  }
  if (!bits.length) return null;
  return h('span', { class: 'pack-meta' }, bits.join(' · '));
}
function identityLine(item) {
  if (item.role === 'firmware') return firmwareLine();
  if (item.role !== 'pack') return null;
  const id = identityOf(item);
  if (!id) return null;
  const warn = id.match.startsWith('this Field is');
  const bits = [id.name !== rowName(item) ? id.name : '', 'version ' + id.version, warn ? id.match : ''].filter(Boolean);
  return h('span', { class: 'pack-meta' + (warn ? ' warn' : '') }, bits.join(' · '));
}
function packRow(item) {
  const mode = viewMode();
  const want = packWant(item);
  const open = S.openPack === item.name;
  const hasRemote = mode !== 'local' && item.copies.some((copy) => copy.side === 'remote');
  const local = shownCopy(item, 'local');
  const remote = shownCopy(item, 'remote');
  const [tone] = statusOf(item);
  const blocked = item.role === 'firmware' ? (S.refusal || S.firmwareRefusal) : S.refusal;
  const canSync = mode === 'both' && !item.held && !blocked && !wrongOs(item) && (item.action === 'push' || item.action === 'pull');
  const sentence = packSentence(item);
  const newest = Math.max(0, ...item.copies.map((copy) => copy.stamp || 0));
  const notes = packNotes(item);
  const strays = strayBuilds(item);
  const details = item.choose || item.others || strays.length || (hasRemote && item.role === 'pack');
  return h('div', { class: 'pack ' + tone + (item.conflict || notes.some((n) => n.querySelector && n.querySelector('.warn')) ? ' clash' : '') },
    h('div', { class: 'pack-row' },
      h('div', { class: 'pack-id' },
        h('span', { class: 'pack-name' }, rowName(item)),
        identityLine(item),
        sentence ? h('span', { class: 'status ' + tone }, sentence) : null,
        null),
      h('div', { class: 'pack-actions' },
        hasRemote && item.role === 'pack' && (open || want === 'remove') ? h('button', {
          class: 'toggle remove' + (want === 'remove' ? ' on' : ''),
          'aria-label': 'Remove ' + rowName(item) + ' from the Field', 'data-focus': 'remove:' + item.name,
          'aria-pressed': want === 'remove' ? 'true' : 'false',
          onclick: () => setPackMode(item, 'remove'),
        }, want === 'remove' ? 'Removing from the Field' : 'Remove from the Field') : null,
        item.conflict ? h('button', {
          class: 'bang' + (open ? ' on' : ''),
          'aria-label': 'Choose which ' + item.name + ' to keep',
          onclick: () => { S.openPack = open ? null : item.name; render(); },
        }, '!') : null,
        details ? h('button', {
          class: 'copies' + (open ? ' on' : ''), 'data-focus': 'copies:' + item.name,
          'aria-label': 'Other versions of ' + item.name,
          onclick: () => { S.openPack = open ? null : item.name; render(); },
        }) : null,
        canSync ? h('button', {
          class: 'toggle sync' + (want === 'sync' ? ' on' : ''),
          'aria-label': 'Stage ' + rowName(item), 'data-focus': 'stage:' + item.name,
          'aria-pressed': want === 'sync' ? 'true' : 'false',
          onclick: () => setPackMode(item, 'sync'),
        }, want === 'sync' ? 'Staged' : 'Stage') : null)),
    notes.length ? h('div', { class: 'pack-notes' }, notes) : null,
    open && details && h('div', { class: 'copies-list' }, [...item.copies
      .slice().sort((a, b) => (b.stamp || 0) - (a.stamp || 0) || (a.path < b.path ? -1 : 1))
      .map((copy) => {
        const using = copy.path === (item.chosen || item.usedPath);
        const fresh = copy.stamp && newest - copy.stamp < 2000;
        return h('div', { class: 'copy' + (using ? ' using' : '') + (fresh ? ' fresh' : '') },
          h('span', { class: 'pack-age' }, (dateKind(copy) || 'no time') + (fresh ? ' · newer' : '') + (Number.isInteger(copy.version) ? ' · version ' + copy.version : '') + (copy.os ? ' · OS ' + copy.os : '')),
          shortSha(copy) ? h('span', { class: 'sha', title: copy.digest }, shortSha(copy)) : null,
          h('span', { class: 'copy-path' }, copy.side === 'remote' && impliedDir(copy, item) ? 'Field' : (impliedDir(copy, item) ? 'Local' : dirLabel(copy.path))),
          h('button', {
            class: 'toggle sync' + (using ? ' on' : ''),
            disabled: !!(copy.os && copy.os !== LOADER_OS),
            title: copy.os && copy.os !== LOADER_OS ? `Built for OS ${copy.os}. It will not load.` : null,
            onclick: () => keepCopy(item.name, copy.path),
          }, using ? 'Using' : copy.os && copy.os !== LOADER_OS ? 'Wrong OS' : 'Use'));
      }), ...strays.map((stray) => h('div', { class: 'copy' },
        h('span', { class: 'pack-age' }, stray.name + ' · version ' + versionOf(stray) + (wrongOs(stray) ? ' · OS ' + wrongOs(stray).os : '')),
        h('span', { class: 'copy-path' }, 'Not used'))) ]));
}

function settleFix(row) {
  if (row.fix === 'stage') {
    const items = (S.links && S.links.items || []).filter((item) => item.role === 'pack');
    const found = items.some((item) => item.name.toLowerCase() === String(row.detail || '').toLowerCase() + '.pack' || (identityOf(item) || {}).name === row.detail);
    if (!found) return h('p', { class: 'pack-meta' }, row.detail + '.pack is not in this folder.');
    return h('button', { class: 'secondary', onclick: () => stageNamed(row.detail) }, 'Stage ' + row.detail);
  }
  if (row.fix !== 'omit') return null;
  const label = unitHolds(row.file)
    ? (localFiles().some((file) => file.name === row.file) ? `Remove ${row.file} from the Field` : `Copy ${row.file} here, then remove it from the Field`)
    : "Don't send";
  return h('button', { class: 'secondary', onclick: () => leavePack(row.file) }, label);
}
// What is true of the whole set: the start screen the loader would show, and how far to trust the prediction.
function settlePanel() {
  const report = S.settle;
  if (!report || !S.current) return null;
  return null;
}
// The pack a left-out pack needs, named in the loader's own sentence ("it needs the base pack, ...").
function neededName(row) {
  const found = /needs the (.+?) pack/.exec(row.sentence || '');
  return found ? found[1] : (row.detail || '');
}
// Why a needed pack is not running: it is not in the folder, it is not staged, or it is staged and still not loading.
function prereqPhrase(row) {
  const need = itemForPack(neededName(row));
  if (!need || !sideCopies(need, 'local').length) return 'which is not in this folder';
  const onField = need.copies.some((copy) => copy.side === 'remote' && copy.os === LOADER_OS);
  if (packWant(need) !== 'sync' && !onField) return 'which is not staged';
  return 'which is not loading';
}
// What the loader would do with this one pack, shown on the pack's own row.
// One pack held twice on the Field under different file names: the extra file says so, with a way to remove it.
function fieldTwinNote(item) {
  if (!S.current || item.role !== 'pack' || !sideCopies(item, 'remote').length) return null;
  const twins = samePackGroup(item).filter((other) => other !== item && sideCopies(other, 'remote').length);
  if (!twins.length) return null;
  const lead = groupLead([item, ...twins]);
  if (lead === item) return null;
  return h('div', { class: 'settle-clash' },
    h('p', { class: 'warn' }, `Same pack as ${lead.name} on the Field. The loader runs only one.`),
    h('div', { class: 'settle-actions' }, h('button', { class: 'secondary', onclick: () => leavePack(item.name) }, 'Remove it from the Field')));
}
function packNotes(item) {
  const twin = fieldTwinNote(item);
  const report = S.settle;
  if (!report || !S.current || item.role !== 'pack') return twin ? [twin] : [];
  const mine = (row) => row.file === item.name;
  const out = [];
  for (const clash of report.clashes.filter(mine)) {
    const holds = (name) => unitHolds(name) && !localFiles().some((file) => file.name === name);
    out.push(h('div', { class: 'settle-clash' },
      h('p', { class: 'warn' }, clash.sentence),
      h('p', { class: 'pack-meta' }, (clash.sequencers
        ? 'Both are sequencers using the same firmware calls, so only one can load and appear in the sequencer list. Leaving the other on the Field keeps the conflict.'
        : 'Only one of them can load: the one earlier in the alphabet gets the calls. Leaving the other on the Field keeps the conflict.')
        + (holds(clash.file) || holds(clash.otherFile) ? ' The one left out is copied to your folder before it is removed from the Field.' : '')),
      h('div', { class: 'settle-actions' },
        h('button', { class: 'secondary', onclick: () => leavePack(clash.file) }, 'Keep ' + titleCase(clash.other)),
        h('button', { class: 'secondary', onclick: () => leavePack(clash.otherFile) }, 'Keep ' + titleCase(clash.name)))));
  }
  for (const row of report.left.filter((entry) => mine(entry) && entry.fix !== 'keep')) {
    if (row.why === 'firmware' && sideCopies(item, 'local').some((copy) => copy.os === LOADER_OS)) continue;
    const reason = row.sentence.replace(/^.*? is left out: /, '').replace(/which is not loading$/, prereqPhrase(row));
    out.push(h('div', { class: 'settle-clash' },
      row.why === 'firmware' && wrongOs(item) && wrongOs(item).twin ? null : h('p', { class: 'warn' }, reason.charAt(0).toUpperCase() + reason.slice(1) + '.'),
      ['sum', 'read', 'lists', 'card'].includes(row.why) ? h('p', { class: 'pack-meta' }, 'Copy it again. If it still fails, rebuild the pack.') : null,
      h('div', { class: 'settle-actions' }, settleFix(row))));
  }
  for (const row of report.unread.filter(mine)) {
    out.push(h('div', { class: 'settle-clash' },
      h('p', { class: 'warn' }, row.sentence.replace(/^\S+ is skipped: /, '').replace(/^./, (c) => c.toUpperCase())),
      h('div', { class: 'settle-actions' }, settleFix({ ...row, fix: 'omit' }))));
  }
  for (const row of report.aside.filter(mine)) out.push(h('p', { class: 'pack-meta' }, row.sentence));
  if (twin) out.unshift(twin);
  return out;
}
function packLane(links) {
  const packs = (links.items || []).filter((item) => item.role === 'pack' && !stashed(item));
  const query = S.packQuery.trim().toLowerCase();
  const visible = packs.filter((item) => packShown(item, query));
  const counts = {
    changes: packs.filter((item) => item.action === 'push' || item.action === 'pull' || packWant(item) === 'remove').length,
    same: packs.filter((item) => !item.conflict && item.action === 'same' && packWant(item) !== 'remove').length,
    conflicts: packs.filter((item) => item.conflict).length,
  };
  const filter = (key, label) => h('button', {
    class: 'toggle ' + (key === 'conflicts' && counts.conflicts ? 'remove' : 'sync') + (S.packShow[key] ? ' on' : ''),
    'aria-pressed': S.packShow[key] ? 'true' : 'false',
    onclick: () => { S.packShow[key] = !S.packShow[key]; render(); },
  }, `${label} ${counts[key]}`);
  const room = packRoom();
  const mode = viewMode();
  const stageable = stageableItems();
  const overview = [settlePanel(), stalePanel(),
  ].filter(Boolean);
  const title = mode === 'both' ? 'This computer and the Field' : mode === 'field' ? 'On the Field' : 'Packs';
  return h('div', { class: 'lane packs mode-' + mode },
    h('div', { class: 'pack-head' },
      h('span', { class: 'kind' }, title),
      mode === 'both' && (counts.changes || counts.same || counts.conflicts) ? null : h('span', { class: 'pack-count' }, packs.length ? String(packs.length) : 'none'),
      mode === 'both' && counts.changes ? filter('changes', 'Changes') : null,
      mode === 'both' && (stageable.length || stagedItems().length) ? h('button', { class: 'toggle sync', onclick: stageable.length ? stageAll : unstageAll },
        stageable.length ? `Stage all ${stageable.length}` : 'Unstage all') : null,
      mode === 'both' && counts.same ? filter('same', 'Matching') : null,
      mode === 'both' && counts.conflicts ? filter('conflicts', 'Choose') : null),
    overview.length ? h('div', { class: 'pack-overview' }, overview) : null,
    h('div', { class: 'pack-browser' },
    packs.length ? h('input', {
      class: 'pack-find', value: S.packQuery, placeholder: 'Find',
      'aria-label': 'Find a pack',
      oninput: (event) => { S.packQuery = event.target.value; S.packCaret = event.target.selectionStart; S.packFocus = true; render(); },
      onfocus: () => { S.packFocus = true; },
      onblur: () => { S.packFocus = false; },
    }) : null,
    h('div', { class: 'pack-scroll', onscroll: (event) => { S.packScroll = event.target.scrollTop; } },
      visible.length ? visible.map(packRow) : h('p', { class: 'pack-age' }, packs.length ? 'Nothing in this view' : 'No packs yet'))));
}

function isWanted(name) {
  const lower = (name || '').toLowerCase();
  return lower.endsWith('.ldr') || lower.endsWith('.pack') || lower.endsWith('.txt');
}
function rememberFile(file, path) {
  if (!file || !isWanted(file.name)) return;
  const where = path || file.webkitRelativePath || file.name;
  S.dropped.set(where, { name: file.name, path: where, size: file.size, modified: file.lastModified, file });
}
function addFiles(list) {
  for (const file of list || []) rememberFile(file);
  replan().catch(fail);
}
function readEntry(entry) {
  return new Promise((resolve) => {
    if (!entry) { resolve(); return; }
    if (entry.isFile) {
      entry.file((file) => { rememberFile(file, (entry.fullPath || file.name).replace(/^\//, '')); resolve(); }, () => resolve());
      return;
    }
    if (!entry.isDirectory) { resolve(); return; }
    const reader = entry.createReader();
    const all = [];
    const pull = () => reader.readEntries((batch) => {
      if (!batch.length) { Promise.all(all.map(readEntry)).then(() => resolve()); return; }
      all.push(...batch);
      pull();
    }, () => resolve());
    pull();
  });
}
function dropZone() {
  const input = h('input', {
    class: 'file-input', type: 'file', multiple: true, accept: '.ldr,.pack,.txt',
    onchange: (event) => { addFiles(event.target.files); event.target.value = ''; },
  });
  return h('div', { class: 'drop' },
    h('button', { type: 'button', class: 'drop-hit', onclick: () => input.click() }, 'Drop .ldr, .pack, or .txt, or click to add'),
    input);
}
// One control to stage or unstage every pull in a lane, in the same header spot as the packs lane.
function pullToggle(items) {
  const pulls = items.filter((item) => item.action === 'pull' && !item.held);
  if (!pulls.length || viewMode() !== 'both') return null;
  const off = pulls.filter((item) => packWant(item) !== 'sync');
  return h('button', {
    class: 'toggle sync', 'data-focus': 'pull-all',
    onclick: () => {
      for (const item of pulls) S.packMode[item.name] = off.length ? 'sync' : 'skip';
      S.message = ''; S.headline = ''; S.activity = [];
      replanQuiet().catch(fail);
    },
  }, off.length ? `Stage all ${off.length}` : 'Unstage all');
}
function fileSection(tone, title, items) {
  if (!items.length) return null;
  const held = items.some((item) => item.held);
  const extras = tone === 'firmware' && S.plan ? S.plan.items.filter((item) => item.kind !== 'file') : [];
  const pad = extras.find((item) => item.kind === 'padding');
  const parks = extras.filter((item) => item.kind === 'park').length;
  return h('div', { class: 'lane files ' + tone + (held ? ' idle' : '') },
    h('div', { class: 'pack-head' },
      h('span', { class: 'kind' }, title),
      h('span', { class: 'pack-count' }, items.length ? String(items.length) : 'none'),
      tone === 'logs' ? pullToggle(items) : null),
    tone === 'firmware' && S.firmware && S.firmware.release ? h('p', { class: 'caption' }, S.firmware.release) : null,
    tone === 'firmware' && (S.firmwareRefusal || S.refusal) ? h('p', { class: 'caption warn' }, S.firmwareRefusal || S.refusal) : null,
    pad && !held ? h('p', { class: 'caption' }, `padding ${mb(pad.size + parks)}`) : null,
    h('div', { class: 'pack-scroll' },
      items.length ? items.map(packRow) : h('p', { class: 'pack-age' }, 'none yet')));
}
function lanes() {
  const links = S.links || { kind: '', packDir: null, items: [], logs: [] };
  const firmware = (links.items || []).filter((item) => item.role === 'firmware');
  return h('section', { class: 'lanes' },
    dropZone(),
    packLane(links),
    fileSection('firmware', 'Firmware', firmware),
    fileSection('logs', 'Logs', links.logs || []));
}

function actions() {
  const busy = ['working', 'reading', 'looking'].includes(S.phase);
  const row = [];
  if (S.phase === 'chrome') return null;
  // While the Field is being read, nothing can be staged or sent: the plan is not finished.
  if (S.phase === 'reading' || (S.phase === 'working' && !S.current)) {
    return h('div', { class: 'actions' }, h('button', { class: 'primary', disabled: 'disabled' }, S.phase === 'reading' ? 'Reading…' : 'Working…'));
  }
  if (!S.current || ['plug', 'busy', 'stalled', 'console', 'error', 'looking'].includes(S.phase)) {
    if (needsFolder()) row.push(h('button', { class: 'primary', onclick: onFolderClick }, 'Choose folder'));
    else row.push(h('button', { class: 'primary', disabled: S.phase === 'looking', onclick: () => look().catch(fail) },
      S.phase === 'looking' ? 'Looking' : S.phase === 'busy' ? 'Try again' : 'Connect'));
  } else {
    const comparing = viewMode() === 'both';
    const packItems = (S.links && S.links.items || []).filter((item) => item.role === 'pack');
    const pulls = comparing && ((S.links && S.links.logs || []).some((item) => item.action === 'pull' && packWant(item) === 'sync')
      || packItems.some((item) => item.action === 'pull' && packWant(item) === 'sync'));
    const removes = packItems.some((item) => packWant(item) === 'remove');
    const pushes = comparing && S.pairs && S.pairs.length && S.plan && !S.refusal;
    const packCount = ((S.plan && S.plan.items) || []).filter((item) => item.kind === 'file' && item.remote !== 'os.ldr' && item.remote.toLowerCase().endsWith('.pack')).length;
    const firmware = !!(S.plan && S.plan.withLdr);
    const rescues = packItems.some((item) => packWant(item) === 'remove' && item.copies.some((copy) => copy.side === 'remote') && !localFiles().some((file) => file.name === item.name));
    const label = removes && !pushes && !pulls ? (rescues ? 'Copy here, then remove from the Field' : 'Remove from the Field')
      : firmware && packCount ? `Send firmware and ${packCount === 1 ? '1 pack' : packCount + ' packs'}`
      : firmware ? 'Send firmware'
      : packCount && !pulls ? (packCount === 1 ? 'Send 1 pack' : `Send ${packCount} packs`)
      : 'Sync changes';
    // Only a problem with something being sent blocks sending; old packs already on the Field do not.
    const sending = new Set(packItems.filter((item) => packWant(item) === 'sync').map((item) => item.name));
    const blocked = !!(S.settle && [...S.settle.left, ...S.settle.unread].some((row) => sending.has(row.file)));
    if (blocked) row.push(h('button', { class: 'primary', disabled: 'disabled' }, label));
    else if (pushes || pulls || removes) row.push(h('button', { class: 'primary', disabled: busy,
      onclick: () => run(pushes && (pulls || removes) ? 'sync' : pushes ? 'send' : 'pull').catch(fail) },
      label));
  }
  const folderButton = window.showDirectoryPicker
    ? h('button', { class: 'secondary', onclick: onFolderClick }, S.dir && S.dirAllowed ? 'Change folder' : 'Choose folder') : null;
  const menu = [];
  if (S.current && S.phase === 'ready') menu.push(h('button', { class: 'secondary', disabled: busy, onclick: () => disconnect().catch(fail) }, 'Disconnect'));
  if (S.current) menu.push(folderButton); else if (!needsFolder()) row.push(folderButton);
  if (S.dropped.size) menu.push(h('button', { class: 'secondary', disabled: busy, onclick: () => { S.dropped.clear(); S.menuOpen = false; replan(); } }, 'Clear dropped'));
  if (window.showDirectoryPicker && S.dirName && S.dirAllowed) {
    const path = (S.dir && typeof S.dir.path === 'string' && S.dir.path) || S.dirPath || `${S.dirName}/`;
    row.push(h('div', { class: 'picked' }, h('b', {}, S.dirName), h('span', {}, path)));
  }
  if (S.folderError) row.push(h('p', { class: 'caption' }, S.folderError));
  const more = menu.filter(Boolean);
  if (more.length === 1) row.push(more[0]);
  else if (more.length) {
    row.push(h('details', { class: 'menu', open: S.menuOpen ? '' : null, ontoggle: (event) => { S.menuOpen = event.target.open; } },
      h('summary', { class: 'secondary' }, 'More'), h('div', { class: 'menu-items' }, more)));
  }
  return h('div', { class: 'actions' }, row);
}

function fail(error) {
  if (error && error.name === 'NotFoundError') return render();   // chooser closed
  if (error && error.name === 'AbortError') return render();
  S.phase = 'error'; S.message = String(error && error.message || error); render();
}

// ---- wiring ----
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const items = [...(e.dataTransfer.items || [])];
  const entries = items.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) Promise.all(entries.map(readEntry)).then(() => replan()).catch(fail);
  else addFiles(e.dataTransfer.files);
});

if (navigator.usb) {
  navigator.usb.addEventListener('disconnect', (e) => {
    if (S.device && e.device !== S.device) return;
    if (Date.now() < quietUntil) { S.device = null; return; }
    Object.assign(S, { device: null, current: null, space: null, plan: null, progress: null, installVolume: false, phase: 'plug', rebootNames: new Set() });
    render();
  });
  navigator.usb.addEventListener('connect', (e) => {
    if (Date.now() < quietUntil && isField(e.device)) S.device = e.device;
  });
}

// #preview lets a review capture any state without a Field: __fieldPreview({...state}).
if (location.hash === '#preview') {
  window.__fieldPreview = (state) => {
    Object.assign(S, state);
    if (!state.dropped) S.dropped = new Map();
    if (state.current) replan().catch(fail);
    else render();
  };
}

render();
(async () => {
  const dir = await recall().catch(() => null);
  if (dir) {
    S.dir = dir; S.dirName = dir.name; S.dirPath = typeof dir.path === 'string' ? dir.path : '';
    localStorage.setItem('field-folder-name', dir.name);
    S.dirAllowed = (await dir.queryPermission({ mode: 'readwrite' })) === 'granted';
    if (S.dirAllowed) await readFolder();
  }
  render();
})().catch(fail);
