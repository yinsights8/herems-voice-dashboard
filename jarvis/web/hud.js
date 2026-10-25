/* Tactical HUD layer. app.js (loaded first) runs the voice engine, the run
   stream, approvals and timings, and writes into the shared element ids. This
   file adds the 3D core, live panels, mission-queue editing and themes. It
   reads app.js's top-level state (API_TOKEN, analyser, phase, micToggle) —
   classic scripts share one global scope. */
(() => {
const q = s => document.querySelector(s);
const H = extra => ({'x-jarvis-token': API_TOKEN, ...(extra || {})});
const getJSON = url => fetch(url, {headers: H()}).then(r => r.ok ? r.json() : Promise.reject(r.status));
const fmtGB = b => b == null ? '—' : (b / 1073741824).toFixed(1);
const pct = (a, b) => (a == null || !b) ? 0 : Math.max(0, Math.min(100, a / b * 100));
const setBar = (id, p) => { const el = q(id); if (el) el.style.width = p.toFixed(1) + '%'; };
const txt = (id, v) => { const el = q(id); if (el) el.textContent = v; };
const median = a => { const v = a.filter(x => typeof x === 'number').sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
const secs = ms => ms == null ? '—' : (ms / 1000).toFixed(1) + 's';

/* ── theme ── */
const themeSel = q('#themeSel');
themeSel.value = document.documentElement.dataset.theme || 'red';
themeSel.onchange = () => {
  document.documentElement.dataset.theme = themeSel.value;
  try { localStorage.setItem('hud.theme', themeSel.value); } catch (_) {}
  core && core.palette();
};

/* ── session clock ── */
const started = Date.now();
setInterval(() => {
  const s = Math.floor((Date.now() - started) / 1000);
  const p = n => String(n).padStart(2, '0');
  txt('#sessionClock', `SESSION ${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`);
}, 1000);

/* ── Ctrl+Space toggles the voice conversation ── */
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); micToggle(); }
});

/* ── mission queue (Task intel) ── */
let tasks = [];
function renderTasks(){
  const list = q('#taskList');
  const open = tasks.filter(t => !t.done).length;
  txt('#taskCount', `${open} active`);
  if (!tasks.length){
    list.innerHTML = '<li class="empty" style="border:0;background:none;cursor:default">No tasks. Add one here, or say “/mission …”.</li>';
    return;
  }
  list.innerHTML = tasks.map((t, i) =>
    `<li class="${t.done ? 'done' : ''}" data-i="${i}" title="Click to mark ${t.done ? 'open' : 'done'}">`
    + `<span class="ck">${t.done ? '✓' : ''}</span><span>${esc(t.text)}</span>`
    + `<button class="x" data-x="${i}" title="Remove" type="button">×</button></li>`).join('');
}
async function taskAction(body){
  try {
    const r = await fetch('/api/task', {method: 'POST', headers: H({'content-type': 'application/json'}), body: JSON.stringify(body)});
    const j = await r.json();
    if (j.tasks){ tasks = j.tasks; renderTasks(); }
  } catch (_) {}
}
q('#taskForm').onsubmit = e => {
  e.preventDefault();
  const v = q('#taskInput').value.trim();
  if (!v) return;
  q('#taskInput').value = '';
  taskAction({action: 'add', text: v});
};
q('#taskList').onclick = e => {
  const x = e.target.closest('[data-x]');
  if (x) return taskAction({action: 'remove', index: +x.dataset.x});
  const li = e.target.closest('li[data-i]');
  if (li) taskAction({action: 'toggle', index: +li.dataset.i});
};
q('#clearDone').onclick = () => taskAction({action: 'clear_done'});

async function pollState(){
  try {
    const j = await getJSON('/api/state');
    tasks = j.tasks || []; renderTasks();
    const goal = (j.goal || '').trim();
    q('#goalLine').classList.toggle('hidden', !goal);
    txt('#goalLine', goal ? 'Objective: ' + goal : '');
    txt('#goalQuote', goal ? `“${goal}”` : 'No standing objective. Say “/goal …” to set one.');
  } catch (status){
    // 404: the page is newer than the running server (it reads page files fresh, code only at start)
    q('#taskList').innerHTML = `<li class="empty" style="border:0;background:none;cursor:default">`
      + (status === 404 ? 'Restart Robin to enable this panel: the running server predates it.'
         : status === 401 ? 'Reload this page: the server restarted.' : 'Can’t reach the server.') + '</li>';
  }
}

