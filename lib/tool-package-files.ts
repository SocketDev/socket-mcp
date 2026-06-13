import { Type } from '@sinclair/typebox'

import { errorMessage } from '@socketsecurity/lib/errors'

import { getOrFetchBlob } from './blob-cache.ts'
import { getSocketInternalUserAgent } from './env.ts'
import { fetchFileList } from './files.ts'
import { debug, logger } from './logger.ts'
import { buildPurl } from './purl.ts'
import {
  AUTH_REQUIRED_MSG,
  authRequiredResult,
  resolveAuthToken,
  SOCKET_API_BASE_URL,
} from './server.ts'
import type { ToolSpec } from './tool-types.ts'

const INTERNAL_USER_AGENT = getSocketInternalUserAgent()

export interface PackageFilesArgs {
  ecosystem?: string | undefined
  depname: string
  version: string
  artifactId?: string | undefined
  platform?: string | undefined
}

export interface PackageFileContentsArgs {
  hash: string
  path?: string | undefined
}

export interface PackageFileGrepArgs {
  hash: string
  pattern: string
  caseInsensitive?: boolean | undefined
  contextLines?: number | undefined
  maxMatches?: number | undefined
  path?: string | undefined
}

const packageFilesInputSchema = Type.Object({
  ecosystem: Type.String({
    description:
      'Package ecosystem (e.g., npm, pypi, gem, cargo, maven, golang, nuget, chrome, openvsx)',
    default: 'npm',
  }),
  depname: Type.String({
    description:
      'Package name (e.g., "lodash", "@babel/core", "org.springframework:spring-core", "meta/pyrefly" for openvsx)',
  }),
  version: Type.String({ description: 'Package version' }),
  artifactId: Type.Optional(
    Type.String({
      description:
        'Per-version artifact disambiguator (e.g. PyPI filename, Maven artifact id, NuGet asset). Required when an ecosystem ships multiple artifacts per version.',
    }),
  ),
  platform: Type.Optional(
    Type.String({
      description:
        "Platform qualifier for ecosystems with per-OS/arch artifacts (e.g. openvsx: 'linux-x64', 'darwin-arm64', 'win32-x64').",
    }),
  ),
})

const packageFileContentsInputSchema = Type.Object({
  hash: Type.String({
    description:
      'Blob hash exactly as shown by `package_files` (the token printed after each file size)',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Optional file path for display only; does not affect the lookup',
    }),
  ),
})

const packageFileGrepInputSchema = Type.Object({
  hash: Type.String({
    description:
      'Blob hash exactly as shown by `package_files` (the token printed after each file size)',
  }),
  pattern: Type.String({
    description:
      'JavaScript regular expression. Plain literal strings work too. Anchors and character classes are supported.',
  }),
  caseInsensitive: Type.Optional(
    Type.Boolean({
      description: 'Match case-insensitively (default: false)',
    }),
  ),
  contextLines: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 5,
      description:
        'Lines of context to show before and after each match (0-5, default: 0)',
    }),
  ),
  maxMatches: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description:
        'Cap on number of matching lines returned (default: 100, max: 500)',
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        'Optional file path for display only; does not affect the lookup',
    }),
  ),
})

export function buildPurlForFiles(
  ecosystem: string,
  depname: string,
  version: string,
  artifactId?: string,
  platform?: string,
): string {
  const qualifiers: Record<string, string> = {}
  if (artifactId) {
    qualifiers['artifact_id'] = artifactId
  }
  if (platform) {
    qualifiers['platform'] = platform
  }
  return buildPurl(
    ecosystem,
    depname,
    version,
    Object.keys(qualifiers).length ? qualifiers : undefined,
  )
}

