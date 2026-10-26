// Captain chunk invariant: source-only graph of every results entrypoint. External
// installed packages/builtins are declared boundaries, not an OS/process sandbox.
// Results do not launch stage workers; the separate C4 graph proof covers those argv roots.
// This is a closed check of modelled syntax, not arbitrary JavaScript evaluation:
// computed/obfuscated loader acquisition or monkey-patched globals are not modelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from '../../starter/node_modules/typescript/lib/typescript.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
function moduleLoads(source){
  const tree=ts.createSourceFile('graph.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length,0,'source graph must parse');
  const found=[];
  const literal=node=>{
    assert.ok(node&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)),'unsupported variable/interpolated module load');
    assert.ok(!['module','node:module'].includes(node.text),'module loader factories are refused under either builtin spelling');
    return node.text;
  };
  const visit=node=>{
    // Also refuse explicit property, destructured or bracket access to this loader
    // acquisition API, before an alias could hide its eventual invocation.
    if((ts.isIdentifier(node)||ts.isStringLiteral(node))&&node.text==='getBuiltinModule')throw Error('getBuiltinModule access unsupported in this results graph');
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)found.push(literal(node.moduleSpecifier));
    if(ts.isCallExpression(node)){
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')found.push(literal(node.arguments[0]));
      if(ts.isIdentifier(node.expression)&&node.expression.text==='createRequire')throw Error('createRequire factories unsupported in this results graph');
    }
    ts.forEachChild(node,visit);
  };visit(tree);return found;
}
test('S8 all neutral results entrypoints have no historical reporting, governed runner or DSH imports',()=>{
  const entries=fs.readdirSync(path.join(root,'packages/results')).filter(name=>name.endsWith('.mjs')).map(name=>path.join(root,'packages/results',name)),seen=new Set(),queue=[...entries];
  while(queue.length){
    const file=queue.pop();if(seen.has(file))continue;seen.add(file);
    const relative=path.relative(root,file).replaceAll('\\','/');
    assert.ok(!relative.startsWith('../')&&!path.isAbsolute(relative),'repository graph cannot escape');
    assert.ok(!relative.startsWith('runner/')||relative==='runner/files.mjs','runner utility allowlist');
    assert.notEqual(relative,'evaluator/report.mjs');assert.doesNotMatch(relative,/dsh|agent-teams/i);
    for(const specifier of moduleLoads(fs.readFileSync(file,'utf8'))){
      assert.doesNotMatch(specifier,/dsh|agent-teams/i);assert.ok(!['module','node:module'].includes(specifier),'unmodeled loader factories are refused');
      if(specifier.startsWith('.'))queue.push(path.resolve(path.dirname(file),specifier));
      else assert.ok(!path.isAbsolute(specifier)&&!specifier.startsWith('file:'),'absolute repository load refused');
    }
  }
  assert.ok(seen.size>=entries.length);assert.ok(seen.has(path.join(root,'evaluator/score.mjs')));
  console.log('Results source-only import graph: '+entries.length+' entrypoints; '+seen.size+' repository modules; external packages/builtins stop traversal; no governed/DSH/historical reporter.');
});
test('S8 results graph rejects unsupported dynamic/require factories rather than claiming an empty safe graph',()=>{
  assert.deepEqual(moduleLoads("import x from './a.mjs';export {x} from './b.mjs';import('./c.mjs');"),['./a.mjs','./b.mjs','./c.mjs']);
  for(const source of ['import(variable);','import(`./${value}.mjs`);','require(variable);','const r=createRequire(import.meta.url);r(variable);'])assert.throws(()=>moduleLoads(source));
  for(const source of [
    "import {createRequire as cr} from 'module';cr(x)(variable);",
    "import {createRequire as cr} from 'node:module';cr(x)(variable);",
    "import('module').then(m=>m.createRequire(x)(variable));",
    "const r=require('module').createRequire(x);r(variable);",
    "process.getBuiltinModule('module').createRequire(x)(variable);",
    "const {getBuiltinModule: get}=process;get('module');",
    "process['getBuiltinModule']('module');",
  ])assert.throws(()=>moduleLoads(source),/module loader factories|getBuiltinModule access/);
});