/* ── system diagnostics + agent ── */
let sys = {};
async function pollSystem(){
  try {
    sys = await getJSON('/api/system');
    txt('#cpuV', sys.cpu_pct == null ? '—' : sys.cpu_pct.toFixed(0) + '%'); setBar('#cpuB', sys.cpu_pct || 0);
    txt('#ramV', sys.ram_total ? `${fmtGB(sys.ram_used)} / ${fmtGB(sys.ram_total)} GB` : '—'); setBar('#ramB', pct(sys.ram_used, sys.ram_total));
    const g = sys.gpu;
    txt('#vramV', g ? `${(g.used_mb / 1024).toFixed(1)} / ${(g.total_mb / 1024).toFixed(1)} GB` : 'no NVIDIA GPU');
    setBar('#vramB', g ? pct(g.used_mb, g.total_mb) : 0);
    txt('#gpuV', g ? g.util_pct + '%' : '—'); setBar('#gpuB', g ? g.util_pct : 0);
    const u = sys.uptime_s || 0;
    txt('#upV', u >= 3600 ? `${Math.floor(u / 3600)}h ${Math.floor(u / 60) % 60}m` : `${Math.floor(u / 60)}m ${u % 60}s`);
    const m = sys.model || {};
    const model = m.model ? m.model + (m.provider ? ' · ' + m.provider : '') : 'Hermes default';
    txt('#modelV', m.model || 'Hermes default'); q('#modelV').title = model;
    txt('#modelChip', model);
    txt('#sessV', sys.session ? sys.session.slice(0, 10) + '…' : 'new on next turn');
    if (sys.session !== curSession){ curSession = sys.session; if (chatView === 'current') refreshChat({first: true}); }
    const busy = q('#busyBadge'); busy.textContent = sys.busy ? 'working' : 'idle';
    const mode = (sys.hermes_mode || '—').split(' ')[0];
    q('#roL').innerHTML = `<b>${sys.cpu_pct == null ? '—' : sys.cpu_pct.toFixed(0) + '%'}</b>CPU<br>${sys.ram_total ? fmtGB(sys.ram_used) + 'G' : '—'}<br>RAM`;
    q('#roR').innerHTML = `<b>${esc(mode.toUpperCase())}</b>MODE<br>${sys.tool_count || '—'}<br>TOOLS`;
  } catch (_) {}
}

/* ── latency, context, success (from the turn log) ── */
async function pollTimings(){
  try {
    const recs = (await getJSON('/api/timings?limit=40')).records || [];
    const last20 = recs.slice(-20);
    const heads = last20.map(r => r.headline_ms).filter(v => typeof v === 'number');
    txt('#medV', secs(median(heads)));
    const prob = last20.filter(r => r.note && r.note !== 'approval answer').length;
    txt('#okV', last20.length ? Math.round(100 * (last20.length - prob) / last20.length) + '%' : '—');
    const lastHead = [...recs].reverse().find(r => typeof r.headline_ms === 'number');
    txt('#latChip', lastHead ? `${lastHead.headline_ms.toLocaleString('en-GB')} ms` : '— ms');
    const ctx = [...recs].reverse().find(r => (r.server || {}).tokens_in);
    if (ctx){
      const s = ctx.server;
      txt('#ctxV', `${s.tokens_in.toLocaleString('en-GB')} tok`); setBar('#ctxB', pct(s.tokens_in, 128000));
      q('#ctxB').parentElement.title = 'Bar scaled to a 128k-token window';
      txt('#outV', `${(s.tokens_out || 0).toLocaleString('en-GB')} tok`);
      txt('#callsV', `${s.api_calls ?? '—'}${s.model_ms ? ' · ' + secs(s.model_ms) : ''}`);
    }
    // sparkline of reply latency, newest on the right
    const svg = q('#spark');
    if (heads.length > 1){
      const max = Math.max(...heads) * 1.1, W = 300, Hh = 44;
      const pts = heads.map((v, i) => `${(i / (heads.length - 1) * W).toFixed(1)},${(Hh - v / max * (Hh - 4) - 2).toFixed(1)}`);
      svg.innerHTML = `<polyline points="${pts.join(' ')}" fill="none" stroke="rgb(var(--acc))" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`
        + `<polyline points="0,${Hh} ${pts.join(' ')} ${W},${Hh}" fill="rgba(var(--acc),.12)" stroke="none"/>`;
    }
  } catch (_) {}
}

