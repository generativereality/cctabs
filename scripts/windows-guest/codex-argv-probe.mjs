import { writeFileSync } from 'node:fs'
writeFileSync('C:\\Users\\dev\\cctabs-cx-validation\\argv-result.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
console.log('>_ OpenAI Codex argv probe\n\u203a Ask Codex to do anything')
setInterval(() => {}, 1000)
