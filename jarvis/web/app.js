/* JARVIS Live HUD — drives Hermes Agent, streams telemetry.

   The brain is your own `hermes` CLI/profile, so configured Hermes tools,
   browser automation, skills, memory, MCP servers and third-party connectors are live. */
const $ = s => document.querySelector(s);
const RT = {tts:false, stt:false, browserStt:false, browserTts:false};
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynth = window.speechSynthesis;
const API_TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content || '';
let NAME = 'Jarvis';                        // replaced by assistant.yaml's name at boot
let UI = {barge_in: true, earcon: true, max_spoken_chars: 700, browser_language: '', hold_unfinished_ms: 1500};
const apiHeaders = extra => ({'x-jarvis-token': API_TOKEN, ...(extra || {})});

// ── reactor ticks ──
(() => {
  const g = $('#ticks480');
  for (let i = 0; i < 128; i++){
    const a = (i/128) * Math.PI*2, maj = i % 8 === 0;
    const r0 = maj ? 246 : 250, r1 = 260;
    const l = document.createElementNS('http://www.w3.org/2000/svg','line');
    l.setAttribute('x1', 260+Math.cos(a)*r0); l.setAttribute('y1', 260+Math.sin(a)*r0);
    l.setAttribute('x2', 260+Math.cos(a)*r1); l.setAttribute('y2', 260+Math.sin(a)*r1);
    if (maj) l.setAttribute('class','maj');
    g.appendChild(l);
  }
})();

const now = () => new Date().toLocaleTimeString('en-GB', {hour12:false});
const rid = () => 'run_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'').slice(0,24)
                                              : Math.random().toString(16).slice(2,14));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ── reactor state ──
function setState(cls, word, sub){
  document.body.className = cls;
  if (word) $('#stword').textContent = word;
  if (sub != null) $('#strun').textContent = sub;
}
function setTag(cls, text){ const t=$('#rtag'); t.className='rtag '+cls; t.textContent=text; }

// ── action log ──
function log(kind, label, msg, jsonHtml){
  const e = document.createElement('div');
  e.className = 'entry k-' + kind;
  e.innerHTML = `<div class="top"><span class="ts">${now()}</span>`
    + `<span class="kind">${esc(label)}</span></div>`
    + (msg ? `<div class="msg">${esc(msg)}</div>` : '')
    + (jsonHtml ? `<div class="jsonblk">${jsonHtml}</div>` : '');
  const box = $('#log');
  box.insertBefore(e, box.firstChild);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}
function usageBlock(u){
  const row = (k,v) => `  <span class="k">"${k}"</span>: <span class="v">${v}</span>`;
  return `{\n  <span class="k">"usage"</span>: {\n`
    + [row('input_tokens', u.input_tokens), row('output_tokens', u.output_tokens),
       row('total_tokens', u.total_tokens)].join(',\n')
    + `\n  }\n}`;
}

/* ══════════ latency monitor ══════════
   Every turn carries a timeline of performance.now() marks. When it ends, the
   Action Log shows a waterfall of where the time went, the browser console gets
   a table, and the record (stage durations only — no words) is appended to
   logs/timings.jsonl on the server. Run `python3 timings_report.py` there for
   medians across many turns. */
let curTurn = null;
const newTurn = kind => ({id: rid().slice(4, 12), kind, t: {}, stt: null, srv: null, ttsMs: null});
const mark = (turn, name) => { if (turn && turn.t[name] == null) turn.t[name] = performance.now(); };

function turnStages(turn){
  const d = (a, b) => (turn.t[a] != null && turn.t[b] != null) ? Math.round(turn.t[b] - turn.t[a]) : null;
  const s = turn.srv || {}, st = turn.stt || {};
  const hermesInfo = [
    s.probe_ms != null && `probe ${s.probe_ms}`,
    s.lock_wait_ms && `lock-wait ${s.lock_wait_ms}`,
    s.tools_snapshot_ms != null && `tools-list ${s.tools_snapshot_ms}`,
    s.spawn_ms != null && `spawn ${s.spawn_ms}`,
    s.hermes_first_text_ms != null && `hermes ${s.hermes_first_text_ms}`,
  ].filter(Boolean).join(' · ');
  return [
    ['endpoint wait', d('lastVoice', 'endpoint'), 'silence before the turn closes'],
    ['encode wav',    d('endpoint', 'encoded'), ''],
    ['upload + STT',  d('sttSent', 'sttDone'),
       (st.stt_ms ?? st.elevenlabs_stt_ms) != null ? `${ENGINE_LABELS[st.engine || 'elevenlabs']} ${st.stt_ms ?? st.elevenlabs_stt_ms} · ${Math.round((st.bytes||0)/1024)}KB` : ''],
    ['to Hermes',     d('sent', 'firstText'), hermesInfo],
    ['answer stream', d('firstText', 'complete'), s.hermes_total_ms != null ? `hermes total ${s.hermes_total_ms}` : ''],
    ['TTS synth',     d('ttsStart', 'ttsReady'), turn.ttsMs != null ? `${ENGINE_LABELS[turn.ttsEngine] || 'server'} ${turn.ttsMs}` : ''],
    ['play start',    d('ttsReady', 'playing'), ''],
  ].filter(r => r[1] != null);
}

function reportTurn(turn){
  if (!turn || turn.reported) return;
  turn.reported = true;
  const anchor = turn.kind === 'voice' ? 'lastVoice' : 'sent';
  const end = turn.t.playing != null ? 'playing' : (turn.t.complete != null ? 'complete' : null);
  const headline = end && turn.t[anchor] != null ? Math.round(turn.t[end] - turn.t[anchor]) : null;
  const stages = turnStages(turn);
  const max = Math.max(1, ...stages.map(r => r[1]));
  const fmt = ms => (ms / 1000).toFixed(2) + 's';
  const lines = stages.map(([label, ms, info]) =>
    `${label.padEnd(14)}${fmt(ms).padStart(7)}  ${'█'.repeat(Math.max(ms > 0 ? 1 : 0, Math.round(ms / max * 16))).padEnd(16)}  ${info}`);
  if (turn.t.playing != null && turn.t.spoken != null)
    lines.push(`${'spoke for'.padEnd(14)}${fmt(turn.t.spoken - turn.t.playing).padStart(7)}${turn.interrupted ? '  (interrupted)' : ''}`);
  const who = turn.kind === 'voice' ? `you stopped → ${NAME} speaks` : 'sent → ' + (end === 'playing' ? `${NAME} speaks` : 'answer done');
  const head = headline != null ? `${who}: ${fmt(headline)}` : (turn.note || 'incomplete turn');
  log('latency', 'TIMING', `${turn.kind} ${turn.id} · ${head}`, esc(lines.join('\n')));
  console.table(Object.fromEntries(stages.map(([l, ms, info]) => [l, {ms, info}])));

  fetch('/api/timing', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
    body: JSON.stringify({
      id: turn.id, kind: turn.kind, note: turn.note || null, interrupted: !!turn.interrupted,
      headline_ms: headline, headline_to: end,
      stages: Object.fromEntries(stages.map(([l, ms]) => [l, ms])),
      server: turn.srv, stt: turn.stt, tts_ms: turn.ttsMs,
      speech_ms: turn.t.speechStart != null && turn.t.lastVoice != null ? Math.round(turn.t.lastVoice - turn.t.speechStart) : null,
      spoke_ms: turn.t.playing != null && turn.t.spoken != null ? Math.round(turn.t.spoken - turn.t.playing) : null,
      noise_floor: turn.noise != null ? +turn.noise.toFixed(5) : null,
      peak_level: turn.peak != null ? +turn.peak.toFixed(5) : null,
      rejected_noises: turn.rejected ?? null,
      stt_result: turn.sttResult || null,
      words: turn.words ?? null,
      answer_chars: turn.answerChars ?? null,
      tools: turn.tools || 0,
      approvals: turn.approvals || 0,
      mode: (turn.srv || {}).mode || null,
      tts_engine: turn.ttsEngine || null,
      stop_reason: (turn.srv || {}).stop_reason || null,
    })}).catch(() => {});
  if (turn.kind === 'voice') rejectedNoises = 0;
  updateStrip(turn, headline, stages);
}

