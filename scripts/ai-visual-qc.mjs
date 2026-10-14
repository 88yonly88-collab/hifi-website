#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));
await import('./visual-qc-check.mjs');
