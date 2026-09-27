<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { api } from '../lib/api';
  import { feed, simState } from '../lib/state';

  interface Rec {
    id: string;
    date: string;
    start: string;
    end: string | null;
    mainEnd: string | null;
    triggers: string[];
    files: Record<'sub' | 'main', { name: string; size: number }>;
  }

  // The camera's calendar day, in its own time zone.
  const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: $simState?.tz ?? 'America/Chicago' }).format(d);
  let date = $state(localDate());
  // Until someone picks a day, follow the camera's own "today" (its time zone
  // is known only once the state has loaded).
  let picked = false;
  $effect(() => {
    if (!picked && $simState?.tz) date = localDate();
  });
  let recs = $state<Rec[]>([]);
  let daysTable = $state('');
  let selected = $state<Rec | null>(null);
  let stream = $state<'sub' | 'main'>('sub');
  let error = $state('');

  const hms = (s: string | null) => (s ? `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}` : 'recording…');

  async function load() {
    try {
      error = '';
      recs = (await api<Rec[]>('GET', `/recordings?date=${date}`)).slice().reverse();
      const [y, m] = date.split('-').map(Number);
      daysTable = (await api<{ table: string }>('GET', `/recordings/days?year=${y}&mon=${m}`)).table;
    } catch {
      error = 'Recordings could not be loaded.';
    }
  }

  $effect(() => {
    void date;
    void load();
  });
  // New events and finished recordings arrive over the feed.
  let seen = 0;
  $effect(() => {
    const n = $feed.filter((f) => f.kind === 'event').length;
    if (n !== seen) {
      seen = n;
      void load();
    }
  });

  const url = (r: Rec, s: 'sub' | 'main', download = false) => `/sim/api/recordings/${encodeURIComponent(r.id)}/${s}${download ? '?download=1' : ''}`;
  const days = $derived(daysTable.split('').map((c, i) => ({ day: i + 1, has: c === '1' })));
  // Blank cells so day 1 sits under its weekday (weeks start on Sunday).
  const lead = $derived(new Date(`${date.slice(0, 8)}01T12:00:00Z`).getUTCDay());
  const shift = (n: number) => {
    picked = true;
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n, 1);
    date = d.toISOString().slice(0, 10);
  };
</script>

<section>
  <h2>Playback</h2>
  <div class="layout">
    <div class="side">
      <div class="month">
        <button onclick={() => shift(-1)} aria-label="Previous month"><Icon name="calendarPrev" size={16} /></button>
        <span>{date.slice(0, 7)}</span>
        <button onclick={() => shift(1)} aria-label="Next month"><Icon name="calendarNext" size={16} /></button>
      </div>
      <div class="days">
        {#each ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as w, i (i)}<span class="wd">{w}</span>{/each}
        {#each Array(lead) as _, i (i)}<span></span>{/each}
        {#each days as d (d.day)}
          {@const iso = `${date.slice(0, 8)}${String(d.day).padStart(2, '0')}`}
          <button class:has={d.has} class:sel={iso === date} data-testid="day-{d.day}" onclick={() => ((picked = true), (date = iso))}>{d.day}</button>
        {/each}
      </div>
      {#if error}<p class="err">{error}</p>{/if}
      <ul>
        {#each recs as r (r.id)}
          <li>
            <button class="row" class:sel={selected?.id === r.id} data-testid="recording-row" onclick={() => (selected = r)}>
              <span class="time">{hms(r.start)} – {hms(r.end)}</span>
              <span class="chips">{#each r.triggers as t (t)}<span class="chip {t}">{t}</span>{/each}</span>
            </button>
          </li>
        {:else}
          <li class="muted">No recordings on {date}.</li>
        {/each}
      </ul>
    </div>
    <div class="view">
      {#if selected}
        <div class="seg">
          <button class:on={stream === 'sub'} onclick={() => (stream = 'sub')}>Sub</button>
          <button class:on={stream === 'main'} onclick={() => (stream = 'main')}>Main (H.265)</button>
        </div>
        {#key `${selected.id}-${stream}`}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video data-testid="playback-video" src={url(selected, stream)} controls autoplay muted playsinline></video>
        {/key}
        <p class="links">
          <a data-testid="download-sub" href={url(selected, 'sub', true)}><Icon name="download" size={14} /> Sub copy</a>
          <a data-testid="download-main" href={url(selected, 'main', true)}><Icon name="download" size={14} /> Main copy</a>
          <span class="muted mono">{selected.files[stream].name}</span>
        </p>
      {:else}
        <p class="muted">Choose a recording.</p>
      {/if}
    </div>
  </div>
</section>

<style>
  section { display: grid; gap: 14px; }
  h2 { margin: 0; font-size: 20px; }
  .layout { display: grid; grid-template-columns: minmax(260px, 340px) 1fr; gap: 20px; align-items: start; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  .side { display: grid; gap: 10px; }
  .month { display: flex; align-items: center; justify-content: space-between; }
  .month button { border: 1px solid var(--border); background: var(--surface-2); border-radius: 8px; padding: 4px 6px; cursor: pointer; display: grid; }
  .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .wd { text-align: center; font-size: 11px; color: var(--muted); }
  .days button { padding: 4px 0; border-radius: 6px; border: 1px solid transparent; background: none; cursor: pointer; color: var(--muted); font-size: 13px; }
  .days button.has { color: var(--text); background: var(--surface-2); }
  .days button.sel { border-color: var(--accent); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; max-height: 55vh; overflow: auto; }
  .row { width: 100%; display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; }
  .row.sel { border-color: var(--accent); }
  .time { font-family: var(--mono); font-size: 13px; }
  .chips { display: inline-flex; gap: 4px; }
  .chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
  .chip.person { color: #22d3ee; } .chip.vehicle { color: #a78bfa; } .chip.pet { color: #f59e0b; }
  .view { display: grid; gap: 10px; }
  video { width: 100%; max-width: 1000px; background: #000; border-radius: var(--radius); }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; width: fit-content; }
  .seg button { padding: 5px 12px; border: 0; background: var(--surface-2); cursor: pointer; font-size: 13px; }
  .seg button.on { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }
  .links { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin: 0; font-size: 14px; }
  .links a { display: inline-flex; gap: 4px; align-items: center; }
  .muted { color: var(--muted); }
  .mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
  .err { color: var(--danger); margin: 0; }
</style>
