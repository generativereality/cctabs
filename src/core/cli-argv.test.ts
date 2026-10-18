import { test, expect } from 'bun:test'
import { parseArgs, resolveArgs } from 'gunshi'
import { inlineValueOptions } from './cli-argv.js'

test('a quoted initial prompt mentioning flags remains one literal string', () => {
 const schema={name:{type:'positional' as const},prompt:{type:'string' as const,short:'p'},engine:{type:'string' as const}}
 const text='Run whoami --json; literal --flags, quotes " and %PATH%\nnext line'
 const argv=inlineValueOptions(['new','review','--engine','codex','-p',text],schema)
 const parsed=resolveArgs(schema,parseArgs(argv),{optionGrouping:true,skipPositional:0})
 expect(parsed.error).toBeUndefined()
 expect(parsed.values.prompt).toBe(text)
 expect(parsed.values.engine).toBe('codex')
})
test('does not swallow unknown flags or rewrite data following the explicit terminator', () => {
 const schema={prompt:{type:'string',short:'p'}}
 expect(inlineValueOptions(['new','x','--prompt','--bogus'],schema)).toEqual(['new','x','--prompt','--bogus'])
 expect(inlineValueOptions(['send','x','--','-p','literal --json'],schema)).toEqual(['send','x','--','-p','literal --json'])
})
