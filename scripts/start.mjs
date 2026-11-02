import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * 生产模式启动：先构建前端，再用 Electron 打开。
 * 不依赖 node_modules/.bin（某些环境下 npm 的 bin 链接会丢）。
 */
const require = createRequire(import.meta.url)
const electronPath = require('electron')

if (!existsSync('dist/index.html')) {
  console.log('[start] 构建前端…')
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' })
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 留着它 Electron 会当纯 Node 跑，窗口不出来
delete env.VITE_DEV_SERVER_URL

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env })
child.on('close', (code) => process.exit(code ?? 0))