// ── latency strip on the HUD (last turn's stages + rolling median) ──
const STAGE_COLORS = {'endpoint wait':'#5b8796', 'encode wav':'#2f5662', 'upload + STT':'#a884ff',
  'to Hermes':'#ffb648', 'answer stream':'#ffd79a', 'TTS synth':'#39f5a6', 'play start':'#40f3ff'};
let recentHeadlines = [];

function updateStrip(turn, headline, stages){
  const el = $('#latStrip'); if (!el) return;
  if (headline != null){ recentHeadlines.push(headline); if (recentHeadlines.length > 20) recentHeadlines.shift(); }
  const sorted = [...recentHeadlines].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const s = ms => ms == null ? '—' : (ms / 1000).toFixed(1) + 's';
  const bar = (stages || []).filter(r => r[1] > 0)
    .map(([l, ms]) => `<i style="flex:${ms} 0 0;background:${STAGE_COLORS[l] || '#83b7c4'}" title="${esc(l)}: ${ms} ms"></i>`).join('');
  el.innerHTML = (bar ? `<div class="lsbar">${bar}</div>` : '')
    + `latency · last <b>${s(headline)}</b> · median <b>${s(med)}</b> (${sorted.length} turns) · `
    + `<a href="/metrics.html" target="_blank">metrics ↗</a>`;
}

// ── the run ──
let running = false, answer = '', firstDelta = false, speakThisRun = true;
let speakDone = Promise.resolve(), activeController = null;

async function transmit(message, options = {}){
  if (!message.trim()) return;
  if (running){
    // A task is running. Plain words go into it as guidance (Hermes /steer);
    // if that can't happen they're sent the moment the task ends. Never dropped.
    if (!message.trim().startsWith('/')) return steerRun(message.trim());
    if (/^\/steer\s+\S/.test(message.trim())) return steerRun(message.trim().replace(/^\/steer\s+/, ''));
    log('note','BUSY',`still working — "${message.slice(0,40)}" not sent. Wait, or press Esc to cancel.`);
    return;
  }
  running = true; answer = ''; firstDelta = false; speakThisRun = options.speak !== false; steerAcked = false;
  const turn = curTurn = options.turn || newTurn('text');
  mark(turn, 'sent');

  // a few seconds into a voice-led task, open the mic again so you can steer or stop it
  clearTimeout(listenTimer);
  listenTimer = setTimeout(() => { if (running && convo && micStream && phase === 'busy') listenDuringRun(); }, 3000);

  const fresh = /^\/new\b/.test(message.trim());
  const id = rid();
  setState('running', 'RUNNING', id.slice(0,20) + '…');
  setTag('run', 'RUNNING');
  $('#response').innerHTML = '<span class="cur"></span>';
  log('run', 'RUN', `started ${id}; uplink cleared`);

  // visible elapsed counter — a slow answer should never look like a dead screen
  const t0 = performance.now();
  const tick = setInterval(() => {
    if (!running) return;
    const s = ((performance.now()-t0)/1000).toFixed(1);
    if (!answer) $('#strun').textContent = `thinking… ${s}s`;
  }, 200);

  try {
    activeController = new AbortController();
    const res = await fetch('/api/run', {
      method:'POST', headers:apiHeaders({'content-type':'application/json'}),
      body: JSON.stringify({message, fresh, turn_id: turn.id}), signal:activeController.signal
    });
    if (!res.ok) throw new Error(`backend returned HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true){
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream:true});
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
  } catch (e){
    if (e?.name === 'AbortError'){
      log('note', 'CANCEL', 'run cancelled');
      setState('', 'STANDBY', 'cancelled');
      setTag('', 'IDLE');
    } else {
      log('error', 'ERROR', String(e).slice(0,200));
      setState('error', 'FAULT', 'stream dropped');
      setTag('err', 'ERROR');
    }
  }
  activeController = null;
  running = false;
  clearInterval(tick);
  clearTimeout(listenTimer);
  clearPermission();                 // a finished or cancelled run has nothing left to approve
  await speakDone;                 // don't return until Jarvis has finished (or been interrupted)
  reportTurn(turn);
  if (nextUp){                     // something said mid-task that couldn't be steered in
    const m = nextUp; nextUp = null;
    log('send','SEND',`sending what you said during the task: ${m.slice(0, 80)}`);
    setTimeout(() => transmit(m), 0);
  }
}

// ── talking to a task while it runs ──
let nextUp = null, listenTimer = null, steerAcked = false;
async function steerRun(text){
  try {
    const r = await fetch('/api/steer', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
                                         body: JSON.stringify({text})});
    if (r.ok){
      log('send','STEER',`passed to the running task: "${text.slice(0, 90)}"`);
      // Hermes applies it at the task's next step, which can be a while if a tool is
      // mid-way: say once that it was heard, so the silence doesn't feel like being ignored.
      if (convo && !steerAcked){
        steerAcked = true;
        speak("Got it, I'll factor that in when the current step finishes. Say stop to start over.");
      } else earcon();
      return;
    }
  } catch(_){}
  nextUp = nextUp ? nextUp + ' ' + text : text;
  log('note','QUEUED',`will send when the current task finishes: "${text.slice(0, 60)}"`);
}
function cancelRun(){
  if (!(running && activeController)) return false;
  fetch('/api/cancel', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:'{}'}).catch(()=>{});
  activeController.abort();
  nextUp = null;
  return true;
}
// Keep the microphone open while a task runs, without changing the "working" display.
function listenDuringRun(){
  if (!convo || !micStream || phase === 'speaking') return;
  phase = 'listening'; inSpeech = false; onsetMs = 0; voicedMs = 0; turnBuf = [];
  setState('running', 'RUNNING', 'working · speak to steer, say "stop" to cancel');
}

function handle(ev){
  switch (ev.t){
    case 'status': {
      if (ev.session_id) sys('session', ev.session_id.slice(0,8));
      const msg = `core online · Hermes tools=${ev.tools ?? 0} profile=${ev.profile||'default'} permission=${ev.permission||'normal'}`;
      log('status', 'STATUS', msg);
      break;
    }
    case 'latency':
      log('latency', 'LATENCY', `first token after ${ev.ms}ms`);
      break;
    case 'tool':
      if (ev.phase === 'use' && curTurn) curTurn.tools = (curTurn.tools || 0) + 1;
      if (ev.phase === 'use')
        log('tool', 'TOOL', `→ ${ev.name}(${ev.input || ''})`);
      else
        log('tool', 'TOOL', `✓ ${ev.ok===false?'error':'ok'}`);
      break;
    case 'delta':
      mark(curTurn, 'firstText');
      answer += ev.text;
      renderAnswer();
      if (!firstDelta){
        firstDelta = true;
        log('reason', 'REASONING', answer.slice(0, 220));
      }
      break;
    case 'usage':
      log('status', 'COMPLETE', 'run completed', usageBlock(ev));
      break;
    case 'complete':
      setState('done', 'COMPLETE', (ev.ms!=null?`${ev.ms}ms`:'') );
      setTag('done', 'COMPLETE');
      log('complete', 'COMPLETE', ev.ms!=null?`run completed in ${ev.ms}ms`:'run completed');
      renderAnswer(true);
      if (curTurn){ mark(curTurn, 'complete'); curTurn.srv = ev.timing || null; curTurn.answerChars = answer.trim().length; }
      if (ev.followup){
        // said mid-task but it reached Hermes after its last step, so the model never saw it
        nextUp = nextUp ? ev.followup + ' ' + nextUp : ev.followup;
        log('note','STEER',`arrived after ${NAME}'s last step — asking it next: "${ev.followup.slice(0, 80)}"`);
      }
      speakDone = speakThisRun ? speak(answer, curTurn) : Promise.resolve();
      break;
    case 'error':
      if (curTurn){ curTurn.srv = ev.timing || curTurn.srv; curTurn.note = 'error: ' + (ev.message || '').slice(0, 60); }
      setState('error', 'FAULT', ev.message?.slice(0,40) || 'error');
      setTag('err', 'ERROR');
      log('error', 'ERROR', ev.message || 'unknown');
      // show it in the panel too, so a failure isn't a silent empty box
      if (!answer) $('#response').innerHTML =
        `<span style="color:var(--red)">⚠ ${esc(ev.message || 'Run failed.')}</span>`;
      else renderAnswer(true);
      break;
    case 'note':
      log('note', 'NOTE', ev.message || '');
      break;
    case 'permission':
      if (curTurn) curTurn.approvals = (curTurn.approvals || 0) + 1;
      askPermission(ev);
      break;
  }
}

