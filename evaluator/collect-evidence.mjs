import fs from 'node:fs';
import path from 'node:path';
import ts from '../starter/node_modules/typescript/lib/typescript.js';
import { root, files, hashFile, sha } from '../runner/files.mjs';
export function analyzeSource(text, filename = 'source.tsx') {
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result = {
    noSuppression: true,
    noSecrets: true,
    noDebugLogging: true,
    noNetwork: true,
  };
  // Use the compiler's recognized directives; prose discussing a directive is not suppression.
  if (source.commentDirectives?.length || source.pragmas.has('ts-nocheck'))
    result.noSuppression = false;
  const name = (n) =>
    ts.isIdentifier(n)
      ? n.text
      : ts.isPropertyAccessExpression(n) &&
          ts.isIdentifier(n.expression) &&
          ['window', 'globalThis', 'console'].includes(n.expression.text)
        ? n.expression.text + '.' + n.name.text
        : ts.isElementAccessExpression(n) &&
            ts.isIdentifier(n.expression) &&
            ts.isStringLiteral(n.argumentExpression)
          ? n.expression.text + '.' + n.argumentExpression.text
          : '';
  const visit = (n) => {
    if (n.kind === ts.SyntaxKind.AnyKeyword) result.noSuppression = false;
    if (
      ts.isStringLiteralLike(n) &&
      /(?:sk-[A-Za-z0-9]{20,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/.test(n.text)
    )
      result.noSecrets = false;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = name(n.expression);
      if (/^console\.(log|debug)$/.test(callee)) result.noDebugLogging = false;
      if (
        /^(?:(?:window|globalThis)\.)?(fetch|XMLHttpRequest|WebSocket)$/.test(
          callee,
        )
      )
        result.noNetwork = false;
      if (
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        n.arguments?.some(
          (x) => ts.isStringLiteralLike(x) && /^https?:/.test(x.text),
        )
      )
        result.noNetwork = false;
    }
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      /^https?:/.test(n.moduleSpecifier.text)
    )
      result.noNetwork = false;
    if (
      ts.isJsxAttribute(n) &&
      n.name.getText(source) === 'src' &&
      n.initializer &&
      ts.isStringLiteralLike(n.initializer) &&
      /^https?:/.test(n.initializer.text)
    )
      result.noNetwork = false;
    ts.forEachChild(n, visit);
  };
  visit(source);
  return result;
}
export function inspectPublic(app) {
  const checks = files(path.join(app, 'src'))
    .filter((p) => /\.(ts|tsx|js|jsx)$/.test(p))
    .map((p) =>
      analyzeSource(fs.readFileSync(path.join(app, 'src', p), 'utf8'), p),
    );
  const visibleIntact = files(path.join(root, 'starter/tests')).every(
    (p) =>
      fs.existsSync(path.join(app, 'tests', p)) &&
      sha(fs.readFileSync(path.join(app, 'tests', p))) ===
        hashFile('starter/tests/' + p),
  );
  const lockedDependencies = ['package.json', 'package-lock.json'].every(
    (p) =>
      fs.existsSync(path.join(app, p)) &&
      sha(fs.readFileSync(path.join(app, p))) === hashFile('starter/' + p),
  );
  return {
    noSuppression: checks.every((c) => c.noSuppression),
    hygiene: {
      visibleIntact,
      lockedDependencies,
      noSecrets: checks.every((c) => c.noSecrets),
      noDebugLogging: checks.every((c) => c.noDebugLogging),
      noNetwork: checks.every((c) => c.noNetwork),
    },
    analysisMethod:
      'TypeScript syntax tree and actual comment directives; bounded hygiene proxy, not a security audit',
  };
}
