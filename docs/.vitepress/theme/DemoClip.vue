<template>
  <section class="demo-clip">
    <!-- muted + playsinline let it autoplay on iOS; controls give fullscreen and sound-free scrubbing -->
    <video
      src="/demo.mp4"
      poster="/demo-poster.jpg"
      autoplay
      muted
      loop
      playsinline
      controls
      preload="metadata"
      aria-label="47-second demo: Claude opens, reads and forks named Tabby tabs, Tabby restarts and every tab comes back, then a tab on Kimi through Ollama"
    ></video>
  </section>
</template>

<style scoped>
.demo-clip {
  max-width: 1152px;
  margin: 0 auto;
  padding: 8px 24px 32px;
}

@media (min-width: 640px) {
  .demo-clip {
    padding: 8px 48px 48px;
  }
}

@media (min-width: 960px) {
  .demo-clip {
    padding: 8px 64px 56px;
  }
}

.demo-clip video {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: #000;
}
</style>
