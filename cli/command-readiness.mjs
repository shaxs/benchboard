// Shared pure readiness/dispatch table. Merely importing it loads no command assets.
export const COMMAND_LOADERS = Object.freeze({
  init: () => import('./initialize-command.mjs').then(module => module.initializeCommand),
  start: () => import('./manual-commands.mjs').then(module => module.startCommand),
  stop: () => import('./manual-commands.mjs').then(module => module.stopCommand),
  status: () => import('./manual-commands.mjs').then(module => module.statusCommand),
  freeze: () => import('./freeze-command.mjs').then(module => module.freezeCommand),
  reconcile: () => import('./reconcile-command.mjs').then(module => module.reconcileCommand),
  reset: () => import('./reset-command.mjs').then(module => module.resetCommand),
  evaluate: () => import('./evaluate-command.mjs').then(module => module.evaluateCommand),
  ui: () => import('./ui-command.mjs').then(module => module.uiCommand),
  export: () => import('./export-command.mjs').then(module => module.exportCommand),
  run: () => import('./run-command.mjs').then(module => module.runCommand),
  review: () => import('./review-command.mjs').then(module => module.reviewCommand),
});
