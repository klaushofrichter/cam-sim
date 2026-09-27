<script lang="ts">
  import { api, ApiError } from '../lib/api';

  type Obj = Record<string, any>;
  interface All {
    settings: { Rec: Obj; MdAlarm: Obj; AiAlarm: Record<string, Obj>; Isp: Obj; IrLights: Obj; WhiteLed: Obj; Osd: Obj; NetPort: Obj };
    devInfo: Obj;
    hddInfo: Obj[];
    enc: Obj;
    certificate: { source: string; enable: number };
  }

  let all = $state<All | null>(null);
  let users = $state<Array<{ userName: string; level: string }>>([]);
  let loadError = $state('');
  // Per card: '', 'Saving…', 'Saved', or an error.
  let saveState = $state<Record<string, string>>({});

  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const ALL = '1'.repeat(168), NONE = '0'.repeat(168);
  const SCHED = [['MD', 'Motion'], ['AI_PEOPLE', 'People'], ['AI_VEHICLE', 'Vehicles'], ['AI_DOG_CAT', 'Pets']] as const;
  const POSITIONS = ['Upper Left', 'Top Center', 'Upper Right', 'Lower Left', 'Bottom Center', 'Lower Right'];
  const AI = [['people', 'People'], ['vehicle', 'Vehicles'], ['dog_cat', 'Pets']] as const;

  // Local editable copies, reset from each load.
  let rec = $state<Obj>({}), md = $state<Obj>({}), ai = $state<Record<string, Obj>>({}), isp = $state<Obj>({}), ir = $state<Obj>({}), wl = $state<Obj>({}), osd = $state<Obj>({}), net = $state<Obj>({});
  let schedule = $state<Record<string, 'on' | 'off' | 'custom'>>({});

  async function load() {
    try {
      const a = await api<All>('GET', '/settings');
      all = a;
      const s = a.settings;
      rec = clone(s.Rec); md = clone(s.MdAlarm); ai = clone(s.AiAlarm); isp = clone(s.Isp); ir = clone(s.IrLights); wl = clone(s.WhiteLed); osd = clone(s.Osd); net = clone(s.NetPort);
      schedule = Object.fromEntries(SCHED.map(([k]) => [k, rec.schedule.table[k] === ALL ? 'on' : rec.schedule.table[k] === NONE ? 'off' : 'custom']));
      users = await api('GET', '/users');
      loadError = '';
    } catch {
      loadError = 'Settings could not be loaded.';
    }
  }
  void load();

  async function save(card: string, writes: Array<[string, Obj]>) {
    saveState[card] = 'Saving…';
    try {
      for (const [path, body] of writes) await api('PUT', `/settings/${path}`, body);
      saveState[card] = 'Saved';
      await load();
    } catch (e) {
      const rsp = e instanceof ApiError ? (e.body as { rspCode?: number } | null)?.rspCode : undefined;
      saveState[card] = rsp !== undefined ? `Rejected by the camera (rspCode ${rsp})` : 'Not saved';
    }
  }

  const saveRecording = () => {
    const r = clone(rec);
    for (const [k] of SCHED) if (schedule[k] !== 'custom') r.schedule.table[k] = schedule[k] === 'on' ? ALL : NONE;
    return save('recording', [['Rec', r]]);
  };
  const sens = {
    get: () => 51 - Number(md.newSens?.sensDef ?? 25),
    set: (v: number) => (md.newSens.sensDef = 51 - v),
  };
  const mb = (n: number) => `${(n / 1024).toFixed(1)} GB`;
</script>

