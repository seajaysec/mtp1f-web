// PTP/MTP over WebUSB for the Field's disk: one session per job,
// root uploads name parent 0xFFFFFFFF, a replaced file is deleted first.

import { isOp1Usb } from './volume.js';

export const FIELD_VENDOR = 0x2367;
// Boot-menu MTP and running-OS MTP are 0x0102. The running instrument is 0x8102.
export const INSTALL_PRODUCT = 0x0102;
export const OP1_PRODUCTS = [0x0102, 0x8102];
export const FIELD_FILTERS = OP1_PRODUCTS.map((productId) => ({ vendorId: FIELD_VENDOR, productId }));
export const isField = isOp1Usb;
const ROOT_HANDLE = 0xffffffff;
const OP = {
  GetDeviceInfo: 0x1001, OpenSession: 0x1002, CloseSession: 0x1003, GetStorageIDs: 0x1004,
  GetDevicePropValue: 0x1015,
  GetStorageInfo: 0x1005, GetObjectHandles: 0x1007,   GetObjectInfo: 0x1008, GetObject: 0x1009, GetPartialObject: 0x101b,
  DeleteObject: 0x100b, SendObjectInfo: 0x100c, SendObject: 0x100d,
};
const OK = 0x2001, SESSION_ALREADY_OPEN = 0x201e;
const FORMAT_UNDEFINED = 0x3000, FORMAT_FOLDER = 0x3001;
const CHUNK = 1 << 20;

export class FieldBusy extends Error {}
export class FieldStalled extends Error {}
export class FieldNotMtp extends Error {}
export class FieldRefused extends Error {}

function u32(view, at) { return view.getUint32(at, true); }

function readString(view, at) {
  const n = view.getUint8(at);
  let text = '';
  for (let i = 0; i < n; i++) {
    const c = view.getUint16(at + 1 + 2 * i, true);
    if (c) text += String.fromCharCode(c);
  }
  return [text, at + 1 + 2 * n];
}

function stringBytes(text) {
  if (!text) return [0];
  const out = [text.length + 1];
  for (const ch of text + '\0') { const c = ch.charCodeAt(0); out.push(c & 0xff, c >> 8); }
  return out;
}

function objectInfo(storage, parent, name, size, folder) {
  const head = new DataView(new ArrayBuffer(52));
  head.setUint32(0, storage, true);
  head.setUint16(4, folder ? FORMAT_FOLDER : FORMAT_UNDEFINED, true);
  head.setUint32(8, size, true);
  head.setUint32(38, parent, true);
  head.setUint16(42, folder ? 1 : 0, true);
  return new Uint8Array([...new Uint8Array(head.buffer), ...stringBytes(name), 0, 0, 0]);
}

export class FieldMTP {
  constructor(device, endpoints, timeoutMs) {
    this.device = device;
    this.ep = endpoints;
    this.timeoutMs = timeoutMs;
    // Each session starts its transaction IDs somewhere new, so no reply from an earlier session can match one.
    this.tid = 0x10000 + Math.floor(Math.random() * 0x7fff0000);
  }

