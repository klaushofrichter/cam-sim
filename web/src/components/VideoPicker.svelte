<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { simState } from '../lib/state';

  interface Video { id: string; name: string; state: 'pending' | 'preparing' | 'ready' | 'failed'; converted?: boolean; durationS?: number; error?: string }
  let videos = $state<Video[]>([]);
  let selected = $state('');
  let message = $state('');
  let busy = $state(false);

  async function load() {
    try {
      const r = await api<{ selected: string; videos: Video[] }>('GET', '/videos');
      videos = r.videos;
      selected = r.selected;
    } catch {
      message = 'The video list could not be loaded.';
    }
  }

  async function choose(id: string) {
    busy = true;
    try {
      await api('PUT', '/video', { id });
      message = '';
    } catch (e) {
      message = e instanceof ApiError ? String((e.body as { detail?: string } | null)?.detail ?? 'Not possible.') : 'Not possible.';
    } finally {
      busy = false;
      await load();
    }
  }

  onMount(() => void load());
  // The state follows SSE: reload when the selection or a video's
  // preparation changes (state carries the selected id).
  $effect(() => {
    if ($simState?.video !== undefined && $simState.video !== selected) void load();
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
    <li class:selected={v.id === selected} data-testid="video-{v.id}">
      <button disabled={busy || v.state !== 'ready' || v.id === selected} onclick={() => void choose(v.id)} aria-pressed={v.id === selected}>
        {#if v.state === 'ready'}
          <img src="/sim/api/videos/{encodeURIComponent(v.id)}/poster" alt="" loading="lazy" />
        {:else}
          <span class="noposter"></span>
        {/if}
        <span class="text">
          <span class="name">{v.name}</span>
          <span class="desc" data-testid="video-state">{v.id === selected ? 'showing · ' : ''}{describe(v)}</span>
        </span>
      </button>
    </li>
  {/each}
</ul>
{#if message}<p class="msg">{message}</p>{/if}
<p class="muted">Live video, RTSP, snapshots and new recordings show the selected video. Earlier recordings keep theirs. Add videos to the library folder (<span class="mono">CAMSIM_LIBRARY_DIR</span>); they are prepared after start.</p>

<style>
  .videos { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  button { width: 100%; display: flex; gap: 10px; align-items: center; text-align: left; padding: 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { cursor: default; }
  li.selected button { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); }
  img, .noposter { width: 96px; height: 54px; object-fit: cover; border-radius: 4px; background: var(--border); flex: none; }
  .text { display: grid; gap: 2px; min-width: 0; }
  .name { font-weight: 600; }
  .desc { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .msg { margin: 0; color: var(--danger); font-size: 13px; }
  .muted { color: var(--muted); margin: 0; font-size: 13px; }
  .mono { font-family: var(--mono); }
</style>
