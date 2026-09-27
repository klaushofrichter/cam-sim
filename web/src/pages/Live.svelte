<script lang="ts">
  import { onDestroy } from 'svelte';
  import mpegts from 'mpegts.js';
  import Icon from '../components/Icon.svelte';
  import TriggerBar from '../components/TriggerBar.svelte';
  import { simState } from '../lib/state';

  let stream = $state<'sub' | 'main'>('sub');
  let video: HTMLVideoElement | undefined = $state();
  let error = $state('');
  let player: ReturnType<typeof mpegts.createPlayer> | null = null;
  const hevc = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.B0"');

  function stop() {
    if (!player) return;
    try {
      player.pause();
      player.unload();
      player.detachMediaElement();
    } finally {
      player.destroy();
      player = null;
    }
  }

  function start() {
    stop();
    error = '';
    if (!video || $simState?.power !== 'on') return;
    if (stream === 'main' && !hevc) {
      error = 'The main stream is H.265, which this browser cannot play in a page (Safari and Chrome on macOS can).';
      return;
    }
    player = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: `/sim/api/media/live/${stream}`, hasAudio: true, hasVideo: true },
      { enableStashBuffer: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 1.5, liveBufferLatencyMinRemain: 0.3 },
    );
    player.attachMediaElement(video);
    player.on(mpegts.Events.ERROR, () => (error = 'The live stream stopped.'));
    player.load();
    void Promise.resolve(player.play()).catch(() => {});
  }

  $effect(() => {
    void stream;
    void $simState?.power;
    start();
  });
  onDestroy(stop);
</script>

<section>
  <div class="head">
    <h2>Live</h2>
    <div class="seg" role="group" aria-label="Stream">
      <button class:on={stream === 'sub'} data-testid="stream-sub" onclick={() => (stream = 'sub')}>Sub · 896×512 H.264</button>
      <button class:on={stream === 'main'} data-testid="stream-main" onclick={() => (stream = 'main')}>Main · H.265</button>
    </div>
    <a class="snap" data-testid="snapshot" href="/sim/api/media/snapshot" download="snapshot.jpg"><Icon name="camera" size={16} /> Snapshot</a>
  </div>
  <div class="stage">
    {#if $simState && $simState.power !== 'on'}
      <p class="msg">The camera is {$simState.power === 'off' ? 'powered off' : 'starting'}.</p>
    {:else if error}
      <p class="msg">{error}</p>
    {/if}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video data-testid="live-video" bind:this={video} muted autoplay playsinline></video>
  </div>
  <TriggerBar />
  <p class="note">Pictures are test patterns until the video library arrives (Plan 2). Watching here is not a camera client: it adds no sessions or counters.</p>
</section>

<style>
  section { display: grid; gap: 14px; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .seg button { padding: 6px 12px; border: 0; background: var(--surface-2); cursor: pointer; font-size: 13px; }
  .seg button.on { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }
  .snap { margin-left: auto; display: inline-flex; gap: 6px; align-items: center; font-size: 14px; }
  .stage { position: relative; background: #000; border-radius: var(--radius); overflow: hidden; aspect-ratio: 896 / 512; max-width: 1100px; }
  video { width: 100%; height: 100%; display: block; }
  .msg { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; margin: 0; background: rgba(0, 0, 0, 0.6); text-align: center; padding: 16px; z-index: 1; }
  .note { color: var(--muted); font-size: 13px; margin: 0; }
</style>
