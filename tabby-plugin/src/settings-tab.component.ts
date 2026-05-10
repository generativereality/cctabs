import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

@Component({
  selector: 'cctabs-settings-tab',
  template: `
    <h3>cctabs HTTP API</h3>
    <p class="text-muted">
      Local API consumed by the cctabs CLI. Bind only to loopback unless you
      know what you're doing — the API has no authentication.
    </p>
    <div class="form-line">
      <div class="header">
        <div class="title">Port</div>
        <div class="description">Default 3300. Restart of the API server is automatic.</div>
      </div>
      <input type="number" class="form-control" [(ngModel)]="config.store.cctabs.port" (change)="config.save()" min="1" max="65535">
    </div>
    <div class="form-line">
      <div class="header">
        <div class="title">Bind host</div>
        <div class="description">Default 127.0.0.1. Use 0.0.0.0 to expose the API to other machines (not recommended).</div>
      </div>
      <input type="text" class="form-control" [(ngModel)]="config.store.cctabs.host" (change)="config.save()">
    </div>
  `,
})
export class CctabsSettingsTabComponent {
  constructor (public config: ConfigService) {}
}