/* ══════════ tool approvals ══════════
   Hermes asks before running tools that need approval. The request appears as a
   card under the response with one button per option; in voice mode Jarvis asks
   aloud and a spoken "yes" / "no" answers it. Unanswered requests are refused by
   the server after a timeout, and Esc refuses them too. */
let pendingPerm = null;

function askPermission(ev){
  pendingPerm = ev;
  log('tool', 'APPROVAL', `Hermes wants to: ${ev.title}`);
  let card = $('#permCard');
  if (!card){
    card = document.createElement('div');
    card.id = 'permCard';
    card.style.cssText = 'margin:0 18px 14px;padding:12px 14px;border:1px solid var(--amber);'
      + 'border-radius:16px;background:rgba(255,182,72,.07);font-family:var(--mono);font-size:12px;color:var(--ink)';
    $('#responseWrap').appendChild(card);
  }
  card.innerHTML = `<div style="color:var(--amber);letter-spacing:.14em;margin-bottom:6px">APPROVAL NEEDED</div>`
    + `<div style="margin-bottom:10px">${esc(ev.title)}</div>`
    + `<div style="display:flex;gap:8px;flex-wrap:wrap">`
    + (ev.options || []).map(o => `<button class="ctl ${o.kind.startsWith('allow') ? 'run' : 'aux'}" data-opt="${esc(o.id)}">${esc(o.name)}</button>`).join('')
    + `</div>`;
  card.querySelectorAll('button').forEach(b => b.onclick = () => answerPermission(b.dataset.opt));
  if (convo && micStream){
    const say = `I need your approval to ${ev.title}. Say yes or no.`;
    speak(say).then(() => { if (convo && micStream && pendingPerm && phase !== 'listening') startListening(); });
  }
}

function clearPermission(){
  pendingPerm = null;
  const card = $('#permCard'); if (card) card.remove();
}

function answerPermission(optionId){
  const ev = pendingPerm; if (!ev) return;
  const opt = (ev.options || []).find(o => o.id === optionId);
  clearPermission();
  log('tool', 'APPROVAL', opt ? `answered: ${opt.name}` : 'refused');
  fetch('/api/permission', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
    body: JSON.stringify({id: ev.id, option_id: optionId || null})})
    .then(r => { if (!r.ok) log('note', 'APPROVAL', 'that request had already expired'); })
    .catch(() => {});
}

