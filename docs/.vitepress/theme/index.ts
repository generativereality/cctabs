import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import DemoClip from './DemoClip.vue'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // The demo clip sits right under the hero on the home page
      'home-hero-after': () => h(DemoClip),
    }),
}