export function definePackageFileContentsTool(): ToolSpec {
  return {
    name: 'package_file_contents',
    title: 'Package File Contents Tool',
    description:
      'Read a single file from a package using the `package_file_contents` tool from Socket. Pass the `hash` printed next to each entry in `package_files` output. Returns up to 1 MB of UTF-8 text; binary files return metadata only.',
    inputSchema: packageFileContentsInputSchema,
    annotations: { readOnlyHint: true },
    async handler(rawArgs) {
      const args = rawArgs as unknown as PackageFileContentsArgs
      const { hash, path } = args
      const label = path ?? hash
      logger.info({ tool: 'package_file_contents', hash, path }, 'tool invoked')
      try {
        const blob = await getOrFetchBlob(hash)
        if (blob.binary) {
          return {
            content: [
              {
                type: 'text',
                text: `${label} appears to be binary (${blob.bytes} bytes, content-type: ${blob.contentType ?? 'unknown'}). Refusing to return binary contents.`,
              },
            ],
          }
        }
        const truncationNote = blob.truncated
          ? `\n\n[truncated — file is ${blob.bytes} bytes, returning first 1 MB]`
          : ''
        const header = `${label} (${blob.bytes} bytes)`
        return {
          content: [
            {
              type: 'text',
              text: `${header}\n\n${blob.text}${truncationNote}`,
            },
          ],
        }
      } catch (e) {
        const errorMsg = `Error fetching blob ${hash}: ${errorMessage(e)}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  }
}

export function definePackageFileGrepTool(): ToolSpec {
  return {
    name: 'package_file_grep',
    title: 'Package File Grep Tool',
    description:
      'Search a single file from a package for lines matching a JavaScript regular expression. Pass the `hash` printed next to each entry in `package_files` output. The file is fetched from Socket once per session and cached, so repeated greps on the same hash skip the network. Returns matching lines with line numbers (grep -n style); binary files are refused. Useful for locating a specific symbol, import, or string inside a dependency without dumping the whole file.',
    inputSchema: packageFileGrepInputSchema,
    annotations: { readOnlyHint: true },
    async handler(rawArgs) {
      const args = rawArgs as unknown as PackageFileGrepArgs
      const { hash, pattern, caseInsensitive, contextLines, maxMatches, path } =
        args
      const label = path ?? hash
      const cap = maxMatches ?? 100
      const ctx = contextLines ?? 0
      logger.info(
        {
          tool: 'package_file_grep',
          hash,
          path,
          pattern,
          caseInsensitive,
          contextLines: ctx,
          maxMatches: cap,
        },
        'tool invoked',
      )
      let re: RegExp
      try {
        re = new RegExp(pattern, caseInsensitive ? 'i' : '')
      } catch (e) {
        const errorMsg = `Invalid regular expression: ${errorMessage(e)}`
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
      try {
        const blob = await getOrFetchBlob(hash)
        if (blob.binary) {
          return {
            content: [
              {
                type: 'text',
                text: `${label} appears to be binary (${blob.bytes} bytes, content-type: ${blob.contentType ?? 'unknown'}). Refusing to grep binary contents.`,
              },
            ],
            isError: true,
          }
        }
        const lines = blob.text.split('\n')
        const matchIndexes: number[] = []
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i]!)) {
            matchIndexes.push(i)
            if (matchIndexes.length >= cap) {
              break
            }
          }
        }
        if (matchIndexes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `${label}: no matches for /${pattern}/${caseInsensitive ? 'i' : ''}`,
              },
            ],
          }
        }
        const lineWidth = String(lines.length).length
        const formatLine = (idx: number, sep: ':' | '-'): string =>
          `${String(idx + 1).padStart(lineWidth, ' ')}${sep} ${lines[idx]}`
        const out: string[] = []
        let lastPrinted = -1
        for (let m = 0; m < matchIndexes.length; m += 1) {
          const matchIdx = matchIndexes[m]!
          const start = Math.max(0, matchIdx - ctx)
          const end = Math.min(lines.length - 1, matchIdx + ctx)
          if (ctx > 0 && lastPrinted >= 0 && start > lastPrinted + 1) {
            out.push('--')
          }
          for (let i = Math.max(start, lastPrinted + 1); i <= end; i += 1) {
            out.push(formatLine(i, i === matchIdx ? ':' : '-'))
          }
          lastPrinted = end
        }
        const truncationNote = blob.truncated
          ? `\n[note: file is ${blob.bytes} bytes; searched only the first 1 MB]`
          : ''
        const capNote =
          matchIndexes.length >= cap
            ? `\n[note: stopped at maxMatches=${cap}; more matches may exist]`
            : ''
        const header = `${label} — ${matchIndexes.length} match${matchIndexes.length === 1 ? '' : 'es'} for /${pattern}/${caseInsensitive ? 'i' : ''}`
        return {
          content: [
            {
              type: 'text',
              text: `${header}\n${out.join('\n')}${truncationNote}${capNote}`,
            },
          ],
        }
      } catch (e) {
        const errorMsg = `Error grepping blob ${hash}: ${errorMessage(e)}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  }
}

export function definePackageFilesTool(): ToolSpec {
  return {
    name: 'package_files',
    title: 'Package File List Tool',
    description:
      "List the files published in a package using the `package_files` tool from Socket. Returns a tree of paths and sizes for any package on a supported ecosystem (npm, pypi, gem, cargo, maven, golang, nuget, chrome, openvsx). Useful for inspecting what a dependency ships before installing it. After calling this, use `package_file_contents` with one of the paths to read the file's contents.",
    inputSchema: packageFilesInputSchema,
    annotations: { readOnlyHint: true },
    async handler(rawArgs, extra) {
      const args = rawArgs as unknown as PackageFilesArgs
      const { ecosystem, depname, version, artifactId, platform } = args
      const purlWithQualifiers = buildPurlForFiles(
        ecosystem ?? 'npm',
        depname,
        version,
        artifactId,
        platform,
      )
      logger.info(
        {
          tool: 'package_files',
          ecosystem,
          depname,
          version,
          artifactId,
          platform,
          purl: purlWithQualifiers,
        },
        'tool invoked',
      )
      const accessToken = resolveAuthToken(extra.authInfo?.token)
      if (!accessToken) {
        logger.error('package_files: ' + AUTH_REQUIRED_MSG)
        return authRequiredResult()
      }
      try {
        const result = await fetchFileList(purlWithQualifiers, {
          baseUrl: SOCKET_API_BASE_URL,
          includeHashes: true,
          userAgent: INTERNAL_USER_AGENT,
          authToken: accessToken,
          onRequest: url => debug({ url }, 'file list request'),
        })
        if (result.fileCount === 0) {
          return {
            content: [
              { type: 'text', text: `No files found for ${result.purl}` },
            ],
          }
        }
        const sizeKb = (result.totalBytes / 1024).toFixed(1)
        const header = `${result.purl} — ${result.fileCount} files, ${sizeKb} KB`
        return {
          content: [{ type: 'text', text: `${header}\n${result.tree}` }],
        }
      } catch (e) {
        const errorMsg = `Error fetching file list for ${purlWithQualifiers}: ${errorMessage(e)}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  }
}
