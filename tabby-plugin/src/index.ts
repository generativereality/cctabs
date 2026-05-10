/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { CctabsLogger } from './logger'
import { TabRegistry } from './tab-registry'
import { PidIndex } from './pid-index'
import { OutputBufferStore } from './output-buffer'
import { CctabsServer } from './server'
import { CctabsConfigProvider, CctabsSettingsTabProvider } from './settings'
import { CctabsSettingsTabComponent } from './settings-tab.component'

@NgModule({
  imports: [
    CommonModule,
    FormsModule,
  ],
  providers: [
    CctabsLogger,
    TabRegistry,
    PidIndex,
    OutputBufferStore,
    CctabsServer,
    { provide: ConfigProvider, useClass: CctabsConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: CctabsSettingsTabProvider, multi: true },
  ],
  declarations: [
    CctabsSettingsTabComponent,
  ],
})
export default class CctabsPluginModule {
  // Force the server (and the output-buffer store, which the server uses)
  // to instantiate eagerly so they start capturing on plugin load.
  constructor (
    logger: CctabsLogger,
    _output: OutputBufferStore,
    _server: CctabsServer,
  ) {
    logger.info('plugin loaded')
  }
}
