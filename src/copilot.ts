import * as core from '@actions/core'
import * as io from '@actions/io'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'
import {spawn} from 'child_process'

export interface CopilotResult {
  stdout: string
  exitCode: number
}

const COPILOT_TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS || 15 * 60 * 1000)
const COPILOT_HEARTBEAT_MS = Math.max(
  1_000,
  Number(process.env.COPILOT_HEARTBEAT_MS || 30_000)
)
const COPILOT_FORCE_KILL_DELAY_MS = 10_000
const COPILOT_SAVE_PROMPT = process.env.COPILOT_SAVE_PROMPT === 'true'

/**
 * Ensure the Copilot CLI is installed and available.
 */
export async function ensureCopilotCLI(): Promise<string> {
  try {
    const copilotPath = await io.which('copilot', false)
    if (copilotPath) {
      core.info(`Copilot CLI found at: ${copilotPath}`)
      return copilotPath
    }
  } catch {
    // Not found, install it
  }

  core.info('Installing Copilot CLI via npm...')
  const exitCode = await exec.exec(
    'npm',
    ['install', '-g', '@github/copilot'],
    {silent: true, env: buildCopilotEnv()}
  )

  if (exitCode !== 0) {
    throw new Error(
      'Failed to install Copilot CLI. ' +
        'Please ensure Node.js v22+ is available or install it manually before running this action.'
    )
  }

  const copilotPath = await io.which('copilot', true)
  core.info(`Copilot CLI installed at: ${copilotPath}`)
  return copilotPath
}

/**
 * Build the minimal environment for the Copilot CLI subprocess.
 * Only pass what is needed — never spread process.env wholesale.
 */
function buildCopilotEnv(): Record<string, string> {
  const env: Record<string, string> = {}

  if (process.env.PATH) env.PATH = process.env.PATH
  if (process.env.HOME) env.HOME = process.env.HOME
  if (process.env.RUNNER_TEMP) env.RUNNER_TEMP = process.env.RUNNER_TEMP
  if (process.env.NODE_PATH) env.NODE_PATH = process.env.NODE_PATH
  if (process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS

  const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''
  if (!token) {
    core.warning(
      'No COPILOT_GITHUB_TOKEN or GITHUB_TOKEN found — Copilot CLI may fail to authenticate'
    )
  }
  env.GITHUB_TOKEN = token

  return env
}

function buildDebugDir(): string | undefined {
  const baseDir =
    process.env.COPILOT_DEBUG_DIR ||
    (process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, 'copilot-debug')
      : undefined)

  if (!baseDir) {
    return undefined
  }

  const dir = path.join(
    baseDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  )
  fs.mkdirSync(dir, {recursive: true})
  return dir
}

function safeWriteFile(filePath: string, data: string): void {
  try {
    fs.writeFileSync(filePath, data, 'utf8')
  } catch (err) {
    core.warning(`Failed to write debug file ${filePath}: ${String(err)}`)
  }
}

function safeAppendFile(filePath: string, data: string): void {
  try {
    fs.appendFileSync(filePath, data, 'utf8')
  } catch (err) {
    core.warning(`Failed to append debug file ${filePath}: ${String(err)}`)
  }
}

function writeJsonFile(
  debugDir: string | undefined,
  fileName: string,
  payload: unknown
): void {
  if (!debugDir) {
    return
  }
  safeWriteFile(path.join(debugDir, fileName), `${JSON.stringify(payload, null, 2)}\n`)
}

function appendJsonLine(
  debugDir: string | undefined,
  fileName: string,
  payload: unknown
): void {
  if (!debugDir) {
    return
  }
  safeAppendFile(path.join(debugDir, fileName), `${JSON.stringify(payload)}\n`)
}

function sanitizeForWorkflowLog(text: string): string {
  return text.replace(/^::/gm, ' ::')
}

/**
 * Run the Copilot CLI with the given prompt and return the result.
 * Uses child_process.spawn directly so we can enforce a real timeout
 * and emit detailed diagnostics while the process is running.
 */