// Map a spoken reply to an approval option. Returns true if it was an answer.
function answerPermissionByVoice(text){
  const ev = pendingPerm; if (!ev) return false;
  const yes = /^(yes|yeah|yep|yup|approve|approved|allow|go ahead|do it|sure|ok|okay|affirmative)\b/i.test(text);
  const no  = /^(no|nope|deny|denied|don'?t|do not|stop|cancel|reject|negative)\b/i.test(text);
  if (!yes && !no) return false;
  const opts = ev.options || [];
  const pick = kinds => kinds.map(k => opts.find(o => o.kind === k)).find(Boolean);
  const opt = yes ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
  answerPermission(opt ? opt.id : null);
  return true;
}

function renderAnswer(finaldone){
  const el = $('#response');
  el.innerHTML = esc(answer) + (finaldone ? '' : '<span class="cur"></span>');
  el.scrollTop = el.scrollHeight;
}

function cleanForSpeech(text){
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(session_id:|session:|duration:|messages:|query:|initializing agent|resume this session|hermes --resume|[-─=]{3,})/i.test(line))
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ══════════ continuous voice conversation ══════════
   Click VOICE once. From then on: listen → you stop → transcribe → Jarvis
   answers and speaks → it listens again, automatically. Click VOICE again
   (or press Esc) to end the conversation.

   ElevenLabs mode runs its own voice-activity detector on raw microphone PCM:
   - speech-band energy (250–3500 Hz), so hum, fans and desk thumps count for less
   - a rolling noise floor carried across turns — no per-turn calibration, so
     answering the instant Jarvis finishes is heard correctly
   - hysteresis: a turn starts only after ONSET_MS above the "enter" level and
     ends only after SILENCE_MS below the lower "stay" level
   - a pre-roll buffer, so the first syllable is never clipped
   - barge-in: while Jarvis speaks, sustained speech above a stricter,
     echo-aware level stops him and starts your turn immediately
   Only your speech is uploaded, as 16 kHz mono WAV. */
const VAD = {
  ONSET_MS: 100,        // speech must persist this long to start a turn
  SILENCE_MS: 800,      // quiet this long ends the turn
  MIN_SPEECH_MS: 250,   // turns with less voiced audio than this are ignored
  MAX_TURN_MS: 20000,   // hard cap on one turn
  PREROLL_MS: 400,      // audio kept from just before speech onset
  BARGE_MS: 280,        // sustained speech needed to interrupt Jarvis
};
const OUT_RATE = 16000;

let convo = false, phase = 'idle';           // idle | listening | busy | speaking
let recognition = null;
let micStream = null, actx = null, analyser = null, tap = null, sink = null, vbuf = null;
let noiseFloor = 0.01, echoFloor = 0.01, warmFrames = 0;
let inSpeech = false, onsetMs = 0, voicedMs = 0, loudAt = 0, turnStart = 0, bargeMs = 0;
let preroll = [], prerollLen = 0, turnBuf = [];
let turnPeak = 0, rejectedNoises = 0, emptyStreak = 0;            // for the latency monitor
let muted = false, player = null, stopSpeech = null;

// AudioWorklet that hands raw mic PCM to the page in ~21 ms blocks.
const TAP_WORKLET = `
class JarvisTap extends AudioWorkletProcessor {
  constructor(){ super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch){
      for (let i = 0; i < ch.length; i++){
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length){ this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('jarvis-tap', JarvisTap);`;

async function openMic(){
  micStream = await navigator.mediaDevices.getUserMedia(
    {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}});
  actx = new (window.AudioContext||window.webkitAudioContext)();
  await actx.resume();
  const url = URL.createObjectURL(new Blob([TAP_WORKLET], {type:'application/javascript'}));
  try { await actx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }

  const src = actx.createMediaStreamSource(micStream);
  // the detector hears only the speech band…
  const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = 3500;
  analyser = actx.createAnalyser(); analyser.fftSize = 1024;
  src.connect(hp); hp.connect(lp); lp.connect(analyser);
  vbuf = new Float32Array(analyser.fftSize);
  // …while the recording taps the full-band signal
  tap = new AudioWorkletNode(actx, 'jarvis-tap');
  sink = actx.createGain(); sink.gain.value = 0;     // keeps the graph running, silently
  src.connect(tap); tap.connect(sink); sink.connect(actx.destination);
  tap.port.onmessage = e => onFrame(e.data);
}

