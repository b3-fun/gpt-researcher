#!/usr/bin/env node
// A local stand-in for GPT Researcher's server, for working on frontend/ with no model and no network.
// It serves frontend/ the way backend/server/app.py does (/, /site/*, /static/*, /outputs/*, /api/reports) under a
// path prefix like the B3OS preview's, and answers the page's WebSocket by replaying one recorded session
// (recording/session.json) at its recorded times, scaled by a speed. No dependencies: Node 18+.
//
//   node frontend-dev/stub.mjs [--port 8765] [--prefix /preview/app/8000/] [--speed 1] [--scenario default]
//
// Then open http://127.0.0.1:8765/preview/app/8000/ . Control it while it runs (each is a GET, all optional):
//   /__stub/config?speed=10            replay 10x faster (any number; 1 is real time)
//   /__stub/config?hold=40             stop before frame 40 and keep the socket open (hold=report: before the first
//                                      report frame; hold=path: before the last; hold=none to clear)
//   /__stub/release                    go on from a hold
//   /__stub/config?drop=30             drop the connection before frame 30 (no close frame, like a network cut);
//                                      dropMode=recover (default: later connections work) or forever (refused)
//   /__stub/config?error=50            send the server's error message before frame 50 and stop, as a failed run does
//   /__stub/config?scenario=tablecode  report with tables and code; scenario=sources40: one with 40 sources
//   /__stub/config?chatError=1         answer the next chat with the server's chat error text
//   /__stub/config?reset=1             back to the defaults
//   /__stub/state                      where the replay is (frame index, held, connections)
//   /__stub/frames                     the session's frames as index, time, type, content
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..', 'frontend');
const REC = path.join(HERE, 'recording');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
const PORT = +(args.port || 8765);
let PREFIX = args.prefix || '/preview/app/8000/';
if (!PREFIX.endsWith('/')) PREFIX += '/';
const session = JSON.parse(fs.readFileSync(path.join(REC, 'session.json'), 'utf8'));

const DEFAULTS = { speed: +(args.speed || 1), hold: null, drop: null, dropMode: 'recover', error: null, scenario: args.scenario || 'default', refuse: false, chatError: false };
let config = { ...DEFAULTS };
let state = { frame: -1, held: false, running: false, connections: 0, runs: 0, chats: 0 };
const holders = new Set();   // resolvers of replays waiting at a hold
function releaseAll() { for (const r of [...holders]) r(); }

