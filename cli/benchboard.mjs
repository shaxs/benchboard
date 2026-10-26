#!/usr/bin/env node
import { main } from './application.mjs';
process.exitCode = await main(process.argv.slice(2));
