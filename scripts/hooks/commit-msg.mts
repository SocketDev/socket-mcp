import { readFileSync } from 'node:fs'
import process from 'node:process'

import {
  stripCommitScissors,
  validateCommitMessage,
} from '../util/commit-message.mts'
import { formatScanHits, scanText } from '../util/scan.mts'

const file = process.argv[2]
if (!file) {
  process.stderr.write('commit-msg: no message file argument.\n')
  process.exit(1)
}
const message = stripCommitScissors(readFileSync(file, 'utf8'))
const problem = validateCommitMessage(message)
if (problem) {
  process.stderr.write(`commit-msg: ${problem}\n`)
  process.exit(1)
}
const hits = scanText('commit message', message)
if (hits.length > 0) {
  process.stderr.write(
    `commit-msg: the message contains secrets, personal paths, or private names:\n${formatScanHits(hits)}\n`,
  )
  process.exit(1)
}