{#snippet state(card: string)}
  <span class="state" class:bad={saveState[card] && !['Saved', 'Saving…'].includes(saveState[card])} data-testid="save-{card}-state">{saveState[card] ?? ''}</span>
{/snippet}

<section>
  <h2>Settings</h2>
  <p class="muted">What the camera's own settings pages would show. Each card writes whole objects through the camera's validation, so the saved and running values stay equal.</p>
  {#if loadError}<p class="err">{loadError}</p>{/if}
  {#if all}
    <div class="grid">
      <div class="card">
        <h3>Recording</h3>
        <label class="row"><input type="checkbox" checked={rec.enable === 1} onchange={(e) => (rec.enable = e.currentTarget.checked ? 1 : 0)} data-testid="rec-enable" /> Record events</label>
        {#each SCHED as [k, label] (k)}
          <label class="row">{label}
            <select bind:value={schedule[k]} data-testid="sched-{k}">
              <option value="on">always</option><option value="off">never</option>
              {#if schedule[k] === 'custom'}<option value="custom">custom schedule (kept)</option>{/if}
            </select>
          </label>
        {/each}
        <p class="muted small">Post-record {rec.postRec}, kept {rec.saveDay} days.</p>
        <div class="actions"><button onclick={() => void saveRecording()} data-testid="save-recording">Save</button>{@render state('recording')}</div>
      </div>

      <div class="card">
        <h3>Detection</h3>
        <label class="stack"><span class="row">Motion sensitivity <span class="val">{sens.get()}</span></span>
          <input type="range" min="1" max="50" value={sens.get()} oninput={(e) => sens.set(Number(e.currentTarget.value))} data-testid="md-sens" /></label>
        {#each AI as [t, label] (t)}
          <label class="stack"><span class="row">{label} <span class="val">{ai[t].sensitivity}</span></span>
            <input type="range" min="0" max="100" bind:value={ai[t].sensitivity} data-testid="ai-{t}" /></label>
        {/each}
        <div class="actions">
          <button data-testid="save-detection" onclick={() => void save('detection', [['MdAlarm', md], ...AI.map(([t]) => [`AiAlarm/${t}`, ai[t]] as [string, Obj])])}>Save</button>{@render state('detection')}
        </div>
      </div>

      <div class="card">
        <h3>Image and lights</h3>
        <label class="row">Day/night
          <select bind:value={isp.dayNight} data-testid="isp-daynight"><option value="Auto">Auto</option><option value="Color">Colour</option><option value="Black&White">Black and white</option></select>
        </label>
        <label class="row">Infrared <select bind:value={ir.state} data-testid="ir-state"><option value="Auto">Auto</option><option value="Off">Off</option></select></label>
        <label class="row">Spotlight
          <select bind:value={wl.mode} data-testid="wl-mode"><option value={0}>Off</option><option value={1}>On motion at night</option><option value={2}>On at night</option><option value={3}>Schedule</option></select>
        </label>
        <label class="stack"><span class="row">Brightness <span class="val">{wl.bright}</span></span>
          <input type="range" min="0" max="100" bind:value={wl.bright} data-testid="wl-bright" /></label>
        <div class="actions"><button data-testid="save-image" onclick={() => void save('image', [['Isp', isp], ['IrLights', ir], ['WhiteLed', wl]])}>Save</button>{@render state('image')}</div>
      </div>

      <div class="card">
        <h3>On-screen text</h3>
        <label class="row"><input type="checkbox" checked={osd.osdChannel.enable === 1} onchange={(e) => (osd.osdChannel.enable = e.currentTarget.checked ? 1 : 0)} /> Camera name</label>
        <input class="text" bind:value={osd.osdChannel.name} data-testid="osd-name" />
        <label class="row">Name position <select bind:value={osd.osdChannel.pos}>{#each POSITIONS as p (p)}<option>{p}</option>{/each}</select></label>
        <label class="row"><input type="checkbox" checked={osd.osdTime.enable === 1} onchange={(e) => (osd.osdTime.enable = e.currentTarget.checked ? 1 : 0)} /> Date and time</label>
        <label class="row">Time position <select bind:value={osd.osdTime.pos}>{#each POSITIONS as p (p)}<option>{p}</option>{/each}</select></label>
        <div class="actions"><button data-testid="save-osd" onclick={() => void save('osd', [['Osd', osd]])}>Save</button>{@render state('osd')}</div>
      </div>

      <div class="card">
        <h3>Network services</h3>
        {#each [['httpEnable', 'HTTP (80)'], ['httpsEnable', 'HTTPS (443)'], ['rtmpEnable', 'RTMP (1935, behind live video)'], ['rtspEnable', 'RTSP (554)'], ['onvifEnable', 'ONVIF (8000)']] as [k, label] (k)}
          <label class="row"><input type="checkbox" checked={net[k] === 1} onchange={(e) => (net[k] = e.currentTarget.checked ? 1 : 0)} data-testid="net-{k}" /> {label}</label>
        {/each}
        <p class="muted small">HTTPS off cuts the camera API on its HTTPS port; HTTP off also stops downloads. This page is unaffected.</p>
        <div class="actions"><button data-testid="save-network" onclick={() => void save('network', [['NetPort', net]])}>Save</button>{@render state('network')}</div>
      </div>

      <div class="card">
        <h3>Device</h3>
        <dl>
          <dt>Model</dt><dd>{all.devInfo.model}</dd>
          <dt>Firmware</dt><dd>{all.devInfo.firmVer}</dd>
          <dt>Hardware</dt><dd>{all.devInfo.hardVer}</dd>
          <dt>Serial</dt><dd class="mono">{all.devInfo.serial}</dd>
          <dt>Streams</dt><dd>{all.enc.mainStream.size} {all.enc.mainStream.vType} · {all.enc.subStream.size} {all.enc.subStream.vType}</dd>
          <dt>Storage</dt><dd>{mb(all.hddInfo[0].capacity - all.hddInfo[0].size)} of {mb(all.hddInfo[0].capacity)} used</dd>
          <dt>Certificate</dt><dd>{all.certificate.source}{all.certificate.enable ? ', custom installed' : ', factory (self-signed)'}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>Users</h3>
        <ul>{#each users as u (u.userName)}<li><span class="mono">{u.userName}</span> <span class="muted">{u.level}</span></li>{/each}</ul>
        <p class="muted small">Set with CAMSIM_USERS; changed through the camera API (AddUser, ModifyUser, DelUser).</p>
      </div>
    </div>
  {/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0 0 6px; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 8px; align-content: start; }
  .stack { display: grid; gap: 2px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .val { font-family: var(--mono); color: var(--accent); }
  select, .text { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }
  input[type='range'] { width: 100%; accent-color: var(--accent); }
  .actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .actions button { padding: 7px 14px; border: 0; border-radius: 8px; background: var(--grad); color: var(--on-grad); font-weight: 600; cursor: pointer; }
  .state { font-size: 13px; color: #22c55e; }
  .state.bad { color: var(--danger); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  ul { margin: 0; padding-left: 18px; }
  .mono { font-family: var(--mono); font-size: 13px; }
  .muted { color: var(--muted); margin: 0; }
  .small { font-size: 13px; }
  .err { color: var(--danger); }
</style>
