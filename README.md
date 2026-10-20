# MoodlIA Test Lab

Disposable Moodle sites for testing MoodlIA packages against every supported
Moodle branch, without installing Moodle for each run.

[Status](#status) · [Getting started](#getting-started) · [Usage](#usage) · [Development](#development) · [Security and privacy](#security-and-privacy) · [Documentation](#documentation) · [License](#license)

## Status

Development infrastructure for disposable Moodle qualification. Golden-image builds and scheduled workflows are separate from evidence that any particular application/version pairing has passed.

## Getting started

### Golden images

`ghcr.io/gafapa/moodlia-lab:<branch>-<variant>` for branches 4.5, 5.0, 5.1,
5.2, and 5.3, in two variants:

- `core`: Moodle with REST enabled and a lab service exposing every Core
  function.
- `moodlia`: the same plus the MoodlIA plugin.

Each image is `erseco/alpine-moodle` with Moodle already installed on SQLite
and a fixture: a source course with a Unicode group and grouping, two target
courses, and on `moodlia` a Page with nested Unicode files. Course shortnames
carry the site (`M405CORE-SOURCE`, `M503MOODLIA-TARGET-A`), because
synchronization copies the source shortname and shortnames are unique per site.
Each course also has its course grade category and grade item, which Moodle
otherwise creates on first use, so read-only web service calls never write.
Images contain no secrets: when a container starts,
`php /opt/moodlia-lab/runtime.php <variant> [prefix]` sets a random administrator
password and prints the connection fixture (a fresh token and the course ids)
as JSON on its last line. An optional uppercase prefix renames the fixture
courses (`SRC-M405CORE-SOURCE`), so two sites started from the same image never
share a shortname.

Images run Moodle in reverse-proxy mode with `SITE_URL` set to the host URL.
Publish them on a host port other than the container port 8080, for example
`-p 127.0.0.1:18080:8080 -e SITE_URL=http://127.0.0.1:18080`: when the host and
port match `wwwroot`, Moodle rejects every request as `reverseproxyabused`.

Images are amd64 only. They are rebuilt weekly, when a plugin release triggers
`repository_dispatch` (`plugin-released`), or on demand (`build-images.yml`,
with optional `plugin_ref` and a comma-separated `versions` list). Each build is
smoke-tested with a web service call before it is pushed. Build one locally with:

```sh
bash images/build.sh v4.5.12 moodlia moodlia-lab:4.5-moodlia ../moodle-local_moodlia
```

The `moodlia-lab` package is public: pulls need no credentials.

## Usage

### Live qualification

```sh
npm run qualify:live -- --source 4.5 --target 5.3 \
  --package 0.1.2 \
  --runner ../moodlia-sync/tools/live-qualification/runner
```

This starts four sites (Core and MoodlIA on each branch), runs plan, approve,
apply, verify, and an unchanged re-plan for the four provider pairings, writes
the report to `results/`, and removes every container, even on failure. When a
run fails it also keeps the plans, CLI output, and synchronization state in
`results/<run-id>-evidence/` (never the tokens); if apply reports that a course
changed after planning, the evidence includes both courses exported twice.
`--package` accepts an existing tarball path or a bare npm version such as `0.1.2` (the runner expands it to `moodlia-sync@0.1.2`). To test an unpublished checkout, create its tarball first with `npm pack` in that repository and pass the actual file path. `--database pgsql` installs
each site from the base image against its own PostgreSQL 17 (the minimum for
Moodle 5.3) instead of SQLite; it needs `--plugin <moodle-local_moodlia checkout>`.

Sites run without the image's internal Moodle cron (`RUN_CRON_TASKS=false`):
SQLite accepts one writer at a time, so cron writes made concurrent web service
calls fail with `dml_write_exception`, and cron tasks could change a course
between plan and apply. For the same reason `runtime.php` disables the log
stores on SQLite sites, because the standard log store writes a row on every web
service call, and switches the SQLite database to WAL, so reads proceed while
another request writes. Because cron does not run, `runtime.php` also creates any
missing contexts at start, as cron would; otherwise parallel reads race to
create them. Each site uses this checkout's `runtime.php`, with the
prefix `SRC` on source sites and `TGT` on target sites.

`--plugin-smoke` then exercises plugin write features on the target MoodlIA
site (group visibility and keys, text formats, embedded files for forum,
glossary, and Lesson, and a backup download); `--large-backup` streams a
backup larger than 100 MiB through upload, download, and restore.

Each container is limited to 768 MiB and 0.75 CPU (`--memory`, `--cpus`) and
labelled `moodlia-lab`, and PHP and nginx accept uploads up to 1 GiB for
large-backup scenarios.

## Development

### GitHub Actions

- `qualify.yml`: reusable (`workflow_call`) and manual qualification of one
  source/target pair.
- `ci.yml`: fast checks on pushes and pull requests without credentials.
- `nightly.yml`: weekly qualification of every source/target pair of the five
  branches, plus one PostgreSQL run; it can also be run manually.
- `.github/actions/lab-up`: starts one site and outputs its URL and a masked
  token, for other repositories' recording or integration jobs. Its `port`
  input defaults to 18080 and must not be 8080. The site runs without cron.

Actions minutes are free for public repositories on standard runners.

## Security and privacy

Use fictional fixtures on disposable sites. Runtime tokens and administrator passwords are generated per container; keep them out of reports and repositories. Remove test containers and volumes after qualification. Never target a persistent teaching site.

### Shared hosts

Prefer Actions. On a shared host, keep to two sites at a time and remove lab
images afterwards with `docker image prune --filter label=moodlia-lab`.

## Documentation

- [Project Pages](https://gafapa.github.io/moodlia-test-lab/)

Build the repository documentation portal with `python tools/build-project-page.py`. Its status comes from this README; purpose and first steps are maintained in `docs/project-page.json`. The `pages.yml` workflow publishes the portal without deploying the application or changing `moodlia.com`.

Shared qualification infrastructure for the [plugin](https://github.com/gafapa/moodle-local_moodlia), [Core](https://github.com/gafapa/moodle-core-cli) and [Sync](https://github.com/gafapa/moodlia-sync).

- [Source code](https://github.com/gafapa/moodlia-test-lab)
- [Issue tracker](https://github.com/gafapa/moodlia-test-lab/issues)
- [MoodlIA website](https://moodlia.com)

## License

GPL-3.0-or-later.
