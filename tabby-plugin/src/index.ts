/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { CctabsLogger } from './logger'
import { TabRegistry } from './tab-registry'
import { PidIndex } from './pid-index'
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
    CctabsServer,
    { provide: ConfigProvider, useClass: CctabsConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: CctabsSettingsTabProvider, multi: true },
  ],
  declarations: [
    CctabsSettingsTabComponent,
  ],
})
export default class CctabsPluginModule {
  // Force the server to instantiate eagerly so it starts on plugin load.
  constructor (logger: CctabsLogger, _server: CctabsServer) {
    logger.info('plugin loaded')
  }
}
