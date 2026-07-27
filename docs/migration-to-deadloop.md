# Rename to deadloop

`deadloop` is the only supported public name for this package.

The rename is a breaking cleanup: old `pi-looper` package names, config paths, environment variables, command names, repo-policy filenames, extension directories, and worker state directories are not kept as compatibility aliases.

## Supported names

Install:

```bash
pi install git:github.com/yasuhito/deadloop
npx skills@latest add yasuhito/deadloop
```

Local config path:

```text
~/.pi/agent/deadloop/projects.json
```

Pi commands:

```text
/deadloop-enable
/deadloop-disable
/deadloop-status
/deadloop-doctor
```

Operator environment variables:

```bash
DEADLOOP_CONFIG=/path/to/projects.json pi
DEADLOOP_PROJECTS=my-project pi
DEADLOOP=off pi
DEADLOOP_AUTOMATIONS=off pi
DEADLOOP_DEBUG=1 pi
```

Trusted repository policy file:

```text
deadloop.json
```

Internal worker state directory:

```text
.deadloop/
```

## Manual migration

If you used an earlier checkout, move your local config manually:

```bash
mkdir -p ~/.pi/agent/deadloop
mv ~/.pi/agent/pi-looper/projects.json ~/.pi/agent/deadloop/projects.json
```

If your target repository has shared policy, rename it:

```bash
git mv pi-looper.project.json deadloop.json
```

Update runbooks and scripts to use `/deadloop-enable`, `/deadloop-disable`, `/deadloop-status`, `/deadloop-doctor`, and `DEADLOOP_*` variables. Re-enable each repository with `/deadloop-enable` after migrating.

## Not changed

- v0 still runs as a Pi package.
- v0 still uses Herdr as the default runner.
- Existing auto-merge gates, GitHub labels, and the promise-file contract are unchanged.
- Local scheduling now requires explicit `/deadloop-enable` permission, with enablement state and mutation guards kept outside the repository.
