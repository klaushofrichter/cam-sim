<script lang="ts">
  import TriggerBar from '../components/TriggerBar.svelte';
  import { api, ApiError } from '../lib/api';
  import { simState, feed, type RequestRecord } from '../lib/state';

  // The faults of src/engine/faults.ts, with the parameters each takes.
  const FAULTS: Array<{ name: string; label: string; params: Array<'ms' | 'count' | 'cmds' | 'rspCode'> }> = [
    { name: 'downloads.refuse', label: 'Every Download resets (like the real camera since 2026-09-26)', params: [] },
    { name: 'downloads.dropFirst', label: 'The next N Downloads reset', params: ['count'] },
    { name: 'downloads.dropMidway', label: 'Download bodies are cut part-way', params: [] },
    { name: 'downloads.delayMs', label: 'Wait before sending a Download body', params: ['ms'] },
    { name: 'flv.reset', label: 'Every live stream connection resets', params: [] },
    { name: 'flv.delayMs', label: 'Delay the live stream response', params: ['ms'] },
    { name: 'search.delayMs', label: 'Slower Search (wider -54 window)', params: ['ms'] },
    { name: 'settings.fail', label: 'These Set commands fail', params: ['cmds', 'rspCode'] },
    { name: 'settings.ignore', label: 'These Set commands answer 200 and change nothing', params: ['cmds'] },
    { name: 'settings.strictPartial', label: "Partial writes' resets show at once", params: [] },
    { name: 'offline', label: 'Offline: every camera connection is dropped', params: [] },
    { name: 'latencyMs', label: 'Delay every camera request', params: ['ms'] },
    { name: 'snap.fail', label: 'Snap answers 500', params: [] },
    { name: 'ftp.fail', label: 'FTP uploads and TestFtp fail (-454)', params: [] },
    { name: 'ftp.delayMs', label: 'Wait before each FTP upload', params: ['ms'] },
    { name: 'rtsp.refuse', label: 'RTSP refuses every reader', params: [] },
    { name: 'rtsp.reset', label: 'RTSP cuts connected readers and refuses new ones', params: [] },
  ];
  let params = $state<Record<string, { ms: number; count: number; cmds: string; rspCode: number }>>(
    Object.fromEntries(FAULTS.map((f) => [f.name, { ms: 1000, count: 1, cmds: 'SetWhiteLed', rspCode: -67 }])),
  );
  let message = $state('');
  let bootMs = $state(1000);
  let paused = $state(false);

  const active = (name: string) => $simState?.faults.find((f) => f.name === name);
  const power = $derived($simState ? ($simState.rebooting ? 'rebooting' : $simState.power) : '…');

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      message = `${label}: done`;
    } catch (e) {
      message = `${label}: ${e instanceof ApiError ? JSON.stringify(e.body) : 'failed'}`;
    }
  }

  async function toggle(f: (typeof FAULTS)[number], box: HTMLInputElement) {
    await toggleFault(f);
    // The box shows the fault's real state, also when the API refused the change
    // (the SSE state update may not come, or come later).
    box.checked = !!(await api<Array<{ name: string }>>('GET', '/faults').catch(() => [])).find((x) => x.name === f.name);
  }

  async function toggleFault(f: (typeof FAULTS)[number]) {
    if (active(f.name)) return run(`${f.name} off`, () => api('DELETE', `/faults/${f.name}`));
    const p = params[f.name];
    const body: Record<string, unknown> = {};
    if (f.params.includes('ms')) body.ms = Number(p.ms);
    if (f.params.includes('count')) body.count = Number(p.count);
    if (f.params.includes('cmds')) body.cmds = p.cmds.split(',').map((s) => s.trim()).filter(Boolean);
    if (f.params.includes('rspCode')) body.rspCode = Number(p.rspCode);
    return run(`${f.name} on`, () => api('PUT', `/faults/${f.name}`, body));
  }

  const powerOff = () => {
    if (confirm('Power the simulated camera off? Every connection drops until you power it on.')) void run('Power off', () => api('POST', '/actions/power-off'));
  };
  const reset = (what: Record<string, boolean>, label: string) => {
    if (!what.everything || confirm('Reset settings, recordings, counters and faults?')) void run(label, () => api('POST', '/reset', what.everything ? {} : what));
  };

  let frozen = $state<typeof $feed>([]);
  $effect(() => {
    if (!paused) frozen = $feed;
  });
  const rows = $derived(frozen.filter((f) => f.kind === 'request' || f.kind === 'event'));
  const counters = $derived(Object.entries($simState?.counters ?? {}).filter(([, v]) => typeof v === 'number'));