/* ── what Robin is doing right now (from the activity stream) ── */
let toolName = null, toolAt = 0;
const doing = q('#doing');
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes){
    if (!(n instanceof HTMLElement) || !n.classList.contains('entry')) continue;
    const kind = (n.querySelector('.kind') || {}).textContent || '';
    const msg = ((n.querySelector('.msg') || {}).textContent || '').trim();
    if (kind === 'TOOL' && msg.startsWith('→')){ toolName = msg.slice(1).replace(/\(\)$/, '').trim(); toolAt = Date.now(); }
    else if (kind === 'TOOL' && msg.startsWith('✓')){ toolName = null; doing.textContent = 'tool finished · thinking'; }
    else if (kind === 'RUN') doing.textContent = 'thinking…';
    else if (kind === 'VOICE' && msg.startsWith('transcribed')) doing.textContent = msg.replace(/^transcribed by [^:]+: /, '');
    else if (kind === 'VOICE' && msg === 'speech detected') doing.textContent = 'hearing you…';
    else if (kind === 'COMPLETE' || kind === 'ERROR' || kind === 'CANCEL'){ toolName = null; doing.textContent = kind === 'COMPLETE' ? 'answer ready' : msg.slice(0, 90); }
    else if (kind === 'NOTE' && msg.startsWith('still working')) doing.textContent = msg;
    else if (kind === 'APPROVAL') doing.textContent = msg;
    else if (kind === 'STEER') doing.textContent = '↪ ' + msg.replace(/^passed to the running task: /, '');
  }
}).observe(q('#log'), {childList: true});

const HINTS = {listening: 'Listening — speak now', running: 'Working — speak to steer, say “stop” or press Esc to cancel', speaking: 'Speaking — talk over to interrupt',
               error: 'Something failed — see neural activity', idle: 'standby — Ctrl+Space to talk'};
function stateNow(){
  const c = document.body.classList;
  return c.contains('error') ? 'error' : c.contains('speaking') ? 'speaking' : c.contains('running') ? 'running'
       : c.contains('listening') ? 'listening' : 'idle';
}
setInterval(() => {
  const s = stateNow();
  txt('#hint', (s === 'idle' ? `${NAME} ` : '') + HINTS[s]);
  txt('#coreSub', s === 'idle' ? 'CORE ONLINE' : s.toUpperCase());
  if (toolName && document.body.classList.contains('running'))
    doing.textContent = `running ${toolName} · ${Math.floor((Date.now() - toolAt) / 1000)}s`;
}, 500);

/* ══════════ conversation + past sessions (expanded response panel) ══════════
   Read from Hermes's own session store through /api/sessions, so it includes
   tool calls, steers, and sessions from the CLI, TUI, Discord and so on. */
