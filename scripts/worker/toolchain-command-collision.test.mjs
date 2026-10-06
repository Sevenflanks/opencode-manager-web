// 僅在 network-none、一次性 root Docker fixture 執行；從不修改 host 或正式 Worker。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { lstatSync, readFileSync, readlinkSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs"
import { test } from "node:test"

const commands = ["java", "javac", "mvn", "gh", "officecli"]
test("工具安裝拒絕既有 regular file 與 dangling symlink，不覆寫命令", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, () => {
  const original = commands.map(name => [name, readlinkSync(`/usr/local/bin/${name}`)])
  const nodeBefore = readFileSync("/usr/local/bin/node")
  const gitBefore = readFileSync("/usr/bin/git")
  for (const name of commands) unlinkSync(`/usr/local/bin/${name}`)
  let cases = 0
  try {
    for (const name of commands) for (const kind of ["file", "dangling"]) {
      const destination = `/usr/local/bin/${name}`
      if (kind === "file") writeFileSync(destination, "collision fixture\n", { flag: "wx" })
      else symlinkSync("/nonexistent-toolchain-collision", destination)
      try {
        const result = spawnSync(process.execPath, ["/opt/omw/deploy/worker/toolchain-install.mjs"], { encoding: "utf8", timeout: 5000 })
        assert.equal(result.error, undefined)
        assert.equal(result.status, 1)
        assert.ok(result.stderr.includes(`Toolchain command collision: ${destination}`))
        if (kind === "file") assert.equal(readFileSync(destination, "utf8"), "collision fixture\n")
        else assert.equal(readlinkSync(destination), "/nonexistent-toolchain-collision")
        cases++
      } finally { unlinkSync(destination) }
    }
    assert.deepEqual(readFileSync("/usr/local/bin/node"), nodeBefore)
    assert.deepEqual(readFileSync("/usr/bin/git"), gitBefore)
    console.log(`COLLISION_CASES=${cases}`)
  } finally {
    for (const [name, source] of original) {
      assert.equal(lstatSync(`/usr/local/bin/${name}`, { throwIfNoEntry: false }), undefined)
      symlinkSync(source, `/usr/local/bin/${name}`)
    }
  }
})
