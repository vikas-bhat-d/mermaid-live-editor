<script lang="ts">
  export async function waitForFontAwesomeToLoad() {
    // FontAwesome CSS is no longer loaded via CDN - fonts are now only used if bundled
    return Promise.resolve();
  }
</script>

<!-- FontAwesome support disabled for offline-first functionality -->