const root = document.documentElement, chatLog = q('#chatLog'), expandBtn = q('#expandBtn');
let chatView = 'current', viewing = null, scope = 'dashboard';
const when = ts => ts ? new Date(ts * 1000).toLocaleString('en-GB', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'}) : '';
const hhmm = ts => ts ? new Date(ts * 1000).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'}) : '';

function setExpanded(on){
  root.classList.toggle('chat-open', on);
  expandBtn.textContent = on ? '⤡ collapse' : '⤢ expand';
  try { localStorage.setItem('hud.chat', on ? '1' : '0'); } catch (_) {}
  if (on) refreshChat();
}
expandBtn.onclick = () => setExpanded(!root.classList.contains('chat-open'));
q('#chatTabs').onclick = e => {
  const b = e.target.closest('button[data-view]'); if (!b) return;
  chatView = b.dataset.view; viewing = null;
  q('#chatTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  refreshChat();
};

function renderMessages(msgs){
  return msgs.map(m => {
    const t = esc(m.text || '');
    if (m.kind === 'user') return `<div class="msg me"><small>You · ${hhmm(m.at)}</small>${t}</div>`;
    if (m.kind === 'steer') return `<div class="msg steer">↪ ${t}</div>`;
    if (m.kind === 'tool') return `<details class="tool"><summary>⚙ ${esc(m.tool)} result</summary><pre>${t || '(empty)'}</pre></details>`;
    return (m.tools && m.tools.length ? `<div class="toolline">⚙ ${m.tools.map(esc).join(' · ')}</div>` : '')
         + (t ? `<div class="msg bot"><small>${esc(NAME)} · ${hhmm(m.at)}</small>${t}</div>` : '');
  }).join('');
}

async function showSession(id, opts = {}){
  try {
    const d = await getJSON('/api/sessions/' + encodeURIComponent(id));
    const head = opts.past ? `<div class="viewbar"><button class="iconbtn" id="backBtn" type="button">← all sessions</button>`
      + `<b>${esc(d.title)}</b><span>${esc(d.source)}</span><span>read-only</span></div>` : '';
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    chatLog.innerHTML = head + (renderMessages(d.messages) || '<div class="empty">No messages yet.</div>');
    if (opts.past) q('#backBtn').onclick = () => { viewing = null; refreshChat(); };
    if (!opts.past || opts.scroll !== false) if (atBottom || opts.first) chatLog.scrollTop = chatLog.scrollHeight;
  } catch (s){
    chatLog.innerHTML = `<div class="empty">${s === 404 && !opts.past ? 'This conversation has no saved messages yet.'
      : 'Couldn’t read Hermes’s session history' + (s === 503 ? ' (state.db not found — set HERMES_STATE_DB).' : '.')}</div>`;
  }
}

async function showSessionList(){
  try {
    const d = await getJSON(`/api/sessions?scope=${scope}&limit=60`);
    const toggle = `<div class="viewbar"><span>Showing</span>`
      + `<button class="iconbtn" id="scopeBtn" type="button">${scope === 'dashboard' ? 'Robin only — show all sources' : 'all sources — show Robin only'}</button></div>`;
    chatLog.innerHTML = toggle + (d.sessions.length ? d.sessions.map(s =>
      `<button class="sessrow${s.current ? ' cur' : ''}" type="button" data-id="${esc(s.id)}">`
      + `<span class="src">${esc(s.source)}</span><span class="t">${esc(s.title)}</span>`
      + `<span class="meta">${when(s.last_at)} · ${s.messages} msgs</span></button>`).join('')
      : '<div class="empty">No sessions found.</div>');
    q('#scopeBtn').onclick = () => { scope = scope === 'dashboard' ? 'all' : 'dashboard'; showSessionList(); };
    chatLog.querySelectorAll('.sessrow').forEach(b => b.onclick = () => { viewing = b.dataset.id; refreshChat({first: true}); });
    chatLog.scrollTop = 0;
  } catch (s){
    chatLog.innerHTML = `<div class="empty">Couldn’t list sessions${s === 404 ? ': restart Robin to enable this view.' : '.'}</div>`;
  }
}

let curSession = null;
function refreshChat(opts = {}){
  if (!root.classList.contains('chat-open')) return;
  const other = chatView === 'sessions';
  root.classList.toggle('view-other', other);
  if (other) return viewing ? showSession(viewing, {past: true, first: opts.first}) : showSessionList();
  if (!curSession){ chatLog.innerHTML = '<div class="empty">No conversation yet. It appears here after the first answer.</div>'; return; }
  showSession(curSession, {first: opts.first});
}
// refresh the open conversation after each answer (Hermes saves it as the turn ends)
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes){
    const kind = n instanceof HTMLElement && (n.querySelector('.kind') || {}).textContent;
    if ((kind === 'COMPLETE' || kind === 'ERROR' || kind === 'STEER') && chatView === 'current'){
      setTimeout(async () => { await pollSystem(); refreshChat(); }, 900);
      setTimeout(() => refreshChat(), 3000);
    }
  }
}).observe(q('#log'), {childList: true});
try { if (localStorage.getItem('hud.chat') === '1') setTimeout(() => setExpanded(true), 400); } catch (_) {}

/* ══════════ slash-command suggestions ══════════
   Type "/" in the input: matching commands (the dashboard's and Hermes's own)
   appear above it. ↑↓ choose, Tab or Enter pick, Esc closes. Once a command is
   picked, the popup shows what to type after it. */
const input = q('#input'), pop = q('#cmdPop');
let CMDS = [], matches = [], sel = 0;
async function loadCommands(){
  try { CMDS = (await getJSON('/api/commands')).commands || []; } catch (_) {}
}
loadCommands(); setInterval(loadCommands, 60000);   // Hermes announces its commands once a session opens

