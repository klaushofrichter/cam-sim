<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { simState } from '../lib/state';

  interface Video { id: string; name: string; state: 'pending' | 'preparing' | 'ready' | 'failed'; converted?: boolean; durationS?: number; error?: string; compat?: string }
  const TEST = 'test-pattern';
  let videos = $state<Video[]>([]);
  let selected = $state('');
  let sequence = $state<string[]>([]);
  let playing = $state('');
  let message = $state('');
  let busy = $state(false);

  async function load() {
    try {
      const r = await api<{ selected: string; sequence: string[]; playing: string; videos: Video[] }>('GET', '/videos');
      videos = r.videos;
      selected = r.selected;
      sequence = r.sequence;
      playing = r.playing;
    } catch {
      message = 'The video list could not be loaded.';
    }
  }

  async function put(body: { id: string } | { ids: string[] }) {
    busy = true;
    try {
      await api('PUT', '/video', body);
      message = '';
    } catch (e) {
      message = e instanceof ApiError ? String((e.body as { detail?: string } | null)?.detail ?? 'Not possible.') : 'Not possible.';
    } finally {
      busy = false;
      await load();
    }
  }

  // Checked library videos, kept in list order; none left selects the test pattern.
  function toggle(id: string, on: boolean) {
    const ids = videos.map((v) => v.id).filter((x) => x !== TEST && (x === id ? on : sequence.includes(x)));
    return put(ids.length ? { ids } : { id: TEST });
  }

  const checked = (id: string) => sequence.includes(id);
  const firstCompat = $derived(videos.find((v) => v.id !== TEST && checked(v.id))?.compat);
  const incompatible = (v: Video) => firstCompat !== undefined && !checked(v.id) && v.compat !== firstCompat;
  const several = $derived(sequence.length > 1);

  onMount(() => void load());
  // The state follows SSE: reload when the selection or a video's
  // preparation changes (state carries the selected id).
  $effect(() => {
    if ($simState?.video !== undefined && ($simState.video !== selected || ($simState.sequence && $simState.sequence.join() !== sequence.join()))) void load();
  });
  // The clock moves a sequence along without an event: look again every few seconds.
  $effect(() => {
    if (!several) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  });
  // Preparing videos: check again until they settle.
  $effect(() => {
    if (!videos.some((v) => v.state === 'pending' || v.state === 'preparing')) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  });

  const describe = (v: Video) =>
    v.state === 'ready'
      ? `${v.id === 'test-pattern' ? 'built in' : v.converted ? 'converted' : 'captured'}${v.durationS ? ` · ${v.durationS} s loop` : ''}`
      : v.state === 'failed'
        ? `could not be prepared: ${v.error ?? 'unknown error'}`
        : v.state === 'preparing'
          ? 'preparing…'
          : 'waiting to be prepared';
</script>

<ul class="videos" data-testid="videos">
  {#each videos as v (v.id)}
    {@const isTest = v.id === TEST}
    {@const off = busy || v.state !== 'ready' || incompatible(v)}
    <li class:selected={checked(v.id)} data-testid="video-{v.id}">
      <label class:off>
        {#if isTest}
          <input type="radio" name="video-choice" checked={checked(v.id)} disabled={busy || v.state !== 'ready'} onchange={() => void put({ id: TEST })} />
        {:else}
          <input type="checkbox" checked={checked(v.id)} disabled={off} onchange={(e) => void toggle(v.id, e.currentTarget.checked)} />
        {/if}
        {#if v.state === 'ready'}
          <img src="/sim/api/videos/{encodeURIComponent(v.id)}/poster" alt="" loading="lazy" />
        {:else}
          <span class="noposter"></span>
        {/if}
        <span class="text">
          <span class="name">{v.name}</span>
          <span class="desc" data-testid="video-state">{#if several && checked(v.id)}{v.id === playing ? 'playing now' : 'in sequence'} · {:else if checked(v.id)}showing · {/if}{describe(v)}</span>
          {#if incompatible(v)}<span class="desc">Different encoding: run scripts/library-normalize.sh to combine it</span>{/if}
        </span>
      </label>
    </li>
  {/each}
</ul>
{#if message}<p class="msg">{message}</p>{/if}
<p class="muted">Live video, RTSP, snapshots and new recordings show the test pattern or the checked videos, played one after another. Earlier recordings keep theirs. Add videos to the library folder (<span class="mono">CAMSIM_LIBRARY_DIR</span>); they are prepared after start.</p>

<style>
  .videos { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  label { width: 100%; display: flex; gap: 10px; align-items: center; text-align: left; padding: 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  label:hover:not(.off) { border-color: var(--accent); }
  label.off { cursor: default; }
  label.off:not(:has(:checked)) { opacity: 0.6; }
  li.selected label { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); }
  img, .noposter { width: 96px; height: 54px; object-fit: cover; border-radius: 4px; background: var(--border); flex: none; }
  .text { display: grid; gap: 2px; min-width: 0; }
  .name { font-weight: 600; }
  .desc { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .msg { margin: 0; color: var(--danger); font-size: 13px; }
  .muted { color: var(--muted); margin: 0; font-size: 13px; }
  .mono { font-family: var(--mono); }
</style>
