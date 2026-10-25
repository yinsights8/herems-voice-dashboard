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
  } catch (_) {}
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
  }
}).observe(q('#log'), {childList: true});

const HINTS = {listening: 'Listening — speak now', running: 'Working — Esc to stop', speaking: 'Speaking — talk over to interrupt',
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

/* ══════════ 3D core ══════════ */
let core = null;
function initCore(){
  const stage = q('#stage'), canvas = q('#core3d');
  let renderer;
  try {
    if (!window.THREE) throw new Error('three.js not loaded');
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true});
  } catch (e){
    stage.insertAdjacentHTML('beforeend', `<div class="nogl">3D view unavailable (${esc(e.message || 'WebGL off')})</div>`);
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 1.4, 8.2); camera.lookAt(0, 0.15, 0);

  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const col = n => { const [r, g, b] = cssv(n).split(',').map(Number); return new THREE.Color(r / 255, g / 255, b / 255); };

  // soft glow sprite texture
  const gc = document.createElement('canvas'); gc.width = gc.height = 128;
  const gx = gc.getContext('2d'), grd = gx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  gx.fillStyle = grd; gx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(gc);

  const group = new THREE.Group(); group.position.y = 0.35; scene.add(group);
  const sphereMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0.95});
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 32), sphereMat); group.add(sphere);
  const glowMat = new THREE.SpriteMaterial({map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending});
  const glow = new THREE.Sprite(glowMat); glow.scale.set(3.4, 3.4, 1); group.add(glow);
  const hotMat = new THREE.SpriteMaterial({map: glowTex, color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending});
  const hot = new THREE.Sprite(hotMat); hot.scale.set(0.9, 0.9, 1); group.add(hot);

  const icoMat = new THREE.LineBasicMaterial({transparent: true, opacity: 0.5});
  const ico = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.12, 1)), icoMat); group.add(ico);

  // each ring is tilted inside a holder that turns about the vertical axis,
  // so the rings precess like a gyroscope instead of spinning flat
  const ringMats = [], rings = [];
  [[1.75, 0.014, 1.2, 0], [2.08, 0.011, 0.75, 2.1], [2.4, 0.008, 1.9, 4.2]].forEach(([r, tube, tilt, phase], i) => {
    const m = new THREE.MeshBasicMaterial({transparent: true, opacity: i === 1 ? 0.75 : 0.45});
    const holder = new THREE.Group(); holder.rotation.y = phase; group.add(holder);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 180), m);
    ring.rotation.x = tilt; holder.add(ring); rings.push(holder); ringMats.push(m);
  });
  // dashed outer orbit
  const pts = []; for (let i = 0; i <= 200; i++){ const a = i / 200 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * 2.85, 0, Math.sin(a) * 2.85)); }
  const dashMat = new THREE.LineDashedMaterial({dashSize: 0.16, gapSize: 0.12, transparent: true, opacity: 0.5});
  const dash = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), dashMat); dash.computeLineDistances();
  dash.rotation.x = 0.18; group.add(dash);
  // satellite on the middle ring
  const pivot = new THREE.Group(); pivot.rotation.x = 0.75; rings[1].add(pivot);
  const satMat = new THREE.MeshBasicMaterial();
  const sat = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), satMat); sat.position.x = 2.08; pivot.add(sat);
  const satGlowMat = new THREE.SpriteMaterial({map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending});
  const satGlow = new THREE.Sprite(satGlowMat); satGlow.scale.set(0.5, 0.5, 1); sat.add(satGlow);
  // particle shell
  const N = 700, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++){
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 3 + Math.random() * 0.9, s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(th) * s * r, u * r * 0.75, Math.sin(th) * s * r], i * 3);
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const ptMat = new THREE.PointsMaterial({size: 0.028, transparent: true, opacity: 0.55, depthWrite: false});
  const shell = new THREE.Points(pg, ptMat); group.add(shell);

  let grid = null;
  const STATE_COLOR = {idle: '--acc', listening: '--listen', running: '--acc2', speaking: '--acc', error: '--err'};
  let pal = {};
  function palette(){
    pal = {acc: col('--acc'), acc2: col('--acc2'), listen: col('--listen'), err: col('--err'), bg: new THREE.Color(cssv('--bg') || '#000')};
    const light = document.documentElement.dataset.theme === 'daylight';
    const blend = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    [glowMat, hotMat, satGlowMat].forEach(m => { m.blending = blend; m.needsUpdate = true; });
    hotMat.opacity = light ? 0.35 : 0.8;
    icoMat.color.copy(pal.acc2); ringMats[0].color.copy(pal.acc); ringMats[1].color.copy(pal.acc2); ringMats[2].color.copy(pal.acc);
    dashMat.color.copy(pal.acc); satMat.color.copy(pal.acc2); satGlowMat.color.copy(pal.acc2); ptMat.color.copy(pal.acc);
    scene.fog = new THREE.Fog(pal.bg, 7, 16);
    if (grid){ group.parent.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = new THREE.GridHelper(18, 36, pal.acc, pal.acc);
    grid.material.transparent = true; grid.material.opacity = light ? 0.25 : 0.38; grid.position.y = -2.05;
    scene.add(grid);
  }
  palette();
  const cur = new THREE.Color().copy(pal.acc);

  function resize(){
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.position.z = w / h < 1.1 ? 10.5 : 8.2;            // step back on narrow screens
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage); resize();

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPEED = {idle: 0.55, listening: 0.9, running: 2.6, speaking: 1.3, error: 0.25};
  let speed = 0.55, level = 0, last = performance.now(), buf = null, gridOff = 0;
  function micLevel(){
    if (typeof analyser === 'undefined' || !analyser || typeof phase === 'undefined' || phase !== 'listening') return 0;
    if (!buf || buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(s / buf.length) * 9);
  }
  function frame(now){
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = now / 1000, st = stateNow();
    speed += ((reduce ? 0.2 : SPEED[st]) - speed) * Math.min(1, dt * 3);
    let target = st === 'listening' ? micLevel()
      : st === 'speaking' ? 0.35 * (0.5 + 0.5 * Math.sin(t * 11)) * (0.6 + 0.4 * Math.sin(t * 2.7)) : 0;
    level += (target - level) * Math.min(1, dt * 12);
    cur.lerp(pal[STATE_COLOR[st].slice(2)] || pal.acc, Math.min(1, dt * 4));
    sphereMat.color.copy(cur); glowMat.color.copy(cur);

    const breathe = 1 + 0.035 * Math.sin(t * 1.6);
    sphere.scale.setScalar(breathe + level * 0.55);
    glow.scale.setScalar(3.2 + level * 2.4 + (st === 'running' ? 0.4 * Math.sin(t * 6) : 0));
    ico.rotation.y += dt * speed * 0.35; ico.rotation.x += dt * speed * 0.12;
    rings[0].rotation.y += dt * speed * 0.5; rings[1].rotation.y -= dt * speed * 0.35; rings[2].rotation.y += dt * speed * 0.22;
    pivot.rotation.z += dt * speed * 1.4;
    dash.rotation.y -= dt * speed * 0.15;
    shell.rotation.y += dt * speed * 0.05;
    gridOff += dt * speed * 0.6;
    if (grid) grid.position.z = gridOff % 0.5;                // floor slides toward you
    group.position.y = 0.35 + 0.06 * Math.sin(t * 0.9);
    renderer.render(scene, camera);
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
