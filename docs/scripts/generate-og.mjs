#!/usr/bin/env node
// Generates public/og.png from og-template.html using Playwright.
// Run: bun run generate-og
import { chromium } from 'playwright'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const templatePath = join(__dirname, '..', 'og-template.html')
const outputPath = join(__dirname, '..', 'public', 'og.png')

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setViewportSize({ width: 1200, height: 630 })
await page.goto(`file://${templatePath}`)
await page.screenshot({ path: outputPath, type: 'png' })
await browser.close()

console.log(`✔ Generated ${outputPath}`)
