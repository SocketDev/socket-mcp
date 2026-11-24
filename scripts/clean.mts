#!/usr/bin/env node

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

import { DIST_DIR } from './paths.mts'

await safeDelete(DIST_DIR)
