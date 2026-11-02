import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

/**
 * 开发启动器：先起 Vite 开发服务器，再拉 Electron 指向它。
 * 这样只有一条命令 `npm run dev`，不用 concurrently / wait-on。
 */
const require = createRequire(import.meta.url)
const electronPath = require('electron') // electron 包导出的就是可执行文件路径

const server = await createServer({ configFile: 'vite.config.ts' })
await server.listen()
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5273/'
console.log(`[dev] renderer: ${url}`)

const env = { ...process.env, VITE_DEV_SERVER_URL: url }
delete env.ELECTRON_RUN_AS_NODE // 留着它 Electron 会当纯 Node 跑，窗口不出来

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env })

child.on('close', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill()
    server.close().finally(() => process.exit(0))
  })
}
