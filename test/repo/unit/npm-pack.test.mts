import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { verifyNpmTarball } from '../../../scripts/repo/npm/pack.mts'

it('checks identity and executable presence inside the packed archive', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'npm-pack-check-'))
  const manifest = {
    name: '@example/harbor',
    version: '1.2.3',
    bin: { harbor: 'dist/cli.cjs' },
    files: ['dist'],
  }
  const packageDirectory = path.join(directory, 'package')
  const executable = path.join(packageDirectory, 'dist/cli.cjs')
  const tarball = path.join(directory, 'package.tgz')
  function pack(): void {
    execFileSync('tar', ['-czf', tarball, '-C', directory, 'package'])
  }
  try {
    mkdirSync(path.dirname(executable), { recursive: true })
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify(manifest),
    )
    writeFileSync(executable, 'process.stdout.write("harbor")')
    pack()
    expect(() => verifyNpmTarball(tarball, manifest)).not.toThrow()
    expect(() =>
      verifyNpmTarball(tarball, { ...manifest, version: '1.2.4' }),
    ).toThrow()
    rmSync(executable)
    pack()
    expect(() => verifyNpmTarball(tarball, manifest)).toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