</script>

<section>
  <h2>Simulator</h2>
  {#if message}<p class="msg" role="status">{message}</p>{/if}
  <div class="grid">
    <div class="card">
      <h3>Power</h3>
      <p class="power">State: <strong data-testid="power-state" class={power}>{power}</strong></p>
      <div class="buttons">
        <button data-testid="power-off" disabled={power !== 'on'} onclick={powerOff}>Power off</button>
        <button data-testid="power-on" disabled={power !== 'off'} onclick={() => void run('Power on', () => api('POST', '/actions/power-on', { ms: Number(bootMs) }))}>Power on</button>
        <button data-testid="reboot" disabled={power !== 'on'} onclick={() => void run('Reboot', () => api('POST', '/actions/reboot', { ms: Number(bootMs) }))}>Reboot</button>
      </div>
      <label class="row">Boot time <span><input type="number" min="0" max="600000" step="100" bind:value={bootMs} data-testid="boot-ms" /> ms</span></label>
      <p class="muted small">Power off: connections drop, sessions end, the recording in progress closes. Power on and reboot: a new serial, and the saved settings take effect.</p>
    </div>

    <div class="card">
      <h3>Events</h3>
      <TriggerBar />
      <p class="muted small">Recorded when recording is on and the schedule allows the type. AI types also set motion.</p>
      <h3>Video</h3>
      <select disabled><option>Test pattern</option></select>
      <p class="muted small">The video library arrives with Plan 2.</p>
    </div>

    <div class="card wide">
      <h3>Faults</h3>
      <ul class="faults">
        {#each FAULTS as f (f.name)}
          {@const on = active(f.name)}
          <li data-testid="fault-{f.name}" class:on>
            <label class="switch"><input type="checkbox" checked={!!on} onchange={(e) => void toggle(f, e.currentTarget)} data-testid="fault-toggle" /> <span class="mono">{f.name}</span></label>
            <span class="desc">{f.label}{#if on?.count !== undefined} · {on.count} left{/if}</span>
            <span class="params">
              {#if f.params.includes('ms')}<input type="number" min="0" bind:value={params[f.name].ms} disabled={!!on} aria-label="{f.name} ms" /> ms{/if}
              {#if f.params.includes('count')}<input type="number" min="1" bind:value={params[f.name].count} disabled={!!on} aria-label="{f.name} count" /> times{/if}
              {#if f.params.includes('cmds')}<input class="cmds" bind:value={params[f.name].cmds} disabled={!!on} aria-label="{f.name} commands" />{/if}
              {#if f.params.includes('rspCode')}<input type="number" bind:value={params[f.name].rspCode} disabled={!!on} aria-label="{f.name} rspCode" />{/if}
            </span>
          </li>
        {/each}
      </ul>
      <div class="buttons"><button onclick={() => void run('Faults cleared', () => api('DELETE', '/faults'))}>Clear all faults</button></div>
    </div>

    <div class="card">
      <h3>Actions</h3>
      <div class="buttons col">
        <button onclick={() => void run('Sessions revoked', () => api('POST', '/actions/tokens.revoke'))}>Revoke all camera sessions</button>
        <button onclick={() => void run('Live streams dropped', () => api('POST', '/actions/flv.dropActive'))}>Drop live streams</button>
        <button onclick={() => void run('Downloads dropped', () => api('POST', '/actions/downloads.dropActive'))}>Drop downloads in flight</button>
      </div>
      <h3>Reset</h3>
      <div class="buttons">
        <button onclick={() => reset({ settings: true }, 'Settings reset')}>Settings</button>
        <button onclick={() => reset({ recordings: true }, 'Recordings cleared')}>Recordings</button>
        <button onclick={() => reset({ counters: true }, 'Counters reset')}>Counters</button>
        <button onclick={() => reset({ faults: true }, 'Faults cleared')}>Faults</button>
        <button class="danger" onclick={() => reset({ everything: true }, 'Everything reset')}>Everything</button>
      </div>
    </div>

    <div class="card">
      <h3>Counters</h3>
      <dl>{#each counters as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
      {#if $simState}<p class="muted small">SD card: {$simState.sd.recordings} recordings, {$simState.sd.usedMb} of {$simState.sd.capacityMb} MB.</p>{/if}
    </div>

    <div class="card wide">
      <div class="loghead"><h3>Live log</h3><button onclick={() => (paused = !paused)} data-testid="log-pause">{paused ? 'Resume' : 'Pause'}</button></div>
      <div class="log">
        <table>
          <thead><tr><th>Time</th><th>What</th><th>Detail</th><th>Status</th></tr></thead>
          <tbody>
            {#each rows as r, i (i)}
              {#if r.kind === 'request'}
                {@const q = r.data as RequestRecord}
                <tr data-testid="log-row"><td class="mono">{new Date(q.at).toLocaleTimeString()}</td><td>{q.method} {q.port}</td><td class="mono">{q.cmd || q.path}</td><td class:bad={q.status === 0 || q.status >= 400}>{q.status || 'dropped'} · {q.ms} ms</td></tr>
              {:else}
                {@const ev = r.data as { at: string; type: string; durationS: number; recordingId: string | null }}
                <tr data-testid="log-row" class="event"><td class="mono">{new Date(ev.at).toLocaleTimeString()}</td><td>event</td><td>{ev.type} {ev.durationS} s</td><td>{ev.recordingId ? 'recorded' : 'not recorded'}</td></tr>
              {/if}
            {:else}
              <tr><td colspan="4" class="muted">Camera requests and events appear here as they happen.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</section>

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 4px 0 6px; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; }
  .wide { grid-column: 1 / -1; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  .buttons.col { flex-direction: column; align-items: stretch; }
  button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.danger { color: var(--danger); }
  .power strong { text-transform: uppercase; }
  .power .on { color: #22c55e; } .power .off { color: var(--danger); } .power .booting, .power .rebooting { color: #f59e0b; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  input[type='number'], .cmds { width: 90px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); }
  .cmds { width: 160px; }
  .faults { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .faults li { display: grid; grid-template-columns: minmax(230px, auto) 1fr auto; gap: 10px; align-items: center; padding: 6px 8px; border-radius: 8px; }
  .faults li.on { background: color-mix(in srgb, var(--danger) 12%, var(--surface-2)); }
  @media (max-width: 800px) { .faults li { grid-template-columns: 1fr; } }
  .switch { display: inline-flex; gap: 8px; align-items: center; cursor: pointer; }
  .desc { color: var(--muted); font-size: 14px; }
  .params { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; font-family: var(--mono); text-align: right; }
  .loghead { display: flex; justify-content: space-between; align-items: center; }
  .log { max-height: 360px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 600; position: sticky; top: 0; background: var(--surface); }
  td, th { padding: 4px 8px; border-bottom: 1px solid var(--border); }
  tr.event td { color: var(--accent); }
  .bad { color: var(--danger); }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  .msg { margin: 0; color: var(--accent); }
</style>
