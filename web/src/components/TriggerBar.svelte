<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { simState } from '../lib/state';

  const TYPES = ['motion', 'person', 'vehicle', 'pet'] as const;
  let duration = $state('15');
  let result = $state('');
  let busy = $state(false);

  async function trigger(type: string) {
    busy = true;
    try {
      const r = await api<{ recording: { id: string; start: string } | null }>('POST', '/events', { type, durationS: Number(duration) });
      result = r.recording
        ? `Recording ${r.recording.start.replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3')} (${type}, ${duration} s)`
        : `${type} detected, not recorded (recording is off or not scheduled for ${type})`;
    } catch (e) {
      result = e instanceof ApiError && (e.body as { error?: string } | null)?.error === 'powered_off' ? 'The camera is powered off.' : 'The event could not be triggered.';
    } finally {
      busy = false;
    }
  }
</script>

<div class="bar">
  <span class="label">Trigger an event</span>
  {#each TYPES as t (t)}
    <button data-testid="trigger-{t}" disabled={busy || $simState?.power !== 'on'} onclick={() => void trigger(t)}>{t}</button>
  {/each}
  <label>for
    <select data-testid="trigger-duration" bind:value={duration}>
      {#each ['5', '15', '30', '60'] as d (d)}<option value={d}>{d} s</option>{/each}
    </select>
  </label>
  {#if result}<span class="result" data-testid="trigger-result">{result}</span>{/if}
</div>

<style>
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .label { color: var(--muted); font-size: 13px; }
  button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; text-transform: capitalize; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  select { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); }
  label { color: var(--muted); font-size: 13px; display: inline-flex; gap: 6px; align-items: center; }
  .result { font-size: 13px; color: var(--accent); }
</style>