function closePop(){ pop.classList.add('hidden'); matches = []; }
function rank(c, word){
  const n = c.name.toLowerCase();
  return n.startsWith(word) ? 0 : n.includes(word) ? 1 : (c.description || '').toLowerCase().includes(word) ? 2 : 9;
}
function updatePop(){
  const v = input.value;
  if (!v.startsWith('/') || v.includes('\n')){ closePop(); return; }
  const m = v.match(/^\/(\S*)(\s+)?/);
  const word = (m[1] || '').toLowerCase();
  if (m[2]){                                  // a command is typed: show what goes after it
    const c = CMDS.find(x => x.name.toLowerCase() === word);
    if (!c || !c.hint || v.trim().length > word.length + 1){ closePop(); return; }
    matches = [];
    pop.innerHTML = `<div class="hintrow"><b>/${esc(c.name)}</b> <i>${esc(c.hint)}</i> — ${esc(c.description)}</div>`;
    pop.classList.remove('hidden');
    return;
  }
  matches = CMDS.map(c => [rank(c, word), c]).filter(([r]) => r < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(x => x[1]);
  if (!matches.length){ closePop(); return; }
  sel = Math.min(sel, matches.length - 1);
  pop.innerHTML = matches.map((c, i) =>
    `<div class="it${i === sel ? ' sel' : ''}" role="option" data-i="${i}"><b>/${esc(c.name)}</b><i>${esc(c.hint || '')}</i>`
    + `<span>${esc(c.description || '')}</span><em>${c.source === 'hermes' ? 'Hermes' : ''}</em></div>`).join('')
    + `<div class="foot">↑↓ choose · Tab or Enter pick · Esc close</div>`;
  pop.classList.remove('hidden');
  const s = pop.querySelector('.it.sel'); s && s.scrollIntoView({block: 'nearest'});
}
function pick(i, send){
  const c = matches[i]; if (!c) return;
  input.value = '/' + c.name + (c.hint ? ' ' : '');
  input.focus();
  closePop();
  if (send && !c.hint) q('#run').click();     // a command with nothing to add runs straight away
  else updatePop();                            // otherwise show what to type next
}
input.addEventListener('input', () => { sel = 0; updatePop(); });
input.addEventListener('blur', () => setTimeout(closePop, 150));
pop.addEventListener('mousedown', e => {      // mousedown, so the input keeps focus
  const it = e.target.closest('.it'); if (!it) return;
  e.preventDefault(); pick(+it.dataset.i, false);
});
// capture on the container so these keys are handled before app.js sends or Esc cancels
q('.uplink').addEventListener('keydown', e => {
  if (e.target !== input || pop.classList.contains('hidden')) return;
  if (e.key === 'Escape'){ closePop(); e.preventDefault(); e.stopPropagation(); return; }
  if (!matches.length) return;                 // hint row only: keys behave normally
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    updatePop(); e.preventDefault(); e.stopPropagation();
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)){
    pick(sel, e.key === 'Enter'); e.preventDefault(); e.stopPropagation();
  }
}, true);

/* ══════════ neural core ══════════
   A glowing knot at the centre, filaments flowing out across a dark plane,
   signal pulses travelling along them, and a web of nodes. Bloom makes it
   glow; the glow follows the loudness of Robin's actual voice while speaking.
   Pulses flow inward while you talk and outward while Robin answers. */
let core = null;

// Loudness of Robin's spoken reply. app.js plays each reply through a new
// Audio element (`player`); we route it through an analyser on its way to the
// speakers. Only done while our AudioContext is running (after any click or
// key press), so speech is never routed into a silent, suspended context.
const speechLevel = (() => {
  let ctx = null, an = null, hooked = null, buf = null;
  const wake = () => {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch (_) {}
  };
  addEventListener('pointerdown', wake, true);
  addEventListener('keydown', wake, true);
  return () => {
    if (typeof player === 'undefined' || !player || !ctx || ctx.state !== 'running') return null;
    if (player !== hooked){
      hooked = player; an = null;
      try {
        const a = ctx.createAnalyser(); a.fftSize = 512;
        const src = ctx.createMediaElementSource(player);
        src.connect(a); a.connect(ctx.destination);
        an = a; buf = new Float32Array(a.fftSize);
      } catch (_) {}
    }
    if (!an || player.paused) return null;
    an.getFloatTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(s / buf.length) * 5);
  };
})();

