/* eslint-disable no-console */
import { parseNi, parseNu, run } from '@antfu/ni'
import c from 'picocolors'
import prompts from 'prompts'
import { execa } from 'execa'
import type {
  CheckOptions,
  PackageMeta,
} from '../../types'
import { collectFromGlobal, collectFromProject } from '../../api/check'
import { writePackage } from '../../io/packages'
import { dumpDependencies } from '../../io/dependencies'
import { promptInteractive } from './interactive'
import { renderPackages } from './render'

export async function check(options: CheckOptions) {
  let exitCode = 0
  let resolvePkgs: PackageMeta[] = []

  if (options.global)
    resolvePkgs = await collectFromGlobal(options)
  else
    resolvePkgs = await collectFromProject(options)

  if (options.interactive)
    resolvePkgs = await promptInteractive(resolvePkgs, options)

  const hasChanges = resolvePkgs.length && resolvePkgs.some(i => i.resolved.some(j => j.update))
  if (!hasChanges) {
    console.log(c.green('dependencies are already up-to-date'))
    return exitCode
  }

  const { lines, errLines } = renderPackages(resolvePkgs, options)

  console.log(lines.join('\n'))

  if (!options.all) {
    const counter = resolvePkgs.reduce((counter, pkg) => {
      for (let i = 0; i < pkg.resolved.length; i++) {
        if (pkg.resolved[i].update)
          return ++counter
      }
      return counter
    }, 0)

    const last = resolvePkgs.length - counter

    if (last === 1)
      console.log(c.green('dependencies are already up-to-date in one package\n'))
    else if (last > 0)
      console.log(c.green(`dependencies are already up-to-date in ${last} packages\n`))
  }

  if (errLines.length) {
    console.error(c.inverse(c.red(c.bold(' ERROR '))))
    console.error()
    console.error(errLines.join('\n'))
    console.error()
  }

  if (options.interactive && !options.write) {
    options.write = await prompts([
      {
        name: 'write',
        type: 'confirm',
        initial: true,
        message: c.green('write to package.json'),
      },
    ]).then(r => r.write)
  }

  if (options.write) {
    for (const pkg of resolvePkgs)
      await writePackage(pkg, options)
  }

  // tips
  if (!options.write) {
    console.log()

    if (options.mode === 'default')
      console.log(`Run ${c.cyan('taze major')} to check major updates`)

    if (hasChanges) {
      if (options.failOnOutdated)
        exitCode = 1

      console.log(`Add ${c.green('-w')} to write to package.json`)
    }

    console.log()
  }
  else if (hasChanges) {
    if (!options.install && !options.update && !options.interactive) {
      console.log(
        c.yellow(`ℹ changes written to package.json, run ${c.cyan('npm i')} to install updates.`),
      )
    }

    if (options.install || options.update || options.interactive)
      console.log(c.yellow('ℹ changes written to package.json'))

    if (options.interactive && !options.install) {
      options.install = await prompts([
        {
          name: 'install',
          type: 'confirm',
          initial: true,
          message: c.green('install now'),
        },
      ]).then(r => r.install)
    }

    if (options.install) {
      console.log(c.magenta('installing...'))
      console.log()

      await run(parseNi, [])
    }

    if (options.update) {
      console.log(c.magenta('updating...'))
      console.log()

      if (options.global) {
        const changes = resolvePkgs[0].resolved.filter(i => i.update)
        const dependencies = dumpDependencies(changes, 'dependencies')
        const updateArgs = Object.entries(dependencies).map(([name, version]) => `${name}@${version}`)
        await execa('npm install -g', updateArgs)
      }
      else {
        await run(parseNu, options.recursive ? ['-r'] : [])
      }
    }
  }

  return exitCode
}
