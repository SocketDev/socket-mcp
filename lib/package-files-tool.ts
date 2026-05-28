import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getSocketApiUrl } from './env.ts'
import { getStaticApiKey } from './depscore-tool.ts'
import { fetchFileList } from './files.ts'
import { getOrFetchBlob } from './blob-cache.ts'
import { buildPurl } from './purl.ts'
import { debug, logger } from './logger.ts'

const SOCKET_API_BASE_URL =
  getSocketApiUrl() || 'https://api.socket.dev'

// Internal UA for authenticated calls to socket.dev's file-list endpoint.
const INTERNAL_USER_AGENT =
  process.env['SOCKET_INTERNAL_USER_AGENT'] || 'socket-internal-tool/1.0'

const AUTH_REQUIRED_MSG =
  'Authentication is required. Configure SOCKET_API_TOKEN (or a legacy alias) for stdio mode or connect through OAuth-enabled HTTP mode.'

function buildPurlForFiles(
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

export function registerPackageFilesTools(srv: McpServer): void {
  srv.registerTool(
    'package_files',
    {
      title: 'Package File List Tool',
      description:
        "List the files published in a package using the `package_files` tool from Socket. Returns a tree of paths and sizes for any package on a supported ecosystem (npm, pypi, gem, cargo, maven, golang, nuget, chrome, openvsx). Useful for inspecting what a dependency ships before installing it. After calling this, use `package_file_contents` with one of the paths to read the file's contents.",
      inputSchema: {
        ecosystem: z
          .string()
          .describe(
            'Package ecosystem (e.g., npm, pypi, gem, cargo, maven, golang, nuget, chrome, openvsx)',
          )
          .default('npm'),
        depname: z
          .string()
          .describe(
            'Package name (e.g., "lodash", "@babel/core", "org.springframework:spring-core", "meta/pyrefly" for openvsx)',
          ),
        version: z.string().describe('Package version'),
        artifactId: z
          .string()
          .optional()
          .describe(
            'Per-version artifact disambiguator (e.g. PyPI filename, Maven artifact id, NuGet asset). Required when an ecosystem ships multiple artifacts per version.',
          ),
        platform: z
          .string()
          .optional()
          .describe(
            "Platform qualifier for ecosystems with per-OS/arch artifacts (e.g. openvsx: 'linux-x64', 'darwin-arm64', 'win32-x64').",
          ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ ecosystem, depname, version, artifactId, platform }, extra) => {
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
      const accessToken = extra.authInfo?.token || getStaticApiKey()
      if (!accessToken) {
        return {
          content: [{ type: 'text', text: AUTH_REQUIRED_MSG }],
          isError: true,
        }
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
        const error = e as Error
        const errorMsg = `Error fetching file list for ${purlWithQualifiers}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  )

  srv.registerTool(
    'package_file_contents',
    {
      title: 'Package File Contents Tool',
      description:
        'Read a single file from a package using the `package_file_contents` tool from Socket. Pass the `hash` printed next to each entry in `package_files` output. Returns up to 1 MB of UTF-8 text; binary files return metadata only.',
      inputSchema: {
        hash: z
          .string()
          .describe(
            'Blob hash exactly as shown by `package_files` (the token printed after each file size)',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Optional file path for display only; does not affect the lookup',
          ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ hash, path }) => {
      const label = path ?? hash
      logger.info(
        { tool: 'package_file_contents', hash, path },
        'tool invoked',
      )
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
        const error = e as Error
        const errorMsg = `Error fetching blob ${hash}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  )

  srv.registerTool(
    'package_file_grep',
    {
      title: 'Package File Grep Tool',
      description:
        'Search a single file from a package for lines matching a JavaScript regular expression. Pass the `hash` printed next to each entry in `package_files` output. The file is fetched from Socket once per session and cached, so repeated greps on the same hash skip the network. Returns matching lines with line numbers (grep -n style); binary files are refused. Useful for locating a specific symbol, import, or string inside a dependency without dumping the whole file.',
      inputSchema: {
        hash: z
          .string()
          .describe(
            'Blob hash exactly as shown by `package_files` (the token printed after each file size)',
          ),
        pattern: z
          .string()
          .describe(
            'JavaScript regular expression. Plain literal strings work too. Anchors and character classes are supported.',
          ),
        caseInsensitive: z
          .boolean()
          .optional()
          .describe('Match case-insensitively (default: false)'),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe(
            'Lines of context to show before and after each match (0-5, default: 0)',
          ),
        maxMatches: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            'Cap on number of matching lines returned (default: 100, max: 500)',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Optional file path for display only; does not affect the lookup',
          ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ hash, pattern, caseInsensitive, contextLines, maxMatches, path }) => {
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
        const errorMsg = `Invalid regular expression: ${(e as Error).message}`
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
        for (let i = 0; i < lines.length; i++) {
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
        for (let m = 0; m < matchIndexes.length; m++) {
          const matchIdx = matchIndexes[m]!
          const start = Math.max(0, matchIdx - ctx)
          const end = Math.min(lines.length - 1, matchIdx + ctx)
          if (ctx > 0 && lastPrinted >= 0 && start > lastPrinted + 1) {
            out.push('--')
          }
          for (let i = Math.max(start, lastPrinted + 1); i <= end; i++) {
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
        const error = e as Error
        const errorMsg = `Error grepping blob ${hash}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  )
}
