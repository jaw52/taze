import c from 'picocolors'
import { execa } from 'execa'
import type { SingleBar } from 'cli-progress'
import type { CheckOptions, DependencyFilter, DependencyResolvedCallback, PackageMeta, RawDep } from '../types'
import { loadPackages, writePackage } from '../io/packages'
import { dumpCache, loadCache, resolvePackage } from '../io/resolves'
import { createMultiProgresBar } from '../log'

export interface CheckEventCallbacks {
  afterPackagesLoaded?: (pkgs: PackageMeta[]) => void
  beforePackageStart?: (pkg: PackageMeta) => void
  afterPackageEnd?: (pkg: PackageMeta) => void
  beforePackageWrite?: (pkg: PackageMeta) => boolean | Promise<boolean>
  afterPackagesEnd?: (pkgs: PackageMeta[]) => void
  afterPackageWrite?: (pkg: PackageMeta) => void
  onDependencyResolved?: DependencyResolvedCallback
}

// Collect dependencies from the global npm
export async function collectFromGlobal(options: CheckOptions) {
  const { stdout } = await execa('npm ls --global --depth=0 --json')
  const npmOutInfo = JSON.parse(stdout) as { dependencies: { [name: string]: { version: string } } }

  const deps: RawDep[] = Object.entries(npmOutInfo.dependencies)
    .map(([name, i]) =>
      ({
        name,
        currentVersion: `^${i.version}`,
        update: true,
        source: 'dependencies',
      }),
    )

  const pkg: PackageMeta = {
    resolved: [],
    raw: null,
    version: '',
    filepath: '',
    relative: '',
    deps,
    name: c.red('npm'),
  }

  const bars = options.loglevel === 'silent' ? null : createMultiProgresBar()
  const depBar = bars?.create(pkg.deps.length, 0, { type: c.green('dep') })

  await resolvePackage(
    pkg,
    options,
    undefined,
    (_pkgName, name, progress) => depBar?.update(progress, { name }),
  )
  bars?.stop()
  return [pkg]
}

// Collect dependencies from the project
export async function collectFromProject(options: CheckOptions) {
  const resolvePkgs: PackageMeta[] = []
  let packagesBar: SingleBar | undefined
  const bars = options.loglevel === 'silent' ? null : createMultiProgresBar()

  const depBar = bars?.create(1, 0)
  await CheckPackages(options, {
    afterPackagesLoaded(pkgs) {
      packagesBar = (options.recursive && pkgs.length)
        ? bars?.create(pkgs.length, 0, { type: c.cyan('pkg'), name: c.cyan(pkgs[0].name) })
        : undefined
    },
    beforePackageStart(pkg) {
      packagesBar?.increment(0, { name: c.cyan(pkg.name) })
      depBar?.start(pkg.deps.length, 0, { type: c.green('dep') })
    },
    beforePackageWrite() {
      // disbale auto write
      return false
    },
    afterPackageEnd(pkg) {
      packagesBar?.increment(1)
      depBar?.stop()
      resolvePkgs.push(pkg)
    },
    onDependencyResolved(_pkgName, name, progress) {
      depBar?.update(progress, { name })
    },
  })

  bars?.stop()
  return resolvePkgs
}

export async function CheckPackages(options: CheckOptions, callbacks: CheckEventCallbacks = {}) {
  if (!options.force)
    await loadCache()

  // packages loading
  const packages = await loadPackages(options)
  callbacks.afterPackagesLoaded?.(packages)

  const privatePackageNames = packages
    .filter(i => i.raw.private)
    .map(i => i.raw.name)
    .filter(i => i)

  // to filter out private dependency in monorepo
  const filter = (dep: RawDep) => !privatePackageNames.includes(dep.name)

  for (const pkg of packages) {
    callbacks.beforePackageStart?.(pkg)
    await CheckSingleProject(pkg, options, filter, callbacks)

    callbacks.afterPackageEnd?.(pkg)
  }

  callbacks.afterPackagesEnd?.(packages)

  await dumpCache()

  return {
    packages,
  }
}

async function CheckSingleProject(pkg: PackageMeta, options: CheckOptions, filter: DependencyFilter = () => true, callbacks: CheckEventCallbacks = {}) {
  await resolvePackage(pkg, options, filter, callbacks.onDependencyResolved)

  const { resolved } = pkg
  const changes = resolved.filter(i => i.update)

  if (options.write && changes.length) {
    const shouldWrite = await Promise.resolve(callbacks.beforePackageWrite?.(pkg))

    if (shouldWrite !== false) {
      await writePackage(pkg, options)
      callbacks.afterPackageWrite?.(pkg)
    }
  }
  return pkg
}