export async function runCopilot(
  copilotPath: string,
  prompt: string,
  model?: string
): Promise<CopilotResult> {
  core.info(`Prompt size: ${prompt.length} chars`)

  const debugDir = buildDebugDir()
  const stdoutLogPath = debugDir ? path.join(debugDir, 'stdout.log') : undefined
  const stderrLogPath = debugDir ? path.join(debugDir, 'stderr.log') : undefined

  const args: string[] = ['--allow-tool', 'shell(git)', '--no-ask-user']
  if (model) {
    args.push('--model', model)
  }

  writeJsonFile(debugDir, 'request.json', {
    copilotPath,
    args,
    model: model ?? null,
    promptChars: prompt.length,
    timeoutMs: COPILOT_TIMEOUT_MS,
    heartbeatMs: COPILOT_HEARTBEAT_MS,
    debugDir: debugDir ?? null,
    startedAt: new Date().toISOString(),
  })

  if (debugDir && COPILOT_SAVE_PROMPT) {
    safeWriteFile(path.join(debugDir, 'prompt.txt'), prompt)
  }

  core.notice(
    `Starting Copilot CLI: timeoutMs=${COPILOT_TIMEOUT_MS}, heartbeatMs=${COPILOT_HEARTBEAT_MS}, model=${model ?? 'default'}${debugDir ? `, debugDir=${debugDir}` : ''}`
  )

  return new Promise<CopilotResult>((resolve, reject) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let lastStdoutAt = startedAt
    let lastStderrAt = startedAt
    let timedOut = false
    let killTimerId: ReturnType<typeof setTimeout> | undefined
    let heartbeatId: ReturnType<typeof setInterval> | undefined

    const cp = spawn(copilotPath, args, {
      env: buildCopilotEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    core.notice(`Copilot spawned with pid=${cp.pid ?? 'unknown'}`)

    cp.stdin.on('error', err => {
      core.warning(`Copilot stdin error: ${err.message}`)
      appendJsonLine(debugDir, 'events.ndjson', {
        type: 'stdin-error',
        timestamp: new Date().toISOString(),
        message: err.message,
      })
    })

    cp.stdin.write(prompt)
    cp.stdin.end()

    const timeoutId = setTimeout(() => {
      timedOut = true
      const now = Date.now()
      const timeoutPayload = {
        type: 'timeout',
        timestamp: new Date().toISOString(),
        elapsedSec: Math.floor((now - startedAt) / 1000),
        stdoutBytes,
        stderrBytes,
        lastStdoutSecAgo: Math.floor((now - lastStdoutAt) / 1000),
        lastStderrSecAgo: Math.floor((now - lastStderrAt) / 1000),
        pid: cp.pid ?? null,
      }

      core.error(
        `Copilot timeout reached after ${timeoutPayload.elapsedSec}s; ` +
          `stdoutBytes=${stdoutBytes}, stderrBytes=${stderrBytes}, ` +
          `lastStdoutSecAgo=${timeoutPayload.lastStdoutSecAgo}, ` +
          `lastStderrSecAgo=${timeoutPayload.lastStderrSecAgo}`
      )
      appendJsonLine(debugDir, 'events.ndjson', timeoutPayload)
      writeJsonFile(debugDir, 'timeout.json', timeoutPayload)

      cp.kill('SIGTERM')
      killTimerId = setTimeout(() => {
        try {
          cp.kill('SIGKILL')
          appendJsonLine(debugDir, 'events.ndjson', {
            type: 'sigkill',
            timestamp: new Date().toISOString(),
            pid: cp.pid ?? null,
          })
        } catch {
          // Process already exited
        }
      }, COPILOT_FORCE_KILL_DELAY_MS)
    }, COPILOT_TIMEOUT_MS)

    heartbeatId = setInterval(() => {
      const now = Date.now()
      const heartbeat = {
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        elapsedSec: Math.floor((now - startedAt) / 1000),
        stdoutBytes,
        stderrBytes,
        lastStdoutSecAgo: Math.floor((now - lastStdoutAt) / 1000),
        lastStderrSecAgo: Math.floor((now - lastStderrAt) / 1000),
        pid: cp.pid ?? null,
      }

      core.notice(
        `Copilot heartbeat: elapsed=${heartbeat.elapsedSec}s ` +
          `stdout=${stdoutBytes}B stderr=${stderrBytes}B ` +
          `lastStdout=${heartbeat.lastStdoutSecAgo}s ` +
          `lastStderr=${heartbeat.lastStderrSecAgo}s`
      )

      if (
        heartbeat.lastStdoutSecAgo >= 120 &&
        heartbeat.lastStderrSecAgo >= 120
      ) {
        core.warning(
          `No Copilot output observed for at least 120s (elapsed=${heartbeat.elapsedSec}s).`
        )
      }

      appendJsonLine(debugDir, 'heartbeat.ndjson', heartbeat)
    }, COPILOT_HEARTBEAT_MS)

    cp.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdout += text
      stdoutBytes += data.length
      lastStdoutAt = Date.now()

      if (stdoutLogPath) {
        safeAppendFile(stdoutLogPath, text)
      }

      core.debug(`Copilot stdout chunk: ${data.length} bytes`)
    })

    cp.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      stderrBytes += data.length
      lastStderrAt = Date.now()

      if (stderrLogPath) {
        safeAppendFile(stderrLogPath, text)
      }

      core.debug(`Copilot stderr chunk: ${data.length} bytes`)
    })

    cp.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeoutId)
      if (heartbeatId) clearInterval(heartbeatId)
      if (killTimerId) clearTimeout(killTimerId)

      const finishedAt = Date.now()
      const closePayload = {
        type: 'close',
        timestamp: new Date().toISOString(),
        elapsedSec: Math.floor((finishedAt - startedAt) / 1000),
        code,
        signal,
        timedOut,
        stdoutBytes,
        stderrBytes,
      }

      appendJsonLine(debugDir, 'events.ndjson', closePayload)
      writeJsonFile(debugDir, 'result.json', closePayload)

      if (stdout) {
        process.stdout.write(sanitizeForWorkflowLog(stdout))
      }
      if (stderr) {
        process.stderr.write(sanitizeForWorkflowLog(stderr))
      }

      if (timedOut) {
        reject(
          new Error(
            `Copilot CLI timed out after ${COPILOT_TIMEOUT_MS / 1000} seconds and was killed` +
              (debugDir ? ` (debug logs: ${debugDir})` : '')
          )
        )
        return
      }

      const exitCode = code ?? 1
      if (exitCode !== 0) {
        core.error(`Copilot CLI exited with code ${exitCode}`)
        core.error(`stderr: ${stderr}`)
        reject(
          new Error(
            `Copilot CLI failed with exit code ${exitCode}` +
              (debugDir ? ` (debug logs: ${debugDir})` : '')
          )
        )
        return
      }

      resolve({stdout, exitCode})
    })

    cp.on('error', (err: Error) => {
      clearTimeout(timeoutId)
      if (heartbeatId) clearInterval(heartbeatId)
      if (killTimerId) clearTimeout(killTimerId)

      appendJsonLine(debugDir, 'events.ndjson', {
        type: 'spawn-error',
        timestamp: new Date().toISOString(),
        message: err.message,
      })

      reject(
        new Error(
          `Failed to spawn Copilot CLI: ${err.message}` +
            (debugDir ? ` (debug logs: ${debugDir})` : '')
        )
      )
    })
  })
}