// ---------- scenarios: the recorded run, with its report swapped for a test report ----------
const SCENARIOS = {
  tablecode: () => fs.readFileSync(path.join(HERE, 'scenarios', 'tablecode.md'), 'utf8'),
  sources40: () => fs.readFileSync(path.join(HERE, 'scenarios', 'sources40.md'), 'utf8'),
};
function framesFor(task) {
  const recQ = session.start.task;
  const swapQ = (data) => (task && task !== recQ ? data.split(JSON.stringify(recQ).slice(1, -1)).join(JSON.stringify(task).slice(1, -1)) : data);
  let frames = session.frames.map((f) => ({ t: f.t, data: swapQ(f.data) }));
  const make = SCENARIOS[config.scenario];
  if (!make) return frames;
  const md = make();
  const firstReport = frames.findIndex((f) => JSON.parse(f.data).type === 'report');
  const reportIdx = frames.map((f, i) => [i, JSON.parse(f.data).type]).filter(([, t]) => t === 'report').map(([i]) => i);
  const times = reportIdx.map((i) => frames[i].t);
  const blocks = md.split(/(?<=\n\n)/);
  const per = Math.ceil(blocks.length / times.length);
  const chunks = times.map((_, k) => blocks.slice(k * per, (k + 1) * per).join('')).filter(Boolean);
  const reportFrames = chunks.map((c, k) => ({ t: times[Math.min(k, times.length - 1)], data: JSON.stringify({ type: 'report', output: c, content: null, metadata: null }) }));
  const after = frames.slice(reportIdx[reportIdx.length - 1] + 1).map((f) => {
    const j = JSON.parse(f.data);
    if (j.type === 'path') { j.output.md = `outputs/scenario-${config.scenario}.md`; return { t: f.t, data: JSON.stringify(j) }; }
    return f;
  });
  let before = frames.slice(0, firstReport);
  if (config.scenario === 'sources40') {
    // 40 sources: the URLs the report cites, announced the way the server announces them.
    const urls = [...md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    const unique = [...new Set(urls)];
    const lastAdded = before.reduce((m, f, i) => (JSON.parse(f.data).content === 'added_source_url' ? i : m), 0);
    const recorded = before.filter((f) => JSON.parse(f.data).content === 'added_source_url').length;
    const extra = unique.slice(recorded).map((u) => ({ t: before[lastAdded].t, data: JSON.stringify({ type: 'logs', content: 'added_source_url', output: `✅ Added source url to research: ${u}\n`, metadata: u }) }));
    before = before.slice(0, lastAdded + 1).concat(extra, before.slice(lastAdded + 1));
  }
  return before.concat(reportFrames, after);
}
function scenarioFile(name) {
  const m = /^scenario-(\w+)\.md$/.exec(name);
  return m && SCENARIOS[m[1]] ? SCENARIOS[m[1]]() : null;
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.JPG': 'image/jpeg' };
function sendFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'content-type': type || TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, no-cache', 'content-length': buf.length });
    res.end(buf);
  });
}
function notFound(res) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"detail":"Not Found"}'); }
function json(res, obj) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj, null, 1)); }
function inside(root, rel) { const p = path.resolve(root, rel); return p.startsWith(root + path.sep) ? p : null; }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  if (url.pathname.startsWith('/__stub/')) return control(url, res);
  if (!url.pathname.startsWith(PREFIX) && url.pathname + '/' !== PREFIX) return notFound(res);
  const rel = decodeURIComponent(url.pathname.slice(PREFIX.length));
  if (rel === '' ) return sendFile(res, path.join(FRONTEND, 'index.html'));
  if (rel.startsWith('site/')) { const f = inside(FRONTEND, rel.slice(5)); return f ? sendFile(res, f) : notFound(res); }
  if (rel.startsWith('static/')) { const f = inside(path.join(FRONTEND, 'static'), rel.slice(7)); return f ? sendFile(res, f) : notFound(res); }
  if (rel.startsWith('outputs/')) {
    const name = rel.slice(8);
    const s = scenarioFile(name);
    if (s !== null) { res.writeHead(200, { 'content-type': TYPES['.md'] }); return res.end(s); }
    const f = inside(path.join(REC, 'files'), name);
    return f ? sendFile(res, f) : notFound(res);
  }
  if (rel === 'api/reports') { res.writeHead(session.api_reports.status, { 'content-type': 'application/json' }); return res.end(session.api_reports.body); }
  return notFound(res);
});

function control(url, res) {
  const q = Object.fromEntries(url.searchParams);
  if (url.pathname === '/__stub/release') { config.hold = null; releaseAll(); return json(res, { released: true }); }
  if (url.pathname === '/__stub/state') return json(res, { ...state, config });
  if (url.pathname === '/__stub/frames') {
    return json(res, framesFor(session.start.task).map((f, i) => { const j = JSON.parse(f.data); return { i, t: f.t, type: j.type ?? null, content: j.content ?? null }; }));
  }
  if (url.pathname !== '/__stub/config') return notFound(res);
  if (q.reset) { config = { ...DEFAULTS }; releaseAll(); }
  if (q.speed) config.speed = Math.max(0.01, +q.speed);
  if (q.hold) config.hold = q.hold === 'none' ? null : q.hold;
  if (q.drop) config.drop = q.drop === 'none' ? null : +q.drop;
  if (q.dropMode) config.dropMode = q.dropMode;
  if (q.error) config.error = q.error === 'none' ? null : +q.error;
  if (q.scenario) config.scenario = q.scenario;
  if (q.refuse) config.refuse = q.refuse === '1';
  if (q.chatError) config.chatError = q.chatError === '1';
  if (config.hold === null) releaseAll();
  return json(res, config);
}