function closeMic(){
  if (tap){ tap.port.onmessage = null; try{ tap.disconnect(); }catch(_){} tap = null; }
  if (micStream){ micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (actx){ actx.close().catch(()=>{}); actx = null; }
  analyser = null; sink = null; vbuf = null;
}

function bandRms(){
  analyser.getFloatTimeDomainData(vbuf);
  let s = 0;
  for (let i = 0; i < vbuf.length; i++) s += vbuf[i] * vbuf[i];
  return Math.sqrt(s / vbuf.length);
}

function levels(){
  return {
    enter: Math.max(0.006, noiseFloor * 2.5 + 0.002),   // to start speech
    stay:  Math.max(0.004, noiseFloor * 1.6 + 0.001),   // to remain in speech
  };
}

function learnFloor(rms){
  const a = warmFrames < 15 ? 0.2 : 0.03;              // converge fast at first, then drift slowly
  warmFrames++;
  noiseFloor = Math.min(0.08, noiseFloor * (1 - a) + rms * a);
}

/* learnFloor only sees frames quieter than the speech threshold, so on its own
   the floor can never rise: if the room gets louder (TV, music, a fan), every
   background frame starts a "turn" and the floor stays stuck at the quiet-room
   level. roomLevel() fixes that with minimum statistics: the 15th-percentile
   level of the last ~4 s, whatever the phase. Speech has gaps between words, so
   this percentile tracks the room, not the speaker; steady background lifts it. */
const ROOM_FRAMES = 190;                               // ~4 s of ~21 ms frames
let roomRing = [], roomTick = 0;
function trackRoom(rms){
  roomRing.push(rms); if (roomRing.length > ROOM_FRAMES) roomRing.shift();
  if (++roomTick % 10 || roomRing.length < ROOM_FRAMES / 2) return;
  const p15 = [...roomRing].sort((a, b) => a - b)[Math.floor(roomRing.length * 0.15)];
  if (p15 > noiseFloor) noiseFloor = Math.min(0.08, noiseFloor + (p15 - noiseFloor) * 0.35);
}

function downsample(f32, rate){
  if (rate === OUT_RATE) return f32;
  const ratio = rate / OUT_RATE, n = Math.floor(f32.length / ratio), out = new Float32Array(n);
  let start = 0;
  for (let i = 0; i < n; i++){
    const end = Math.min(f32.length, Math.floor((i + 1) * ratio));
    let s = 0, c = 0;
    for (let j = start; j < end; j++){ s += f32[j]; c++; }
    out[i] = c ? s / c : 0;
    start = end;
  }
  return out;
}

function pushPreroll(pcm){
  preroll.push(pcm); prerollLen += pcm.length;
  const max = OUT_RATE * VAD.PREROLL_MS / 1000;
  while (preroll.length > 1 && prerollLen - preroll[0].length >= max)
    prerollLen -= preroll.shift().length;
}

function meter(rms, enter){
  // live input bar in the reactor subtitle; the speech threshold sits at the midpoint
  const n = Math.max(0, Math.min(14, Math.round(rms / enter * 7)));
  $('#strun').textContent = 'IN ' + '▮'.repeat(n) + '▯'.repeat(14 - n);
}

function onFrame(raw){
  if (!actx || !analyser) return;
  const pcm = downsample(raw, actx.sampleRate);
  const frameMs = raw.length / actx.sampleRate * 1000;
  const rms = bandRms();
  if (phase !== 'speaking') trackRoom(rms);              // the assistant's own voice isn't the room
  const {enter, stay} = levels();
  const t = performance.now();

  if (phase === 'listening'){
    meter(rms, enter);
    if (!inSpeech){
      pushPreroll(pcm);
      if (rms > enter){
        onsetMs += frameMs;
        if (onsetMs >= VAD.ONSET_MS) startSpeech(t, onsetMs);
      } else {
        if (onsetMs > 0) rejectedNoises++;        // a blip shorter than ONSET_MS
        onsetMs = 0;
        learnFloor(rms);
      }
    } else {
      turnBuf.push(pcm);
      if (rms > turnPeak) turnPeak = rms;
      if (rms > stay){ loudAt = t; voicedMs += frameMs; }
      if (t - loudAt > VAD.SILENCE_MS) return finishTurn('silence');
      if (t - turnStart > VAD.MAX_TURN_MS) return finishTurn('max-length');
    }
    return;
  }

  pushPreroll(pcm);
  if (phase === 'speaking' && UI.barge_in){
    // Jarvis's own voice leaking back through the speakers raises echoFloor,
    // so only clearly-louder, sustained speech counts as an interruption.
    const barge = Math.max(enter * 1.8, echoFloor * 2.5 + 0.004);
    if (rms > barge){
      bargeMs += frameMs;
      if (bargeMs >= VAD.BARGE_MS) bargeIn(t);
    } else {
      bargeMs = 0;
      echoFloor = echoFloor * 0.95 + rms * 0.05;
    }
  } else if (rms < enter){
    learnFloor(rms);                                   // idle/busy: keep tracking the room
  }
}

function startSpeech(t, alreadyMs){
  turnPeak = 0;
  inSpeech = true; turnStart = loudAt = t; voicedMs = alreadyMs;
  turnBuf = preroll.slice(); preroll = []; prerollLen = 0;
  log('voice','VOICE','speech detected');
}

function bargeIn(t){
  bargeMs = 0;
  log('voice','VOICE',`barge-in — ${NAME} interrupted`);
  if (stopSpeech) stopSpeech();
  phase = 'listening';
  setState('listening','LISTENING','go ahead…');
  startSpeech(t, VAD.BARGE_MS);
}

function startListening(){
  if (!convo || !micStream) return;
  phase = 'listening'; inSpeech = false; onsetMs = 0; voicedMs = 0; turnBuf = [];
  setState('listening','LISTENING','listening…');
}

// Return to listening after a turn — but never cut across Jarvis speaking
// or a turn that barge-in has already started.
function resumeListening(){
  if (!convo || !micStream || phase === 'speaking') return;
  if (running) return listenDuringRun();         // a task is still going: keep listening, keep showing it
  if (phase !== 'listening') startListening();
  else if (!inSpeech) setState('listening','LISTENING','listening…');
}

function encodeWav(chunks){
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0,'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8,'WAVE');
  w(12,'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, OUT_RATE, true); v.setUint32(28, OUT_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36,'data'); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2){
    const s = Math.max(-1, Math.min(1, c[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], {type:'audio/wav'});
}

// Drop audio-event tags like "(background noise)" and filler-only transcripts.
function cleanTranscript(t){
  const s = String(t || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  // \p{L}: letters in any script, so a Hindi or other non-Latin transcript isn't discarded
  const bare = s.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!bare || /^((uh+|um+|hm+|mm+|ah+|er+|oh)\s?)+$/.test(bare)) return '';
  return s;
}

// Short rising tick the instant your turn ends — "heard you".
function earcon(){
  if (muted || !actx || !UI.earcon) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  o.connect(g); g.connect(actx.destination);
  o.start(t); o.stop(t + 0.15);
}

// ── a sentence that paused mid-way, waiting for its continuation ──
let held = null;
function armedText(said){
  const armed = $('#input').dataset.cmd || '';
  return (armed ? armed + ' ' : '') + said;
}
function sendVoice(said, turn){
  $('#input').value = '';
  log('send','SEND',`auto-sent voice: ${armedText(said)}`);
}
function sendHeld(){
  if (!held) return;
  // you started talking again, or that speech is being transcribed: wait for it
  if (inSpeech || (phase === 'busy' && !running)){ held.timer = setTimeout(sendHeld, 300); return; }
  const {text, turn} = held; held = null;
  sendVoice(text, turn);
  const full = armedText(text); disarm();
  phase = 'busy';
  transmit(full, {turn}).then(resumeListening);
}

async function finishTurn(reason){
  const frames = turnBuf, voiced = voicedMs;
  let turn = newTurn('voice');
  turn.t.speechStart = turnStart; turn.t.lastVoice = loudAt; mark(turn, 'endpoint');
  turn.noise = noiseFloor; turn.peak = turnPeak; turn.rejected = rejectedNoises;
  turnBuf = []; inSpeech = false; onsetMs = 0;
  if (voiced >= VAD.MIN_SPEECH_MS && turn.peak < levels().enter * 1.5){
    rejectedNoises++;
    log('voice','VOICE',`${reason} · ${Math.round(voiced)}ms barely above the room (peak ${turn.peak.toFixed(3)}, floor ${noiseFloor.toFixed(4)}) — ignored as background`);
    return startListening();
  }
  if (voiced < VAD.MIN_SPEECH_MS){
    rejectedNoises++;
    log('voice','VOICE',`${reason} · only ${Math.round(voiced)}ms voiced — ignored`);
    return startListening();
  }
  phase = 'busy';
  earcon();
  const blob = encodeWav(frames);
  mark(turn, 'encoded');
  log('voice','VOICE',`${reason} · ${Math.round(blob.size/1024)}KB speech · floor ${noiseFloor.toFixed(4)}`);
  setState('running','TRANSCRIBING','…');
  const t0 = performance.now();
  try {
    mark(turn, 'sttSent');
    const sttUsed = sttEngine();
    const r = await fetch('/api/listen?engine=' + encodeURIComponent(sttUsed), {method:'POST',
      headers:apiHeaders({'content-type':'audio/wav'}), body:blob}).then(r => r.json());
    mark(turn, 'sttDone'); turn.stt = r.timing || null;
    const text = cleanTranscript(r.text);
    turn.words = text ? text.split(/\s+/).length : 0;
    const ms = Math.round(performance.now() - t0);
    if (r.error){
      // the chosen speech-to-text failed: stop listening and say why; the user decides what to do
      log('error', 'VOICE', `${ENGINE_LABELS[sttUsed]} couldn't transcribe: ${r.error.slice(0, 220)}. `
        + 'Fix it, or choose another option in the Voice menu, then click VOICE.');
      turn.note = 'STT error'; reportTurn(turn);
      flagSelect('#voiceSel');
      stopConvo();
      return;
    }
    if (!text){
      // say what came back, so a loop of empty turns can be diagnosed from the log
      const raw = String(r.text || '').trim();
      const tags = raw.match(/\([^)]*\)|\[[^\]]*\]/g) || [];
      turn.sttResult = !raw ? 'empty' : (tags.length && !raw.replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim() ? 'sound tags' : 'filler');
      log('voice','VOICE', !raw ? `nothing transcribed (${Math.round(blob.size/1024)}KB, peak ${turn.peak.toFixed(3)})`
        : `no words — heard only ${tags.length ? tags.slice(0, 3).join(' ') : `"${raw.slice(0, 40)}"`}`);
      emptyStreak++;
      if (emptyStreak === 3)
        log('note', 'VOICE', `3 turns in a row had no words: background sound is starting turns. `
          + `Room level ${noiseFloor.toFixed(4)} — the detector is adjusting; a quieter room or a headset mic helps.`);
      turn.note = 'nothing transcribed';
      reportTurn(turn);
    } else if (pendingPerm){
      log('voice','VOICE',`transcribed by ${ENGINE_LABELS[sttUsed]} in ${ms}ms: "${text}"`);
      if (answerPermissionByVoice(text)){
        turn.note = 'approval answer'; reportTurn(turn);
        phase = 'busy'; setState('running', 'RUNNING', 'continuing…');
        return;                                 // the paused run carries on
      }
      log('voice','VOICE','approval pending — say "yes" or "no"');
      return startListening();
    } else if (running && new RegExp(`^(hey )?(${NAME}|jarvis)?[,.!\\s]*(stop|cancel|abort|never ?mind|stop (it|that))[.!]?$`, 'i').test(text.trim())){
      emptyStreak = 0;
      log('voice','VOICE',`heard "${text}" — stopping the task`);
      turn.note = 'stop command'; reportTurn(turn);
      cancelRun();
    } else {
      emptyStreak = 0;
      unflagSelect('#voiceSel');
      log('voice','VOICE',`transcribed by ${ENGINE_LABELS[sttUsed]} in ${ms}ms: "${text}"`);
      let said = text;
      if (held){                                // the rest of a sentence that paused mid-way
        said = held.text + ' ' + text; clearTimeout(held.timer); held = null;
      }
      // Speech-to-text ends a finished sentence with . ? or !; without one you probably
      // paused mid-thought. Wait a moment for the rest instead of acting on half a request.
      if (!running && UI.hold_unfinished_ms > 0 && !/[.?!…]["'”’)\]]*$/.test(said) && said.split(/\s+/).length < 40){
        held = {text: said, turn, timer: setTimeout(sendHeld, UI.hold_unfinished_ms)};
        log('voice','VOICE','sounds unfinished — listening for the rest');
        return startListening();
      }
      const full = armedText(said);
      sendVoice(said, turn); disarm();
      await transmit(full, {turn});  // runs, then speaks (interruptible)
    }
  } catch(e){
    log('error','VOICE','transcription failed');
    turn.note = 'transcription failed'; reportTurn(turn);
  }
  resumeListening();
}

// ── voice choice: one menu on the HUD sets both directions ──
//   ElevenLabs        → ElevenLabs Scribe listens, ElevenLabs speaks
//   Kokoro + Whisper  → faster-whisper listens, Kokoro speaks (both on your machine)
//   Browser           → the browser's own recognition and voice
// Nothing switches automatically. If the chosen engines fail, the log says
// exactly why and the menu turns red; you choose another option yourself.
const VOICE = {provider: 'elevenlabs', providers: {}};
const VOICE_LABELS = {elevenlabs:'ElevenLabs', kokoro:'Kokoro + Whisper', browser:'Browser'};
const ENGINE_LABELS = {elevenlabs:'ElevenLabs', whisper:'Whisper', kokoro:'Kokoro', browser:'browser'};
const sttEngine = () => ({elevenlabs:'elevenlabs', kokoro:'whisper'})[VOICE.provider] || 'browser';
const ttsEngine = () => ({elevenlabs:'elevenlabs', kokoro:'kokoro'})[VOICE.provider] || 'browser';

function flagSelect(sel){
  const el = $(sel); if (!el) return;
  el.style.borderColor = 'var(--red)'; el.style.color = 'var(--red)';
}
function unflagSelect(sel){
  const el = $(sel); if (!el) return;
  el.style.borderColor = ''; el.style.color = '';
}

function updateVoiceLabels(){
  RT.stt = sttEngine() !== 'browser';         // server-side listening (with barge-in) vs browser
  const txt = `${ENGINE_LABELS[sttEngine()]} STT / ${ENGINE_LABELS[ttsEngine()]} TTS`;
  $('#top-voice') && ($('#top-voice').textContent = 'Voice: ' + txt);
  sys('voice', txt);
  if (!convo) $('#mic').textContent = `◉ ${VOICE.provider === 'kokoro' ? 'Local' : VOICE_LABELS[VOICE.provider]} Voice`;
}

function renderVoiceSelect(){
  const sel = $('#voiceSel'); if (!sel) return;
  const names = ['elevenlabs', 'kokoro'].concat(SpeechRecognition || speechSynth ? ['browser'] : []);
  sel.innerHTML = names.map(n => {
    const st = VOICE.providers[n];
    const off = st && !st.ok ? ' (off)' : '';
    return `<option value="${n}"${VOICE.provider === n ? ' selected' : ''}>🎙 ${VOICE_LABELS[n]}${off}</option>`;
  }).join('');
  sel.title = 'Voice (listen + speak)\n' + Object.entries(VOICE.providers).map(([n, v]) =>
    `${VOICE_LABELS[n]}: listen ${v.listen.ok ? 'ready' : 'off'} (${v.listen.detail}); speak ${v.speak.ok ? 'ready' : 'off'} (${v.speak.detail})`).join('\n');
  updateVoiceLabels();
}

function refreshVoice(){
  return fetch('/api/voice').then(r => r.json()).then(j => { VOICE.providers = j.providers || {}; renderVoiceSelect(); }).catch(() => {});
}

// ── voice out ──
function speak(text, turn = null){
  return new Promise(resolve => {
    text = cleanForSpeech(text);
    if (muted || !text) return resolve();
    const cap = Math.max(80, Number(UI.max_spoken_chars) || 700);
    const spoken = text.length > cap ? text.slice(0, cap - 20).replace(/\s+\S*$/,'') + '…' : text;

    let finished = false;
    const finish = interrupted => {
      if (finished) return;
      finished = true;
      if (turn){ mark(turn, 'spoken'); turn.interrupted = interrupted; }
      if (stopSpeech === stop) stopSpeech = null;
      document.body.classList.remove('speaking');
      if (!interrupted && phase === 'speaking') (running ? listenDuringRun() : startListening());
      resolve();
    };
    const stop = () => {
      finish(true);
      if (player){ try{ player.pause(); }catch(_){} }
      if (speechSynth){ try{ speechSynth.cancel(); }catch(_){} }
    };
    if (stopSpeech) stopSpeech();               // never two voices at once
    stopSpeech = stop;

    // Keep listening while he talks, so you can interrupt him.
    if (convo && micStream){ phase = 'speaking'; bargeMs = 0; echoFloor = Math.max(noiseFloor, 0.004); }
    mark(turn, 'ttsStart');

    const viaBrowser = () => {
      if (!speechSynth) return finish(false);
      if (turn) turn.ttsEngine = 'browser';
      try{
        speechSynth.cancel();
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 0.95; u.pitch = 0.82; u.volume = 1;
        document.body.classList.add('speaking');
        mark(turn, 'ttsReady');
        u.onstart = () => mark(turn, 'playing');
        u.onend = u.onerror = () => finish(false);
        speechSynth.speak(u);
      }catch(_){ finish(false); }
    };
    const engine = ttsEngine();
    if (engine === 'browser') return viaBrowser();
    fetch('/api/speak', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
                         body: JSON.stringify({text:spoken, engine})})
      .then(r => {
        if (turn) turn.ttsMs = Number(r.headers.get('x-jarvis-tts-ms')) || null;
        if (!r.ok) return r.json().catch(() => ({})).then(j => Promise.reject(new Error(j.error || `HTTP ${r.status}`)));
        if (turn) turn.ttsEngine = r.headers.get('x-jarvis-tts-engine') || engine;
        unflagSelect('#voiceSel');
        return r.blob();
      })
      .then(blob => {
        mark(turn, 'ttsReady');
        if (finished) return;                   // interrupted before audio arrived
        const url = URL.createObjectURL(blob);
        if (player) player.pause();
        player = new Audio(url);
        document.body.classList.add('speaking');
        const done = () => { URL.revokeObjectURL(url); finish(false); };
        player.onended = done; player.onerror = done;
        return player.play().then(() => mark(turn, 'playing'));
      })
      .catch(e => {
        if (finished) return;
        // the chosen engine failed: stay silent, show why, let the user choose another
        log('error', 'TTS', `${ENGINE_LABELS[engine]} couldn't speak: ${String(e.message || e).slice(0, 220)}. `
          + 'The answer is on screen; choose another option in the Voice menu if this keeps happening.');
        if (turn) turn.note = turn.note || `TTS failed (${engine})`;
        flagSelect('#voiceSel');
        refreshVoice();
        finish(false);
      });
  });
}

// ── start / stop the whole conversation ──
async function micToggle(){
  if (convo){ stopConvo(); return; }
  // Prefer ElevenLabs server-side STT when configured. Browser STT is unreliable
  // across Chrome profiles and often fails silently.
  if (RT.stt){
    try { await openMic(); }
    catch(e){
      closeMic();
      log('error','VOICE', e?.name === 'NotAllowedError'
        ? 'mic blocked — allow it in the address bar'
        : `mic failed: ${String(e).slice(0,140)}`);
      return;
    }
    convo = true;
    $('#mic').classList.add('on'); $('#mic').textContent = `● ${ENGINE_LABELS[sttEngine()]} Live`;
    log('voice','VOICE',`${VOICE_LABELS[VOICE.provider]} voice conversation open · listening with ${ENGINE_LABELS[sttEngine()]}`
      + `${UI.barge_in ? ` · speak over ${NAME} to interrupt` : ''}`);
    startListening();
    return;
  }
  if (SpeechRecognition){
    convo = true;
    $('#mic').classList.add('on'); $('#mic').textContent = '● Browser Live';
    log('voice','VOICE','browser speech recognition open · listening');
    setState('listening','LISTENING','browser speech online');
    startBrowserRecognition();
    return;
  }
  log('error','VOICE','this browser has no speech recognition — choose ElevenLabs or Kokoro + Whisper in the Voice menu');
}

function stopConvo(){
  convo = false; phase = 'idle';
  inSpeech = false; turnBuf = []; preroll = []; prerollLen = 0;
  if (recognition){ try{ recognition.onend = null; recognition.stop(); }catch(_){} recognition = null; }
  if (stopSpeech) stopSpeech();
  closeMic();
  document.body.classList.remove('speaking');
  $('#mic').classList.remove('on'); updateVoiceLabels();
  log('voice','VOICE','conversation closed');
  setState('', 'STANDBY', 'awaiting uplink');
}

// ── browser speech turn (the "Browser" voice choice) ──
function startBrowserRecognition(){
  if (!convo || !SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.lang = UI.browser_language || navigator.language || 'en-GB';
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = '';
  recognition.onresult = e => {
    let interim = '';
    for (let i=e.resultIndex; i<e.results.length; i++){
      const txt = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += txt;
      else interim += txt;
    }
    const shown = (finalText || interim || '').trim();
    if (shown) $('#strun').textContent = 'HEARD: ' + shown.slice(0,42);
  };
  recognition.onerror = e => log('error','VOICE',`browser speech: ${e.error || 'error'}`);
  recognition.onend = async () => {
    const text = cleanTranscript(finalText);
    if (!convo) return;
    if (!text){ setTimeout(startBrowserRecognition, 250); return; }
    log('voice','VOICE',`browser transcribed: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);
    if (convo) setTimeout(startBrowserRecognition, 350);
  };
  setState('listening','LISTENING','browser speech online');
  try{ recognition.start(); }catch(e){ log('error','VOICE','speech recognition failed to start'); }
}

// ══════════ command matrix ══════════
function disarm(){
  document.querySelectorAll('.cmd').forEach(c=>c.classList.remove('armed'));
  $('#input').dataset.cmd = '';
}
const PAYLOAD_COMMANDS = new Set(['/goal','/browser','/background','/mission','/personality']);
$('#cmds').addEventListener('click', e => {
  const b = e.target.closest('.cmd'); if (!b) return;
  const cmd = b.dataset.cmd;
  if (running){
    log('note','BUSY',`${cmd} not sent — ${NAME} is still working.`);
    return;
  }

  // Every matrix button executes its base command immediately. Commands that
  // accept an argument remain armed afterwards so the next typed or spoken
  // payload is sent as `/command payload`.
  disarm();
  if (PAYLOAD_COMMANDS.has(cmd)){
    b.classList.add('armed');
    $('#input').dataset.cmd = cmd;
    $('#input').focus();
    $('#tip').textContent = `${TIPS[cmd] || cmd} The command is live and remains armed for your next payload.`;
  } else {
    $('#tip').textContent = defaultTip;
  }
  log('command', 'COMMAND', `executing ${cmd} on Hermes backend`);
  transmit(cmd, {speak: !['/tools','/commands'].includes(cmd)});
});
const TIPS = {
  '/new':'Fresh thread — clears the Hermes conversation and starts clean.',
  '/goal':'Say your standing objective, e.g. “ship the dashboard and verify tool access”.',
  '/tools':'Shows Hermes tool status from the active profile.',
  '/toolsets':'Asks Hermes to list enabled toolsets and connected tools.',
  '/browser':'Say a Chrome/browser mission, e.g. “inspect the current tab”.',
  '/background':'Say a mission, e.g. “research competitors and save a report”.',
  '/mission':'Add or read mission queue items.',
  '/personality':'Set the persona, e.g. “calm, laconic, Stark tower operator”.',
  '/kanban':'Ask about the work queue, e.g. “what’s on my board today?”.',
  '/commands':'Show all dashboard slash commands.'
};
let defaultTip = '';

// ══════════ controls ══════════
function sendFromInput(){
  const armed = $('#input').dataset.cmd || '';
  const raw = $('#input').value.trim();
  if (!raw && !armed) return;
  const full = (armed && !raw.startsWith('/')) ? `${armed} ${raw}` : (raw || armed);
  $('#input').value = ''; disarm(); $('#tip').textContent = defaultTip;
  log('send','SEND',`transmit: ${full}`);
  transmit(full);
}
$('#run').onclick = sendFromInput;
$('#mic').onclick = micToggle;
$('#showCommands').onclick = () => transmit('/commands', {speak:false});
$('#missionBtn').onclick = () => transmit('/mission');
$('#clearBtn').onclick = () => { answer=''; $('#response').innerHTML='<span class="rplaceholder">Display cleared. Standing by.</span>'; log('note','CLEAR','response panel cleared'); };
document.querySelectorAll('[data-quick]').forEach(b => b.onclick = () =>
  transmit(b.dataset.quick, {speak:false}));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (cancelRun()) return;
  if (convo) stopConvo();
});
$('#voiceSel') && ($('#voiceSel').onchange = e => {
  const wasLive = convo;
  if (wasLive) stopConvo();                   // listening differs per choice; restart cleanly
  VOICE.provider = e.target.value; unflagSelect('#voiceSel');
  try { localStorage.setItem('assistant.voice', VOICE.provider); } catch(_){}
  renderVoiceSelect();
  const st = VOICE.providers[VOICE.provider];
  log('voice', 'VOICE', `voice → ${VOICE_LABELS[VOICE.provider]} (listen: ${ENGINE_LABELS[sttEngine()]}, speak: ${ENGINE_LABELS[ttsEngine()]})`
    + (st && !st.ok ? ` · warning: ${!st.listen.ok ? st.listen.detail : st.speak.detail}` : '')
    + (wasLive ? ' · click VOICE to start again' : ''));
});
$('#mute').onclick = () => {
  muted = !muted; const b=$('#mute');
  b.textContent = muted?'🔇':'🔊'; b.classList.toggle('on',!muted); b.classList.toggle('off',muted);
  if (muted && stopSpeech){
    stopSpeech();
    if (convo && micStream && phase === 'speaking') startListening();
  }
};
$('#input').addEventListener('keydown', e => {
  // Enter sends; Shift+Enter adds a new line. Ignored mid-composition (IME input).
  if (e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); sendFromInput(); }
});

// ══════════ system panel ══════════
function sys(id, val, cls){
  const el = $('#sy-' + id); if (!el) return;
  el.textContent = val; if (cls != null) el.className = cls;
}
// live clock in the system panel
setInterval(() => sys('clock', now()), 1000);

// poll for finished /background missions and report them when they land
setInterval(async () => {
  try {
    const j = await fetch('/api/jobs', {headers:apiHeaders()}).then(r => r.json());
    for (const d of (j.done || [])){
      log('complete','MISSION', `${d.mission} → ${(d.result||'').slice(0,200)}`);
      // don't talk over you, or over a turn being transcribed
      if (!running && phase !== 'busy' && !inSpeech) speak(`Mission complete. ${(d.result||'').slice(0,300)}`);
    }
  } catch(_){}
}, 4000);

// ══════════ boot ══════════
(async () => {
  defaultTip = $('#tip').textContent;
  try {
    const s = await fetch('/api/status').then(r=>r.json());
    VOICE.providers = s.voice_providers || {};
    let saved = ''; try { saved = localStorage.getItem('assistant.voice') || ''; } catch(_){}
    VOICE.provider = VOICE_LABELS[saved] ? saved : (VOICE_LABELS[s.voice_default] ? s.voice_default : 'elevenlabs');
    renderVoiceSelect();
    setInterval(refreshVoice, 30000);
    if (s.ui){
      NAME = s.ui.name || NAME;
      UI = {...UI, ...s.ui};
      Object.assign(VAD, s.ui.vad || {});      // listening timings from assistant.yaml
    }
    RT.browserStt = !!SpeechRecognition; RT.browserTts = !!speechSynth;

    const port = location.port || '8730';
    sys('gw', `online · :${port}`, 'ok');
    sys('brain', s.runtime === 'hermes' ? 'Hermes Agent' : 'Hermes offline', s.runtime === 'hermes' ? 'ok' : 'warn');

    sys('profile', s.profile || 'default');
    sys('runtime', s.runtime === 'hermes' ? (s.hermes_mode || 'hermes').split(' ')[0] : (s.runtime || '—'), s.runtime === 'hermes' ? 'ok' : 'warn');
    sys('clock', now());
    $('#top-gw').textContent = `Gateway: online ${location.origin}`;
    $('#top-profile').textContent = 'Profile: ' + (s.profile || 'default');
    const tools = (s.tools || []).slice(0, 12);
    $('#toolsList').innerHTML = tools.length ? tools.map(t => `<span class="chip">${esc(t)}</span>`).join('') : '<span class="chip ghost">Hermes tool list unavailable — set HERMES_CMD if needed</span>';

    fetch('/api/timings?limit=20', {headers:apiHeaders()}).then(r => r.json()).then(j => {
      const recs = j.records || [], last = recs[recs.length - 1];
      if (!last) return;
      // seed the rolling median with the earlier turns; updateStrip adds the last one
      recentHeadlines = recs.slice(0, -1).map(r => r.headline_ms).filter(v => typeof v === 'number');
      updateStrip(null, typeof last.headline_ms === 'number' ? last.headline_ms : null, Object.entries(last.stages || {}));
    }).catch(() => {});
    log('status', 'BOOT',
        `gateway online · ${s.runtime} core · profile=${s.profile || 'default'} · permission=${s.permission}`);
    log('voice', 'VOICE', `voice: ${VOICE_LABELS[VOICE.provider]} · `
      + Object.entries(VOICE.providers).map(([k, v]) => `${VOICE_LABELS[k]} ${v.ok ? 'ready' : 'off'}`).join(' · '));
    updateVoiceLabels();
    setState('', 'STANDBY', 'awaiting uplink');
  } catch(e){
    sys('gw','offline','warn');
    log('error','STATUS','server unreachable');
  }
})();