function initCore(){
  const stage = q('#stage'), canvas = q('#core3d');
  let renderer;
  try {
    if (!window.THREE) throw new Error('three.js not loaded');
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance'});
  } catch (e){
    stage.insertAdjacentHTML('beforeend', `<div class="nogl">3D view unavailable (${esc(e.message || 'WebGL off')})</div>`);
    return null;
  }
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 3.3, 7.4);

  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const col = n => { const [r, g, b] = cssv(n).split(',').map(Number); return new THREE.Color(r / 255, g / 255, b / 255); };
  const R = (a, b) => a + Math.random() * (b - a);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const PLANE = -0.6;

  const gc = document.createElement('canvas'); gc.width = gc.height = 128;
  const gx = gc.getContext('2d'), grd = gx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.2, 'rgba(255,255,255,.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  gx.fillStyle = grd; gx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(gc);

  const world = new THREE.Group(); scene.add(world);
  const lineGeo = (pos, n) => { const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3)); return g; };

  // ── the knot: tangled closed loops at the centre ──
  const knotPos = [], knotMeta = [];
  for (let k = 0; k < 34; k++){
    const qn = new THREE.Quaternion().setFromEuler(new THREE.Euler(R(0, 6.3), R(0, 6.3), R(0, 6.3)));
    const rad = R(0.32, 0.82), lobes = 2 + Math.floor(R(0, 5)), ph = R(0, 6.3), wob = R(0.1, 0.35), m = 1 + Math.floor(R(0, 3)), mix = Math.random();
    let prev = null;
    for (let i = 0; i <= 120; i++){
      const th = i / 120 * Math.PI * 2, r = rad * (1 + 0.35 * Math.sin(lobes * th + ph));
      const v = V(Math.cos(th) * r, Math.sin(m * th + ph) * wob, Math.sin(th) * r).applyQuaternion(qn);
      if (prev){ knotPos.push(prev.x, prev.y, prev.z, v.x, v.y, v.z); knotMeta.push(mix, 1, mix, 1); }
      prev = v;
    }
  }
  const knotGeo = lineGeo(knotPos, knotPos.length / 3);
  const knotMat = new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false});
  const knot = new THREE.LineSegments(knotGeo, knotMat); world.add(knot);

  // ── filaments flowing out across the plane ──
  const fil = [], filMix = [], filPos = [], filMeta = [];
  for (let f = 0; f < 90; f++){
    const a = R(0, Math.PI * 2), d = R(5, 13), mix = Math.random();
    const at = (ang, r, y) => V(Math.cos(ang) * r, y, Math.sin(ang) * r);
    const curve = new THREE.CatmullRomCurve3([
      at(a, 0.25, R(-0.15, 0.15)), at(a + R(-0.5, 0.5), 1.4, R(-0.1, 0.35)),
      at(a + R(-0.4, 0.4), d * 0.45, PLANE + R(-0.1, 0.3)), at(a + R(-0.3, 0.3), d, PLANE + R(-0.2, 0.2))]);
    const S = curve.getSpacedPoints(60);
    fil.push(S); filMix.push(mix);
    for (let i = 0; i < S.length - 1; i++){
      filPos.push(S[i].x, S[i].y, S[i].z, S[i + 1].x, S[i + 1].y, S[i + 1].z);
      const b = t => Math.pow(1 - t, 0.9) * 0.85 + 0.06;
      filMeta.push(mix, b(i / 60), mix, b((i + 1) / 60));
    }
  }
  const filGeo = lineGeo(filPos, filPos.length / 3);
  const filMat = new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false});
  world.add(new THREE.LineSegments(filGeo, filMat));

  // ── signal pulses travelling along the filaments ──
  const P = 170, pulses = [];
  for (let p = 0; p < P; p++) pulses.push({f: Math.floor(R(0, fil.length)), t: Math.random(), v: R(0.05, 0.15)});
  const pulseGeo = new THREE.BufferGeometry();
  pulseGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P * 3), 3));
  pulseGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(P * 3), 3));
  const pulseMat = new THREE.PointsMaterial({size: 0.17, map: glowTex, vertexColors: true, transparent: true, depthWrite: false});
  world.add(new THREE.Points(pulseGeo, pulseMat));

  // ── the node web on the plane ──
  const NN = 170, nodes = [], nodeMix = [];
  for (let n = 0; n < NN; n++){
    const r = 2.6 + Math.sqrt(Math.random()) * 10.5, a = R(0, Math.PI * 2);
    nodes.push(V(Math.cos(a) * r, PLANE + R(-0.25, 0.35), Math.sin(a) * r)); nodeMix.push(Math.random());
  }
  const edgeSet = new Set(), edgePos = [], edgeMeta = [];
  nodes.forEach((p, i) => {
    nodes.map((o, j) => [j, p.distanceTo(o)]).filter(([j, d]) => j !== i && d < 3.4)
      .sort((x, y) => x[1] - y[1]).slice(0, 2).forEach(([j]) => {
        const key = i < j ? i + ':' + j : j + ':' + i;
        if (edgeSet.has(key)) return; edgeSet.add(key);
        const o = nodes[j]; edgePos.push(p.x, p.y, p.z, o.x, o.y, o.z); edgeMeta.push(nodeMix[i], 0.45, nodeMix[j], 0.45);
      });
  });
  const edgeGeo = lineGeo(edgePos, edgePos.length / 3);
  const edgeMat = new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false});
  world.add(new THREE.LineSegments(edgeGeo, edgeMat));
  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute('position', new THREE.Float32BufferAttribute(nodes.flatMap(p => [p.x, p.y, p.z]), 3));
  nodeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(NN * 3), 3));
  const nodeMat = new THREE.PointsMaterial({size: 0.3, map: glowTex, vertexColors: true, transparent: true, depthWrite: false});
  world.add(new THREE.Points(nodeGeo, nodeMat));
  const nodeDist = nodes.map(p => Math.hypot(p.x, p.z));

  // ── drifting dust ──
  const D = 380, dustPos = new Float32Array(D * 3);
  for (let i = 0; i < D; i++) dustPos.set([R(-14, 14), R(PLANE, 5), R(-14, 14)], i * 3);
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({size: 0.035, transparent: true, opacity: 0.5, depthWrite: false});
  const dust = new THREE.Points(dustGeo, dustMat); scene.add(dust);

  // ── centre glow ──
  const glowMat = new THREE.SpriteMaterial({map: glowTex, transparent: true, depthWrite: false});
  const glow = new THREE.Sprite(glowMat); world.add(glow);
  const hotMat = new THREE.SpriteMaterial({map: glowTex, color: 0xffffff, transparent: true, depthWrite: false});
  const hot = new THREE.Sprite(hotMat); world.add(hot);

  // ── bloom (the glow), when the post-processing add-on loaded ──
  let composer = null, bloom = null;
  if (THREE.EffectComposer && THREE.UnrealBloomPass){
    try {
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 1.0, 0.6, 0.12);
      composer.addPass(bloom);
    } catch (_) { composer = null; bloom = null; }
  }

  // ── colours from the theme ──
  let pal = {}, light = false, grid = null, filCol = [], nodeCol = [];
  const additive = [knotMat, filMat, edgeMat, pulseMat, nodeMat, dustMat, glowMat, hotMat];
  function paintLines(geo, meta){
    const c = geo.getAttribute('color'), tmp = new THREE.Color();
    for (let i = 0; i < meta.length / 2; i++){
      tmp.copy(pal.A).lerp(pal.B, meta[i * 2]);
      const out = pal.bg.clone().lerp(tmp, meta[i * 2 + 1]);
      c.setXYZ(i, out.r, out.g, out.b);
    }
    c.needsUpdate = true;
  }
  function palette(){
    light = document.documentElement.dataset.theme === 'daylight';
    pal = {A: col('--acc'), B: col('--acc2'), listen: col('--listen'), err: col('--err'), bg: new THREE.Color(cssv('--bg') || '#000')};
    scene.background = pal.bg;
    scene.fog = new THREE.FogExp2(pal.bg, light ? 0.035 : 0.05);
    additive.forEach(m => { m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; m.needsUpdate = true; });
    paintLines(knotGeo, knotMeta); paintLines(filGeo, filMeta); paintLines(edgeGeo, edgeMeta);
    filCol = filMix.map(m => pal.A.clone().lerp(pal.B, m));
    nodeCol = nodeMix.map(m => pal.A.clone().lerp(pal.B, m));
    dustMat.color.copy(pal.A).lerp(pal.B, 0.5);
    if (grid){ world.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = new THREE.GridHelper(48, 96, pal.A, pal.A);
    grid.material.transparent = true; grid.material.opacity = light ? 0.12 : 0.06; grid.position.y = PLANE - 0.05;
    world.add(grid);
    if (bloom) bloom.enabled = !light;            // bloom only reads well on dark themes
  }
  palette();

  function resize(){
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    camera.aspect = w / h;
    camera.position.z = w / h < 1.1 ? 10 : 7.4;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage); resize();

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPEED = {idle: 0.45, listening: 0.7, running: 1.7, speaking: 1.1, error: 0.2};
  const STATE_COLOR = {idle: 'A', listening: 'listen', running: 'B', speaking: 'A', error: 'err'};
  const cur = pal.A.clone(), tmp = new THREE.Color();
  let speed = 0.45, level = 0, glowAmt = 0.25, wave = 0, last = performance.now(), mbuf = null;
  function micLevel(){
    if (typeof analyser === 'undefined' || !analyser || typeof phase === 'undefined' || phase !== 'listening') return 0;
    if (!mbuf || mbuf.length !== analyser.fftSize) mbuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(mbuf);
    let s = 0; for (let i = 0; i < mbuf.length; i++) s += mbuf[i] * mbuf[i];
    return Math.min(1, Math.sqrt(s / mbuf.length) * 9);
  }
  const pPos = pulseGeo.getAttribute('position'), pCol = pulseGeo.getAttribute('color'), nCol = nodeGeo.getAttribute('color');

  function frame(now){
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = now / 1000, st = stateNow();
    speed += ((reduce ? 0.15 : SPEED[st]) - speed) * Math.min(1, dt * 3);

    // how loud: Robin's real voice while speaking (a gentle pulse if it can't be measured), your mic while listening
    let target = 0;
    if (st === 'speaking'){
      const v = speechLevel();
      target = v == null ? 0.45 * (0.5 + 0.5 * Math.sin(t * 11)) * (0.6 + 0.4 * Math.sin(t * 2.7)) : v;
    } else if (st === 'listening') target = micLevel();
    level += (target - level) * Math.min(1, dt * (target > level ? 18 : 6));
    const goal = {idle: 0.22, listening: 0.32 + level * 0.5, running: 0.45 + 0.12 * Math.sin(t * 5),
                  speaking: 0.6 + level * 1.1, error: 0.18}[st];
    glowAmt += (goal - glowAmt) * Math.min(1, dt * 6);
    cur.lerp(pal[STATE_COLOR[st]], Math.min(1, dt * 4));
    if (bloom) bloom.strength = Math.min(1.9, 0.3 + glowAmt * 1.45);

    knot.rotation.y += dt * speed * 0.35; knot.rotation.x += dt * speed * 0.17;
    knot.scale.setScalar(1 + glowAmt * 0.22 + level * 0.25 + 0.03 * Math.sin(t * 1.5));
    knotMat.color.setScalar(Math.min(1.05, 0.32 + glowAmt * 0.7));
    filMat.color.setScalar(Math.min(1.25, 0.4 + glowAmt * 0.75));
    edgeMat.color.setScalar(0.35 + glowAmt * 0.45);
    glowMat.color.copy(cur); glowMat.opacity = light ? 0.35 : 0.25 + glowAmt * 0.6;
    glow.scale.setScalar(Math.min(4.2, 1.6 + glowAmt * 2.4));
    hotMat.opacity = light ? 0.2 : Math.min(0.6, 0.2 + glowAmt * 0.35); hot.scale.setScalar(Math.min(0.9, 0.35 + glowAmt * 0.5));

    // pulses: inward while you talk, outward otherwise; faster and brighter as Robin speaks
    const dir = st === 'listening' ? -1 : 1, pace = speed * (st === 'speaking' ? 1 + level * 2 : 1);
    const pb = 0.25 + glowAmt * 1.1;
    for (let i = 0; i < P; i++){
      const p = pulses[i];
      p.t += dir * p.v * dt * pace;
      if (p.t > 1 || p.t < 0){ p.t = dir > 0 ? 0 : 1; p.f = Math.floor(Math.random() * fil.length); }
      const S = fil[p.f], x = p.t * (S.length - 1), i0 = Math.min(S.length - 2, Math.floor(x)), fr = x - i0;
      pPos.setXYZ(i, S[i0].x + (S[i0 + 1].x - S[i0].x) * fr, S[i0].y + (S[i0 + 1].y - S[i0].y) * fr, S[i0].z + (S[i0 + 1].z - S[i0].z) * fr);
      const b = Math.sin(Math.PI * p.t) * pb, c = filCol[p.f];
      pCol.setXYZ(i, c.r * b, c.g * b, c.b * b);
    }
    pPos.needsUpdate = true; pCol.needsUpdate = true;

    // nodes twinkle; a ripple rolls outward across the web while Robin speaks
    wave += dt * (st === 'speaking' ? 6 : 2.2);
    const waveR = wave % 15, ripAmp = st === 'speaking' ? 0.4 + level * 1.6 : 0.25 * glowAmt;
    for (let n = 0; n < NN; n++){
      const dd = nodeDist[n] - waveR;
      const b = 0.42 + 0.15 * Math.sin(t * 1.3 + n * 1.7) + Math.exp(-dd * dd / 1.2) * ripAmp;
      const c = nodeCol[n];
      if (light){ tmp.copy(pal.bg).lerp(c, Math.min(1, b + 0.2)); nCol.setXYZ(n, tmp.r, tmp.g, tmp.b); }
      else nCol.setXYZ(n, c.r * b, c.g * b, c.b * b);
    }
    nCol.needsUpdate = true;

    world.rotation.y += dt * 0.025 * speed;
    dust.rotation.y -= dt * 0.01;
    camera.position.x = Math.sin(t * 0.07) * 0.6;
    camera.lookAt(0, -0.25, 0);
    if (composer && !light) composer.render(); else renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  return {palette};
}
core = initCore();

/* ── start the pollers ── */
pollState(); pollSystem(); pollTimings();
setInterval(pollSystem, 3000);
setInterval(pollState, 5000);
setInterval(pollTimings, 6000);
})();
