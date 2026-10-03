<script lang="ts">
  import Icon from './Icon.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import CameraMeta from './CameraMeta.svelte';
  import { logout } from '../lib/api';
  import { simState } from '../lib/state';
  import { drawerOpen } from '../lib/nav';

  const power = $derived($simState ? ($simState.rebooting ? 'rebooting' : $simState.power) : '…');
</script>

<header data-testid="topbar">
  <button class="hamburger" data-testid="hamburger" aria-label="Open menu" aria-expanded={$drawerOpen} onclick={() => drawerOpen.set(true)}>
    <Icon name="menu" />
  </button>
  <span class="brand"><Icon name="camera" size={22} /> <span class="brand-name">cam-sim</span></span>
  <span class="cam" data-testid="camera-name">{$simState?.name ?? ''}</span>
  <span class="badge {power}" title="Power state" data-testid="power-badge">{power}</span>
  <span class="meta"><CameraMeta /></span>
  <span class="spacer"></span>
  <div class="desktop-only"><ThemeToggle /></div>
  <button class="logout desktop-only" data-testid="logout" onclick={() => void logout()}><Icon name="logout" size={16} /> Sign out</button>
</header>

<style>
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--chrome); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .hamburger { display: none; width: 36px; height: 36px; place-items: center; border: 0; background: transparent; cursor: pointer; border-radius: 10px; color: var(--text); flex-shrink: 0; }
  .hamburger:hover { background: var(--surface-2); }
  .brand { display: inline-flex; gap: 8px; align-items: center; font-weight: 700; color: var(--accent); }
  .cam { font-weight: 600; }
  .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .spacer { flex: 1; }
  .badge { white-space: nowrap; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.04em; }
  .badge.on { color: #22c55e; border-color: color-mix(in srgb, #22c55e 50%, var(--border)); }
  .badge.off { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); }
  .badge.booting, .badge.rebooting { color: #f59e0b; }
  .logout { display: inline-flex; gap: 6px; align-items: center; padding: 7px 12px; border-radius: 8px; border: 0; background: var(--grad); color: var(--on-grad); cursor: pointer; font-weight: 600; }
  /* Phones (cams' breakpoint): one row; hamburger, logo, camera name, power.
     Theme, Sign out and the camera line move into the drawer. */
  @media (max-width: 767px) {
    header { flex-wrap: nowrap; gap: 8px; padding: 8px 12px; }
    .hamburger { display: grid; }
    .meta, .desktop-only, .brand-name { display: none; }
    .cam { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { padding: 2px 7px; flex-shrink: 0; }
  }
</style>
