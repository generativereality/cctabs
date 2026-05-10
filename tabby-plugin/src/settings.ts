import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { CctabsSettingsTabComponent } from './settings-tab.component'

@Injectable()
export class CctabsConfigProvider extends ConfigProvider {
  defaults = {
    cctabs: {
      port: 3300,
      host: '127.0.0.1',
    },
  }

  platformDefaults = {}
}

@Injectable()
export class CctabsSettingsTabProvider extends SettingsTabProvider {
  id = 'cctabs'
  icon = 'plug'
  title = 'cctabs'

  getComponentType (): any {
    return CctabsSettingsTabComponent
  }
}