  // Open and claim the MTP interface. Busy means another app holds the Field.
  static async connect(device, { timeoutMs = 15000 } = {}) {
    try {
      if (!device.opened) await device.open();
    } catch (error) {
      throw new FieldBusy(String(error && error.message || error));
    }
    if (!device.configuration) await device.selectConfiguration(1);
    let found = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 6) found = { number: iface.interfaceNumber, alt };
      }
    }
    if (!found) {
      await device.close();
      throw new FieldNotMtp('the Field is not sharing its drive');
    }
    try {
      await device.claimInterface(found.number);
    } catch (error) {
      await device.close().catch(() => {});
      throw new FieldBusy(String(error && error.message || error));
    }
    const bulk = (dir) => found.alt.endpoints.find((e) => e.type === 'bulk' && e.direction === dir);
    const out = bulk('out'), inn = bulk('in');
    const mtp = new FieldMTP(device, { number: found.number, out: out.endpointNumber, in: inn.endpointNumber,
                                       packet: out.packetSize || 512 }, timeoutMs);
    await mtp.drain();
    return mtp;
  }

  // A transfer cut off earlier (an unplug, a closed tab) can leave the Field's reply waiting on the pipe, and the
  // next session would read it as the answer to its own first command. Whatever is already waiting is read and
  // dropped. A read that finds nothing is cancelled by releasing the interface, which is then claimed again.
  async drain() {
    for (let round = 0; round < 4096; round++) {
      let timer;
      const idle = new Promise((resolve) => { timer = setTimeout(() => resolve('idle'), 250); });
      const read = this.device.transferIn(this.ep.in, CHUNK).catch(() => 'failed');
      const got = await Promise.race([read, idle]);
      clearTimeout(timer);
      if (got !== 'idle' && got !== 'failed') continue;
      await this.device.releaseInterface(this.ep.number).catch(() => {});
      await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 1000))]);
      await this.device.claimInterface(this.ep.number);
      return;
    }
    throw new FieldStalled('the Field kept sending data nobody asked for');
  }

  async guard(promise, what) {
    let timer;
    const stall = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new FieldStalled(`the Field stopped answering during ${what}`)), this.timeoutMs);
    });
    try {
      return await Promise.race([promise, stall]);
    } finally {
      clearTimeout(timer);
    }
  }

  async out(bytes, what) {
    const r = await this.guard(this.device.transferOut(this.ep.out, bytes), what);
    if (r.status !== 'ok') throw new FieldStalled(`USB ${r.status} during ${what}`);
  }

  async in(length, what) {
    const r = await this.guard(this.device.transferIn(this.ep.in, length), what);
    if (r.status !== 'ok') throw new FieldStalled(`USB ${r.status} during ${what}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async command(code, params, what) {
    this.tid += 1;
    const view = new DataView(new ArrayBuffer(12 + 4 * params.length));
    view.setUint32(0, view.byteLength, true);
    view.setUint16(4, 1, true);
    view.setUint16(6, code, true);
    view.setUint32(8, this.tid, true);
    params.forEach((p, i) => view.setUint32(12 + 4 * i, p >>> 0, true));
    await this.out(new Uint8Array(view.buffer), what);
  }

  // One container (data or response) for the current transaction. Zero-length packets between phases are skipped.
  // A container left over from an earlier transaction or session carries another transaction ID: it is read to its
  // end and dropped. A packet that is not a container head at all (the middle of an old transfer) is dropped too.
  async container(what, onProgress) {
    for (let dropped = 0; dropped < 4096; dropped++) {
      const reply = await this.readContainer(what, onProgress);
      if (reply && reply.tid === this.tid) return reply;
    }
    throw new FieldStalled(`the Field kept answering an earlier request during ${what}`);
  }

  async readContainer(what, onProgress) {
    let first;
    do first = await this.in(CHUNK, what); while (first.byteLength === 0);
    if (first.byteLength < 12) return null;
    const head = new DataView(first.buffer, first.byteOffset, 12);
    const length = u32(head, 0), type = head.getUint16(4, true), code = head.getUint16(6, true), tid = u32(head, 8);
    if (type < 2 || type > 4 || length < 12 || (tid !== this.tid && length > 1 << 30)) return null;
    if (tid !== this.tid) onProgress = null;
    const body = new Uint8Array(length - 12);
    body.set(first.subarray(12, Math.min(first.byteLength, length)));
    let got = first.byteLength - 12;
    while (got < body.length) {
      const want = Math.min(CHUNK, Math.ceil((body.length - got) / this.ep.packet) * this.ep.packet);
      const more = await this.in(want, what);
      body.set(more.subarray(0, body.length - got), got);
      got += more.byteLength;
      if (onProgress) onProgress(Math.min(got, body.length), body.length);
    }
    return { type, code, tid, body };
  }

  async response(what) {
    const reply = await this.container(what);
    if (reply.type !== 3) throw new FieldStalled(`unexpected data during ${what}`);
    const view = new DataView(reply.body.buffer, reply.body.byteOffset, reply.body.byteLength);
    return { code: reply.code, params: Array.from({ length: reply.body.length >> 2 }, (_, i) => u32(view, 4 * i)) };
  }

  async transact(code, params, what, { dataIn = false, dataOut = null, onProgress } = {}) {
    await this.command(code, params, what);
    let data = null;
    if (dataOut) await this.sendData(code, dataOut, what, onProgress);
    if (dataIn) {
      const first = await this.container(what, onProgress);
      if (first.type === 3) return this.check({ code: first.code, params: [] }, what, null);
      data = first.body;
    }
    return this.check(await this.response(what), what, data);
  }

  check(reply, what, data) {
    if (reply.code !== OK) throw new FieldRefused(`${what}: the Field answered 0x${reply.code.toString(16)}`);
    return { params: reply.params, data };
  }

  // dataOut: {size, read(offset, length) -> Promise<Uint8Array>}
  async sendData(code, source, what, onProgress) {
    const total = 12 + source.size;
    const head = new DataView(new ArrayBuffer(12));
    head.setUint32(0, total > 0xffffffff ? 0xffffffff : total, true);
    head.setUint16(4, 2, true);
    head.setUint16(6, code, true);
    head.setUint32(8, this.tid, true);
    let offset = 0;
    const firstLength = Math.min(source.size, CHUNK - 12);
    const first = new Uint8Array(12 + firstLength);
    first.set(new Uint8Array(head.buffer));
    first.set(await source.read(0, firstLength), 12);
    await this.out(first, what);
    offset = firstLength;
    if (onProgress) onProgress(offset, source.size);
    while (offset < source.size) {
      const piece = await source.read(offset, Math.min(CHUNK, source.size - offset));
      await this.out(piece, what);
      offset += piece.byteLength;
      if (onProgress) onProgress(offset, source.size);
    }
    if (total % this.ep.packet === 0) await this.out(new Uint8Array(0), what);
  }

  // The model and serial only label the unit. A Field that answers OK with no description (seen after an earlier
  // request for it was cut off) still connects; the page then names the unit by its USB product.
  async deviceInfo() {
    const { data } = await this.transact(OP.GetDeviceInfo, [], 'device info', { dataIn: true });
    if (!data || data.byteLength < 12) return null;
    try {
      return this.parseDeviceInfo(data);
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  }

  parseDeviceInfo(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 8;
    [, at] = readString(view, at);
    at += 2;
    for (let i = 0; i < 5; i++) at += 4 + 2 * u32(view, at);
    let manufacturer, model, version, serial;
    [manufacturer, at] = readString(view, at);
    [model, at] = readString(view, at);
    [version, at] = readString(view, at);
    [serial, at] = readString(view, at);
    return { manufacturer, model, version, serial };
  }

  // PTP DateTime, 0x5011. The string is the Field's own clock, with no zone.
  async deviceTime() {
    try {
      const { data } = await this.transact(OP.GetDevicePropValue, [0x5011], 'clock', { dataIn: true });
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const [text] = readString(view, 0);
      return text || null;
    } catch {
      return null;
    }
  }

  async openSession() {
    await this.command(OP.OpenSession, [1], 'open session');
    const reply = await this.response('open session');
    if (reply.code !== OK && reply.code !== SESSION_ALREADY_OPEN) this.check(reply, 'open session');
    const ids = (await this.transact(OP.GetStorageIDs, [], 'storage', { dataIn: true })).data;
    const view = new DataView(ids.buffer, ids.byteOffset, ids.byteLength);
    if (!u32(view, 0)) throw new FieldRefused('the Field reported no storage');
    this.storage = u32(view, 4);
    const info = (await this.transact(OP.GetStorageInfo, [this.storage], 'storage info', { dataIn: true })).data;
    const iv = new DataView(info.buffer, info.byteOffset, info.byteLength);
    return { capacity: Number(iv.getBigUint64(6, true)), free: Number(iv.getBigUint64(14, true)) };
  }

  async handles(parent) {
    const { data } = await this.transact(OP.GetObjectHandles, [this.storage, 0, parent], 'listing', { dataIn: true });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return Array.from({ length: u32(view, 0) }, (_, i) => u32(view, 4 + 4 * i));
  }

  async objectRow(id) {
    const info = (await this.transact(OP.GetObjectInfo, [id], 'listing', { dataIn: true })).data;
    const iv = new DataView(info.buffer, info.byteOffset, info.byteLength);
    let at = 52;
    let name;
    [name, at] = readString(iv, at);
    let created = null;
    let modified = null;
    try {
      let captured;
      [captured, at] = readString(iv, at);
      created = captured;
      const [written] = readString(iv, at);
      modified = written;
    } catch { created = null; modified = null; }
    const folder = iv.getUint16(4, true) === FORMAT_FOLDER;
    return { id, parent: u32(iv, 38), name, kind: folder ? 'folder' : 'file', size: folder ? 0 : u32(iv, 8), created, modified };
  }

  // Every object as {id, parent, name, kind, size}; the Field hands them over in its own order.
  // The boot-menu drive answers "every object" with the whole tree. The running unit's drive answers with the top
  // level only, so each folder is also asked for its own children. An object already listed is not read again.
  async inventory(onProgress) {
    const rows = [];
    const seen = new Set();
    const folders = [];
    const take = async (ids) => {
      const fresh = ids.filter((id) => !seen.has(id));
      for (const [index, id] of fresh.entries()) {
        seen.add(id);
        const row = await this.objectRow(id);
        rows.push(row);
        if (row.kind === 'folder') folders.push(id);
        if (onProgress) onProgress(rows.length, rows.length + fresh.length - index - 1);
      }
    };
    await take(await this.handles(0));
    while (folders.length) await take(await this.handles(folders.shift()));
    return rows;
  }

  async get(id, onProgress) {
    return (await this.transact(OP.GetObject, [id], 'download', { dataIn: true, onProgress })).data;
  }

  // The first bytes of a file. Reading a whole os.ldr can stall the Field; a pack header is 96 bytes.
  async peek(id, size) {
    const { data } = await this.transact(OP.GetPartialObject, [id, 0, size], 'peek', { dataIn: true });
    return data ? data.subarray(0, size) : new Uint8Array(0);
  }

  async remove(id) {
    await this.transact(OP.DeleteObject, [id, 0], 'delete');
  }

  async mkdir(name, parent) {
    if (!parent) throw new FieldRefused('no top-level folders over MTP');
    const info = objectInfo(this.storage, parent, name, 0, true);
    const reply = await this.transact(OP.SendObjectInfo, [this.storage, parent], 'new folder',
      { dataOut: { size: info.length, read: async () => info } });
    return reply.params[2];
  }

  // source: {size, read(offset, length)}; parent 0 means the volume root.
  async send(name, parent, source, onProgress) {
    const where = parent || ROOT_HANDLE;
    const info = objectInfo(this.storage, where, name, source.size, false);
    const reply = await this.transact(OP.SendObjectInfo, [this.storage, where], 'send ' + name,
      { dataOut: { size: info.length, read: async () => info } });
    await this.transact(OP.SendObject, [], 'send ' + name, { dataOut: source, onProgress });
    return reply.params[2];
  }

  // Carry out planCopy's items in order: make the
  // planned folders, delete each file being replaced, send it under its own name.
  // current: {path: row}; sources: {remote: {size, read}}; onStep(remote, done, total).
  async applyCopy(current, plan, sources, onStep) {
    const handle = (path) => (path === '.' ? 0 : current[path].id);
    const parentPath = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
    for (const folder of plan.folders) {
      const id = await this.mkdir(folder.slice(folder.lastIndexOf('/') + 1), handle(parentPath(folder)));
      current[folder] = { id, kind: 'folder', size: 0 };
    }
    for (const item of plan.items) {
      const old = current[item.remote];
      if (old) {
        await this.remove(old.id);
        delete current[item.remote];
      }
      const name = item.remote.slice(item.remote.lastIndexOf('/') + 1);
      const id = await this.send(name, handle(parentPath(item.remote)), sources[item.remote],
        (done, total) => onStep && onStep(item.remote, done, total));
      current[item.remote] = { id, kind: 'file', size: item.size };
    }
  }

  // CloseSession answers OK on the running instrument, then the Field leaves MTP and
  // enumerates as the normal instrument again (measured 2026-11-19: product 0x0102
  // back to 0x8102 within a second). Releasing the interface without that command
  // leaves the drive shared. A later open accepts a session that is already open.
  async close() {
    await this.device.releaseInterface(this.ep.number).catch(() => {});
    await this.device.close().catch(() => {});
  }

  // Optional disconnect. On the running instrument this returns it to normal mode.
  async endSession() {
    await this.command(OP.OpenSession, [1], 'open session');
    const opened = await this.response('open session');
    if (opened.code !== OK && opened.code !== SESSION_ALREADY_OPEN) this.check(opened, 'open session');
    await this.command(OP.CloseSession, [], 'close');
    await this.response('close');
  }
}
