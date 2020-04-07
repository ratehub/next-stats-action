const path = require('path')
const fs = require('fs-extra')
const exec = require('../util/exec')
const glob = require('../util/glob')
const logger = require('../util/logger')
let { statsAppDir, diffingDir } = require('../constants')

module.exports = async function collectDiffs(
  filesToTrack = [],
  initial = false
) {
  if (initial) {
    logger('Setting up directory for diffing')
    logger(statsAppDir)
    logger(await exec(`ls ${statsAppDir}`))

    // set-up diffing directory
    await fs.remove(diffingDir)
    await fs.mkdirp(diffingDir)
    await exec(`cd ${diffingDir} && git init`)
  } else {
    // remove any previous files in case they won't be overwritten
    const toRemove = await glob('!(.git)', { cwd: diffingDir, dot: true })

    await Promise.all(
      toRemove.map(file => fs.remove(path.join(diffingDir, file)))
    )
  }
  const diffs = {}

  await Promise.all(
    filesToTrack.map(async fileGroup => {
      const { globs } = fileGroup
      const curFiles = []

      await Promise.all(
        globs.map(async pattern => {
          curFiles.push(...(await glob(pattern, { cwd: statsAppDir })))
        })
      )

      for (let file of curFiles) {
        const absPath = path.join(statsAppDir, file)

        const diffDest = path.join(diffingDir, file)
        await fs.copy(absPath, diffDest)
      }

      if (curFiles.length > 0) {
        await exec(
          `cd ${diffingDir} && ` +
            `yarn prettier --write ${curFiles
              .map(f => path.join(diffingDir, f))
              .join(' ')}`
        )
      }
    })
  )

  await exec(`cd ${diffingDir} && git add .`)

  await exec(`sleep 600`)

  if (initial) {
    await exec(`cd ${diffingDir} && git commit -m 'initial commit'`)
  } else {
    let { stdout: renamedFiles } = await exec(
      `cd ${diffingDir} && git diff --name-status HEAD`
    )
    renamedFiles = renamedFiles
      .trim()
      .split('\n')
      .filter(line => line.startsWith('R'))

    diffs._renames = []

    await Promise.all(
      renamedFiles.map(async line => {
        const [, prev, cur] = line.split('\t')
        await fs.move(path.join(diffingDir, cur), path.join(diffingDir, prev))
        diffs._renames.push({
          prev,
          cur,
        })
      })
    )

    await exec(`cd ${diffingDir} && git add .`)

    let { stdout: changedFiles } = await exec(
      `cd ${diffingDir} && git diff --name-only HEAD`
    )
    changedFiles = changedFiles.trim().split('\n')

    await Promise.all(
      changedFiles.map(async file => {
        const fileKey = path.basename(file)
        const hasFile = await fs.exists(path.join(diffingDir, file))

        if (!hasFile) {
          diffs[fileKey] = 'deleted'
          return
        }

        try {
          let { stdout } = await exec(
            `cd ${diffingDir} && git diff --minimal HEAD ${file}`
          )
          stdout = (stdout.split(file).pop() || '').trim()
          if (stdout.length > 0) {
            diffs[fileKey] = stdout
          }
        } catch (err) {
          console.error(`Failed to diff ${file}: ${err.message}`)
          diffs[fileKey] = `failed to diff`
        }
      })
    )
  }
  return diffs
}
