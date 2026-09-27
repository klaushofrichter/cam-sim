<script lang="ts">
  import { onMount } from 'svelte';
  import { loggedIn, checkSession, api } from './lib/api';
  import { page } from './lib/router';
  import { simState, connectFeed, disconnectFeed, type SimState } from './lib/state';
  import Login from './pages/Login.svelte';
  import TopBar from './components/TopBar.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Live from './pages/Live.svelte';
  import Playback from './pages/Playback.svelte';
  import Settings from './pages/Settings.svelte';
  import Simulator from './pages/Simulator.svelte';

  const loadState = async () => {
    try {
      simState.set(await api<SimState>('GET', '/state'));
    } catch {
      // a 401 flips loggedIn; anything else keeps the last state
    }
  };

  onMount(() => void checkSession());

  $effect(() => {
    if ($loggedIn) {
      void loadState();
      connectFeed(() => void loadState());
    } else {
      disconnectFeed();
    }
  });
</script>

{#if $loggedIn === false}
  <Login />
{:else if $loggedIn}
  <div class="shell" data-testid="shell">
    <TopBar />
    <div class="body">
      <Sidebar />
      <main>
        {#if $page === 'live'}<Live />
        {:else if $page === 'playback'}<Playback />
        {:else if $page === 'settings'}<Settings />
        {:else}<Simulator />{/if}
      </main>
    </div>
  </div>
{/if}

<style>
  .shell { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  .body { display: grid; grid-template-columns: auto 1fr; min-height: 0; }
  main { overflow: auto; padding: 20px 24px 40px; }
  @media (max-width: 700px) { main { padding: 12px; } }
</style>