// ---------- WebSocket (RFC 6455, text frames only, enough for this page) ----------
function encode(text, opcode = 1) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}
function decoder(onMessage, onClose, onPing) {
  let buf = Buffer.alloc(0);
  let parts = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ m[i % 4])); }
      buf = buf.subarray(need);
      if (op === 8) return onClose();
      if (op === 9) { onPing(data); continue; }
      if (op === 10) continue;
      parts.push(data);
      if (fin) { onMessage(Buffer.concat(parts).toString('utf8')); parts = []; }
    }
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://stub');
  if (url.pathname !== PREFIX + 'ws' || config.refuse) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  state.connections++;
  let open = true;
  const send = (text) => { if (open) socket.write(encode(text)); };
  const close = () => { if (!open) return; open = false; state.connections--; state.running = false; try { socket.end(encode('', 8)); } catch {} };
  let myHold = null;
  socket.on('close', () => { if (open) { open = false; state.connections--; state.running = false; } if (myHold) myHold(); });
  socket.on('error', () => {});
  let busy = false;

  socket.on('data', decoder(async (msg) => {
    if (msg === 'ping') return send('pong');
    if (busy) return send(JSON.stringify({ type: 'logs', content: 'warning', output: 'Task already running. Please wait.' }));
    if (msg.startsWith('start')) {
      busy = true;
      await replay(JSON.parse(msg.slice(6)));
      busy = false;
    } else if (msg.startsWith('chat')) {
      busy = true;
      state.chats++;
      const frames = config.chatError
        ? [{ t: 900, data: JSON.stringify({ type: 'chat', content: 'Error processing your message: Error code: 400 - context_length_exceeded', role: 'assistant' }) }]
        : session.chat.frames;
      config.chatError = false;
      let prev = 0;
      for (const f of frames) { await sleep((f.t - prev) / config.speed); prev = f.t; send(f.data); }
      busy = false;
    } else {
      send(JSON.stringify({ type: 'error', content: 'error', output: 'Unknown command received by server' }));
    }
  }, close, (d) => socket.write(encode(d.toString(), 10))));

  async function replay(start) {
    state.runs++;
    state.running = true;
    const frames = framesFor(start.task);
    const holdAt = config.hold === 'report' ? frames.findIndex((f) => JSON.parse(f.data).type === 'report')
      : config.hold === 'path' ? frames.length - 1 : config.hold === null ? -1 : +config.hold;
    let prev = 0;
    for (let i = 0; i < frames.length; i++) {
      if (!open) return;
      await sleep(Math.max(0, frames[i].t - prev) / config.speed);
      prev = frames[i].t;
      if (!open) return;
      if (i === holdAt || (config.hold !== null && +config.hold === i)) {
        state.frame = i;
        await new Promise((r) => { myHold = r; holders.add(r); state.held = true; });
        holders.delete(myHold); myHold = null; state.held = holders.size > 0;
        if (!open) return;
      }
      if (config.drop !== null && i >= config.drop) {
        config.drop = null;
        if (config.dropMode === 'forever') config.refuse = true;
        open = false; state.connections--; state.running = false;
        socket.destroy();     // no close frame: the page sees 1006, as on a network cut
        return;
      }
      if (config.error !== null && i >= config.error) {
        config.error = null;
        send(JSON.stringify({ type: 'logs', content: 'error', output: 'Error: Failed to get response from openai API' }));
        state.running = false;
        return;
      }
      state.frame = i;
      send(frames[i].data);
    }
    state.running = false;
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub: http://127.0.0.1:${PORT}${PREFIX}  (speed ${config.speed}, scenario ${config.scenario}; control at /__stub/config)`);
});
