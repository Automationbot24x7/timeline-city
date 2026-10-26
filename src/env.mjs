// Loads .env (searched upward from the project dir and cwd) and project.yaml.
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

function findUp(start, name) {
  let dir = path.resolve(start)
  for (;;) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadEnv(...startDirs) {
  for (const start of [...startDirs, process.cwd()]) {
    const file = findUp(start, '.env')
    if (!file) continue
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || !line.includes('=')) continue
      const i = line.indexOf('=')
      const key = line.slice(0, i).trim()
      const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
      if (!(key in process.env)) process.env[key] = value
    }
    return file
  }
  return null
}

export const DEFAULT_MODELS = {
  director: 'minimax/minimax-m3.1-flash',
  image: 'google/nano-banana-2.1',
  tts: 'minimax/speech/2.8/hd',
  music: 'minimax/music/2.6', // is_instrumental: true guarantees no vocals
  music_fallback: 'minimax/music/3',
}

export function loadProject(projectDir) {
  const file = path.join(projectDir, 'project.yaml')
  if (!fs.existsSync(file)) throw new Error(`No project.yaml in ${projectDir}`)
  const config = YAML.parse(fs.readFileSync(file, 'utf8'))
  config.models = { ...DEFAULT_MODELS, ...(config.models || {}) }
  config.target_seconds ??= 150
  config.fps ??= 30
  config.aspects ??= ['16:9']
  config.language ??= 'en'
  return config
}
