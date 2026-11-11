/* B3OS Researcher: the page's one script (no framework, no build step).
 *
 * It speaks to GPT Researcher's server exactly as upstream's page did:
 *   WebSocket at <this page's address>ws. The page sends "start {json}" (task, report_type, report_source, source_urls,
 *   tone, agent, query_domains, max_search_results), "chat {json}" (message, report, messages) and "ping". The server
 *   sends {type: "logs", content, output, metadata}, {type: "report", output} (Markdown, in pieces), {type: "path",
 *   output: {pdf, docx, md, json}} (relative links under outputs/), {type: "chat", content}, {type: "images"} and
 *   {type: "error"}; "pong" for a ping. Closing the socket makes the server cancel a running research: that is Stop.
 *   History lives in the browser: the cookie "conversationHistory" (localStorage when cookies are off), entries
 *   {prompt, links, timestamp}, with the report length and its numbers added.
 * Markdown is drawn with the vendored Showdown and DOMPurify, loaded when a report is first needed.
 * What the old page's status panel showed (socket state, attempts, messages) goes to the console at debug level.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const debug = (...a) => console.debug('[researcher]', ...a);
  const LENGTHS = { research_report: 'Summary', detailed_report: 'Detailed', deep: 'Deep' };
  // How long each length takes on this deployment (timed on B3OS, 2026-11-11), in seconds and in words.
  const ESTIMATE = { research_report: [30, 'about 30 s'], detailed_report: [60, 'about 1 min'], deep: [90, 'about 1.5 min'] };
  const STEPS = ['plan', 'search', 'read', 'write'];
  // Server log `content` -> the step it belongs to. Anything not here goes to the log only.
  const STEP_OF = {
    starting_research: 0, agent_generated: 0, planning_research: 0, subqueries: 0, research_plan: 0,
    running_subquery_research: 1, running_subquery_with_vectorstore_research: 1, added_source_url: 1, researching: 1,
    subquery_context_not_found: 1, mcp_retrieval: 1, mcp_results: 1, mcp_research_complete: 1,
    scraping_urls: 2, scraping_content: 2, scraping_images: 2, scraping_complete: 2, fetching_query_content: 2,
    fetching_query_format: 2, context_combined: 2, research_step_finalized: 2, answering_from_memory: 2,
    generating_subtopics: 3, subtopics_generated: 3, writing_report: 3, writing_introduction: 3, introduction_written: 3,
    generating_draft_sections: 3, draft_sections_generated: 3, writing_conclusion: 3, conclusion_written: 3,
    report_written: 3, fetching_relevant_written_content: 3,
  };
  const BACKOFF = [1000, 2000, 4000, 8000, 8000];
  const CONN_LABEL = { idle: 'Connection idle', live: 'Connection live', retrying: 'Connection retrying', lost: 'Connection lost' };
  const nf = new Intl.NumberFormat('en-US');

  // ---------- state ----------
  let phase = 'ask';        // ask | running | done | stopped | failed | lost | opened
  let run = null;           // the research on screen
  let lastRequest = null;   // what "Run again" sends
  let ws = null;
  let wsStats = { attempts: 0, received: 0 };
  let tick = null, heartbeat = null, retryTimer = null, noticeTimer = null, noteTimer = null;
  let chat = { thread: [], pending: null };
  let history = [];
  let cookiesEnabled = true;

  // ---------- small helpers ----------
  const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;
  const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
  const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); } catch { return u; } };
  const stripEmoji = (s) => s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/^[\s\n]+/, '');
  const countWords = (md) => md.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'report';
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) e.append(kid);
    return e;
  };
  const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'icon'); s.setAttribute('aria-hidden', 'true'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#i-${name}`); s.append(u); return s; };
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return '';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}, ${time}`;
  };

  // A line of facts: each part kept on one line, so a break can only fall after a separator.
  function setParts(node, parts) {
    const kids = [];
    parts.forEach((p, i) => { if (i) kids.push('\u00a0· '); kids.push(el('span', { class: 'nowrap', text: p })); });
    node.replaceChildren(...kids);
  }

  // ---------- connection ----------
  function setConn(state) {
    const c = $('conn');
    c.dataset.state = state;
    c.setAttribute('aria-label', CONN_LABEL[state]);
    c.title = CONN_LABEL[state];
    debug('connection', state, { readyState: ws ? ws.readyState : 'none', ...wsStats });
  }
  function wsUrl() {
    const u = new URL('ws', location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.search = ''; u.hash = '';
    return u.href;
  }
  // Opens a socket and resolves when it is open. Only a socket that opened reports its close to onSocketClosed.
  function openSocket() {
    wsStats.attempts++;
    return new Promise((resolve, reject) => {
      let s;
      try { s = new WebSocket(wsUrl()); } catch (e) { reject(e); return; }
      let opened = false;
      ws = s;
      s.onopen = () => { opened = true; debug('socket open', wsStats); resolve(s); };
      s.onmessage = (e) => { if (s === ws) { wsStats.received++; onMessage(e.data); } };
      s.onerror = () => debug('socket error');
      s.onclose = (e) => {
        debug('socket closed', e.code, e.reason || '', wsStats);
        if (s === ws) ws = null;
        if (!opened) reject(e); else onSocketClosed(s, e);
      };
    });
  }
  function closeSocket() {
    if (!ws) return;
    const s = ws;
    ws = null;
    s.onclose = null; s.onmessage = null;
    try { s.close(1000); } catch {}
  }
  const socketOpen = () => ws && ws.readyState === WebSocket.OPEN;
  function send(text) { if (socketOpen()) { ws.send(text); return true; } return false; }
  function startHeartbeat() { stopHeartbeat(); heartbeat = setInterval(() => send('ping'), 20000); }
  function stopHeartbeat() { clearInterval(heartbeat); heartbeat = null; }

  function onSocketClosed() {
    stopHeartbeat();
    if (phase === 'running') return reconnect(0);
    if (chat.pending) return chatFailed('Connection lost. Ask again.');
    setConn('idle');
  }

  // The server ends a research when its connection drops, so a reconnect starts the research over (once).
  function reconnect(i) {
    setConn('retrying');
    setFactsNote('Connection lost. Reconnecting…');
    clearTimeout(retryTimer);
    if (i >= BACKOFF.length) return lostForGood();
    retryTimer = setTimeout(async () => {
      if (phase !== 'running') return;
      try { await openSocket(); } catch { return reconnect(i + 1); }
      if (run.restarts >= 1) { closeSocket(); return lostForGood(); }
      const hadProgress = run.received > 0;
      run.restarts++;
      resetProgress();
      send(`start ${JSON.stringify(run.request)}`);
      startHeartbeat();
      setConn('live');
      if (hadProgress) { addLog('Reconnected. The server had stopped the run, so it started over.'); setFactsNote('Reconnected. Started over.', 8000); }
      else setFactsNote('');
    }, BACKOFF[i]);
  }
  function lostForGood() {
    phase = 'lost';
    setFactsNote('');
    stopRunClock();
    renderFacts();
    setConn('lost');
    $('stop').hidden = true;
    renderSteps();
    showNotice('danger', 'Connection lost. The research stopped.', [runAgainBtn(), editBtn()]);
  }

  // ---------- notices ----------
  // Passing messages (reconnecting, reconnected) stand in the facts line; the tinted notice is for what ends a run.
  function setFactsNote(text, hideAfter = 0) {
    clearTimeout(noteTimer);
    $('factsNote').textContent = text;
    $('factsText').hidden = !!text;
    if (hideAfter) noteTimer = setTimeout(() => setFactsNote(''), hideAfter);
  }
  function showNotice(tone, text, actions = [], hideAfter = 0) {
    clearTimeout(noticeTimer);
    const n = $('notice');
    n.dataset.tone = tone === 'warn' ? '' : tone;
    $('noticeText').textContent = text;
    $('noticeActions').replaceChildren(...actions);
    n.hidden = false;
    if (hideAfter) noticeTimer = setTimeout(hideNotice, hideAfter);
  }
  function hideNotice() { clearTimeout(noticeTimer); $('notice').hidden = true; }
  const runAgainBtn = () => el('button', { type: 'button', class: 'btn btn--neutral btn--sm', onclick: () => startResearch(lastRequest) }, 'Run again');
  const editBtn = () => el('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => showAsk(run ? run.task : '') }, 'Edit question');

  // ---------- the ask form ----------
  function readRequest() {
    const task = $('task').value.trim();
    const domains = $('queryDomains').value.split(',').map((d) => d.trim()).filter(Boolean);
    const n = Math.min(20, Math.max(1, parseInt($('maxSearchResults').value, 10) || 5));
    return {
      task,
      report_type: document.querySelector('input[name="report_type"]:checked').value,
      report_source: 'web',
      source_urls: [],
      tone: $('tone').value,
      agent: 'Auto Agent',
      query_domains: domains,
      max_search_results: n,
    };
  }
  function growField(t, max) {
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight + 2, max)}px`;
  }
  function showAsk(text = '') {
    if (phase === 'running') return;
    closeSocket();
    stopRunClock();
    hideNotice();
    phase = 'ask';
    run = null;
    setConn('idle');
    $('run').hidden = true;
    $('ask').hidden = false;
    document.body.classList.remove('is-run');
    const t = $('task');
    t.value = text;
    growField(t, window.innerHeight * 0.4);
    window.scrollTo(0, 0);
    t.focus();
  }

  // ---------- a research ----------
  function newRun(req) {
    return {
      request: req, task: req.task, type: req.report_type,
      startedAt: Date.now(), endedAt: null, restarts: 0, received: 0,
      step: 0, questions: 0, searches: 0, urls: new Set(), pending: [], queued: 0, read: 0, domains: [], starts: 0, finalized: 0,
      sectionsPlanned: 0, sectionsWritten: 0, md: '', links: null, log: [], restOpen: false,
    };
  }
  function resetProgress() {
    Object.assign(run, { startedAt: Date.now(), received: 0, step: 0, reached: 0, questions: 0, searches: 0, urls: new Set(), pending: [], queued: 0, read: 0, domains: [], starts: 0, finalized: 0, sectionsPlanned: 0, sectionsWritten: 0, md: '', restOpen: false });
    $('report').replaceChildren();
    renderSteps();
  }

  async function startResearch(req) {
    if (!req || !req.task) return;
    lastRequest = req;
    closeSocket();
    clearTimeout(retryTimer);
    hideNotice();
    chat = { thread: [], pending: null };
    run = newRun(req);
    phase = 'running';
    loadMarkdown();
    showRunView();
    startRunClock();
    setConn('live');
    try {
      await openSocket();
    } catch {
      return reconnect(0);
    }
    if (phase !== 'running') return;
    send(`start ${JSON.stringify(req)}`);
    startHeartbeat();
  }

  function showRunView() {
    $('ask').hidden = true;
    $('run').hidden = false;
    document.body.classList.add('is-run');
    const title = $('runTitle');
    title.textContent = run.task;
    title.toggleAttribute('data-long', run.task.length > 140);
    title.removeAttribute('data-clamped');
    $('titleMore').hidden = true;
    requestAnimationFrame(() => {
      title.setAttribute('data-clamped', '');
      const over = title.scrollHeight > title.clientHeight + 2;
      if (!over) title.removeAttribute('data-clamped');
      $('titleMore').hidden = !over;
      $('titleMore').setAttribute('aria-expanded', 'false');
      $('titleMore').textContent = 'Show all';
    });
    const running = phase === 'running';
    setFactsNote('');
    $('runMeta').hidden = !running;
    $('stop').hidden = !running;
    $('doneline').hidden = running;
    $('steps').hidden = !running;
    $('stepsToggle').setAttribute('aria-expanded', 'false');
    $('stepsToggle').textContent = 'Show steps';
    $('actions').hidden = true;
    $('followup').hidden = true;
    $('thread').replaceChildren();
    $('report').replaceChildren();
    $('log').replaceChildren();
    $('log').hidden = true;
    $('logToggle').setAttribute('aria-expanded', 'false');
    $('logToggle').textContent = 'Show log';
    renderSteps();
    renderFacts();
    window.scrollTo(0, 0);
    title.focus({ preventScroll: true });
  }

  function startRunClock() { stopRunClock(); tick = setInterval(renderFacts, 1000); }
  function stopRunClock() { clearInterval(tick); tick = null; }
  // While it runs: the time against the length's estimate ("8 s of about 30 s"); past the estimate, or once the run
  // has stopped, the time alone.
  function renderFacts() {
    if (!run) return;
    const ms = (run.endedAt || Date.now()) - run.startedAt;
    const [est, words] = ESTIMATE[run.type] || ESTIMATE.research_report;
    $('factsText').textContent = phase === 'running' && ms < est * 1000 ? `${fmtDur(ms)} of ${words}` : fmtDur(ms);
  }

  function stopResearch() {
    if (phase !== 'running') return;
    closeSocket();          // the server cancels the research when its socket closes
    clearTimeout(retryTimer);
    stopHeartbeat();
    phase = 'stopped';
    setFactsNote('');
    stopRunClock();
    renderFacts();
    setConn('idle');
    $('stop').hidden = true;
    renderSteps();
    addLog('Stopped.');
    showNotice('info', 'Stopped.', [runAgainBtn(), editBtn()]);
    $('noticeActions').firstChild.focus();
  }

  function fail(text) {
    phase = 'failed';
    setFactsNote('');
    closeSocket();
    stopHeartbeat();
    stopRunClock();
    renderFacts();
    setConn('idle');
    $('stop').hidden = true;
    renderSteps();
    const msg = String(text || '').replace(/^Error:\s*/, '').trim();
    const sentence = /openai API|context_length|model_not_available|rate.?limit|Failed to get response/i.test(msg)
      ? 'The research stopped: the model did not answer.'
      : `The research stopped: ${msg.length > 160 ? msg.slice(0, 157) + '…' : msg || 'the server reported an error.'}`;
    showNotice('danger', sentence, [runAgainBtn(), editBtn()]);
  }

  // ---------- messages ----------
  function onMessage(raw) {
    if (raw === 'pong') return;
    let m;
    try { m = JSON.parse(raw); } catch { debug('not JSON', raw); return; }
    if (m.type === 'chat') return onChatAnswer(m);
    if (!run || phase !== 'running') { debug('ignored', m.type, m.content); return; }
    run.received++;
    if (m.type === 'logs') return onLog(m);
    if (m.type === 'report') return onReport(m);
    if (m.type === 'path') return onDone(m);
    if (m.type === 'error') { addLog(String(m.output || 'Server error')); return; }
    if (m.type === 'images') { addLog('Images: ' + String(m.output || '').slice(0, 200)); return; }
    debug('other message', m);   // the first message (query, sources, context, report) has no type
  }

  function onLog(m) {
    const c = m.content;
    const out = String(m.output ?? '');
    addLog(out);
    if (c === 'error') return fail(out);
    // Detailed and Deep search and read again while writing (one sub-research per section): the dot goes back to
    // Read, and a writing message or report text takes it to Write again. While sub-researches run side by side,
    // the first one done sends a writing message as the others still read: the dot waits in Read until each
    // research that started has finished (report text still moves it at once).
    const s = STEP_OF[c];
    const waiting = s === 3 && run.step === 2 && run.starts > 1 && run.finalized < run.starts;
    if (s !== undefined && s > run.step && !waiting) run.step = s;
    else if (run.step === 3 && (s === 1 || s === 2)) run.step = 2;
    const n = parseInt((out.match(/(\d+)/) || [])[1], 10) || 0;
    switch (c) {
      case 'planning_research':
        if (/Browsing the web/i.test(out)) run.searches++;
        break;
      case 'subqueries':
        if (Array.isArray(m.metadata)) run.questions += m.metadata.length;
        break;
      case 'running_subquery_research':
      case 'running_subquery_with_vectorstore_research':
        run.searches++;
        break;
      case 'added_source_url': {
        const u = typeof m.metadata === 'string' ? m.metadata : out.replace(/^.*?research:\s*/, '').trim();
        if (u && !run.urls.has(u)) { run.urls.add(u); run.pending.push(u); }
        break;
      }
      case 'scraping_urls':
        run.queued += n;
        break;
      case 'scraping_content': {
        // The server says how many pages it read, not which: the domains are taken in the order the URLs came.
        run.read += n;
        for (const u of run.pending.splice(0, n)) { const d = domainOf(u); if (d && !run.domains.includes(d)) run.domains.push(d); }
        break;
      }
      case 'starting_research': run.starts++; break;
      case 'research_step_finalized': run.finalized++; break;
      case 'generating_draft_sections': run.sectionsPlanned++; break;
      case 'report_written': if (run.type === 'detailed_report') run.sectionsWritten++; break;
      default: break;
    }
    renderSteps();
    renderFacts();
  }

  function onReport(m) {
    run.md += String(m.output ?? '');
    if (run.step < 3) run.step = 3;
    scheduleRender();
    renderSteps();
  }

  async function onDone(m) {
    const r = run;
    r.endedAt = Date.now();
    r.links = m.output || {};
    phase = 'done';
    stopHeartbeat();
    stopRunClock();
    setConn('idle');
    hideNotice();
    r.step = 4;
    renderSteps();
    showReportState();
    // The saved Markdown is the report as the downloads hold it (for Detailed, the assembled one).
    if (r.links.md) {
      try { const res = await fetch(r.links.md, { cache: 'no-store' }); const md = res.ok ? await res.text() : null; if (md && md.trim()) r.md = md; } catch {}
      if (run === r) { await renderReport(true); updateDoneLine(); renderSteps(); }
    }
    await loadMarkdown();
    saveToHistory(r);
  }

  // ---------- steps ----------
  // A step in progress says how far it is ("9 of 14 pages"); a done step says what happened ("9 pages, 5 unreadable").
  function stepFact(i, state) {
    const r = run;
    const done = state === 'done';
    switch (STEPS[i]) {
      case 'plan': return r.questions ? plural(r.questions, 'question', 'questions') : '';
      case 'search': return r.searches || r.urls.size ? `${plural(r.searches, 'search', 'searches')}, ${plural(r.urls.size, 'result', 'results')}` : '';
      case 'read':
        if (!r.queued) return '';
        if (done) return plural(r.read, 'page', 'pages') + (r.queued > r.read ? `, ${nf.format(r.queued - r.read)} unreadable` : '');
        return `${nf.format(r.read)} of ${plural(r.queued, 'page', 'pages')}`;
      case 'write': {
        const words = countWords(r.md);
        const parts = [];
        const planned = Math.max(r.sectionsPlanned, r.starts - 1);
        if (words) parts.push(plural(words, 'word', 'words'));
        if (r.type === 'detailed_report' && planned > 0) parts.push(done ? plural(r.sectionsWritten || planned, 'section', 'sections') : `${r.sectionsWritten} of ${plural(planned, 'section', 'sections')}`);
        return parts.join(', ');
      }
      default: return '';
    }
  }
  const LIVE_DEFAULT = ['Choosing what to look for', 'Starting the searches', 'Opening the pages', 'Starting to write'];
  function renderSteps() {
    if (!run) return;
    const items = $('timeline').children;
    run.reached = Math.max(run.reached || 0, run.step);
    for (let i = 0; i < STEPS.length; i++) {
      let state;
      if (i < run.step) state = 'done';
      else if (i === run.step) state = phase === 'running' ? 'current' : phase === 'done' || phase === 'opened' ? 'done' : 'stopped';
      else state = 'todo';
      const li = items[i];
      if (li.dataset.state !== state) li.dataset.state = state;
      // A step after the current one that was reached before keeps its fact, with the open dot.
      let fact = state === 'todo' && i > run.reached ? '' : stepFact(i, state);
      if (!fact && state === 'current') fact = LIVE_DEFAULT[i];
      if (state === 'stopped' && !fact) fact = 'stopped';
      const f = li.querySelector('.step__fact');
      if (f.textContent !== fact) f.textContent = fact;
    }
    renderDomains();
  }
  let domainsShown = '';
  function renderDomains() {
    const ul = $('domains');
    const key = run.domains.join(' ');
    if (key === domainsShown) return;
    domainsShown = key;
    if (!run.domains.length) { ul.hidden = true; ul.replaceChildren(); return; }
    ul.hidden = false;
    fitDomains();
  }
  // A mono list of the domains read, at most two lines, then "+N more".
  function fitDomains() {
    const ul = $('domains');
    if (!run || ul.hidden) return;
    const doms = run.domains;
    ul.replaceChildren(...doms.map((d) => el('li', { text: d })));
    const lis = [...ul.children];
    const top = lis[0].offsetTop;
    const line = lis[0].offsetHeight;
    const onThird = (li) => li.offsetTop - top > line * 1.5 + 2;
    let cut = lis.findIndex(onThird);
    if (cut === -1) return;
    for (let k = cut; k < lis.length; k++) lis[k].remove();
    for (;;) {
      const more = el('li', { 'data-more': true, text: `+${doms.length - cut} more` });
      ul.append(more);
      if (!onThird(more) || cut <= 1) break;
      more.remove();
      ul.lastChild.remove();
      cut--;
    }
  }

  // ---------- log ----------
  function addLog(text) {
    if (!run) return;
    const line = stripEmoji(String(text)).replace(/\s+$/, '');
    if (!line) return;
    const t = fmtClock(Date.now() - run.startedAt);
    run.log.push([t, line]);
    const box = $('log');
    if (!box.hidden) {
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
      box.append(logLine(t, line));
      if (atEnd) box.scrollTop = box.scrollHeight;
    }
  }
  const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const logLine = (t, line) => { const d = el('div'); d.append(el('span', { text: t + '  ' }), line); return d; };
  function toggleLog() {
    const box = $('log');
    const open = box.hidden;
    box.hidden = !open;
    $('logToggle').setAttribute('aria-expanded', String(open));
    $('logToggle').textContent = open ? 'Hide log' : 'Show log';
    if (open && run) { box.replaceChildren(...run.log.map(([t, l]) => logLine(t, l))); box.scrollTop = box.scrollHeight; }
  }

  // ---------- Markdown ----------
  let mdLib = null, converter = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => { const s = el('script', { src }); s.onload = resolve; s.onerror = reject; document.head.append(s); });
  }
  function loadMarkdown() {
    if (!mdLib) mdLib = Promise.all([loadScript('site/vendor/js/showdown.min.js'), loadScript('site/vendor/js/purify.min.js')]).then(() => true, () => { debug('Markdown libraries did not load'); return false; });
    return mdLib;
  }
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  function mdToHtml(md) {
    if (window.showdown && window.DOMPurify) {
      if (!converter) {
        converter = new window.showdown.Converter({
          tables: true, ghCodeBlocks: true, strikethrough: true, tasklists: true, simplifiedAutoLink: true,
          openLinksInNewWindow: true, literalMidWordUnderscores: true, noHeaderId: true, disableForced4SpacesIndentedSublists: true,
        });
      }
      // Report text comes from web pages and a model: sanitize before it reaches the page.
      return window.DOMPurify.sanitize(converter.makeHtml(md), { ADD_ATTR: ['target'] });
    }
    return md.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; renderReport(false); }, 120);
  }
  async function renderReport(final) {
    if (!run) return;
    await loadMarkdown();
    const md = run.md;
    const box = document.createElement('div');
    box.innerHTML = mdToHtml(md);
    enhanceReport(box, final);
    patchBlocks($('report'), [...box.childNodes]);
  }
  // Walks the new top-level blocks against the shown ones from the top: an equal block stays in place, and from the
  // first difference to the end the new ones replace the old. A selection or a click in what is already written
  // survives the stream (it renders up to eight times a second).
  // A block whose only change is its citations' labels (the References section arrived and named them) keeps its
  // place and takes the new labels.
  function patchBlocks(parent, next) {
    const old = [...parent.childNodes];
    const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType === 1 ? a.outerHTML === b.outerHTML : a.nodeValue === b.nodeValue);
    const bare = (n) => { const c = n.cloneNode(true); for (const x of c.querySelectorAll('.cite')) { x.removeAttribute('title'); x.removeAttribute('aria-label'); } return c.outerHTML; };
    const relabel = (a, b) => {
      if (a.nodeType !== 1 || b.nodeType !== 1 || !a.querySelector('.cite') || bare(a) !== bare(b)) return false;
      const to = b.querySelectorAll('.cite');
      a.querySelectorAll('.cite').forEach((x, j) => { x.title = to[j].title; x.setAttribute('aria-label', to[j].getAttribute('aria-label')); });
      return true;
    };
    let i = 0;
    while (i < old.length && i < next.length && (same(old[i], next[i]) || relabel(old[i], next[i]))) i++;
    for (let k = old.length - 1; k >= i; k--) old[k].remove();
    parent.append(...next.slice(i));
  }

  // Links open in a new tab; tables scroll inside themselves; "([Name](url))" citations become numbers; the
  // References section becomes "Sources", one row per source: number, title, domain.
  function enhanceReport(root, final) {
    for (const a of root.querySelectorAll('a[href]')) {
      if (/^https?:/i.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    }
    let n = 0;
    for (const t of root.querySelectorAll('table')) {
      const wrap = el('div', { class: 'table', tabindex: '0', role: 'region', 'aria-label': `Table ${++n}` });
      t.replaceWith(wrap);
      wrap.append(t);
    }
    // The references section, if any.
    const refs = new Map();      // normalized url -> {url, title, domain}
    let refHeading = null;
    const refNodes = [];
    for (const h of root.querySelectorAll('h1, h2, h3, h4')) {
      if (/^(references|sources|bibliography|works cited|citations)\s*:?$/i.test(h.textContent.trim())) { refHeading = h; break; }
    }
    if (refHeading) {
      const level = +refHeading.tagName[1];
      for (let s = refHeading.nextElementSibling; s; s = s.nextElementSibling) {
        if (/^H[1-6]$/.test(s.tagName) && +s.tagName[1] <= level) break;
        refNodes.push(s);
      }
      const items = refNodes.flatMap((node) => (node.matches('ul, ol') ? [...node.children] : [node]));
      for (const item of items) {
        const a = item.querySelector('a[href^="http"]');
        if (!a) continue;
        const url = a.getAttribute('href');
        const em = item.querySelector('em, i');
        let title = em ? em.textContent : (/^https?:/.test(a.textContent.trim()) ? '' : a.textContent);
        if (!title) title = item.textContent.replace(/https?:\/\/\S+/g, '').replace(/\(\d{4}[^)]*\)|\(n\.d\.\)/g, '').trim();
        title = title.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
        const domain = domainOf(url);
        refs.set(normUrl(url), { url, title, own: !!title && title.toLowerCase() !== domain, domain });
      }
    }
    // Citations in the text, numbered in order of first use.
    const order = [];            // normalized urls
    const numOf = new Map();
    const citedAs = new Map();   // normalized url -> the link text of its first citation
    const citeEls = [];          // [citation link, normalized url]: titled once every title is known
    const numFor = (url, name) => {
      const k = normUrl(url);
      if (!citedAs.has(k) && name) citedAs.set(k, name);
      if (!numOf.has(k)) { numOf.set(k, order.length + 1); order.push(k); if (!refs.has(k)) refs.set(k, { url, title: '', own: false, domain: domainOf(url) }); }
      return numOf.get(k);
    };
    const isLink = (node) => node && node.nodeType === 1 && node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') || '') && !node.classList.contains('cite');
    for (const a of [...root.querySelectorAll('a[href^="http"]')]) {
      if (!root.contains(a) || refNodes.some((r) => r.contains(a))) continue;
      const before = a.previousSibling;
      if (!before || before.nodeType !== 3 || !/\(\s*$/.test(before.data)) continue;
      const group = [a];
      let next = a.nextSibling;
      while (next && next.nodeType === 3 && /^\s*[;,]\s*$/.test(next.data) && isLink(next.nextSibling)) { group.push(next.nextSibling); next = next.nextSibling.nextSibling; }
      if (!next || next.nodeType !== 3 || !/^\s*\)/.test(next.data)) continue;
      before.data = before.data.replace(/\s*\(\s*$/, ' ');
      next.data = next.data.replace(/^\s*\)/, '');
      for (let k = 1; k < group.length; k++) group[k].previousSibling.remove();
      const cites = el('span', { class: 'cites' });
      group[0].before(cites);
      for (const g of group) {
        const url = g.getAttribute('href');
        const num = numFor(url, g.textContent.trim());
        const c = el('a', { class: 'cite', href: url, target: '_blank', rel: 'noopener noreferrer' }, `[${num}]`);
        citeEls.push([c, normUrl(url), num]);
        cites.append(c);
        g.remove();
      }
    }
    // A source with no title of its own (a bare URL) gets one built; failing that, its domain, said once.
    for (const [k, r] of refs) if (!r.own) r.title = builtTitle(r.url, citedAs.get(k), r.domain) || r.domain;
    for (const [c, k, num] of citeEls) {
      const r = refs.get(k);
      c.title = r.domain && r.title !== r.domain ? `${r.title} (${r.domain})` : r.title;
      c.setAttribute('aria-label', `Source ${num}: ${r.title}`);
    }
    if (!refHeading && !order.length) return;
    // Cited sources first (in citation order), then listed ones nobody cited.
    const cited = order.length;
    for (const k of refs.keys()) if (!numOf.has(k)) { numOf.set(k, order.length + 1); order.push(k); }
    if (!order.length) return;
    // A row: number, title, and at the right the domain; when the title is the domain, the page's path.
    const row = (k) => {
      const r = refs.get(k);
      const right = r.title !== r.domain ? r.domain : pathOf(r.url);
      return el('li', {}, el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' },
        el('span', { class: 'sources__n', text: String(numOf.get(k)) }),
        el('span', { class: 'sources__title', text: r.title }),
        right ? el('span', { class: 'sources__domain', text: right }) : null));
    };
    // When the text cites sources, the list holds those; pages listed but cited nowhere wait behind a quiet button.
    const split = cited > 0 && cited < order.length;
    const blocks = [el('ol', { class: 'sources' }, ...order.slice(0, split ? cited : order.length).map(row))];
    if (split) {
      const open = !!(run && run.restOpen);
      const label = `${open ? 'Hide' : 'Show'} ${nf.format(order.length - cited)} not cited`;
      blocks.push(el('button', { type: 'button', class: 'linkbtn linkbtn--quiet', 'aria-expanded': String(open), 'data-rest': true }, label));
      blocks.push(el('ol', { class: 'sources sources--rest', start: String(cited + 1), hidden: !open }, ...order.slice(cited).map(row)));
    }
    const heading = el('h2', { text: 'Sources' });
    if (refHeading) {
      for (const node of refNodes) node.remove();
      refHeading.replaceWith(heading);
      heading.after(...blocks);
    } else if (final) {
      root.append(heading, ...blocks);
    }
  }
  const pathOf = (url) => {
    try {
      const u = new URL(url);
      let p = u.pathname + u.search;
      try { p = decodeURIComponent(p); } catch {}
      return p.replace(/\/$/, '');
    } catch { return ''; }
  };
  function toggleRest(b) {
    const list = b.nextElementSibling;
    const open = list.hidden;
    list.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    b.textContent = b.textContent.replace(/^(Show|Hide)/, open ? 'Hide' : 'Show');
    if (run) run.restOpen = open;
  }

  // The title of a source that has none: the name the text cites it by and, after a colon, the URL's last path
  // segment as words ("TFTC: Eia record us power demand 2026 2027 ai data centers"). Empty when neither exists.
  function builtTitle(url, name, domain) {
    let words = '';
    try {
      const segs = new URL(url).pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
      const isId = (x) => /^\d+$/.test(x) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(x) || (x.length >= 16 && /\d/.test(x) && /^[a-z0-9]+$/i.test(x));
      while (segs.length && isId(segs[segs.length - 1].replace(/\.html?$/i, ''))) segs.pop();   // trailing id segments
      const w = (segs.pop() || '').replace(/\.(html?|php|aspx?|cfm|jsp|pdf)$/i, '').split(/[-_+\s]+/).filter(Boolean);
      if (w.length > 1 && /^\d+$/.test(w[w.length - 1]) && !/^(19|20)\d\d$/.test(w[w.length - 1])) w.pop();   // "...-says-7"
      words = w.join(' ');
      if (/^[\d\s]*$/.test(words)) words = '';                                        // digits only: an id
      if (w.filter((x) => /\p{L}{3,}/u.test(x)).length < 3) words = '';               // a code ("Wp2606"), not words
      if (words.length > 80) words = words.slice(0, 80).replace(/\s+\S*$/, '') + '…';
      words = words.charAt(0).toUpperCase() + words.slice(1);
    } catch {}
    const n = (name || '').replace(/\s+/g, ' ').trim();
    const named = n && !/^https?:/i.test(n) && n.toLowerCase().replace(/^www\./, '') !== domain;
    return [named ? n : '', words].filter(Boolean).join(': ');
  }

  // ---------- the report state ----------
  // The timeline folds and the action row appears above the report: the text being read stays where it was (the
  // page scrolls by what moved), with or without the browser's scroll anchoring (Safari on an iPhone has none).
  function showReportState() {
    const rep = $('report');
    const y0 = rep.getBoundingClientRect().top;
    document.documentElement.style.overflowAnchor = 'none';
    $('runMeta').hidden = true;
    $('stop').hidden = true;
    $('steps').hidden = true;
    $('stepsToggle').setAttribute('aria-expanded', 'false');
    $('stepsToggle').textContent = 'Show steps';
    $('doneline').hidden = false;
    updateDoneLine();
    renderReport(true).then(updateDoneLine);
    buildDownloads();
    $('actions').hidden = false;
    $('followup').hidden = false;
    const dy = rep.getBoundingClientRect().top - y0;
    if (window.scrollY > 0 && dy) window.scrollBy(0, dy);
    document.documentElement.style.overflowAnchor = '';
  }
  // A source is a page the report cites (a row of the first Sources list): the done line, History and the JSON
  // download count the same rows. The rows behind "Show N not cited" are not counted.
  const CITED = '.sources:not(.sources--rest) li';
  const shownSources = () => $('report').querySelectorAll(CITED).length;
  function countSources(md) {
    const box = document.createElement('div');
    box.innerHTML = mdToHtml(md);
    enhanceReport(box, true);
    return box.querySelectorAll(CITED).length;
  }
  function updateDoneLine() {
    if (!run) return;
    const parts = [];
    if (run.endedAt && run.startedAt) parts.push(`Done in ${fmtDur(run.endedAt - run.startedAt)}`);
    else if (run.savedAt) parts.push(fmtWhen(run.savedAt));
    const n = shownSources();
    if (n) parts.push(plural(n, 'source', 'sources'));
    const words = countWords(run.md);
    if (words) parts.push(plural(words, 'word', 'words'));
    setParts($('doneText'), parts);
    $('stepsToggle').hidden = !run.log.length;
  }
  function toggleSteps() {
    const open = $('steps').hidden;
    $('steps').hidden = !open;
    $('stepsToggle').setAttribute('aria-expanded', String(open));
    $('stepsToggle').textContent = open ? 'Hide steps' : 'Show steps';
  }

  // ---------- downloads ----------
  function buildDownloads() {
    const links = (run && run.links) || {};
    const name = slug(run.task);
    const items = [
      { label: 'Markdown', hint: '.md', href: links.md, file: `${name}.md` },
      links.pdf ? { label: 'PDF', hint: '.pdf', href: links.pdf, file: `${name}.pdf` } : { label: 'Print to PDF', print: true },
      { label: 'Word', hint: '.docx', href: links.docx, file: `${name}.docx` },
      { label: 'JSON', hint: '.json', json: true },
    ].filter((i) => i.href || i.print || i.json);
    $('dlList').replaceChildren(...items.map((i) => el('li', { role: 'none' }, i.print || i.json
      ? el('button', { type: 'button', role: 'menuitem', class: 'menu__item', tabindex: '-1', onclick: () => { closeMenu(); if (i.print) window.print(); else downloadJson(`${name}.json`); } }, i.label, i.hint ? el('small', { text: i.hint }) : null)
      : el('a', { role: 'menuitem', class: 'menu__item', tabindex: '-1', href: i.href, download: i.file, onclick: () => closeMenu() }, i.label, i.hint ? el('small', { text: i.hint }) : null))));
  }
  // The server's JSON file is the run's event log; it does not hold the report. This one holds both.
  async function downloadJson(file) {
    const links = run.links || {};
    let log = null;
    if (links.json) { try { const r = await fetch(links.json, { cache: 'no-store' }); if (r.ok) log = await r.json(); } catch {} }
    const rows = (sel) => [...$('report').querySelectorAll(sel)].map((a) => ({ n: +a.querySelector('.sources__n').textContent, title: a.querySelector('.sources__title').textContent, url: a.href }));
    const sources = rows('.sources:not(.sources--rest) a');
    const notCited = rows('.sources--rest a');
    const data = {
      question: run.task,
      report_type: run.type,
      finished_at: run.endedAt ? new Date(run.endedAt).toISOString() : run.savedAt || null,
      duration_s: run.endedAt && run.startedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : null,
      words: countWords(run.md),
      sources,
      not_cited: notCited,
      report_markdown: run.md,
      files: { markdown: links.md || null, word: links.docx || null, pdf: links.pdf || null, log: links.json || null },
      log,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: file });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const menuItems = () => [...$('dlList').querySelectorAll('[role="menuitem"]')];
  function openMenu(focusLast = false) {
    $('dlList').hidden = false;
    $('dlBtn').setAttribute('aria-expanded', 'true');
    const items = menuItems();
    (focusLast ? items[items.length - 1] : items[0])?.focus();
  }
  function closeMenu(refocus = false) {
    if ($('dlList').hidden) return;
    $('dlList').hidden = true;
    $('dlBtn').setAttribute('aria-expanded', 'false');
    if (refocus) $('dlBtn').focus();
  }
  function onMenuKey(e) {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu();
  }

  async function copyReport() {
    if (!run || !run.md) return;
    let ok = false;
    try { await navigator.clipboard.writeText(run.md); ok = true; } catch {
      const t = el('textarea', { style: 'position:fixed;opacity:0' });
      t.value = run.md; document.body.append(t); t.select();
      try { ok = document.execCommand('copy'); } catch {}
      t.remove();
    }
    const label = $('copyLabel');
    label.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { label.textContent = 'Copy'; }, 2000);
  }

  // ---------- follow-up questions ----------
  async function sendChat(e) {
    e && e.preventDefault();
    const input = $('chatInput');
    const q = input.value.trim();
    if (!q || chat.pending || !run || !run.md) return;
    input.value = '';
    growField(input, window.innerHeight * 0.3);
    const answer = el('div', { class: 'qa__a prose', 'data-pending': true, 'aria-live': 'polite' }, el('span', { class: 'spin', 'aria-hidden': 'true' }), ' Writing an answer');
    $('thread').append(el('div', { class: 'qa' }, el('p', { class: 'qa__q', text: q }), answer));
    chat.thread.push({ role: 'user', content: q });
    chat.pending = answer;
    $('chatSend').disabled = true;
    const payload = { message: q, report: run.md, messages: chat.thread.map(({ role, content }) => ({ role, content })) };
    if (!socketOpen()) {
      try { await openSocket(); } catch { return chatFailed('Server not reached. Ask again.'); }
    }
    if (!send(`chat ${JSON.stringify(payload)}`)) chatFailed('Server not reached. Ask again.');
  }
  function onChatAnswer(m) {
    const box = chat.pending;
    if (!box) { debug('chat message with no question', m); return; }
    chat.pending = null;
    $('chatSend').disabled = false;
    const text = String(m.content ?? '');
    if (/^(Error processing your message|Chat functionality is not available|Error: Invalid message format|No message provided)/.test(text)) {
      chat.thread.pop();
      box.removeAttribute('data-pending');
      box.setAttribute('data-error', '');
      box.textContent = 'The answer failed. Ask again.';
      debug('chat error', text);
      return;
    }
    chat.thread.push({ role: 'assistant', content: text });
    box.removeAttribute('data-pending');
    loadMarkdown().then(() => { box.innerHTML = mdToHtml(text); enhanceReport(box, false); });
  }
  function chatFailed(msg) {
    const box = chat.pending;
    chat.pending = null;
    $('chatSend').disabled = false;
    if (!box) return;
    chat.thread.pop();
    box.removeAttribute('data-pending');
    box.setAttribute('data-error', '');
    box.textContent = msg;
    setConn('idle');
  }

  // ---------- history (cookie, as upstream's page keeps it) ----------
  function checkCookiesEnabled() {
    try {
      document.cookie = 'testcookie=1; path=/';
      cookiesEnabled = document.cookie.indexOf('testcookie') !== -1;
      if (cookiesEnabled) document.cookie = 'testcookie=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    } catch { cookiesEnabled = false; }
  }
  function setCookie(name, value, days) {
    if (!cookiesEnabled) { try { localStorage.setItem(name, value); return true; } catch { return false; } }
    const date = new Date(Date.now() + days * 864e5);
    const expires = `; expires=${date.toUTCString()}`;
    const encoded = encodeURIComponent(value);
    if ((name + '=' + encoded + expires + '; path=/').length > 4000) {
      // Too big for a cookie: drop the oldest entry and try again (upstream's rule).
      const list = JSON.parse(value);
      if (Array.isArray(list) && list.length > 1) return setCookie(name, JSON.stringify(list.slice(0, -1)), days);
      return false;
    }
    document.cookie = `${name}=${encoded}${expires}; path=/`;
    return true;
  }
  function getCookie(name) {
    if (!cookiesEnabled) { try { return localStorage.getItem(name); } catch { return null; } }
    for (const part of document.cookie.split(';')) {
      const c = part.trim();
      if (c.startsWith(name + '=')) { try { return decodeURIComponent(c.slice(name.length + 1)); } catch { return null; } }
    }
    return null;
  }
  function deleteCookie(name) {
    if (!cookiesEnabled) { try { localStorage.removeItem(name); } catch {} return; }
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
  }
  function loadHistory() {
    try {
      const raw = getCookie('conversationHistory');
      const list = raw ? JSON.parse(raw) : [];
      history = Array.isArray(list) ? list.filter((e) => e && (e.prompt || e.task)) : [];
    } catch { history = []; deleteCookie('conversationHistory'); }
    history.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  }
  function persistHistory() {
    if (!history.length) { deleteCookie('conversationHistory'); return; }
    const slim = history.slice(0, 20).map((e) => ({ prompt: e.prompt || e.task || '', links: e.links || {}, timestamp: e.timestamp || new Date().toISOString(), type: e.type, stats: e.stats }));
    setCookie('conversationHistory', JSON.stringify(slim), 30);
    loadHistory();
  }
  function saveToHistory(r) {
    if (!r || !r.links) return;
    const l = r.links;
    history.unshift({
      prompt: r.task,
      links: { pdf: l.pdf || '', docx: l.docx || '', md: l.md || '', json: l.json || '' },
      timestamp: new Date().toISOString(),
      type: r.type,
      stats: [Math.round((r.endedAt - r.startedAt) / 1000), countSources(r.md)],
    });
    persistHistory();
  }

  function renderHistory() {
    const q = $('histSearch').value.trim().toLowerCase();
    const list = $('histList');
    const empty = $('histEmpty');
    const busy = phase === 'running';
    $('histBusy').hidden = !busy || !history.length;
    $('histSearchWrap').hidden = !history.length;
    $('histFoot').hidden = !history.length;
    if (!history.length) {
      list.replaceChildren();
      empty.textContent = 'No research yet.';
      empty.hidden = false;
      return;
    }
    const rows = history.filter((e) => (e.prompt || e.task || '').toLowerCase().includes(q));
    list.replaceChildren(...rows.map((e) => el('li', {}, el('button', {
      type: 'button',
      'aria-disabled': busy ? 'true' : null,
      onclick: () => { if (!busy) openEntry(e); },
    }, el('span', { class: 'hist__q', text: e.prompt || e.task }), el('span', { class: 'hist__meta', text: [LENGTHS[e.type], fmtWhen(e.timestamp)].filter(Boolean).join(' · ') })))));
    empty.hidden = rows.length > 0;
    empty.textContent = rows.length ? '' : `Nothing matches “${$('histSearch').value.trim()}”.`;
  }

  let lastFocus = null;
  function openDrawer() {
    loadHistory();
    lastFocus = document.activeElement;
    $('histSearch').value = '';
    $('histConfirm').hidden = true;
    $('histClear').hidden = false;
    renderHistory();
    $('history').hidden = false;
    $('historyOpen').setAttribute('aria-expanded', 'true');
    for (const id of ['top', 'main']) $(id).inert = true;
    document.querySelector('.foot').inert = true;
    // The page stops scrolling under the drawer; its scrollbar's room is kept as padding, so nothing shifts.
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.paddingRight = sbw ? sbw + 'px' : '';
    (history.length ? $('histSearch') : $('history').querySelector('[data-close].btn')).focus();
  }
  function closeDrawer() {
    if ($('history').hidden) return;
    $('history').hidden = true;
    $('historyOpen').setAttribute('aria-expanded', 'false');
    for (const id of ['top', 'main']) $(id).inert = false;
    document.querySelector('.foot').inert = false;
    document.documentElement.style.overflow = '';
    document.body.style.paddingRight = '';
    (lastFocus && lastFocus.isConnected ? lastFocus : $('historyOpen')).focus();
  }
  function trapFocus(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const f = [...$('history').querySelectorAll('button, input, a[href], [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !$('history').contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function askClear() {
    $('histConfirmText').textContent = history.length === 1 ? 'Clear this one?' : `Clear all ${history.length}?`;
    $('histClear').hidden = true;
    $('histConfirm').hidden = false;
    $('histClearNo').focus();
  }
  function cancelClear() { $('histConfirm').hidden = true; $('histClear').hidden = false; $('histClear').focus(); }
  function doClear() {
    history = [];
    persistHistory();
    $('histConfirm').hidden = true;
    $('histClear').hidden = false;
    renderHistory();
    $('history').querySelector('.drawer__head [data-close]').focus();
  }

  // A history row opens its report (state 3), read back from the server's outputs/.
  async function openEntry(e) {
    closeDrawer();
    closeSocket();
    hideNotice();
    chat = { thread: [], pending: null };
    const req = { task: e.prompt || e.task, report_type: e.type || 'research_report', report_source: 'web', source_urls: [], tone: 'Objective', agent: 'Auto Agent', query_domains: [], max_search_results: 5 };
    lastRequest = req;
    run = newRun(req);
    run.startedAt = null;
    run.savedAt = e.timestamp;
    run.links = e.links || {};
    if (Array.isArray(e.stats)) run.durationMs = e.stats[0] * 1000;
    phase = 'opened';
    setConn('idle');
    showRunView();
    $('runMeta').hidden = true;
    $('doneline').hidden = false;
    $('stepsToggle').hidden = true;
    setParts($('doneText'), [LENGTHS[run.type], fmtWhen(e.timestamp)].filter(Boolean));
    $('report').replaceChildren(el('p', { class: 'report__missing' }, el('span', { class: 'spin', 'aria-hidden': 'true' }), ' Opening the report'));
    let md = null;
    try {
      const [r] = await Promise.all([fetch(run.links.md, { cache: 'no-store' }), loadMarkdown()]);
      md = r.ok ? await r.text() : null;
    } catch { md = null; }
    if (!run || run.savedAt !== e.timestamp) return;
    if (!md || !md.trim()) {
      $('report').replaceChildren();
      showNotice('info', 'This report is no longer on the server.', [runAgainBtn()]);
      return;
    }
    run.md = md;
    await renderReport(true);
    if (!run || run.savedAt !== e.timestamp) return;
    const parts = [];
    if (run.durationMs) parts.push(`Done in ${fmtDur(run.durationMs)}`);
    const n = shownSources();
    if (n) parts.push(plural(n, 'source', 'sources'));
    parts.push(plural(countWords(md), 'word', 'words'));
    parts.push(fmtWhen(e.timestamp));
    setParts($('doneText'), parts);
    buildDownloads();
    $('actions').hidden = false;
    $('followup').hidden = false;
  }

  // ---------- wiring ----------
  function init() {
    checkCookiesEnabled();
    loadHistory();
    $('hintMod').textContent = isMac ? '⌘' : 'Ctrl';
    const task = $('task');
    task.addEventListener('input', () => { growField(task, window.innerHeight * 0.4); $('taskError').hidden = true; });
    task.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('askForm').requestSubmit(); }
    });
    $('askForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const req = readRequest();
      if (!req.task) { $('taskError').textContent = 'Type a question first.'; $('taskError').hidden = false; task.focus(); return; }
      startResearch(req);
    });
    const showLengthTime = () => { $('lengthTime').textContent = ESTIMATE[readRequest().report_type][1]; };
    for (const r of document.querySelectorAll('input[name="report_type"]')) r.addEventListener('change', showLengthTime);
    showLengthTime();
    $('optionsToggle').addEventListener('click', () => {
      const open = $('options').hidden;
      $('options').hidden = !open;
      $('optionsToggle').setAttribute('aria-expanded', String(open));
      if (open) $('tone').focus();
    });
    for (const b of document.querySelectorAll('.stepper [data-step]')) {
      b.addEventListener('click', () => {
        const i = $('maxSearchResults');
        i.value = String(Math.min(20, Math.max(1, (parseInt(i.value, 10) || 5) + +b.dataset.step)));
      });
    }
    for (const b of $('examples').querySelectorAll('button')) {
      b.addEventListener('click', () => { task.value = b.textContent.trim(); growField(task, window.innerHeight * 0.4); $('taskError').hidden = true; task.focus(); });
    }
    $('stop').addEventListener('click', stopResearch);
    $('logToggle').addEventListener('click', toggleLog);
    $('stepsToggle').addEventListener('click', toggleSteps);
    $('titleMore').addEventListener('click', () => {
      const t = $('runTitle');
      const clamped = t.hasAttribute('data-clamped');
      t.toggleAttribute('data-clamped', !clamped);
      $('titleMore').setAttribute('aria-expanded', String(clamped));
      $('titleMore').textContent = clamped ? 'Show less' : 'Show all';
    });
    $('run').addEventListener('click', (e) => { const b = e.target.closest('button[data-rest]'); if (b) toggleRest(b); });
    $('copy').addEventListener('click', copyReport);
    $('dlBtn').addEventListener('click', () => ($('dlList').hidden ? openMenu() : closeMenu()));
    $('dlBtn').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(e.key === 'ArrowUp'); }
    });
    $('dlList').addEventListener('keydown', onMenuKey);
    document.addEventListener('click', (e) => { if (!$('dlMenu').contains(e.target)) closeMenu(); });
    $('newResearch').addEventListener('click', () => showAsk(''));
    $('chatForm').addEventListener('submit', sendChat);
    const chatInput = $('chatInput');
    chatInput.addEventListener('input', () => growField(chatInput, window.innerHeight * 0.3));
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) sendChat(e); });
    $('historyOpen').addEventListener('click', openDrawer);
    for (const c of $('history').querySelectorAll('[data-close]')) c.addEventListener('click', closeDrawer);
    $('history').addEventListener('keydown', trapFocus);
    $('histSearch').addEventListener('input', renderHistory);
    $('histClear').addEventListener('click', askClear);
    $('histClearNo').addEventListener('click', cancelClear);
    $('histClearYes').addEventListener('click', doClear);
    let resizeT = null;
    window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { domainsShown = ''; if (run) renderDomains(); }, 150); });
    window.addEventListener('pagehide', () => closeSocket());
    // A browser prints the page's address in its header or footer by default. Under the B3OS preview that address
    // holds the share token, so the page steps off it while printing (Download, PDF or the browser's own Print).
    let printSaved = null;
    window.addEventListener('beforeprint', () => {
      if (printSaved) return;
      printSaved = { href: location.href, title: document.title };
      try { window.history.replaceState(window.history.state, '', '/'); } catch {}
      if (run && run.task) document.title = run.task;
    });
    window.addEventListener('afterprint', () => {
      if (!printSaved) return;
      try { window.history.replaceState(window.history.state, '', printSaved.href); } catch {}
      document.title = printSaved.title;
      printSaved = null;
    });
    task.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
