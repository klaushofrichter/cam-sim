<script lang="ts">
  import { simState } from '../lib/state';
  // The simulated camera's model, firmware and serial: in the top bar on
  // desktop, in the drawer footer on phones.
  let { testid = 'camera-meta' }: { testid?: string } = $props();
</script>

<span data-testid={testid}>{$simState ? `${$simState.model} · ${$simState.firmVer} · ${$simState.serial}` : ''}</span>
